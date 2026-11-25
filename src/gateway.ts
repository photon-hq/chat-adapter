import type { Logger, StateAdapter } from "chat";
import { io } from "socket.io-client";
import type { Socket } from "socket.io-client";

import type { PhotonApiOptions } from "./client";
import { API_VERSION, NAME } from "./constants";
import type { PhotonEvent } from "./types";

const SUBSCRIBE_TIMEOUT_MS = 10_000;

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
    ack: (
      result:
        | { ok: true; startSeq?: number }
        | { error: DeliveryError; ok: false }
    ) => void
  ) => void;
}

export interface GatewayOptions extends PhotonApiOptions {
  abortSignal?: AbortSignal;
  /** How long to listen; `Infinity` listens until `abortSignal`. */
  durationMs: number;
  logger?: Logger;
  onEvent: (event: PhotonEvent) => void;
  /** Keeps the last handled `seq`, so the next connection resumes after it. */
  state: StateAdapter;
}

/**
 * Listens to the project's event websocket, reconnecting as needed, and
 * resolves once it has stopped and saved its last cursor.
 */
export async function listenForEvents({
  apiKey,
  baseUrl,
  projectId,
  abortSignal,
  durationMs,
  logger,
  onEvent,
  state,
}: GatewayOptions): Promise<void> {
  const cursorKey = `${NAME}:cursor:${projectId}`;
  let cursor = (await state.get<number>(cursorKey)) ?? 0;
  let queue = Promise.resolve();
  const enqueue = (task: () => void | Promise<void>) => {
    queue = queue.then(task);
  };

  let stop!: () => void;
  // oxlint-disable-next-line promise/avoid-new -- settles when any of the stop conditions below fires
  const stopped = new Promise<void>((resolve) => {
    stop = resolve;
  });

  const saveCursor = async (seq: number) => {
    if (seq <= cursor) {
      return;
    }
    await state.set(cursorKey, seq);
    cursor = seq;
  };
  const seedCursor = async (startSeq: number) => {
    if (cursor !== 0) {
      return;
    }
    try {
      await saveCursor(startSeq);
    } catch (error) {
      logger?.error("Photon websocket cursor failed", {
        seq: startSeq,
        error: String(error),
      });
    }
  };
  const socket: Socket<ServerEvents, ClientEvents> = io(baseUrl, {
    path: `/v1/projects/${projectId}/events/ws`,
    addTrailingSlash: false,
    transports: ["websocket"],
    extraHeaders: { authorization: `Bearer ${apiKey}` },
  });
  const isCurrentConnection = (connectionId: string | undefined) =>
    socket.connected && socket.id === connectionId;
  const subscribe = (connectionId: string | undefined) => {
    if (!isCurrentConnection(connectionId)) {
      return;
    }
    socket
      .timeout(SUBSCRIBE_TIMEOUT_MS)
      .emit(
        "subscribe",
        { startSeq: cursor, apiVersion: API_VERSION },
        (timedOut, result) => {
          if (!isCurrentConnection(connectionId)) {
            return;
          }
          if (timedOut) {
            // Closing the transport makes Socket.IO reconnect and subscribe again.
            socket.io.engine.close();
            return;
          }
          if (result.ok) {
            const { startSeq } = result;
            if (
              startSeq !== undefined &&
              Number.isSafeInteger(startSeq) &&
              startSeq > 0
            ) {
              enqueue(() => seedCursor(startSeq));
            }
            return;
          }
          logger?.error("Photon websocket subscription rejected", {
            ...result.error,
          });
          // Photon closes the connection after a fatal rejection; a non-fatal one would only repeat.
          if (!result.error.fatal) {
            stop();
          }
        }
      );
  };
  socket.on("connect", () => {
    const connectionId = socket.id;
    enqueue(() => subscribe(connectionId));
  });
  const deliver = async (event: PhotonEvent, seq: number) => {
    if (seq <= cursor) {
      return;
    }
    // An event that fails is logged and skipped, so one bad payload can't stall the stream.
    try {
      onEvent(event);
      await saveCursor(seq);
    } catch (error) {
      logger?.error("Photon websocket event failed", {
        seq,
        error: String(error),
      });
    }
  };
  socket.on("delivery", (event, { seq }) => {
    enqueue(() => deliver(event, seq));
  });
  socket.on("delivery_error", (error) => {
    logger?.warn("Photon websocket delivery error", { ...error });
  });
  socket.on("connect_error", (error) => {
    // Socket.IO retries a failed connection unless the server refused it outright.
    if (socket.active) {
      logger?.warn("Photon websocket connection failed", {
        error: error.message,
      });
      return;
    }
    logger?.error("Photon refused the websocket; listener stopped", {
      error: error.message,
    });
    stop();
  });
  socket.on("disconnect", (reason) => {
    // Photon disconnects for good only on a protocol violation; anything else reconnects.
    if (reason === "io server disconnect") {
      logger?.error("Photon closed the websocket; listener stopped");
      stop();
    }
  });

  const timer = Number.isFinite(durationMs)
    ? setTimeout(stop, durationMs)
    : undefined;
  abortSignal?.addEventListener("abort", stop, { once: true });
  if (abortSignal?.aborted) {
    stop();
  }
  await stopped;

  clearTimeout(timer);
  abortSignal?.removeEventListener("abort", stop);
  socket.disconnect();
  await queue;
}
