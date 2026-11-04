import { randomUUID } from "node:crypto";
import {
  AdapterError,
  cardToFallbackText,
  extractCard,
  extractFiles,
  ValidationError,
} from "@chat-adapter/shared";
import type {
  Adapter,
  AdapterPostableMessage,
  Attachment,
  ChatInstance,
  EmojiValue,
  FetchOptions,
  FetchResult,
  FileUpload,
  FormattedContent,
  Logger,
  RawMessage,
  Root,
  StreamChunk,
  ThreadInfo,
  WebhookOptions,
} from "chat";
import {
  defaultEmojiResolver,
  Message,
  NotImplementedError,
  parseMarkdown,
  stringifyMarkdown,
} from "chat";
import { lookup } from "mime-types";
import { io, type Socket } from "socket.io-client";
import { decodeWebhookSecret, verifyWebhookSignature } from "./webhook";

const NAME = "photon";
const DEFAULT_BASE_URL = "https://api.photon.codes";
// The event contract this adapter parses; the websocket pins it per subscription.
const API_VERSION = "2026-07-01";
const SUBSCRIBE_TIMEOUT_MS = 10_000;
const HISTORY_EXCLUDED_CONTENT = "message.read,space.typing.update";
const TRAILING_SLASHES = /\/+$/;

export interface PhotonAdapterConfig {
  /** Project API key (`pho_sk_...`). Defaults to `PHOTON_API_KEY`. */
  apiKey?: string;
  /** Photon API origin. Defaults to `PHOTON_API_URL`, then https://api.photon.codes. */
  baseUrl?: string;
  logger?: Logger;
  /** Photon project ID. Defaults to `PHOTON_PROJECT_ID`. */
  projectId?: string;
  /** Bot name matched for @-mentions in group Spaces. Defaults to "photon". */
  userName?: string;
  /** Webhook destination signing secret (`whsec_...`). Defaults to `PHOTON_WEBHOOK_SECRET`. */
  webhookSecret?: string;
}

/** A Chat SDK thread is one Photon Space, spoken in by one of the project's Agent Users. */
export interface PhotonThreadId {
  agentUserId: string;
  spaceId: string;
  /** Photon Space kind, such as "direct" or "group". */
  spaceKind: string;
}

export interface PhotonUser {
  handle: string;
  id: string;
  kind: string;
  platform: string;
  [key: string]: unknown;
}

export interface PhotonSpace {
  id: string;
  kind: string;
  participantIds: string[];
  platform: string;
  [key: string]: unknown;
}

export interface PhotonContent {
  type: string;
  [key: string]: unknown;
}

/** A Photon Message as the API and webhooks return it. */
export interface PhotonMessage {
  content: PhotonContent;
  createdAt: string;
  id: string;
  parentMessageId?: string;
  platform: string;
  receivedBy?: PhotonUser;
  sentBy: PhotonUser;
  space: PhotonSpace;
  status: string;
  timestamps: Record<string, string | undefined>;
  [key: string]: unknown;
}

/** A Photon event envelope, as webhooks and the websocket deliver it. */
export interface PhotonEvent {
  data?: { object?: PhotonMessage };
  id?: string;
  type?: string;
}

interface DeliveryError {
  code: string;
  fatal: boolean;
  message: string;
}

interface ServerEvents {
  delivery: (event: PhotonEvent, metadata: { seq: number }) => void;
  delivery_error: (error: DeliveryError) => void;
}

interface ClientEvents {
  subscribe: (
    input: { apiVersion: string; startSeq: number },
    ack: (result: { ok: true } | { error: DeliveryError; ok: false }) => void
  ) => void;
}

interface PhotonAttachment {
  contentType: string;
  filename?: string;
  id: string;
  sizeBytes: number;
}

interface ContentParts {
  attachmentIds: string[];
  text: string;
}

export class PhotonAdapter implements Adapter<PhotonThreadId, PhotonMessage> {
  readonly name = NAME;
  readonly userName: string;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private chat: ChatInstance | null = null;
  private logger?: Logger;
  private readonly projectId: string;
  private readonly webhookKey?: Buffer;

