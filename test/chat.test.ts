import { createHmac } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { createMemoryState } from "@chat-adapter/state-memory";
import { Chat } from "chat";
import { Server } from "socket.io";
import { describe, expect, it, vi } from "vitest";

import { createPhotonAdapter } from "../src/index";

const PROJECT = "pho_prj_00000000000000000000000001";
const SPACE = "pho_spc_00000000000000000000000001";
const AGENT = "pho_usr_00000000000000000000000001";
const PEER = "pho_usr_00000000000000000000000002";
const KEY = Buffer.alloc(32, 9);

function messageEvent(n: number, text: string) {
  return {
    id: `pho_evt_0000000000000000000000000${n}`,
    type: "message.received",
    apiVersion: "2026-07-01",
    source: "sms.photon",
    timestamp: "2026-11-04T10:00:01.000Z",
    data: {
      projectId: PROJECT,
      object: {
        id: `pho_msg_0000000000000000000000000${n}`,
        projectId: PROJECT,
        platform: "sms",
        status: "received",
        space: {
          id: SPACE,
          kind: "direct",
          platform: "sms",
          participantIds: [AGENT, PEER],
        },
        sentBy: {
          id: PEER,
          handle: "+12025550102",
          kind: "contact",
          platform: "sms",
        },
        receivedBy: {
          id: AGENT,
          handle: "+12025550101",
          kind: "agent",
          platform: "sms",
        },
        content: { type: "text", format: "plain", text },
        createdAt: "2026-11-04T10:00:01.000Z",
        timestamps: { receivedAt: "2026-11-04T10:00:00.000Z" },
      },
    },
  };
}

function pingPongBot(baseUrl?: string) {
  const fetchMock = vi.fn<
    (url: string, init: RequestInit) => Promise<Response>
  >(() =>
    Promise.resolve(
      Response.json(
        { id: "pho_msg_00000000000000000000000009" },
        { status: 202 }
      )
    )
  );
  vi.stubGlobal("fetch", fetchMock);

  const state = createMemoryState();
  const chat = new Chat({
    userName: "photon",
    adapters: {
      photon: createPhotonAdapter({
        projectId: PROJECT,
        apiKey: "pho_sk_test",
        webhookSecret: `whsec_${KEY.toString("base64")}`,
        baseUrl,
      }),
    },
    state,
    logger: "silent",
  });
  const seen: string[] = [];
  chat.onDirectMessage(async (thread, message) => {
    seen.push(message.text);
    await thread.post("pong");
  });
  const replies = () =>
    fetchMock.mock.calls
      .filter(([url]) => url.endsWith("/messages"))
      .map(([, init]) => JSON.parse(init.body as string));
  return { chat, state, seen, replies };
}

const PONG = {
  spaceId: SPACE,
  senderId: AGENT,
  content: { type: "text", format: "plain", text: "pong" },
};

describe("Photon in a Chat instance", () => {
  it("answers a direct message through a real Chat instance", async () => {
    const { chat, seen, replies } = pingPongBot();
    const event = messageEvent(1, "ping");
    const body = JSON.stringify(event);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac("sha256", KEY)
      .update(`${event.id}.${timestamp}.${body}`)
      .digest("base64");
    const tasks: Promise<unknown>[] = [];

    const response = await chat.webhooks.photon(
      new Request("https://bot.example/api/webhooks/photon", {
        method: "POST",
        body,
        headers: {
          "webhook-id": event.id,
          "webhook-timestamp": timestamp,
          "webhook-signature": `v1,${signature}`,
        },
      }),
      { waitUntil: (task) => tasks.push(task) }
    );
    await Promise.all(tasks);

    expect(response.status).toBe(200);
    expect(seen).toStrictEqual(["ping"]);
    expect(replies()).toStrictEqual([PONG]);
  });

  it("answers over the websocket and resumes after the last event", async () => {
    const http = createServer();
    const io = new Server(http, {
      path: `/v1/projects/${PROJECT}/events/ws`,
      addTrailingSlash: false,
      transports: ["websocket"],
    });
    const subscriptions: unknown[] = [];
    // The second connection repeats seq 7, which must not be answered twice.
    const deliveries = [
      [[7, messageEvent(1, "ping")]],
      [
        [7, messageEvent(1, "ping")],
        [8, messageEvent(2, "ping again")],
      ],
    ] as const;
    io.use((socket, next) =>
      socket.handshake.headers.authorization === "Bearer pho_sk_test"
        ? next()
        : next(new Error("unauthorized"))
    );
    io.on("connection", (socket) => {
      socket.on("subscribe", (input, ack) => {
        const connection = subscriptions.push(input) - 1;
        ack({ ok: true });
        for (const [seq, event] of deliveries[connection] ?? []) {
          socket.emit("delivery", event, { seq, replyExpected: false });
        }
      });
    });
    http.listen(0);
    await once(http, "listening");
    const { port } = http.address() as AddressInfo;

    const { chat, state, seen, replies } = pingPongBot(
      `http://localhost:${port}`
    );
    await chat.initialize();
    const adapter = chat.getAdapter("photon");
    const listen = async () => {
      const tasks: Promise<unknown>[] = [];
      const controller = new AbortController();
      const response = await adapter.startGatewayListener(
        { waitUntil: (task) => tasks.push(task) },
        Number.POSITIVE_INFINITY,
        controller.signal
      );
      expect(response.status).toBe(200);
      return async () => {
        controller.abort();
        await Promise.all(tasks);
      };
    };

    try {
      const stopFirst = await listen();
      await vi.waitFor(() => expect(seen).toStrictEqual(["ping"]));
      await stopFirst();
      await expect(state.get(`photon:cursor:${PROJECT}`)).resolves.toBe(7);

      const stopSecond = await listen();
      await vi.waitFor(() =>
        expect(seen).toStrictEqual(["ping", "ping again"])
      );
      await stopSecond();
    } finally {
      await io.close();
    }

    expect(subscriptions).toStrictEqual([
      { startSeq: 0, apiVersion: "2026-07-01" },
      { startSeq: 7, apiVersion: "2026-07-01" },
    ]);
    await expect(state.get(`photon:cursor:${PROJECT}`)).resolves.toBe(8);
    expect(replies()).toStrictEqual([PONG, PONG]);
  });
});
