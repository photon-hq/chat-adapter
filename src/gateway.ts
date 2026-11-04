import type { Logger, StateAdapter } from "chat";
import { io, type Socket } from "socket.io-client";
import type { PhotonApiOptions } from "./client";
import { NAME } from "./constants";
import type { PhotonEvent } from "./types";

// The event contract this adapter parses; each subscription pins it.
const API_VERSION = "2026-07-01";
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
    ack: (result: { ok: true } | { error: DeliveryError; ok: false }) => void
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

  let stop: () => void = () => undefined;
  const stopped = new Promise<void>((resolve) => {
    stop = resolve;
  });

  const socket: Socket<ServerEvents, ClientEvents> = io(baseUrl, {
    path: `/v1/projects/${projectId}/events/ws`,
    addTrailingSlash: false,
    transports: ["websocket"],
    extraHeaders: { authorization: `Bearer ${apiKey}` },
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
            return;
          }
          if (result.ok) {
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
  });
  socket.on("delivery", (event, { seq }) => {
    queue = queue
      .then(async () => {
        if (seq <= cursor) {
          return;
        }
        onEvent(event);
        await state.set(cursorKey, seq);
        cursor = seq;
      })
      // An event that fails is logged and skipped, so one bad payload can't stall the stream.
      .catch((error: unknown) => {
        logger?.error("Photon websocket event failed", {
          seq,
          error: String(error),
        });
      });
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