  constructor(config: PhotonAdapterConfig = {}) {
    const projectId = config.projectId ?? process.env.PHOTON_PROJECT_ID;
    const apiKey = config.apiKey ?? process.env.PHOTON_API_KEY;
    if (!(projectId && apiKey)) {
      throw new ValidationError(
        NAME,
        "projectId and apiKey are required (or set PHOTON_PROJECT_ID and PHOTON_API_KEY)"
      );
    }
    const webhookSecret =
      config.webhookSecret ?? process.env.PHOTON_WEBHOOK_SECRET;
    this.webhookKey = webhookSecret
      ? decodeWebhookSecret(webhookSecret)
      : undefined;
    if (webhookSecret && !this.webhookKey) {
      throw new ValidationError(NAME, "webhookSecret must be a whsec_ secret");
    }

    this.projectId = projectId;
    this.apiKey = apiKey;
    this.baseUrl = (
      config.baseUrl ??
      process.env.PHOTON_API_URL ??
      DEFAULT_BASE_URL
    ).replace(TRAILING_SLASHES, "");
    this.userName = config.userName ?? NAME;
    this.logger = config.logger;
  }

  async initialize(chat: ChatInstance): Promise<void> {
    this.chat = chat;
    this.logger ??= chat.getLogger(NAME);
  }

  encodeThreadId({ spaceId, agentUserId, spaceKind }: PhotonThreadId): string {
    return `${NAME}:${spaceId}:${agentUserId}:${spaceKind}`;
  }

  decodeThreadId(threadId: string): PhotonThreadId {
    const parts = threadId.split(":");
    const [adapter, spaceId, agentUserId, spaceKind] = parts;
    if (
      parts.length !== 4 ||
      adapter !== NAME ||
      !spaceId ||
      !agentUserId ||
      !spaceKind
    ) {
      throw new ValidationError(NAME, `Invalid Photon thread ID: ${threadId}`);
    }
    return { spaceId, agentUserId, spaceKind };
  }

  channelIdFromThreadId(threadId: string): string {
    return `${NAME}:${this.decodeThreadId(threadId).spaceId}`;
  }

  isDM(threadId: string): boolean {
    return this.decodeThreadId(threadId).spaceKind === "direct";
  }

  /**
   * Handles a Photon webhook delivery: verifies its Standard Webhooks
   * signature, then routes `message.received` into the Chat SDK. Every other
   * event is acknowledged so Photon does not retry it.
   */
  async handleWebhook(
    request: Request,
    options?: WebhookOptions
  ): Promise<Response> {
    if (!this.chat) {
      return new Response("Chat instance not initialized", { status: 500 });
    }
    if (!this.webhookKey) {
      return new Response(
        "Webhook secret not configured (set PHOTON_WEBHOOK_SECRET)",
        { status: 500 }
      );
    }

    const body = new Uint8Array(await request.arrayBuffer());
    const webhookId = verifyWebhookSignature(
      body,
      request.headers,
      this.webhookKey
    );
    if (!webhookId) {
      return new Response("Invalid webhook signature", { status: 401 });
    }

    let event: PhotonEvent;
    try {
      event = JSON.parse(new TextDecoder().decode(body));
    } catch {
      return new Response("Invalid JSON body", { status: 400 });
    }
    if (event.id !== webhookId) {
      return new Response("Signed webhook ID does not match the event", {
        status: 401,
      });
    }

    this.routeEvent(event, options);
    return new Response(null, { status: 200 });
  }

