import { createHmac } from "node:crypto";
import { createMemoryState } from "@chat-adapter/state-memory";
import { Chat } from "chat";
import { afterEach, expect, it, vi } from "vitest";
import { createPhotonAdapter } from "./index";

const PROJECT = "pho_prj_00000000000000000000000001";
const SPACE = "pho_spc_00000000000000000000000001";
const AGENT = "pho_usr_00000000000000000000000001";
const PEER = "pho_usr_00000000000000000000000002";
const KEY = Buffer.alloc(32, 9);

afterEach(() => vi.unstubAllGlobals());

it("answers a direct message through a real Chat instance", async () => {
  const fetchMock = vi.fn(
    async (_url: string, _init: RequestInit) =>
      new Response(
        JSON.stringify({ id: "pho_msg_00000000000000000000000009" }),
        { status: 202 }
      )
  );
  vi.stubGlobal("fetch", fetchMock);

  const chat = new Chat({
    userName: "photon",
    adapters: {
      photon: createPhotonAdapter({
        projectId: PROJECT,
        apiKey: "pho_sk_test",
        webhookSecret: `whsec_${KEY.toString("base64")}`,
      }),
    },
    state: createMemoryState(),
    logger: "silent",
  });
  const seen: string[] = [];
  chat.onDirectMessage(async (thread, message) => {
    seen.push(message.text);
    await thread.post("pong");
  });

  const id = "pho_evt_00000000000000000000000001";
  const body = JSON.stringify({
    id,
    type: "message.received",
    apiVersion: "2026-07-01",
    source: "sms.photon",
    timestamp: "2026-11-04T10:00:01.000Z",
    data: {
      projectId: PROJECT,
      object: {
        id: "pho_msg_00000000000000000000000001",
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
        content: { type: "text", format: "plain", text: "ping" },
        createdAt: "2026-11-04T10:00:01.000Z",
        timestamps: { receivedAt: "2026-11-04T10:00:00.000Z" },
      },
    },
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", KEY)
    .update(`${id}.${timestamp}.${body}`)
    .digest("base64");
  const tasks: Promise<unknown>[] = [];

  const response = await chat.webhooks.photon(
    new Request("https://bot.example/api/webhooks/photon", {
      method: "POST",
      body,
      headers: {
        "webhook-id": id,
        "webhook-timestamp": timestamp,
        "webhook-signature": `v1,${signature}`,
      },
    }),
    { waitUntil: (task) => tasks.push(task) }
  );
  await Promise.all(tasks);

  expect(response.status).toBe(200);
  expect(seen).toEqual(["ping"]);
  const sends = fetchMock.mock.calls.filter(([url]) =>
    url.endsWith("/messages")
  );
  expect(sends.map(([, init]) => JSON.parse(init.body as string))).toEqual([
    {
      spaceId: SPACE,
      senderId: AGENT,
      content: { type: "text", format: "plain", text: "pong" },
    },
  ]);
});
