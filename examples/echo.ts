import { createMemoryState } from "@chat-adapter/state-memory";
import { createPhotonAdapter } from "@photon-ai/chat-adapter";
import { Chat } from "chat";

const bot = new Chat({
  userName: "echo",
  adapters: { photon: createPhotonAdapter() },
  state: createMemoryState(),
});

bot.onDirectMessage(async (thread, message) => {
  if (message.text) {
    await thread.post(message.text);
  }
});

await bot.initialize();
await bot
  .getAdapter("photon")
  .startGatewayListener({}, Number.POSITIVE_INFINITY);
