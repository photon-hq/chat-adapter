import { once } from "node:events";
import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

import { createMemoryState } from "@chat-adapter/state-memory";
import { Server } from "socket.io";
import { describe, expect, it } from "vitest";

import { API_VERSION } from "../src/constants";
import { listenForEvents } from "../src/gateway";
import { createPhotonAdapter } from "../src/index";

const PROJECT = "pho_prj_00000000000000000000000001";
const PROJECT_PATH = `/v1/projects/${PROJECT}`;

describe(createPhotonAdapter, () => {
  it("pins HTTP requests and websocket subscriptions to the same date", async () => {
    const requests: IncomingMessage[] = [];
    const server = createServer((request, response) => {
      requests.push(request);
      response
        .writeHead(200, { "content-type": "application/json" })
        .end('{"items":[]}');
    });

    const io = new Server(server, {
      path: `${PROJECT_PATH}/events/ws`,
      addTrailingSlash: false,
      transports: ["websocket"],
    });
    const controller = new AbortController();
    const subscriptions: { versions: string[]; input: unknown }[] = [];
    io.on("connection", (socket) => {
      socket.on("subscribe", (input, ack) => {
        subscriptions.push({
          versions: socket.request.headersDistinct["photon-version"] ?? [],
          input,
        });
        ack({ ok: true });
        controller.abort();
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    try {
      const config = {
        apiKey: "pho_sk_test",
        baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        projectId: PROJECT,
      };
      const adapter = createPhotonAdapter(config);
      const thread = adapter.encodeThreadId({
        spaceId: "space",
        agentUserId: "agent",
        spaceKind: "direct",
      });
      await adapter.fetchMessages(thread);
      await adapter.markAsRead(thread, "message");

      const state = createMemoryState();
      await state.connect();
      await listenForEvents({
        ...config,
        abortSignal: controller.signal,
        durationMs: 2000,
        onEvent: () => {},
        state,
      });
    } finally {
      controller.abort();
      await io.close();
    }

    expect(
      requests.map(({ method, url, headersDistinct }) => [
        method,
        url?.split("?")[0],
        headersDistinct["photon-version"],
      ])
    ).toStrictEqual([
      ["GET", `${PROJECT_PATH}/messages`, [API_VERSION]],
      ["POST", `${PROJECT_PATH}/messages/message/read`, [API_VERSION]],
    ]);
    expect(subscriptions).toStrictEqual([
      { versions: [], input: { startSeq: 0, apiVersion: API_VERSION } },
    ]);
  });
});
