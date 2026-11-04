import { extractFiles, ValidationError } from "@chat-adapter/shared";
import type {
  Adapter,
  AdapterPostableMessage,
  Attachment,
  ChatInstance,
  EmojiValue,
  FetchOptions,
  FetchResult,
  FormattedContent,
  Logger,
  RawMessage,
  StreamChunk,
  ThreadInfo,
  WebhookOptions,
} from "chat";
import {
  defaultEmojiResolver,
  type Message,
  NotImplementedError,
  stringifyMarkdown,
} from "chat";
import { PhotonClient } from "./client";
import { NAME } from "./constants";
import { readContent, toTextContent } from "./content";
import { listenForEvents } from "./gateway";
import { buildChatMessage, toAttachment, toChatMessage } from "./message";
import type {
  PhotonAdapterConfig,
  PhotonContent,
  PhotonEvent,
  PhotonMessage,
  PhotonSpace,
  PhotonThreadId,
} from "./types";
import { decodeWebhookSecret, verifyWebhookSignature } from "./webhook";

const DEFAULT_BASE_URL = "https://api.photon.codes";
const HISTORY_EXCLUDED_CONTENT = "message.read,space.typing.update";
const TRAILING_SLASHES = /\/+$/;

export class PhotonAdapter implements Adapter<PhotonThreadId, PhotonMessage> {
  readonly name = NAME;
  readonly userName: string;

  private chat: ChatInstance | null = null;
  private readonly client: PhotonClient;
  private logger?: Logger;
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

    this.client = new PhotonClient({
      projectId,
      apiKey,
      baseUrl: (
        config.baseUrl ??
        process.env.PHOTON_API_URL ??
        DEFAULT_BASE_URL
      ).replace(TRAILING_SLASHES, ""),
    });
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
    const listener = listenForEvents({
      ...this.client.options,
      abortSignal,
      durationMs,
      logger: this.logger,
      onEvent: (event) => this.routeEvent(event, options),
      state: this.chat.getState(),
    }).catch((error: unknown) => {
      this.logger?.error("Photon websocket listener failed", {
        error: String(error),
      });
    });
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
      const attachmentId = await this.client.upload(file);
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
    await this.client
      .request("POST", `/spaces/${spaceId}/typing`, "startTyping", {
        json: { senderId: agentUserId, typing: true },
      })
      .catch((error: unknown) => {
        if (!(error instanceof NotImplementedError)) {
          throw error;
        }
      });
  }

  async markAsRead(_threadId: string, messageId: string): Promise<void> {
    await this.client.request(
      "POST",
      `/messages/${messageId}/read`,
      "markAsRead",
      { idempotent: true }
    );
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
      await this.client.request("GET", `/messages?${query}`, "fetchMessages")
    ).json()) as { items: PhotonMessage[]; nextPageToken?: string };

    const items = forward ? page.items : [...page.items].reverse();
    const messages = await Promise.all(
      items
        .map((raw) => ({ raw, parts: readContent(raw.content) }))
        .filter(({ parts }) => parts.text || parts.attachmentIds.length)
        .map(({ raw, parts }) =>
          toChatMessage(this.client, raw, threadId, parts)
        )
    );
    return { messages, nextCursor: page.nextPageToken };
  }

  async fetchThread(threadId: string): Promise<ThreadInfo> {
    const { spaceId } = this.decodeThreadId(threadId);
    const space = (await (
      await this.client.request("GET", `/spaces/${spaceId}`, "fetchThread")
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
    return buildChatMessage(
      raw,
      threadId,
      text,
      attachmentIds.map((id) => toAttachment(this.client, id))
    );
  }

  renderFormatted(content: FormattedContent): string {
    return stringifyMarkdown(content);
  }

  rehydrateAttachment(attachment: Attachment): Attachment {
    const id = attachment.fetchMetadata?.attachmentId;
    return id
      ? { ...attachment, fetchData: () => this.client.download(id) }
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
      () => toChatMessage(this.client, raw, threadId, parts),
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

  private async send(
    threadId: string,
    content: PhotonContent,
    feature: string,
    parentMessageId?: string
  ): Promise<RawMessage<PhotonMessage>> {
    const { spaceId, agentUserId } = this.decodeThreadId(threadId);
    const response = await this.client.request("POST", "/messages", feature, {
      json: { spaceId, senderId: agentUserId, content, parentMessageId },
      idempotent: true,
    });
    const raw = (await response.json()) as PhotonMessage;
    return { id: raw.id, threadId, raw };
  }
}

export function createPhotonAdapter(
  config: PhotonAdapterConfig = {}
): PhotonAdapter {
  return new PhotonAdapter(config);
}
