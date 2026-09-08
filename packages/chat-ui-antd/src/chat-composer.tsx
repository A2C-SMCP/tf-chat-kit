import { ChatReferencePicker } from "./reference-picker.js";
import {
  appendComposerReference,
  useChatDocumentSource,
} from "@turingfocus/chat-react";
import { Button, Input, Modal, Space, Typography, theme } from "antd";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ClipboardEvent,
  type ChangeEvent,
  type ReactNode,
} from "react";

import type {
  ChatAttachmentUploader,
  ComposerDraft,
  ComposerTextEdit,
} from "@turingfocus/chat-react";
import {
  rebaseComposerLongTexts,
  resolveComposerDraftText,
} from "@turingfocus/chat-react";
import type { UploadedAttachment } from "@turingfocus/chat-protocol";

import { resolveChatUiLabels } from "./labels.js";
import type { ChatUiLabelOverrides } from "./types.js";

export interface ChatComposerProps {
  readonly className?: string | undefined;
  readonly disabled?: boolean | undefined;
  readonly disabledReason?: ReactNode | undefined;
  readonly interruptAction?: ChatComposerInterruptAction | undefined;
  readonly labels?: ChatUiLabelOverrides | undefined;
  readonly onSend: (
    text: string,
    attachments?: readonly UploadedAttachment[],
  ) => boolean | PromiseLike<boolean>;
  readonly attachmentUploader?: ChatAttachmentUploader | undefined;
  readonly draft?: ComposerDraft | undefined;
  readonly getDeadlineAt?: (() => number) | undefined;
  readonly longTextThreshold?: number | undefined;
  readonly maxAttachments?: number | undefined;
  readonly onDraftChange?:
    | ((
        draft: Pick<ComposerDraft, "attachments" | "longTexts" | "text">,
      ) => void)
    | undefined;
  readonly resetKey?: string | undefined;
  readonly style?: CSSProperties | undefined;
  readonly textInputDisabled?: boolean | undefined;
}

export interface ChatComposerInterruptAction {
  readonly disabled?: boolean | undefined;
  readonly onInterrupt: () => boolean | PromiseLike<boolean>;
  readonly resetKey?: string | undefined;
}

