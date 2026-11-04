import { createHmac } from "node:crypto";
import type { ChatInstance, Message } from "chat";
import { NotImplementedError, paragraph, root, text } from "chat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPhotonAdapter, type PhotonMessage } from "../src/index";

const SECRET = `whsec_${Buffer.alloc(32, 7).toString("base64")}`;
const PROJECT = "pho_prj_00000000000000000000000001";
const SPACE = "pho_spc_00000000000000000000000001";
const AGENT = "pho_usr_00000000000000000000000001";
const PEER = "pho_usr_00000000000000000000000002";
const ATTACHMENT = "pho_att_00000000000000000000000001";
const THREAD = `photon:${SPACE}:${AGENT}:direct`;
const UUID = /^[0-9a-f-]{36}$/;
const MULTIPART_BOUNDARY = /^multipart\/related; boundary=(.+)$/;

const received: PhotonMessage = {
  id: "pho_msg_00000000000000000000000001",
  projectId: PROJECT,
  platform: "imessage",
  status: "received",
  space: {
    id: SPACE,
    projectId: PROJECT,
    kind: "direct",
    platform: "imessage",
    participantIds: [AGENT, PEER],
    details: {},
    metadata: {},
  },
  sentBy: {
    id: PEER,
    projectId: PROJECT,
    handle: "+12025550102",
    kind: "contact",
    platform: "imessage",
    details: {},
    metadata: {},
  },
  receivedBy: {
    id: AGENT,
    projectId: PROJECT,
    handle: "+12025550101",
    kind: "agent",
    platform: "imessage",
    details: {},
    metadata: {},
  },
  content: {
    type: "group",
    parts: [
      { type: "text", format: "plain", text: "What's in this photo?" },
      { type: "attachment", attachmentId: ATTACHMENT },
    ],
  },
  createdAt: "2026-11-04T10:00:01.000Z",
  updatedAt: "2026-11-04T10:00:01.000Z",
  metadata: {},
  timestamps: { receivedAt: "2026-11-04T10:00:00.000Z" },
};

