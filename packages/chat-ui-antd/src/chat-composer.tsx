import { Button, Input, Typography, theme } from "antd";
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { resolveChatUiLabels } from "./labels.js";
import type { ChatUiLabelOverrides } from "./types.js";

export interface ChatComposerProps {
  readonly className?: string | undefined;
  readonly disabled?: boolean | undefined;
  readonly disabledReason?: ReactNode | undefined;
  readonly interruptAction?: ChatComposerInterruptAction | undefined;
  readonly labels?: ChatUiLabelOverrides | undefined;
  readonly onSend: (text: string) => boolean | PromiseLike<boolean>;
  readonly resetKey?: string | undefined;
  readonly style?: CSSProperties | undefined;
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
  labels: labelOverrides,
  onSend,
  resetKey,
  style,
}: ChatComposerProps) => {
  const { token } = theme.useToken();
  const labels = resolveChatUiLabels(labelOverrides);
  const [draft, setDraft] = useState("");
  const [interrupting, setInterrupting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const interruptRequestId = useRef(0);
  const submissionId = useRef(0);
  const interruptResetKey = interruptAction?.resetKey ?? null;

  useEffect(() => {
    submissionId.current += 1;
    setDraft("");
    setSubmitting(false);
  }, [resetKey]);

  useEffect(() => {
    interruptRequestId.current += 1;
    setInterrupting(false);
  }, [interruptResetKey]);

  const submit = async (): Promise<void> => {
    const text = draft.trim();
    if (disabled || submitting || text.length === 0) return;

    const requestId = submissionId.current + 1;
    submissionId.current = requestId;
    setSubmitting(true);
    try {
      const succeeded = await onSend(text);
      if (submissionId.current !== requestId) return;
      if (succeeded) {
        setDraft((current) => (current.trim() === text ? "" : current));
      }
    } catch {
      // The owner of the command callback owns error presentation. Retain the
      // draft so the user can retry without creating a second error source.
    } finally {
      if (submissionId.current === requestId) setSubmitting(false);
    }
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
          disabled={disabled}
          onChange={(event) => {
            setDraft(event.target.value);
          }}
          onPressEnter={handlePressEnter}
          placeholder={
            disabled
              ? typeof disabledReason === "string"
                ? disabledReason
                : labels.textSendingUnavailable
              : labels.composerPlaceholder
          }
          value={draft}
        />
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
          disabled={disabled || draft.trim().length === 0}
          loading={submitting}
          onClick={() => {
            void submit();
          }}
          type="primary"
        >
          {submitting ? labels.sending : labels.send}
        </Button>
      </div>
      {disabled && disabledReason !== undefined ? (
        <Typography.Text type="secondary">{disabledReason}</Typography.Text>
      ) : null}
    </div>
  );
};
