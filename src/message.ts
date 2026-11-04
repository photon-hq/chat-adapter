import type { Attachment } from "chat";
import {
  Message,
  paragraph,
  parseMarkdown,
  root,
  text as textNode,
  toPlainText,
} from "chat";

import type { PhotonClient } from "./client";
import type { ContentParts } from "./content";
import { attachmentType } from "./content";
import type { PhotonAttachment, PhotonMessage } from "./types";

/** Builds a Chat SDK Message, looking up each attachment's name, type, and size. */
export async function toChatMessage(
  client: PhotonClient,
  raw: PhotonMessage,
  threadId: string,
  parts: ContentParts
): Promise<Message<PhotonMessage>> {
  const attachments = await Promise.all(
    parts.attachmentIds.map((id) =>
      client
        .request("GET", `/attachments/${id}`, "fetchAttachment")
        .then(async (response) =>
          toAttachment(client, id, (await response.json()) as PhotonAttachment)
        )
        // A failed lookup costs the attachment its type and name, not the message.
        .catch(() => toAttachment(client, id))
    )
  );
  return buildChatMessage(raw, threadId, parts, attachments);
}

export function buildChatMessage(
  raw: PhotonMessage,
  threadId: string,
  { text, markdown }: ContentParts,
  attachments: Attachment[]
): Message<PhotonMessage> {
  // Only Markdown is parsed, so plain text keeps characters like * and _ as sent.
  const formatted = markdown
    ? parseMarkdown(text)
    : root(text ? [paragraph([textNode(text)])] : []);
  return new Message<PhotonMessage>({
    id: raw.id,
    threadId,
    text: markdown ? toPlainText(formatted) : text,
    formatted,
    raw,
    author: {
      userId: raw.sentBy.id,
      userName: raw.sentBy.handle,
      fullName: raw.sentBy.handle,
      isBot: raw.sentBy.kind === "agent",
      isMe: raw.status !== "received",
    },
    metadata: {
      dateSent: new Date(
        raw.timestamps.receivedAt ??
          raw.timestamps.dispatchedAt ??
          raw.createdAt
      ),
      edited: false,
    },
    attachments,
  });
}

export function toAttachment(
  client: PhotonClient,
  id: string,
  info?: PhotonAttachment
): Attachment {
  return {
    type: attachmentType(info?.contentType),
    mimeType: info?.contentType,
    name: info?.filename,
    size: info?.sizeBytes,
    fetchMetadata: { attachmentId: id },
    fetchData: () => client.download(id),
  };
}