  /**
   * Receives events over Photon's websocket instead of a webhook. Listens for
   * `durationMs` (`Infinity` listens until `abortSignal`), reconnecting as
   * needed, and keeps the last event it handled in the Chat SDK state so the
   * next connection resumes after it.
   */
  async startGatewayListener(
    options: WebhookOptions = {},
    durationMs = 180_000,
    abortSignal?: AbortSignal
  ): Promise<Response> {
    if (!this.chat) {
      return new Response("Chat instance not initialized", { status: 500 });
    }
    const state = this.chat.getState();
    const cursorKey = `${NAME}:cursor:${this.projectId}`;
    let cursor = (await state.get<number>(cursorKey)) ?? 0;
    let queue = Promise.resolve();

    const socket: Socket<ServerEvents, ClientEvents> = io(this.baseUrl, {
      path: `/v1/projects/${this.projectId}/events/ws`,
      addTrailingSlash: false,
      transports: ["websocket"],
      extraHeaders: { authorization: `Bearer ${this.apiKey}` },
    });
    socket.on("connect", () => {
      socket
        .timeout(SUBSCRIBE_TIMEOUT_MS)
        .emit(
          "subscribe",
          { startSeq: cursor, apiVersion: API_VERSION },
          (timedOut, result) => {
            if (timedOut) {
              // Closing the transport makes Socket.IO reconnect and subscribe again.
              socket.io.engine.close();
            } else if (!result.ok) {
              this.logger?.error("Photon websocket subscription rejected", {
                ...result.error,
              });
            }
          }
        );
    });
    socket.on("delivery", (event, { seq }) => {
      queue = queue
        .then(async () => {
          if (seq <= cursor) {
            return;
          }
          this.routeEvent(event, options);
          await state.set(cursorKey, seq);
          cursor = seq;
        })
        .catch((error: unknown) => {
          this.logger?.error("Photon websocket cursor not saved", {
            seq,
            error: String(error),
          });
        });
    });
    socket.on("delivery_error", (error) => {
      this.logger?.warn("Photon websocket delivery error", { ...error });
    });
    socket.on("connect_error", (error) => {
      this.logger?.warn("Photon websocket connection failed", {
        error: error.message,
      });
    });

    let finish: (drained: Promise<void>) => void = () => undefined;
    const listener = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const stop = () => {
      clearTimeout(timer);
      socket.disconnect();
      finish(queue);
    };
    const timer = Number.isFinite(durationMs)
      ? setTimeout(stop, durationMs)
      : undefined;
    socket.on("disconnect", (reason) => {
      // Photon disconnects for good only on a protocol violation; anything else reconnects.
      if (reason === "io server disconnect") {
        this.logger?.error("Photon closed the websocket; listener stopped");
        stop();
      }
    });
    if (abortSignal?.aborted) {
      stop();
    }
    abortSignal?.addEventListener("abort", stop, { once: true });
    options.waitUntil?.(listener);

    return Response.json({ status: "listening", durationMs });
  }

  async postMessage(
    threadId: string,
    message: AdapterPostableMessage
  ): Promise<RawMessage<PhotonMessage>> {
    const text = toTextContent(message);
    const files = extractFiles(message);
    if (!(text || files.length)) {
      throw new ValidationError(NAME, "postMessage needs text or a file");
    }

    const sent: RawMessage<PhotonMessage>[] = [];
    if (text) {
      sent.push(await this.send(threadId, text, "postMessage"));
    }
    for (const file of files) {
      const attachmentId = await this.upload(file);
      sent.push(
        await this.send(
          threadId,
          { type: "attachment", attachmentId },
          "postMessage"
        )
      );
    }
    return sent[0] as RawMessage<PhotonMessage>;
  }

  // Photon cannot edit messages live on most platforms, so a streamed reply
  // goes out once, complete, instead of as a placeholder that gets edited.
  async stream(
    threadId: string,
    textStream: AsyncIterable<string | StreamChunk>
  ): Promise<RawMessage<PhotonMessage> | null> {
    let text = "";
    for await (const chunk of textStream) {
      if (typeof chunk === "string") {
        text += chunk;
      } else if (chunk.type === "markdown_text") {
        text += chunk.text;
      }
    }
    return text.trim() ? this.postMessage(threadId, { markdown: text }) : null;
  }

  async editMessage(
    threadId: string,
    messageId: string,
    message: AdapterPostableMessage
  ): Promise<RawMessage<PhotonMessage>> {
    const text = toTextContent(message);
    if (!text) {
      throw new ValidationError(NAME, "editMessage needs text");
    }
    return this.send(
      threadId,
      { type: "message.update", content: text },
      "editMessage",
      messageId
    );
  }

