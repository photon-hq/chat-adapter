# @photon-ai/chat-adapter

[Chat SDK](https://chat-sdk.dev/docs) adapter for [Photon](https://photon.codes). One adapter reaches every platform a Photon project has connected: iMessage, SMS, WhatsApp, WhatsApp Business, Telegram, and email.

It talks to the [Photon API](https://api.photon.codes) with a project API key and receives messages through a signed Photon webhook.

## Installation

```bash
pnpm add chat @photon-ai/chat-adapter
```

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

## Setup

1. In the [Photon dashboard](https://app.photon.codes), create a project API key (`pho_sk_...`).
2. Add a webhook destination pointing at your route, with the `message.received` event, and copy its signing secret (`whsec_...`).
3. Set the environment variables:

| Variable | Option | Description |
| --- | --- | --- |
| `PHOTON_PROJECT_ID` | `projectId` | The project's ID. Required. |
| `PHOTON_API_KEY` | `apiKey` | The project API key. Required. |
| `PHOTON_WEBHOOK_SECRET` | `webhookSecret` | The webhook destination's signing secret. Required to receive messages. |
| `PHOTON_API_URL` | `baseUrl` | API origin. Defaults to `https://api.photon.codes`. |

Options passed to `createPhotonAdapter` take precedence over the environment.

## Threads

A thread is one Photon Space, as seen by one of your project's Agents (the line or account that received the message). Thread IDs look like `photon:<spaceId>:<agentUserId>:<spaceKind>`, so a reply always goes out from the Agent the message arrived on, even from a later invocation. Direct Spaces are DMs: they reach `onDirectMessage`, or count as mentions.

## Features

| Chat SDK | Photon |
| --- | --- |
| Receive messages | `message.received` webhooks, Standard Webhooks signatures |
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
