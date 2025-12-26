import type { ModelMessage } from "ai";
import type { Attachment, ImageInput, Message } from "../types.js";

type UserContentPart =
  | { type: "text"; text: string }
  | { type: "image"; image: string | URL; mediaType?: string }
  | { type: "file"; data: string | URL; mediaType: string; filename?: string };

export function buildMessages(
  history: Message[],
  input: string,
  image?: ImageInput,
  attachments?: Attachment[]
): ModelMessage[] {
  const messages: ModelMessage[] = [];

  for (const msg of history) {
    if (typeof msg.content === "string") {
      messages.push({ role: msg.role, content: msg.content });
    }
  }

  const hasAttachments = attachments && attachments.length > 0;
  const hasImage = !!image;

  if (hasAttachments || hasImage) {
    const content: UserContentPart[] = [];

    if (hasImage) {
      content.push({
        type: "image",
        image: image.base64,
        mediaType: image.mimeType,
      });
    }

    if (hasAttachments) {
      for (const attachment of attachments) {
        switch (attachment.type) {
          case "image":
            if (attachment.source === "base64") {
              content.push({
                type: "image",
                image: attachment.base64,
                mediaType: attachment.mimeType,
              });
            } else {
              content.push({
                type: "image",
                image: new URL(attachment.url),
              });
            }
            break;

          case "pdf":
            if (attachment.source === "base64") {
              content.push({
                type: "file",
                data: attachment.base64,
                mediaType: "application/pdf",
              });
            } else {
              content.push({
                type: "file",
                data: new URL(attachment.url),
                mediaType: "application/pdf",
              });
            }
            break;

          case "file":
            content.push({
              type: "file",
              data: attachment.base64,
              mediaType: attachment.mimeType,
              filename: attachment.filename,
            });
            break;
        }
      }
    }

    content.push({ type: "text", text: input });
    messages.push({ role: "user", content } as ModelMessage);
  } else {
    messages.push({ role: "user", content: input });
  }

  return messages;
}

export function buildHistoryFromResult(
  previousHistory: Message[],
  userInput: string,
  image: ImageInput | undefined,
  attachments: Attachment[] | undefined,
  assistantResponse: string
): Message[] {
  const hasMultiModal = !!image || (attachments && attachments.length > 0);

  const userMessage: Message = hasMultiModal
    ? {
        role: "user",
        content: [{ type: "text", text: userInput }],
        timestamp: Date.now(),
      }
    : { role: "user", content: userInput, timestamp: Date.now() };

  return [
    ...previousHistory,
    userMessage,
    { role: "assistant", content: assistantResponse, timestamp: Date.now() },
  ];
}
