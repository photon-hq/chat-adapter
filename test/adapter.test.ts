import { createHmac } from "node:crypto";

import { createMemoryState } from "@chat-adapter/state-memory";
import type { ChatInstance, Message } from "chat";
import { emoji, NotImplementedError, paragraph, root, text } from "chat";
import { describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

import { createPhotonAdapter } from "../src/index";
import type { PhotonAdapterConfig, PhotonMessage } from "../src/index";

const SECRET = `whsec_${Buffer.alloc(32, 7).toString("base64")}`;
const PROJECT = "pho_prj_00000000000000000000000001";
const SPACE = "pho_spc_00000000000000000000000001";
const AGENT = "pho_usr_00000000000000000000000001";
const PEER = "pho_usr_00000000000000000000000002";
const ATTACHMENT = "pho_att_00000000000000000000000001";
const THREAD = `photon:${SPACE}:${AGENT}:direct`;
const UUID = /^[0-9a-f-]{36}$/u;
const MULTIPART_BOUNDARY = /^multipart\/related; boundary=(?<boundary>.+)$/u;

const received: PhotonMessage = {
  id: "pho_msg_00000000000000000000000001",
  projectId: PROJECT,
  platform: "imessage",
  status: "received",
  space: {
    id: SPACE,
    kind: "direct",
    platform: "imessage",
    participantIds: [AGENT, PEER],
  },
  sentBy: {
    id: PEER,
    handle: "+12025550102",
    kind: "contact",
    platform: "imessage",
  },
  receivedBy: {
    id: AGENT,
    handle: "+12025550101",
    kind: "agent",
    platform: "imessage",
  },
  content: {
    type: "group",
    parts: [
      { type: "text", format: "plain", text: "What's in this photo?" },
      { type: "attachment", attachmentId: ATTACHMENT },
    ],
  },
  createdAt: "2026-11-04T10:00:01.000Z",
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

const json = (body: unknown, status = 200) => Response.json(body, { status });

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

let fetchMock: Mock<typeof fetch>;
let processMessage: Mock<ChatInstance["processMessage"]>;
let processReaction: Mock<ChatInstance["processReaction"]>;
let processMessageUpdated: Mock<ChatInstance["processMessageUpdated"]>;
let processMessageDeleted: Mock<ChatInstance["processMessageDeleted"]>;

async function setup(config: PhotonAdapterConfig = {}) {
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
  const adapter = createPhotonAdapter({
    projectId: PROJECT,
    apiKey: "pho_sk_test",
    webhookSecret: SECRET,
    ...config,
  });
  const state = createMemoryState();
  await state.connect();
  processMessage = vi.fn<ChatInstance["processMessage"]>();
  processReaction = vi.fn<ChatInstance["processReaction"]>();
  processMessageUpdated = vi.fn<ChatInstance["processMessageUpdated"]>();
  processMessageDeleted = vi.fn<ChatInstance["processMessageDeleted"]>();
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
    getState: () => state,
    processMessage,
    processReaction,
    processMessageUpdated,
    processMessageDeleted,
  } as unknown as ChatInstance);
  return adapter;
}

