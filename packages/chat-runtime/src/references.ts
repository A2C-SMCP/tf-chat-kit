import type {
  MaybePromise,
  UploadCancellationSignal,
} from "@turingfocus/chat-protocol";
import {
  rebaseComposerLongTexts,
  type ComposerDraft,
} from "./composer-draft.js";

/** Content already authorized by the integrating application, expanded as plain text on send. */
export interface ChatDocumentReference {
  readonly id: string;
  readonly title: string;
  readonly content: string;
}
export interface ChatDocumentSource {
  list(request: {
    readonly query: string;
    readonly conversationId: string;
    readonly signal: UploadCancellationSignal;
  }): MaybePromise<readonly ChatDocumentReference[]>;
}

export function appendComposerReference(
  draft: ComposerDraft,
  reference: ChatDocumentReference,
  anchorId: string,
): Pick<ComposerDraft, "text" | "longTexts" | "attachments"> {
  if (
    reference.id.length === 0 ||
    reference.title.length === 0 ||
    anchorId.length === 0 ||
    draft.longTexts.some((item) => item.id === anchorId)
  )
    throw new TypeError("Invalid or duplicate reference identity");
  const prefix = draft.text.endsWith("/")
    ? draft.text.slice(0, -1)
    : draft.text;
  const separator = prefix.length === 0 || /\s$/.test(prefix) ? "" : " ";
  const label = `[Reference: ${reference.title}]`;
  const start = prefix.length + separator.length;
  return {
    attachments: draft.attachments,
    text: `${prefix}${separator}${label}`,
    longTexts: [
      ...rebaseComposerLongTexts(draft.text, prefix, draft.longTexts),
      {
        id: anchorId,
        label,
        start,
        end: start + label.length,
        content: `${reference.title}\n${reference.content}`,
      },
    ],
  };
}
