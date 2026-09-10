import { Alert, type AlertProps } from "antd";
import { useState } from "react";
import type {
  ChatError,
  ChatErrorOccurrence,
} from "@turingfocus/chat-protocol";

// Legacy snapshots and run failures have no occurrence metadata. Their visible
// error content is the fallback identity until cleared or their scope changes.
export const chatErrorNoticeKey = (
  error: ChatError | undefined,
  occurrence?: ChatErrorOccurrence,
): string =>
  JSON.stringify([
    occurrence?.id,
    occurrence?.generation,
    error?.conversationId,
    error?.code,
    error?.message,
    error?.retryable,
  ]);

interface DismissibleChatAlertProps extends Omit<
  AlertProps,
  "closable" | "onClose"
> {
  /** Stable identity of the current notice; a new occurrence restores it. */
  readonly resetOn: string | undefined;
  /** Temporary suppression must not discard the current dismissal. */
  readonly visible?: boolean;
}

export const DismissibleChatAlert = ({
  resetOn,
  visible = true,
  ...props
}: DismissibleChatAlertProps) => {
  const [state, setState] = useState({ resetOn, dismissed: false });
  // Reset during render so a replacement notice never inherits the old close
  // state, including when React retries a concurrent render.
  if (!Object.is(state.resetOn, resetOn)) {
    setState({ resetOn, dismissed: false });
  }
  if (!visible || (Object.is(state.resetOn, resetOn) && state.dismissed))
    return null;
  return (
    <Alert
      {...props}
      closable
      onClose={() => setState({ resetOn, dismissed: true })}
    />
  );
};
