import { cardToFallbackText, extractCard } from "@chat-adapter/shared";
import type { AdapterPostableMessage, Attachment, Root } from "chat";
import { parseMarkdown, stringifyMarkdown } from "chat";
import type { PhotonContent } from "./types";

export interface ContentParts {
  attachmentIds: string[];
  text: string;
}

/** Reads the text and attachments a Chat SDK message can carry out of Photon content. */
export function readContent(content: PhotonContent): ContentParts {
  switch (content.type) {
    case "text":
      return { text: content.text as string, attachmentIds: [] };
    case "attachment":
    case "voice": {
      const caption = (content.metadata as { caption?: { text?: string } })
        ?.caption?.text;
      return {
        text: caption ?? "",
        attachmentIds: [content.attachmentId as string],
      };
    }
    case "group": {
      const parts = (content.parts as PhotonContent[]).map(readContent);
      return {
        text: parts
          .map((part) => part.text)
          .filter(Boolean)
          .join("\n"),
        attachmentIds: parts.flatMap((part) => part.attachmentIds),
      };
    }
    default:
      return { text: "", attachmentIds: [] };
  }
}

/** Turns a Chat SDK message into Photon text content, or nothing when it has no text. */
export function toTextContent(
  message: AdapterPostableMessage
): PhotonContent | undefined {
  const card = extractCard(message);
  if (card) {
    return plainText(cardToFallbackText(card));
  }
  if (typeof message === "string") {
    return plainText(message);
  }
  if ("raw" in message) {
    return plainText(message.raw);
  }
  if ("markdown" in message) {
    return markdownText(parseMarkdown(message.markdown));
  }
  if ("ast" in message) {
    return markdownText(message.ast);
  }
  return;
}

export function attachmentType(mimeType?: string): Attachment["type"] {
  const kind = mimeType?.split("/")[0];
  return kind === "image" || kind === "video" || kind === "audio"
    ? kind
    : "file";
}

function plainText(text: string): PhotonContent | undefined {
  return text.trim() ? { type: "text", format: "plain", text } : undefined;
}

function markdownText(ast: Root): PhotonContent | undefined {
  const text = stringifyMarkdown(withoutHtml(ast)).trim();
  return text ? { type: "text", format: "markdown", text } : undefined;
}

interface AstNode {
  children?: AstNode[];
  type: string;
}

// Photon rejects raw HTML in Markdown (INVALID_CONTENT), and model output often has some.
function withoutHtml<T extends AstNode>(node: T): T {
  return node.children
    ? {
        ...node,
        children: node.children
          .filter((child) => child.type !== "html")
          .map(withoutHtml),
      }
    : node;
}