/** Delivers a webhook, answering the adapter's API calls with `responses`, and waits for its routing to finish. */
async function receive(request: Request, ...responses: Response[]) {
  const adapter = await setup();
  for (const response of responses) {
    fetchMock.mockResolvedValueOnce(response);
  }
  const tasks: Promise<unknown>[] = [];
  await adapter.handleWebhook(request, {
    waitUntil: (task) => tasks.push(task),
  });
  await Promise.all(tasks);
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
    expect(processMessage).toHaveBeenCalledExactlyOnceWith(
      adapter,
      THREAD,
      expect.any(Function),
      undefined
    );
    expect(adapter.isDM(THREAD)).toBeTruthy();

    const factory = processMessage.mock.calls[0]?.[2] as () => Promise<Message>;
    await expect(factory()).resolves.toMatchObject({
      text: "What's in this photo?",
      author: {
        userId: PEER,
        userName: "+12025550102",
        isMe: false,
        isBot: false,
      },
      metadata: { dateSent: new Date("2026-11-04T10:00:00.000Z") },
      attachments: [
        {
          type: "image",
          mimeType: "image/jpeg",
          name: "IMG_1.jpeg",
          size: 2048,
        },
      ],
    });
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

    const factory = processMessage.mock.calls[0]?.[2] as () => Promise<Message>;
    await expect(factory()).resolves.toMatchObject({
      text: "What's in this photo?",
      attachments: [
        { type: "file", fetchMetadata: { attachmentId: ATTACHMENT } },
      ],
    });
  });

  it("rejects a bad signature", async () => {
    const adapter = await setup();
    const request = signedRequest(event);
    request.headers.set("webhook-signature", "v1,AAAA");
    const response = await adapter.handleWebhook(request);
    expect(response.status).toBe(401);
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
    const response = await adapter.handleWebhook(
      signedRequest({ ...event, type: "space.typing.updated" })
    );
    expect(response.status).toBe(200);
    expect(processMessage).not.toHaveBeenCalled();
  });

  const ORIGINAL = "pho_msg_00000000000000000000000005";
  const inbound = (object: Partial<PhotonMessage>) =>
    signedRequest({
      ...event,
      data: {
        projectId: PROJECT,
        object: { ...received, parentMessageId: ORIGINAL, ...object },
      },
    });

  it("routes an inbound reaction to the reaction handlers", async () => {
    const adapter = await receive(
      inbound({ content: { type: "reaction", reaction: "👍" } })
    );
    expect(processReaction).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        adapter,
        added: true,
        emoji: emoji.thumbs_up,
        rawEmoji: "👍",
        messageId: ORIGINAL,
        threadId: THREAD,
        user: expect.objectContaining({ userId: PEER, isMe: false }),
      }),
      expect.anything()
    );
    expect(processMessage).not.toHaveBeenCalled();
  });

  it("routes an inbound edit as the updated original Message", async () => {
    await receive(
      inbound({
        content: {
          type: "message.update",
          content: { type: "text", format: "plain", text: "fixed" },
        },
      })
    );
    const update = processMessageUpdated.mock.calls[0]?.[0];
    expect(update?.threadId).toBe(THREAD);
    const factory = update?.message as () => Promise<Message>;
    await expect(factory()).resolves.toMatchObject({
      id: ORIGINAL,
      text: "fixed",
      metadata: { edited: true },
    });
    expect(processMessage).not.toHaveBeenCalled();
  });

  it("routes the removal of a reaction, which deletes the reaction's Message", async () => {
    const reaction = "pho_msg_00000000000000000000000006";
    await receive(
      inbound({
        parentMessageId: reaction,
        content: { type: "message.delete" },
      }),
      json({
        ...received,
        id: reaction,
        parentMessageId: ORIGINAL,
        content: { type: "reaction", reaction: "❤️" },
      })
    );
    expect(call(0).url.pathname).toBe(
      `/v1/projects/${PROJECT}/messages/${reaction}`
    );
    expect(processReaction).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        added: false,
        emoji: emoji.heart,
        messageId: ORIGINAL,
        threadId: THREAD,
      }),
      expect.anything()
    );
    expect(processMessageDeleted).not.toHaveBeenCalled();
  });

  it("routes the deletion of any other Message to the delete handlers", async () => {
    const adapter = await receive(
      inbound({ content: { type: "message.delete" } }),
      json({ ...received, id: ORIGINAL })
    );
    expect(processMessageDeleted).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        adapter,
        messageId: ORIGINAL,
        threadId: THREAD,
        channelId: `photon:${SPACE}`,
      }),
      expect.anything()
    );
    expect(processReaction).not.toHaveBeenCalled();
  });
});

