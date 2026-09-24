import type { ModelMessage } from "ai";
import type { Attachment } from "./types.js";

type UserContentPart =
  | { type: "text"; text: string }
  | { type: "file"; data: string | URL; mediaType: string; filename?: string };

function attachmentToPart(attachment: Attachment): UserContentPart {
  switch (attachment.type) {
    case "image":
      return attachment.source === "base64"
        ? { type: "file", data: attachment.base64, mediaType: attachment.mimeType }
        : { type: "file", data: new URL(attachment.url), mediaType: "image/*" };

    case "pdf":
      return attachment.source === "base64"
        ? { type: "file", data: attachment.base64, mediaType: "application/pdf" }
        : { type: "file", data: new URL(attachment.url), mediaType: "application/pdf" };

    case "file":
      return {
        type: "file",
        data: attachment.base64,
        mediaType: attachment.mimeType,
        filename: attachment.filename,
      };
  }
}

/** Builds the user turn for a run, converting attachments to `{type:'file', mediaType, data}` parts. */
export function buildUserMessage(input: string, attachments?: Attachment[]): ModelMessage {
  if (!attachments || attachments.length === 0) {
    return { role: "user", content: input };
  }

  const content: UserContentPart[] = attachments.map(attachmentToPart);
  content.push({ type: "text", text: input });

  return { role: "user", content };
}
