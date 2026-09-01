import type {
  SendMessageInput,
  UploadedAttachment,
} from "@turingfocus/chat-protocol";

import type { TFRobotMessageCreator } from "./types.js";

type TFRobotMessage = Readonly<Record<string, unknown>>;
type MediaKind = "audio" | "image" | "pdf" | "video";

const mediaKind = (attachment: UploadedAttachment): MediaKind | undefined => {
  const mime = attachment.mimeType.toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return mime === "application/pdf" ? "pdf" : undefined;
};

const baseMessage = (
  creator: TFRobotMessageCreator,
  conversationId: number | string,
) => ({
  additionalKwargs: {},
  attachments: null,
  createTimestamp: 0,
  creator,
  conversationId,
  role: "user" as const,
});

const mediaPart = (attachment: UploadedAttachment, kind: MediaKind) => {
  const media = {
    url: attachment.uri,
    mimeType: attachment.mimeType,
    ...(attachment.name === undefined ? {} : { name: attachment.name }),
  };
  switch (kind) {
    case "image":
      return { partType: "image_url", imageUrl: media };
    case "video":
      return { partType: "video_url", videoUrl: media };
    case "audio":
      return { partType: "audio_url", audioUrl: media };
    case "pdf":
      return { partType: "pdf_url", pdfUrl: media };
  }
};

/** Maps one normalized user turn to the currently verified TFRobot DTO. */
export const buildTFRobotOutboundMessage = (
  input: SendMessageInput,
  creator: TFRobotMessageCreator,
  conversationId: number | string,
): TFRobotMessage => {
  const base = baseMessage(creator, conversationId);
  const text = input.text ?? "";
  const attachments = input.attachments ?? [];
  const media = attachments.flatMap((attachment) => {
    const kind = mediaKind(attachment);
    return kind === undefined ? [] : [{ attachment, kind }];
  });
  const generic = attachments.filter(
    (attachment) => mediaKind(attachment) === undefined,
  );
  const messages: TFRobotMessage[] = [];

  if (media.length > 0 && (text.length > 0 || media.length > 1)) {
    messages.push({
      ...base,
      msgType: "multipart",
      content: [
        ...(text.length === 0 ? [] : [{ partType: "text", text }]),
        ...media.map(({ attachment, kind }) => mediaPart(attachment, kind)),
      ],
    });
  } else {
    for (const { attachment, kind } of media) {
      messages.push({
        ...base,
        msgType: kind === "pdf" ? "file" : kind,
        content: attachment.uri,
        ...(kind === "image"
          ? {
              additionalKwargs: {
                mimeType: attachment.mimeType,
                ...(attachment.name === undefined
                  ? {}
                  : { altText: attachment.name }),
              },
            }
          : {}),
      });
    }
    if (text.length > 0) {
      messages.push({ ...base, msgType: "text", content: text });
    }
  }

  for (const attachment of generic) {
    messages.push({ ...base, msgType: "file", content: attachment.uri });
  }
  if (messages.length === 1) return messages[0]!;
  return {
    ...base,
    msgType: "history",
    historyPrefix: "",
    content: messages,
  };
};