  async deleteMessage(threadId: string, messageId: string): Promise<void> {
    await this.send(
      threadId,
      { type: "message.delete" },
      "deleteMessage",
      messageId
    );
  }

  async addReaction(
    threadId: string,
    messageId: string,
    emoji: EmojiValue | string
  ): Promise<void> {
    await this.send(
      threadId,
      { type: "reaction", reaction: defaultEmojiResolver.toGChat(emoji) },
      "addReaction",
      messageId
    );
  }

  async removeReaction(): Promise<void> {
    throw new NotImplementedError(
      "Photon removes a reaction by deleting the reaction's own Message, which this adapter does not track",
      "removeReaction"
    );
  }

  // Typing is cosmetic, so a platform without it makes this a no-op instead of failing the reply.
  async startTyping(threadId: string): Promise<void> {
    const { spaceId, agentUserId } = this.decodeThreadId(threadId);
    await this.request("POST", `/spaces/${spaceId}/typing`, "startTyping", {
      json: { senderId: agentUserId, typing: true },
    }).catch((error: unknown) => {
      if (!(error instanceof NotImplementedError)) {
        throw error;
      }
    });
  }

  async markAsRead(_threadId: string, messageId: string): Promise<void> {
    await this.request("POST", `/messages/${messageId}/read`, "markAsRead", {
      idempotent: true,
    });
  }

  async fetchMessages(
    threadId: string,
    options: FetchOptions = {}
  ): Promise<FetchResult<PhotonMessage>> {
    const { spaceId, agentUserId } = this.decodeThreadId(threadId);
    const forward = options.direction === "forward";
    const query = new URLSearchParams({
      spaceId,
      perspectiveUserId: agentUserId,
      pageSize: String(options.limit ?? 50),
      order: forward ? "asc" : "desc",
      excludeContentTypes: HISTORY_EXCLUDED_CONTENT,
    });
    if (options.cursor) {
      query.set("pageToken", options.cursor);
    }
    const page = (await (
      await this.request("GET", `/messages?${query}`, "fetchMessages")
    ).json()) as { items: PhotonMessage[]; nextPageToken?: string };

    const items = forward ? page.items : [...page.items].reverse();
    const messages = await Promise.all(
      items
        .map((raw) => ({ raw, parts: readContent(raw.content) }))
        .filter(({ parts }) => parts.text || parts.attachmentIds.length)
        .map(({ raw, parts }) => this.toMessage(raw, threadId, parts))
    );
    return { messages, nextCursor: page.nextPageToken };
  }

  async fetchThread(threadId: string): Promise<ThreadInfo> {
    const { spaceId } = this.decodeThreadId(threadId);
    const space = (await (
      await this.request("GET", `/spaces/${spaceId}`, "fetchThread")
    ).json()) as PhotonSpace;
    return {
      id: threadId,
      channelId: this.channelIdFromThreadId(threadId),
      isDM: space.kind === "direct",
      metadata: { space },
    };
  }

  parseMessage(raw: PhotonMessage): Message<PhotonMessage> {
    const threadId = this.threadIdOf(raw);
    if (!threadId) {
      throw new ValidationError(NAME, `Message ${raw.id} has no Agent User`);
    }
    const { text, attachmentIds } = readContent(raw.content);
    return this.buildMessage(
      raw,
      threadId,
      text,
      attachmentIds.map((id) => this.toAttachment(id))
    );
  }

  renderFormatted(content: FormattedContent): string {
    return stringifyMarkdown(content);
  }

  rehydrateAttachment(attachment: Attachment): Attachment {
    const id = attachment.fetchMetadata?.attachmentId;
    return id
      ? { ...attachment, fetchData: () => this.download(id) }
      : attachment;
  }

