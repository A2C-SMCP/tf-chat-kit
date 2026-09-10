import { Button, Tag, Typography, theme } from "antd";
import { useEffect, useRef, useState, type CSSProperties } from "react";

import type { Run } from "@turingfocus/chat-protocol";

import { resolveChatUiLabels } from "./labels.js";
import {
  chatErrorNoticeKey,
  DismissibleChatAlert,
} from "./dismissible-chat-alert.js";
import type { ChatUiLabelOverrides } from "./types.js";

export interface ChatRunStatusProps {
  readonly canInterrupt: boolean;
  readonly className?: string | undefined;
  readonly labels?: ChatUiLabelOverrides | undefined;
  readonly onInterrupt: () => boolean | PromiseLike<boolean>;
  readonly run: Run | null;
  readonly showInterruptButton?: boolean | undefined;
  readonly style?: CSSProperties | undefined;
}

export const ChatRunStatus = ({
  canInterrupt,
  className,
  labels: labelOverrides,
  onInterrupt,
  run,
  showInterruptButton = true,
  style,
}: ChatRunStatusProps) => {
  const { token } = theme.useToken();
  const labels = resolveChatUiLabels(labelOverrides);
  const [interrupting, setInterrupting] = useState(false);
  const interruptRequestId = useRef(0);

  useEffect(() => {
    interruptRequestId.current += 1;
    setInterrupting(false);
  }, [canInterrupt, run]);

  if (run === null) return null;

  const statusColor =
    run.status === "succeeded"
      ? "success"
      : run.status === "failed"
        ? "error"
        : run.status === "running"
          ? "processing"
          : "default";
  const interruptAvailable =
    run.status === "running" && run.canInterrupt && canInterrupt;

  const interrupt = async (): Promise<void> => {
    if (!interruptAvailable || interrupting) return;
    const requestId = interruptRequestId.current + 1;
    interruptRequestId.current = requestId;
    setInterrupting(true);
    try {
      await onInterrupt();
    } catch {
      // The command owner renders failures. This component owns pending state
      // only, preventing duplicate alerts in composed views.
    } finally {
      if (interruptRequestId.current === requestId) setInterrupting(false);
    }
  };

  return (
    <div
      className={className}
      style={{
        borderBlockEnd: `${token.lineWidth}px ${token.lineType} ${token.colorBorderSecondary}`,
        padding: `${token.paddingXS}px ${token.paddingSM}px`,
        ...style,
      }}
    >
      <div
        style={{
          alignItems: "center",
          display: "flex",
          gap: token.marginXS,
          justifyContent: "space-between",
        }}
      >
        <Typography.Text>
          {labels.runStatusLabel}: <Tag color={statusColor}>{run.status}</Tag>
        </Typography.Text>
        {showInterruptButton && run.status === "running" ? (
          <Button
            danger
            disabled={!interruptAvailable}
            loading={interrupting}
            onClick={() => {
              void interrupt();
            }}
            size="small"
          >
            {interrupting
              ? labels.interrupting
              : interruptAvailable
                ? labels.interrupt
                : labels.interruptUnavailable}
          </Button>
        ) : null}
      </div>
      {run.error === undefined ? null : (
        <DismissibleChatAlert
          key={JSON.stringify([run.conversationId, run.id])}
          resetOn={chatErrorNoticeKey(run.error)}
          message={run.error.message}
          showIcon
          style={{ marginTop: token.marginXS }}
          type="error"
        />
      )}
    </div>
  );
};