describe("sending", () => {
  it("posts Markdown as the thread's Agent, without raw HTML", async () => {
    const adapter = await setup();
    fetchMock.mockResolvedValueOnce(sent({}));

    const result = await adapter.postMessage(THREAD, {
      markdown: "**Hi**<br>there",
    });

    const request = call(0);
    expect(`${request.method} ${request.url}`).toBe(
      `POST https://api.photon.codes/v1/projects/${PROJECT}/messages`
    );
    expect(request.headers.get("authorization")).toBe("Bearer pho_sk_test");
    expect(request.headers.get("idempotency-key")).toMatch(UUID);
    expect(JSON.parse(request.body as string)).toStrictEqual({
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
    expect(JSON.parse(call(0).body as string).content).toStrictEqual({
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
      ?.match(MULTIPART_BOUNDARY)?.groups?.boundary;
    expect(boundary).toBeTruthy();
    expect(upload.headers.get("idempotency-key")).toBeTruthy();
    const body = Buffer.from(await (upload.body as Blob).arrayBuffer());
    expect(body).toStrictEqual(
      Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Type: application/json\r\n\r\n{"contentType":"image/png","sizeBytes":3,"filename":"dot.png"}\r\n--${boundary}\r\nContent-Type: image/png\r\n\r\n`
        ),
        Buffer.from([1, 2, 3]),
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ])
    );
    expect(JSON.parse(call(1).body as string).content).toStrictEqual({
      type: "attachment",
      attachmentId: ATTACHMENT,
    });
  });

  it("edits, deletes, and reacts by sending against the parent Message", async () => {
    const adapter = await setup();
    fetchMock
      .mockResolvedValueOnce(sent({}))
      .mockResolvedValueOnce(sent({}))
      .mockResolvedValueOnce(sent({}));
    const parent = "pho_msg_00000000000000000000000002";

    await adapter.editMessage(THREAD, parent, "fixed");
    await adapter.deleteMessage(THREAD, parent);
    await adapter.addReaction(THREAD, parent, "thumbs_up");

    const bodies = [0, 1, 2].map((i) => JSON.parse(call(i).body as string));
    expect(bodies.map((body) => body.parentMessageId)).toStrictEqual([
      parent,
      parent,
      parent,
    ]);
    expect(bodies.map((body) => body.content)).toStrictEqual([
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

  it("removes a reaction it added by deleting that reaction's Message", async () => {
    const adapter = await setup();
    const parent = "pho_msg_00000000000000000000000002";
    const reaction = "pho_msg_00000000000000000000000008";
    fetchMock
      .mockResolvedValueOnce(json({ ...received, id: reaction }, 202))
      .mockResolvedValueOnce(sent({}));

    await adapter.addReaction(THREAD, parent, emoji.thumbs_up);
    await adapter.removeReaction(THREAD, parent, emoji.thumbs_up);
    await adapter.removeReaction(THREAD, parent, emoji.thumbs_up);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(call(1).body as string)).toStrictEqual({
      spaceId: SPACE,
      senderId: AGENT,
      content: { type: "message.delete" },
      parentMessageId: reaction,
    });
  });

  it("leaves alone a reaction it didn't add", async () => {
    const adapter = await setup();
    await adapter.removeReaction(
      THREAD,
      "pho_msg_00000000000000000000000002",
      emoji.thumbs_up
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("opens a DM from the configured Agent", async () => {
    const adapter = await setup({ agentUserId: AGENT });
    fetchMock
      .mockResolvedValueOnce(json({ ...received.sentBy }))
      .mockResolvedValueOnce(json({ ...received.space }));

    await expect(adapter.openDM(PEER)).resolves.toBe(THREAD);
    expect(call(0).url.pathname).toBe(`/v1/projects/${PROJECT}/users/${PEER}`);
    expect(JSON.parse(call(1).body as string)).toStrictEqual({
      participantIds: [AGENT, PEER],
      platform: "imessage",
    });
    expect(call(1).headers.get("idempotency-key")).toMatch(UUID);
  });

  it("needs an Agent to open a DM from", async () => {
    const adapter = await setup();
    await expect(adapter.openDM(PEER)).rejects.toThrow(
      "openDM needs agentUserId"
    );
  });

  it("starts typing as the thread's Agent", async () => {
    const adapter = await setup();
    fetchMock.mockResolvedValueOnce(json({}, 202));
    await adapter.startTyping(THREAD);
    expect(call(0).url.pathname).toBe(
      `/v1/projects/${PROJECT}/spaces/${SPACE}/typing`
    );
    expect(JSON.parse(call(0).body as string)).toStrictEqual({
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
    expect(Object.fromEntries(query)).toStrictEqual({
      spaceId: SPACE,
      perspectiveUserId: AGENT,
      pageSize: "2",
      order: "desc",
      excludeContentTypes: "message.read,space.typing.update",
    });
    expect(page.nextCursor).toBe("abc.def");
    expect(
      page.messages.map((message) => [message.id, message.author.isMe])
    ).toStrictEqual([
      [received.id, false],
      [reply.id, true],
    ]);
  });
});

describe("parseMessage", () => {
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
    expect(plain.formatted).toStrictEqual(
      root([paragraph([text("2*3*4 = 24")])])
    );
  });
});

describe("thread IDs", () => {
  it("round-trips and rejects foreign IDs", async () => {
    const adapter = await setup();
    expect(adapter.encodeThreadId(adapter.decodeThreadId(THREAD))).toBe(THREAD);
    expect(adapter.channelIdFromThreadId(THREAD)).toBe(`photon:${SPACE}`);
    expect(() => adapter.decodeThreadId("slack:C1:123")).toThrow(
      "Invalid Photon thread ID: slack:C1:123"
    );
  });

  it("answers mentions of the Chat instance's name", async () => {
    const adapter = await setup();
    expect(adapter.userName).toBe("mybot");
  });
});