  /** Routes `message.received` into the Chat SDK; every other event is ignored. */
  private routeEvent(event: PhotonEvent, options?: WebhookOptions): void {
    const raw = event.data?.object;
    if (event.type !== "message.received" || !raw) {
      return;
    }
    const threadId = this.threadIdOf(raw);
    if (!threadId) {
      this.logger?.warn("Photon message has no receiving Agent; skipped", {
        messageId: raw.id,
      });
      return;
    }
    const parts = readContent(raw.content);
    if (!(parts.text || parts.attachmentIds.length)) {
      return;
    }
    this.chat?.processMessage(
      this,
      threadId,
      () => this.toMessage(raw, threadId, parts),
      options
    );
  }

  private threadIdOf(raw: PhotonMessage): string | undefined {
    const agent = raw.status === "received" ? raw.receivedBy : raw.sentBy;
    return agent
      ? this.encodeThreadId({
          spaceId: raw.space.id,
          agentUserId: agent.id,
          spaceKind: raw.space.kind,
        })
      : undefined;
  }

  private async toMessage(
    raw: PhotonMessage,
    threadId: string,
    { text, attachmentIds }: ContentParts
  ): Promise<Message<PhotonMessage>> {
    const attachments = await Promise.all(
      attachmentIds.map((id) =>
        this.request("GET", `/attachments/${id}`, "fetchAttachment")
          .then(async (response) =>
            this.toAttachment(id, (await response.json()) as PhotonAttachment)
          )
          // A failed lookup costs the attachment its type and name, not the message.
          .catch(() => this.toAttachment(id))
      )
    );
    return this.buildMessage(raw, threadId, text, attachments);
  }

  private buildMessage(
    raw: PhotonMessage,
    threadId: string,
    text: string,
    attachments: Attachment[]
  ): Message<PhotonMessage> {
    return new Message<PhotonMessage>({
      id: raw.id,
      threadId,
      text,
      formatted: parseMarkdown(text),
      raw,
      author: {
        userId: raw.sentBy.id,
        userName: raw.sentBy.handle,
        fullName: raw.sentBy.handle,
        isBot: raw.sentBy.kind === "agent",
        isMe: raw.status !== "received",
      },
      metadata: {
        dateSent: new Date(
          raw.timestamps.receivedAt ??
            raw.timestamps.dispatchedAt ??
            raw.createdAt
        ),
        edited: false,
      },
      attachments,
    });
  }

  private toAttachment(id: string, info?: PhotonAttachment): Attachment {
    return {
      type: attachmentType(info?.contentType),
      mimeType: info?.contentType,
      name: info?.filename,
      size: info?.sizeBytes,
      fetchMetadata: { attachmentId: id },
      fetchData: () => this.download(id),
    };
  }

  private async download(attachmentId: string): Promise<Buffer> {
    const response = await this.request(
      "GET",
      `/attachments/${attachmentId}/content`,
      "fetchAttachment"
    );
    return Buffer.from(await response.arrayBuffer());
  }

  private async send(
    threadId: string,
    content: PhotonContent,
    feature: string,
    parentMessageId?: string
  ): Promise<RawMessage<PhotonMessage>> {
    const { spaceId, agentUserId } = this.decodeThreadId(threadId);
    const response = await this.request("POST", "/messages", feature, {
      json: { spaceId, senderId: agentUserId, content, parentMessageId },
      idempotent: true,
    });
    const raw = (await response.json()) as PhotonMessage;
    return { id: raw.id, threadId, raw };
  }

  /** Uploads a file as the two-part multipart/related body Photon expects. */
  private async upload(file: FileUpload): Promise<string> {
    const bytes = new Uint8Array(
      file.data instanceof Blob ? await file.data.arrayBuffer() : file.data
    );
    const contentType = (
      file.mimeType ||
      lookup(file.filename) ||
      "application/octet-stream"
    )
      .split(";")[0]
      ?.trim() as string;
    const boundary = `photon-${randomUUID()}`;
    const metadata = JSON.stringify({
      contentType,
      sizeBytes: bytes.byteLength,
      filename: file.filename,
    });
    const body = new Blob([
      `--${boundary}\r\nContent-Type: application/json\r\n\r\n${metadata}\r\n`,
      `--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`,
      bytes,
      `\r\n--${boundary}--\r\n`,
    ]);
    const response = await this.request("POST", "/attachments", "postMessage", {
      body,
      contentType: `multipart/related; boundary=${boundary}`,
      idempotent: true,
    });
    return ((await response.json()) as PhotonAttachment).id;
  }

