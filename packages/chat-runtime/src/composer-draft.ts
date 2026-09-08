import type { UploadedAttachment } from "@turingfocus/chat-protocol";

export interface ComposerLongText {
  readonly content: string;
  /** Exclusive end offset of the visible placeholder in ComposerDraft.text. */
  readonly end: number;
  readonly id: string;
  /** Visible placeholder text. It is never used as a replacement key. */
  readonly label: string;
  /** Inclusive start offset of the visible placeholder. */
  readonly start: number;
}

export interface ComposerDraft {
  readonly attachments: readonly UploadedAttachment[];
  readonly conversationId: string;
  readonly longTexts: readonly ComposerLongText[];
  readonly revision: number;
  readonly text: string;
}

export interface SetComposerDraftInput {
  readonly attachments?: readonly UploadedAttachment[] | undefined;
  readonly conversationId: string;
  readonly longTexts?: readonly ComposerLongText[] | undefined;
  readonly text?: string | undefined;
}

export interface ComposerTextEdit {
  /** End offset in the new text after the inserted replacement. */
  readonly nextEnd: number;
  /** Replaced range end in the previous text. */
  readonly previousEnd: number;
  /** Replaced range start in the previous text. */
  readonly previousStart: number;
}

export type ComposerDraftListener = (draft: ComposerDraft) => void;

export const areComposerLongTextsValid = (
  text: string,
  longTexts: readonly ComposerLongText[],
): boolean => {
  const ids = new Set<string>();
  let previousEnd = 0;
  for (const item of [...longTexts].sort(
    (left, right) => left.start - right.start,
  )) {
    if (
      item.id.length === 0 ||
      ids.has(item.id) ||
      item.label.length === 0 ||
      !Number.isSafeInteger(item.start) ||
      !Number.isSafeInteger(item.end) ||
      item.start < previousEnd ||
      item.end <= item.start ||
      text.slice(item.start, item.end) !== item.label
    ) {
      return false;
    }
    ids.add(item.id);
    previousEnd = item.end;
  }
  return true;
};

export const emptyComposerDraft = (conversationId: string): ComposerDraft =>
  Object.freeze({
    attachments: Object.freeze([]),
    conversationId,
    longTexts: Object.freeze([]),
    revision: 0,
    text: "",
  });

export const resolveComposerDraftText = (draft: ComposerDraft): string => {
  const ordered = [...draft.longTexts].sort(
    (left, right) => left.start - right.start,
  );
  let cursor = 0;
  let resolved = "";
  for (const item of ordered) {
    if (
      item.start < cursor ||
      item.end < item.start ||
      draft.text.slice(item.start, item.end) !== item.label
    ) {
      continue;
    }
    resolved += draft.text.slice(cursor, item.start);
    resolved += item.content;
    cursor = item.end;
  }
  return resolved + draft.text.slice(cursor);
};

/** Reanchors long-text nodes after one textarea edit. Edited nodes are removed. */
export const rebaseComposerLongTexts = (
  previousText: string,
  nextText: string,
  longTexts: readonly ComposerLongText[],
  edit?: ComposerTextEdit,
): readonly ComposerLongText[] => {
  if (previousText === nextText) return longTexts;
  if (
    edit !== undefined &&
    Number.isSafeInteger(edit.previousStart) &&
    Number.isSafeInteger(edit.previousEnd) &&
    Number.isSafeInteger(edit.nextEnd) &&
    edit.previousStart >= 0 &&
    edit.previousEnd >= edit.previousStart &&
    edit.previousEnd <= previousText.length &&
    edit.nextEnd >= edit.previousStart &&
    edit.nextEnd <= nextText.length &&
    previousText.slice(0, edit.previousStart) ===
      nextText.slice(0, edit.previousStart) &&
    previousText.slice(edit.previousEnd) === nextText.slice(edit.nextEnd)
  ) {
    const offset = edit.nextEnd - edit.previousEnd;
    return longTexts.flatMap((item) => {
      if (item.end <= edit.previousStart) return [item];
      if (item.start >= edit.previousEnd) {
        return [
          { ...item, start: item.start + offset, end: item.end + offset },
        ];
      }
      return [];
    });
  }
  let prefix = 0;
  const prefixLimit = Math.min(previousText.length, nextText.length);
  while (
    prefix < prefixLimit &&
    previousText.charCodeAt(prefix) === nextText.charCodeAt(prefix)
  ) {
    prefix += 1;
  }

  let suffix = 0;
  const suffixLimit = Math.min(
    previousText.length - prefix,
    nextText.length - prefix,
  );
  while (
    suffix < suffixLimit &&
    previousText.charCodeAt(previousText.length - 1 - suffix) ===
      nextText.charCodeAt(nextText.length - 1 - suffix)
  ) {
    suffix += 1;
  }

  const previousEditEnd = previousText.length - suffix;
  const nextEditEnd = nextText.length - suffix;
  const offset = nextEditEnd - previousEditEnd;
  return longTexts.flatMap((item) => {
    if (item.end <= prefix) return [item];
    if (item.start >= previousEditEnd) {
      return [{ ...item, start: item.start + offset, end: item.end + offset }];
    }
    return [];
  });
};