export const ChatComposer = ({
  className,
  disabled = false,
  disabledReason,
  interruptAction,
  attachmentUploader,
  draft: controlledDraft,
  getDeadlineAt,
  longTextThreshold = 4_000,
  maxAttachments = 20,
  onDraftChange,
  labels: labelOverrides,
  onSend,
  resetKey,
  style,
  textInputDisabled = false,
}: ChatComposerProps) => {
  const { source: documentSource, scope: documentScope } =
    useChatDocumentSource();
  const [referencePickerOpen, setReferencePickerOpen] = useState(false);
  useEffect(
    () => setReferencePickerOpen(false),
    [resetKey, documentSource, documentScope],
  );
  const { token } = theme.useToken();
  const labels = resolveChatUiLabels(labelOverrides);
  const [draft, setDraft] = useState("");
  const [uploading, setUploading] = useState<
    readonly {
      readonly file: File;
      readonly id: string;
      readonly error?: string;
    }[]
  >([]);
  const [selectedLongTextId, setSelectedLongTextId] = useState<string>();
  const sequence = useRef(0);
  const uploadGeneration = useRef(0);
  const uploadControllers = useRef(new Map<string, AbortController>());
  const fileInput = useRef<HTMLInputElement | null>(null);
  const textarea = useRef<HTMLTextAreaElement | null>(null);
  const pendingTextEdit = useRef<
    Pick<ComposerTextEdit, "previousEnd" | "previousStart"> | undefined
  >();
  const [interrupting, setInterrupting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const interruptRequestId = useRef(0);
  const submissionId = useRef(0);
  const interruptResetKey = interruptAction?.resetKey ?? null;
  const text = controlledDraft?.text ?? draft;
  const attachments = controlledDraft?.attachments ?? [];
  const longTexts = controlledDraft?.longTexts ?? [];
  const revision = controlledDraft?.revision ?? 0;
  const draftSnapshot = useRef({ attachments, longTexts, revision, text });
  draftSnapshot.current = { attachments, longTexts, revision, text };

  const updateDraft = useCallback(
    (
      patch: Partial<Pick<ComposerDraft, "attachments" | "longTexts" | "text">>,
      textEdit?: ComposerTextEdit,
    ) => {
      if (controlledDraft !== undefined && onDraftChange !== undefined) {
        const current = draftSnapshot.current;
        const nextText = patch.text ?? current.text;
        const nextLongTexts =
          patch.longTexts ??
          rebaseComposerLongTexts(
            current.text,
            nextText,
            current.longTexts,
            textEdit,
          );
        const next = {
          attachments: patch.attachments ?? current.attachments,
          longTexts: nextLongTexts,
          text: nextText,
        };
        draftSnapshot.current = { ...next, revision: current.revision + 1 };
        onDraftChange(next);
      } else if (patch.text !== undefined) {
        setDraft(patch.text);
      }
    },
    [controlledDraft, onDraftChange],
  );

  useEffect(() => {
    const cancelUploads = (): void => {
      uploadGeneration.current += 1;
      for (const controller of uploadControllers.current.values()) {
        controller.abort();
      }
      uploadControllers.current.clear();
    };
    cancelUploads();
    pendingTextEdit.current = undefined;
    submissionId.current += 1;
    setDraft("");
    setUploading([]);
    setSubmitting(false);
    return cancelUploads;
  }, [resetKey]);

  useEffect(() => {
    interruptRequestId.current += 1;
    setInterrupting(false);
  }, [interruptResetKey]);

  const submit = async (): Promise<void> => {
    const resolvedText = resolveComposerDraftText({
      attachments,
      conversationId: controlledDraft?.conversationId ?? "standalone",
      longTexts,
      revision,
      text,
    });
    if (
      disabled ||
      submitting ||
      (resolvedText.trim().length === 0 && attachments.length === 0)
    )
      return;

    const requestId = submissionId.current + 1;
    submissionId.current = requestId;
    setSubmitting(true);
    try {
      const succeeded = await onSend(resolvedText, attachments);
      if (submissionId.current !== requestId) return;
      if (succeeded && controlledDraft === undefined) {
        updateDraft({ attachments: [], longTexts: [], text: "" });
      }
    } catch {
      // The owner of the command callback owns error presentation. Retain the
      // draft so the user can retry without creating a second error source.
    } finally {
      if (submissionId.current === requestId) setSubmitting(false);
    }
  };

  const uploadFile = useCallback(
    async (file: File, id: string): Promise<void> => {
      if (attachmentUploader === undefined || getDeadlineAt === undefined)
        return;
      const generation = uploadGeneration.current;
      uploadControllers.current.get(id)?.abort();
      const controller = new AbortController();
      uploadControllers.current.set(id, controller);
      setUploading((current) => [
        ...current.filter((item) => item.id !== id),
        { file, id },
      ]);
      let result: Awaited<ReturnType<ChatAttachmentUploader["upload"]>>;
      try {
        result = await attachmentUploader.upload({
          deadlineAt: getDeadlineAt(),
          blob: file,
          fileName: file.name,
          mimeType: file.type,
          cancellation: {
            get aborted() {
              return controller.signal.aborted;
            },
            subscribe(listener) {
              if (controller.signal.aborted) {
                listener();
                return () => undefined;
              }
              const onAbort = (): void => listener();
              controller.signal.addEventListener("abort", onAbort, {
                once: true,
              });
              return () =>
                controller.signal.removeEventListener("abort", onAbort);
            },
          },
        });
      } catch (error) {
        if (uploadGeneration.current !== generation) return;
        setUploading((current) =>
          current.map((item) =>
            item.id === id
              ? {
                  ...item,
                  error:
                    error instanceof Error ? error.message : "Upload failed",
                }
              : item,
          ),
        );
        return;
      } finally {
        if (uploadControllers.current.get(id) === controller) {
          uploadControllers.current.delete(id);
        }
      }
      if (uploadGeneration.current !== generation) return;
      if (result.ok) {
        updateDraft({
          attachments: [...draftSnapshot.current.attachments, result.value],
        });
        setUploading((current) => current.filter((item) => item.id !== id));
      } else {
        setUploading((current) =>
          current.map((item) =>
            item.id === id ? { ...item, error: result.error.message } : item,
          ),
        );
      }
    },
    [attachmentUploader, getDeadlineAt, updateDraft],
  );

  const selectFiles = (event: ChangeEvent<HTMLInputElement>): void => {
    const remaining = Math.max(
      0,
      maxAttachments - attachments.length - uploading.length,
    );
    for (const file of Array.from(event.target.files ?? []).slice(
      0,
      remaining,
    )) {
      const id = `upload-${++sequence.current}`;
      void uploadFile(file, id);
    }
    event.target.value = "";
  };

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    pendingTextEdit.current = undefined;
    const files = Array.from(event.clipboardData.files);
    if (files.length > 0 && attachmentUploader !== undefined) {
      event.preventDefault();
      const remaining = Math.max(
        0,
        maxAttachments - attachments.length - uploading.length,
      );
      for (const file of files.slice(0, remaining))
        void uploadFile(file, `paste-${++sequence.current}`);
      return;
    }
    const pasted = event.clipboardData.getData("text/plain");
    if (pasted.length <= longTextThreshold || controlledDraft === undefined)
      return;
    event.preventDefault();
    const id = `long-text-${++sequence.current}`;
    const label = `[Pasted text ${longTexts.length + 1}]`;
    const element = textarea.current;
    const start = element?.selectionStart ?? text.length;
    const end = element?.selectionEnd ?? start;
    const nextText = `${text.slice(0, start)}${label}${text.slice(end)}`;
    updateDraft({
      text: nextText,
      longTexts: [
        ...rebaseComposerLongTexts(text, nextText, longTexts, {
          nextEnd: start + label.length,
          previousEnd: end,
          previousStart: start,
        }),
        {
          content: pasted,
          end: start + label.length,
          id,
          label,
          start,
        },
      ].sort((left, right) => left.start - right.start),
    });
  };

  const handlePressEnter = (
    event: KeyboardEvent<HTMLTextAreaElement>,
  ): void => {
    if (event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void submit();
  };

  const interrupt = async (): Promise<void> => {
    if (
      interruptAction === undefined ||
      interruptAction.disabled === true ||
      interrupting
    ) {
      return;
    }
    const action = interruptAction;
    const requestId = interruptRequestId.current + 1;
    interruptRequestId.current = requestId;
    setInterrupting(true);
    try {
      await action.onInterrupt();
    } catch {
      // The owner of the command callback owns error presentation. The
      // composer only owns the pending state for this action.
    } finally {
      if (interruptRequestId.current === requestId) setInterrupting(false);
    }
  };

  return (
    <div
      className={className}
      style={{
        borderBlockStart: `${token.lineWidth}px ${token.lineType} ${token.colorBorderSecondary}`,
        padding: token.paddingSM,
        ...style,
      }}
    >
      <div
        data-chat-composer=""
        style={{ alignItems: "flex-end", display: "flex", gap: token.marginXS }}
      >
        <Input.TextArea
          aria-label={labels.composerLabel}
          autoSize={{ maxRows: 8, minRows: 2 }}
          disabled={disabled || textInputDisabled}
          onBeforeInput={(event) => {
            pendingTextEdit.current = {
              previousEnd: event.currentTarget.selectionEnd ?? text.length,
              previousStart: event.currentTarget.selectionStart ?? text.length,
            };
          }}
          onChange={(event) => {
            const pending = pendingTextEdit.current;
            pendingTextEdit.current = undefined;
            const nextText = event.target.value;
            if (nextText.endsWith("/") && documentSource !== undefined)
              setReferencePickerOpen(true);
            const insertedLength =
              pending === undefined
                ? undefined
                : nextText.length -
                  (text.length - (pending.previousEnd - pending.previousStart));
            updateDraft(
              { text: nextText },
              pending === undefined ||
                insertedLength === undefined ||
                insertedLength < 0
                ? undefined
                : {
                    ...pending,
                    nextEnd: pending.previousStart + insertedLength,
                  },
            );
          }}
          onPaste={handlePaste}
          onPressEnter={handlePressEnter}
          placeholder={
            disabled || textInputDisabled
              ? typeof disabledReason === "string"
                ? disabledReason
                : labels.textSendingUnavailable
              : labels.composerPlaceholder
          }
          ref={textarea}
          value={text}
        />
        {documentSource !== undefined &&
          controlledDraft !== undefined &&
          onDraftChange !== undefined && (
            <Button
              disabled={disabled || textInputDisabled}
              onClick={() => setReferencePickerOpen(true)}
            >
              References
            </Button>
          )}
        {attachmentUploader === undefined ? null : (
          <Button
            disabled={
              disabled ||
              attachments.length + uploading.length >= maxAttachments
            }
            onClick={() => fileInput.current?.click()}
          >
            {labels.attach}
          </Button>
        )}
        {attachmentUploader === undefined ? null : (
          <input
            hidden
            multiple
            onChange={selectFiles}
            ref={fileInput}
            type="file"
          />
        )}
        {interruptAction === undefined ? null : (
          <Button
            danger
            disabled={interruptAction.disabled === true}
            loading={interrupting}
            onClick={() => {
              void interrupt();
            }}
          >
            {interrupting
              ? labels.interrupting
              : interruptAction.disabled === true
                ? labels.interruptUnavailable
                : labels.interrupt}
          </Button>
        )}
        <Button
          disabled={
            disabled ||
            uploading.some((item) => item.error === undefined) ||
            (text.trim().length === 0 && attachments.length === 0)
          }
          loading={submitting}
          onClick={() => {
            void submit();
          }}
          type="primary"
        >
          {submitting ? labels.sending : labels.send}
        </Button>
      </div>
      {attachments.length === 0 && uploading.length === 0 ? null : (
        <Space wrap size="small" style={{ marginBlockStart: token.marginXS }}>
          {attachments.map((attachment) => (
            <Button
              aria-label={`${labels.removeAttachment} ${attachment.name ?? attachment.uri}`}
              key={attachment.uri}
              onClick={() =>
                updateDraft({
                  attachments: attachments.filter(
                    (item) => item !== attachment,
                  ),
                })
              }
              size="small"
            >
              {attachment.name ?? attachment.uri} ×
            </Button>
          ))}
          {uploading.map((item) => (
            <Button
              danger={item.error !== undefined}
              key={item.id}
              loading={item.error === undefined}
              onClick={() =>
                item.error === undefined
                  ? undefined
                  : void uploadFile(item.file, item.id)
              }
              size="small"
            >
              {item.error === undefined
                ? item.file.name
                : `${labels.retryUpload} ${item.file.name}`}
            </Button>
          ))}
        </Space>
      )}
      {referencePickerOpen &&
        controlledDraft !== undefined &&
        onDraftChange !== undefined && (
          <ChatReferencePicker
            key={resetKey}
            conversationId={controlledDraft.conversationId}
            onClose={() => setReferencePickerOpen(false)}
            onSelect={(reference) => {
              const current = draftSnapshot.current;
              let anchorId: string;
              do {
                anchorId = `reference-${++sequence.current}`;
              } while (current.longTexts.some((item) => item.id === anchorId));
              updateDraft(
                appendComposerReference(
                  {
                    ...current,
                    conversationId: controlledDraft.conversationId,
                  },
                  reference,
                  anchorId,
                ),
              );
              setReferencePickerOpen(false);
            }}
          />
        )}
      {longTexts.length === 0 ? null : (
        <Space wrap size="small" style={{ marginBlockStart: token.marginXS }}>
          {longTexts.map((item) => (
            <Space.Compact key={item.id}>
              <Button
                onClick={() => setSelectedLongTextId(item.id)}
                size="small"
              >
                {item.label}
              </Button>
              <Button
                aria-label={`${labels.removeLongText} ${item.label}`}
                onClick={() => {
                  const nextText = `${text.slice(0, item.start)}${text.slice(item.end)}`;
                  updateDraft({
                    text: nextText,
                    longTexts: rebaseComposerLongTexts(
                      text,
                      nextText,
                      longTexts.filter((entry) => entry.id !== item.id),
                      {
                        nextEnd: item.start,
                        previousEnd: item.end,
                        previousStart: item.start,
                      },
                    ),
                  });
                }}
                size="small"
              >
                ×
              </Button>
            </Space.Compact>
          ))}
        </Space>
      )}
      {disabled && disabledReason !== undefined ? (
        <Typography.Text type="secondary">{disabledReason}</Typography.Text>
      ) : null}
      <Modal
        footer={null}
        onCancel={() => setSelectedLongTextId(undefined)}
        open={selectedLongTextId !== undefined}
        title={labels.pastedTextTitle}
      >
        {longTexts.find((item) => item.id === selectedLongTextId) ===
        undefined ? null : (
          <Input.TextArea
            autoSize={{ minRows: 8, maxRows: 20 }}
            onChange={(event) =>
              updateDraft({
                longTexts: longTexts.map((item) =>
                  item.id === selectedLongTextId
                    ? { ...item, content: event.target.value }
                    : item,
                ),
              })
            }
            value={
              longTexts.find((item) => item.id === selectedLongTextId)!.content
            }
          />
        )}
      </Modal>
    </div>
  );
};