  private async request(
    method: string,
    path: string,
    feature: string,
    init: {
      body?: Blob;
      contentType?: string;
      idempotent?: boolean;
      json?: unknown;
    } = {}
  ): Promise<Response> {
    const headers = new Headers({ authorization: `Bearer ${this.apiKey}` });
    if (init.json !== undefined) {
      headers.set("content-type", "application/json");
    }
    if (init.contentType) {
      headers.set("content-type", init.contentType);
    }
    if (init.idempotent) {
      headers.set("idempotency-key", randomUUID());
    }
    const response = await fetch(
      `${this.baseUrl}/v1/projects/${this.projectId}${path}`,
      {
        method,
        headers,
        body: init.json === undefined ? init.body : JSON.stringify(init.json),
      }
    );
    if (response.ok) {
      return response;
    }

    const problem = (await response.json().catch(() => ({}))) as {
      code?: string;
      detail?: string;
      title?: string;
    };
    const detail = problem.detail ?? problem.title ?? response.statusText;
    if (
      problem.code === "UNSUPPORTED_CONTENT" ||
      problem.code === "OPERATION_UNAVAILABLE"
    ) {
      throw new NotImplementedError(`${feature}: ${detail}`, feature);
    }
    throw new AdapterError(
      `${feature} failed with ${response.status}${problem.code ? ` ${problem.code}` : ""}: ${detail}`,
      NAME,
      problem.code
    );
  }
}

export function createPhotonAdapter(
  config: PhotonAdapterConfig = {}
): PhotonAdapter {
  return new PhotonAdapter(config);
}

function readContent(content: PhotonContent): ContentParts {
  switch (content.type) {
    case "text":
      return { text: content.text as string, attachmentIds: [] };
    case "attachment":
    case "voice": {
      const caption = (content.metadata as { caption?: { text?: string } })
        ?.caption?.text;
      return {
        text: caption ?? "",
        attachmentIds: [content.attachmentId as string],
      };
    }
    case "group": {
      const parts = (content.parts as PhotonContent[]).map(readContent);
      return {
        text: parts
          .map((part) => part.text)
          .filter(Boolean)
          .join("\n"),
        attachmentIds: parts.flatMap((part) => part.attachmentIds),
      };
    }
    default:
      return { text: "", attachmentIds: [] };
  }
}

function toTextContent(
  message: AdapterPostableMessage
): PhotonContent | undefined {
  const card = extractCard(message);
  if (card) {
    return plainText(cardToFallbackText(card));
  }
  if (typeof message === "string") {
    return plainText(message);
  }
  if ("raw" in message) {
    return plainText(message.raw);
  }
  if ("markdown" in message) {
    return markdownText(parseMarkdown(message.markdown));
  }
  if ("ast" in message) {
    return markdownText(message.ast);
  }
  return;
}

function plainText(text: string): PhotonContent | undefined {
  return text.trim() ? { type: "text", format: "plain", text } : undefined;
}

function markdownText(ast: Root): PhotonContent | undefined {
  const text = stringifyMarkdown(withoutHtml(ast)).trim();
  return text ? { type: "text", format: "markdown", text } : undefined;
}

interface AstNode {
  children?: AstNode[];
  type: string;
}

// Photon rejects raw HTML in Markdown (INVALID_CONTENT), and model output often has some.
function withoutHtml<T extends AstNode>(node: T): T {
  return node.children
    ? {
        ...node,
        children: node.children
          .filter((child) => child.type !== "html")
          .map(withoutHtml),
      }
    : node;
}

function attachmentType(mimeType?: string): Attachment["type"] {
  const kind = mimeType?.split("/")[0];
  return kind === "image" || kind === "video" || kind === "audio"
    ? kind
    : "file";
}
