# @photon-ai/chat-adapter

[Chat SDK](https://chat-sdk.dev/docs) adapter for [Photon](https://photon.codes). One adapter reaches every platform a Photon project has connected: iMessage, SMS, WhatsApp, WhatsApp Business, Telegram, and email.

It talks to the [Photon API](https://api.photon.codes) with a project API key and receives messages through a signed Photon webhook or over Photon's websocket.

## Installation

```bash
pnpm add chat @photon-ai/chat-adapter @chat-adapter/state-redis
```

The examples keep Chat SDK's state in Redis: `createRedisState()` reads `REDIS_URL`. Any Chat SDK state adapter works.

## Usage

```ts
import { Chat } from "chat";
import { createPhotonAdapter } from "@photon-ai/chat-adapter";
import { createRedisState } from "@chat-adapter/state-redis";

export const bot = new Chat({
  userName: "mybot",
  adapters: { photon: createPhotonAdapter() },
  state: createRedisState(),
});

bot.onDirectMessage(async (thread, message) => {
  await thread.post(`You said: ${message.text}`);
});

bot.onNewMention(async (thread) => {
  await thread.subscribe();
  await thread.post({ markdown: "Hi, I'm **here**." });
});

bot.onSubscribedMessage(async (thread, message) => {
  await thread.post(`You said: ${message.text}`);
});
```

Route Photon's webhook to the adapter, for example in a Next.js route handler:

```ts
// app/api/webhooks/photon/route.ts
import { after } from "next/server";
import { bot } from "@/lib/bot";

export async function POST(request: Request) {
  return bot.webhooks.photon(request, { waitUntil: (task) => after(() => task) });
}
```

### Or over the websocket

Without a public URL, receive messages over Photon's websocket instead. `startGatewayListener` connects, reconnects when the connection drops, and saves the last event it handled in your state adapter, so the next connection resumes after it. Use a persistent state adapter, such as Redis, for that to survive a restart.

On a long-running server, listen until shutdown:

```ts
await bot.initialize();
const controller = new AbortController();
process.on("SIGTERM", () => controller.abort());
await bot
  .getAdapter("photon")
  .startGatewayListener({}, Number.POSITIVE_INFINITY, controller.signal);
```

On serverless, start it from a cron job that runs more often than the listener lasts (the default is 3 minutes). Check the cron secret first, so nobody else can start listeners on your API key; Vercel Cron sends `CRON_SECRET` as a bearer token:

```ts
// app/api/photon/gateway/route.ts
import { after } from "next/server";
import { bot } from "@/lib/bot";

export const maxDuration = 800;

export async function GET(request: Request) {
  if (request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  await bot.initialize();
  return bot
    .getAdapter("photon")
    .startGatewayListener({ waitUntil: (task) => after(() => task) }, 600_000);
}
```

Overlapping listeners are fine: Chat SDK drops a message it has already handled.

## Setup

1. In the [Photon dashboard](https://app.photon.codes), create a project API key (`pho_sk_...`).
2. To receive by webhook, add a webhook destination pointing at your route, with the `message.received` event, and copy its signing secret (`whsec_...`). The websocket needs only the API key.
3. Set the environment variables:

| Variable | Option | Description |
| --- | --- | --- |
| `PHOTON_PROJECT_ID` | `projectId` | The project's ID. Required. |
| `PHOTON_API_KEY` | `apiKey` | The project API key. Required. |
| `PHOTON_WEBHOOK_SECRET` | `webhookSecret` | The webhook destination's signing secret. Required to receive messages by webhook. |
| `PHOTON_API_URL` | `baseUrl` | API origin. Defaults to `https://api.photon.codes`. |

Options passed to `createPhotonAdapter` take precedence over the environment.

## Threads

A thread is one Photon Space, as seen by one of your project's Agents (the line or account that received the message). Thread IDs look like `photon:<spaceId>:<agentUserId>:<spaceKind>`, so a reply always goes out from the Agent the message arrived on, even from a later invocation. Direct Spaces are DMs: they reach `onDirectMessage`, or count as mentions.

## Features

| Chat SDK | Photon |
| --- | --- |
| Receive messages | `message.received`, by webhook (Standard Webhooks signatures) or websocket |
| `post` | Text (Markdown or plain) and files, uploaded as attachments |
| Streaming | Collected and sent once, complete |
| `edit` / `delete` | `message.update` / `message.delete`, where the platform supports them |
| `addReaction` | `reaction`, where the platform supports it |
| `startTyping` | Space typing; a no-op where the platform has none |
| `fetchMessages` | Space history, paginated |
| `fetchThread` | The Space |
| `markAsRead` | Read receipts |
| Inbound attachments | Name, type, and size, with `fetchData()` to download |

Platforms differ: when one doesn't support an operation, Photon refuses it and the adapter throws Chat SDK's `NotImplementedError`. For example, iMessage doesn't support edits, deletes, or reactions yet; Telegram supports edits and deletes.

Markdown goes to Photon as Markdown, and each platform renders what it can (SMS gets plain text). Raw HTML in Markdown is dropped, because Photon rejects it.

## Not supported yet

- `removeReaction`: Photon removes a reaction by deleting the reaction's own message, which the adapter doesn't track.
- Starting a conversation (`openDM`): reply to inbound messages, or create the Space through the Photon API first.
- Cards and modals: cards are sent as their fallback text.
- Inbound reactions, edits, and deletes are acknowledged but not routed to handlers.

## License

MIT
