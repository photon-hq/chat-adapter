import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createMemoryState } from "@chat-adapter/state-memory";
import { Server } from "socket.io";
import { afterEach, expect, it } from "vitest";
import { listenForEvents } from "./gateway";

const PROJECT = "pho_prj_00000000000000000000000001";
let io: Server | undefined;

afterEach(async () => {
  await io?.close();
});

async function serve(setup: (server: Server) => void): Promise<string> {
  const http = createServer();
  io = new Server(http, {
    path: `/v1/projects/${PROJECT}/events/ws`,
    addTrailingSlash: false,
    transports: ["websocket"],
  });
  setup(io);
  await new Promise<void>((resolve) => http.listen(0, resolve));
  return `http://localhost:${(http.address() as AddressInfo).port}`;
}

async function listen(baseUrl: string): Promise<void> {
  const state = createMemoryState();
  await state.connect();
  return listenForEvents({
    apiKey: "pho_sk_test",
    baseUrl,
    projectId: PROJECT,
    durationMs: Number.POSITIVE_INFINITY,
    onEvent: () => undefined,
    state,
  });
}

it("stops when Photon refuses the connection", async () => {
  const baseUrl = await serve((server) =>
    server.use((_socket, next) => next(new Error("unauthorized")))
  );
  await expect(listen(baseUrl)).resolves.toBeUndefined();
});

it("stops when Photon rejects the subscription for good", async () => {
  const baseUrl = await serve((server) =>
    server.on("connection", (socket) =>
      socket.on("subscribe", (_input, ack) =>
        ack({
          ok: false,
          error: {
            code: "frame_invalid",
            message: "unsupported apiVersion",
            fatal: false,
            retryable: false,
          },
        })
      )
    )
  );
  await expect(listen(baseUrl)).resolves.toBeUndefined();
});

it("stops when Photon disconnects it", async () => {
  const baseUrl = await serve((server) =>
    server.on("connection", (socket) =>
      socket.on("subscribe", (_input, ack) => {
        ack({ ok: true });
        socket.disconnect(true);
      })
    )
  );
  await expect(listen(baseUrl)).resolves.toBeUndefined();
});