function signedRequest(
  event: unknown,
  id = "pho_evt_00000000000000000000000001"
) {
  const body = JSON.stringify(event);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", Buffer.alloc(32, 7))
    .update(`${id}.${timestamp}.${body}`)
    .digest("base64");
  return new Request("https://bot.example/api/webhooks/photon", {
    method: "POST",
    body,
    headers: {
      "webhook-id": id,
      "webhook-timestamp": timestamp,
      "webhook-signature": `v1,${signature}`,
    },
  });
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

let fetchMock: ReturnType<typeof vi.fn>;
let processMessage: ReturnType<typeof vi.fn>;

async function setup() {
  const adapter = createPhotonAdapter({
    projectId: PROJECT,
    apiKey: "pho_sk_test",
    webhookSecret: SECRET,
  });
  processMessage = vi.fn();
  await adapter.initialize({
    getLogger: () => ({
      debug() {},
      info() {},
      warn() {},
      error() {},
      child() {
        return this;
      },
    }),
    getUserName: () => "mybot",
    processMessage,
  } as unknown as ChatInstance);
  return adapter;
}

function call(index: number) {
  const [url, init] = fetchMock.mock.calls[index] as [string, RequestInit];
  return {
    url: new URL(url),
    method: init.method,
    headers: new Headers(init.headers),
    body: init.body,
  };
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("handleWebhook", () => {
  const event = {
    id: "pho_evt_00000000000000000000000001",
    type: "message.received",
    apiVersion: "2026-07-01",
    source: "imessage.photon",
    timestamp: "2026-11-04T10:00:01.000Z",
    data: { projectId: PROJECT, object: received },
  };

  it("routes message.received to the Space thread of the receiving Agent", async () => {
    const adapter = await setup();
    fetchMock.mockResolvedValueOnce(
      json({
        id: ATTACHMENT,
        contentType: "image/jpeg",
        filename: "IMG_1.jpeg",
        sizeBytes: 2048,
      })
    );

    const response = await adapter.handleWebhook(signedRequest(event));

    expect(response.status).toBe(200);
    expect(processMessage).toHaveBeenCalledOnce();
    const [, threadId, factory] = processMessage.mock.calls[0] as [
      unknown,
      string,
      () => Promise<Message>,
    ];
    expect(threadId).toBe(THREAD);
    expect(adapter.isDM(threadId)).toBe(true);

    const message = await factory();
    expect(message.text).toBe("What's in this photo?");
    expect(message.author).toMatchObject({
      userId: PEER,
      userName: "+12025550102",
      isMe: false,
      isBot: false,
    });
    expect(message.metadata.dateSent.toISOString()).toBe(
      "2026-11-04T10:00:00.000Z"
    );
    expect(message.attachments).toMatchObject([
      { type: "image", mimeType: "image/jpeg", name: "IMG_1.jpeg", size: 2048 },
    ]);
    expect(call(0).url.pathname).toBe(
      `/v1/projects/${PROJECT}/attachments/${ATTACHMENT}`
    );
  });

  it("keeps the message when an attachment lookup fails", async () => {
    const adapter = await setup();
    fetchMock.mockResolvedValueOnce(
      json({ code: "UPSTREAM_UNAVAILABLE" }, 503)
    );

    await adapter.handleWebhook(signedRequest(event));

    const [, , factory] = processMessage.mock.calls[0] as [
      unknown,
      string,
      () => Promise<Message>,
    ];
    const message = await factory();
    expect(message.text).toBe("What's in this photo?");
    expect(message.attachments).toMatchObject([
      { type: "file", fetchMetadata: { attachmentId: ATTACHMENT } },
    ]);
  });

  it("rejects a bad signature", async () => {
    const adapter = await setup();
    const request = signedRequest(event);
    request.headers.set("webhook-signature", "v1,AAAA");
    expect((await adapter.handleWebhook(request)).status).toBe(401);
    expect(processMessage).not.toHaveBeenCalled();
  });

  it("rejects an event whose ID differs from the signed webhook ID", async () => {
    const adapter = await setup();
    const response = await adapter.handleWebhook(
      signedRequest(event, "pho_evt_00000000000000000000000009")
    );
    expect(response.status).toBe(401);
  });

  it("acknowledges other events without routing them", async () => {
    const adapter = await setup();
    const typing = { ...event, type: "space.typing.updated" };
    expect((await adapter.handleWebhook(signedRequest(typing))).status).toBe(
      200
    );
    expect(processMessage).not.toHaveBeenCalled();
  });
});

describe("sending", () => {
  const sent = (content: unknown) =>
    json(
      {
        ...received,
        id: "pho_msg_00000000000000000000000002",
        status: "dispatched",
        sentBy: received.receivedBy,
        content,
      },
      202
    );

  it("posts Markdown as the thread's Agent, without raw HTML", async () => {
    const adapter = await setup();
    fetchMock.mockResolvedValueOnce(sent({}));

    const result = await adapter.postMessage(THREAD, {
      markdown: "**Hi**<br>there",
    });

    const request = call(0);
    expect(request.method).toBe("POST");
    expect(request.url.toString()).toBe(
      `https://api.photon.codes/v1/projects/${PROJECT}/messages`
    );
    expect(request.headers.get("authorization")).toBe("Bearer pho_sk_test");
    expect(request.headers.get("idempotency-key")).toMatch(UUID);
    expect(JSON.parse(request.body as string)).toEqual({
      spaceId: SPACE,
      senderId: AGENT,
      content: { type: "text", format: "markdown", text: "**Hi**there" },
    });
    expect(result).toMatchObject({
      id: "pho_msg_00000000000000000000000002",
      threadId: THREAD,
    });
  });

  it("sends plain strings as plain text", async () => {
    const adapter = await setup();
    fetchMock.mockResolvedValueOnce(sent({}));
    await adapter.postMessage(THREAD, "2 * 3 = 6");
    expect(JSON.parse(call(0).body as string).content).toEqual({
      type: "text",
      format: "plain",
      text: "2 * 3 = 6",
    });
  });

  it("uploads files as multipart/related, then sends them", async () => {
    const adapter = await setup();
    fetchMock
      .mockResolvedValueOnce(
        json({ id: ATTACHMENT, contentType: "image/png", sizeBytes: 3 }, 201)
      )
      .mockResolvedValueOnce(sent({}));

    await adapter.postMessage(THREAD, {
      raw: "",
      files: [{ filename: "dot.png", data: Buffer.from([1, 2, 3]) }],
    });

    const upload = call(0);
    expect(upload.url.pathname).toBe(`/v1/projects/${PROJECT}/attachments`);
    const boundary = upload.headers
      .get("content-type")
      ?.match(MULTIPART_BOUNDARY)?.[1];
    expect(boundary).toBeTruthy();
    expect(upload.headers.get("idempotency-key")).toBeTruthy();
    const body = Buffer.from(await (upload.body as Blob).arrayBuffer());
    expect(body).toEqual(
      Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Type: application/json\r\n\r\n{"contentType":"image/png","sizeBytes":3,"filename":"dot.png"}\r\n--${boundary}\r\nContent-Type: image/png\r\n\r\n`
        ),
        Buffer.from([1, 2, 3]),
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ])
    );
    expect(JSON.parse(call(1).body as string).content).toEqual({
      type: "attachment",
      attachmentId: ATTACHMENT,
    });
  });

  it("edits, deletes, and reacts by sending against the parent Message", async () => {
    const adapter = await setup();
    fetchMock.mockImplementation(async () => sent({}));
    const parent = "pho_msg_00000000000000000000000002";

    await adapter.editMessage(THREAD, parent, "fixed");
    await adapter.deleteMessage(THREAD, parent);
    await adapter.addReaction(THREAD, parent, "thumbs_up");

    const bodies = [0, 1, 2].map((i) => JSON.parse(call(i).body as string));
    expect(bodies.map((body) => body.parentMessageId)).toEqual([
      parent,
      parent,
      parent,
    ]);
    expect(bodies.map((body) => body.content)).toEqual([
      {
        type: "message.update",
        content: { type: "text", format: "plain", text: "fixed" },
      },
      { type: "message.delete" },
      { type: "reaction", reaction: "👍" },
    ]);
  });

  it("collects a stream into one message", async () => {
    const adapter = await setup();
    fetchMock.mockResolvedValueOnce(sent({}));
    async function* chunks() {
      yield "Hello";
      yield { type: "markdown_text" as const, text: ", **world**" };
      yield {
        type: "task_update" as const,
        id: "1",
        title: "search",
        status: "complete" as const,
      };
    }

    await adapter.stream(THREAD, chunks());

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.parse(call(0).body as string).content.text).toBe(
      "Hello, **world**"
    );
  });

  it("raises NotImplementedError when the platform lacks the content type", async () => {
    const adapter = await setup();
    fetchMock.mockResolvedValueOnce(
      json(
        {
          code: "UNSUPPORTED_CONTENT",
          status: 422,
          title: "Unsupported Content",
          detail: "imessage does not support message.update",
        },
        422
      )
    );
    await expect(
      adapter.editMessage(THREAD, "pho_msg_00000000000000000000000002", "x")
    ).rejects.toBeInstanceOf(NotImplementedError);
  });

  it("starts typing as the thread's Agent", async () => {
    const adapter = await setup();
    fetchMock.mockResolvedValueOnce(json({}, 202));
    await adapter.startTyping(THREAD);
    expect(call(0).url.pathname).toBe(
      `/v1/projects/${PROJECT}/spaces/${SPACE}/typing`
    );
    expect(JSON.parse(call(0).body as string)).toEqual({
      senderId: AGENT,
      typing: true,
    });
  });
});

describe("startTyping", () => {
  it("is a no-op where the platform has no typing", async () => {
    const adapter = await setup();
    fetchMock.mockResolvedValueOnce(
      json(
        {
          code: "OPERATION_UNAVAILABLE",
          status: 422,
          detail: "sms has no typing",
        },
        422
      )
    );
    await expect(adapter.startTyping(THREAD)).resolves.toBeUndefined();
  });

  it("still throws other failures", async () => {
    const adapter = await setup();
    fetchMock.mockResolvedValueOnce(json({ code: "FORBIDDEN" }, 403));
    await expect(adapter.startTyping(THREAD)).rejects.toThrow(
      "startTyping failed with 403 FORBIDDEN"
    );
  });
});

describe("fetchMessages", () => {
  it("keeps the cursor when an Agent's history page has only ignored content", async () => {
    const adapter = await setup();
    fetchMock.mockImplementation((url: string) =>
      new URL(url).searchParams.has("excludeContentTypes")
        ? json(
            {
              code: "INVALID_REQUEST",
              status: 400,
              title: "Invalid Request",
              type: "https://photon.codes/docs/problems/invalid-request",
              detail: "excludeContentTypes requires resourceId",
            },
            400
          )
        : json({
            items: [{ ...received, content: { type: "message.read" } }],
            nextPageToken: "next.page",
          })
    );

    const page = await adapter.fetchMessages(THREAD, {
      cursor: "previous.page",
      direction: "forward",
    });

    expect(Object.fromEntries(call(0).url.searchParams)).toEqual({
      spaceId: SPACE,
      perspectiveUserId: AGENT,
      pageSize: "50",
      order: "asc",
      pageToken: "previous.page",
    });
    expect(page).toEqual({ messages: [], nextCursor: "next.page" });
  });

  it("reads the Agent's view of the Space, oldest first", async () => {
    const adapter = await setup();
    const reply: PhotonMessage = {
      ...received,
      id: "pho_msg_00000000000000000000000003",
      status: "delivered",
      sentBy: received.receivedBy as PhotonMessage["sentBy"],
      receivedBy: undefined,
      content: { type: "text", format: "markdown", text: "A **cat**." },
      timestamps: { dispatchedAt: "2026-11-04T10:00:05.000Z" },
    };
    const reaction = {
      ...reply,
      id: "pho_msg_00000000000000000000000004",
      content: { type: "reaction", reaction: "👍" },
    };
    fetchMock
      .mockResolvedValueOnce(
        json({ items: [reaction, reply, received], nextPageToken: "abc.def" })
      )
      .mockResolvedValueOnce(
        json({ id: ATTACHMENT, contentType: "image/jpeg", sizeBytes: 1 })
      );

    const page = await adapter.fetchMessages(THREAD, { limit: 2 });

    const query = call(0).url.searchParams;
    expect(Object.fromEntries(query)).toEqual({
      spaceId: SPACE,
      perspectiveUserId: AGENT,
      pageSize: "2",
      order: "desc",
    });
    expect(page.nextCursor).toBe("abc.def");
    expect(
      page.messages.map((message) => [message.id, message.author.isMe])
    ).toEqual([
      [received.id, false],
      [reply.id, true],
    ]);
  });
});

describe("parseMessage", () => {
  it("uses the user ID when a fallback snapshot has no handle", async () => {
    const adapter = await setup();
    const message = adapter.parseMessage({
      ...received,
      sentBy: {
        id: PEER,
        projectId: PROJECT,
        platform: "future-platform",
        kind: "human",
        details: {},
        metadata: {},
      },
    });

    expect(message.author).toMatchObject({
      userId: PEER,
      userName: PEER,
      fullName: PEER,
      isBot: false,
      isMe: false,
    });
  });

  it("strips Markdown from text, and keeps plain text as sent", async () => {
    const adapter = await setup();
    const markdown = adapter.parseMessage({
      ...received,
      content: { type: "text", format: "markdown", text: "Hello **world**" },
    });
    const plain = adapter.parseMessage({
      ...received,
      content: { type: "text", format: "plain", text: "2*3*4 = 24" },
    });

    expect(markdown.text).toBe("Hello world");
    expect(plain.text).toBe("2*3*4 = 24");
    expect(plain.formatted).toEqual(root([paragraph([text("2*3*4 = 24")])]));
  });
});

describe("thread IDs", () => {
  it("round-trips and rejects foreign IDs", async () => {
    const adapter = await setup();
    expect(adapter.encodeThreadId(adapter.decodeThreadId(THREAD))).toBe(THREAD);
    expect(adapter.channelIdFromThreadId(THREAD)).toBe(`photon:${SPACE}`);
    expect(() => adapter.decodeThreadId("slack:C1:123")).toThrow();
  });

  it("answers mentions of the Chat instance's name", async () => {
    expect((await setup()).userName).toBe("mybot");
  });
});
