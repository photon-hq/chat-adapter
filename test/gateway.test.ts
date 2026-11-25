import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { createMemoryState } from "@chat-adapter/state-memory";
import { Server } from "socket.io";
import { afterEach, describe, expect, it } from "vitest";

import { listenForEvents } from "../src/gateway";

const PROJECT = "pho_prj_00000000000000000000000001";
let io: Server | undefined;

async function serve(setup: (server: Server) => void): Promise<string> {
  const http = createServer();
  io = new Server(http, {
    path: `/v1/projects/${PROJECT}/events/ws`,
    addTrailingSlash: false,
    transports: ["websocket"],
  });
  setup(io);
  http.listen(0);
  await once(http, "listening");
  return `http://localhost:${(http.address() as AddressInfo).port}`;
}

async function listen(
  baseUrl: string,
  state = createMemoryState(),
  abortSignal?: AbortSignal
): Promise<void> {
  await state.connect();
  return listenForEvents({
    apiKey: "pho_sk_test",
    baseUrl,
    projectId: PROJECT,
    abortSignal,
    durationMs: Number.POSITIVE_INFINITY,
    onEvent: () => {},
    state,
  });
}

function deferred() {
  let resolveDeferred!: () => void;
  // oxlint-disable-next-line promise/avoid-new -- controlled test synchronization
  const promise = new Promise<void>((resolve) => {
    resolveDeferred = resolve;
  });
  return { promise, resolve: resolveDeferred };
}

describe(listenForEvents, () => {
  afterEach(async () => {
    await io?.close();
  });

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

  it("persists a nonzero subscribe cursor before a retry or restart", async () => {
    const state = createMemoryState();
    const subscriptions: unknown[] = [];
    let connection = 0;
    const baseUrl = await serve((server) => {
      server.on("connection", (socket) => {
        socket.on("subscribe", (input, ack) => {
          subscriptions.push(input);
          ack({ ok: true, startSeq: connection === 0 ? 17 : 0 });
          const firstConnection = connection === 0;
          connection += 1;
          if (firstConnection) {
            setTimeout(() => socket.conn.close(), 0);
          } else {
            setTimeout(() => socket.disconnect(true), 0);
          }
        });
      });
    });

    await listen(baseUrl, state);
    await expect(state.get(`photon:cursor:${PROJECT}`)).resolves.toBe(17);
    expect(subscriptions).toStrictEqual([
      { startSeq: 0, apiVersion: "2026-07-01" },
      { startSeq: 17, apiVersion: "2026-07-01" },
    ]);

    await listen(baseUrl, state);
    await expect(state.get(`photon:cursor:${PROJECT}`)).resolves.toBe(17);
    expect(subscriptions).toStrictEqual([
      { startSeq: 0, apiVersion: "2026-07-01" },
      { startSeq: 17, apiVersion: "2026-07-01" },
      { startSeq: 17, apiVersion: "2026-07-01" },
    ]);
  });

  it("waits to resubscribe until the initial cursor is persisted", async () => {
    const state = createMemoryState();
    await state.connect();
    const originalSet = state.set.bind(state);
    const writeReleased = deferred();
    const initialWriteStarted = deferred();
    let holdWrite = true;
    state.set = async (key, value, ttlMs) => {
      if (holdWrite) {
        holdWrite = false;
        initialWriteStarted.resolve();
        await writeReleased.promise;
      }
      await originalSet(key, value, ttlMs);
    };

    const subscriptions: unknown[] = [];
    let connection = 0;
    const secondConnected = deferred();
    const baseUrl = await serve((server) => {
      server.on("connection", (socket) => {
        const firstConnection = connection === 0;
        connection += 1;
        if (!firstConnection) {
          secondConnected.resolve();
        }
        socket.on("subscribe", (input, ack) => {
          subscriptions.push(input);
          ack({ ok: true, startSeq: firstConnection ? 17 : 0 });
          if (firstConnection) {
            setTimeout(() => socket.conn.close(), 0);
          } else {
            setTimeout(() => socket.disconnect(true), 0);
          }
        });
      });
    });

    const listening = listen(baseUrl, state);
    await initialWriteStarted.promise;
    await secondConnected.promise;
    expect(subscriptions).toStrictEqual([
      { startSeq: 0, apiVersion: "2026-07-01" },
    ]);
    writeReleased.resolve();
    await listening;

    expect(subscriptions).toStrictEqual([
      { startSeq: 0, apiVersion: "2026-07-01" },
      { startSeq: 17, apiVersion: "2026-07-01" },
    ]);
    await expect(state.get(`photon:cursor:${PROJECT}`)).resolves.toBe(17);
  });

  it("keeps a saved cursor ahead of an old acknowledgement and replay", async () => {
    const state = createMemoryState();
    await state.connect();
    await state.set(`photon:cursor:${PROJECT}`, 8);
    const baseUrl = await serve((server) => {
      server.on("connection", (socket) => {
        socket.on("subscribe", (_input, ack) => {
          ack({ ok: true, startSeq: 0 });
          socket.emit("delivery", {}, { seq: 7 });
          socket.emit("delivery", {}, { seq: 9 });
          setTimeout(() => socket.disconnect(true), 0);
        });
      });
    });

    await listen(baseUrl, state);

    await expect(state.get(`photon:cursor:${PROJECT}`)).resolves.toBe(9);
  });
});
