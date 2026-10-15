import { Button, theme } from "antd";
import type { OutgoingMessage } from "@turingfocus/chat-protocol";
import type { ChatUiLabels } from "./types.js";

/** The same Runtime-owned observations appear during first send and in an open chat. */
export function ChatOutgoingMessages({
  messages,
  labels,
  onDismiss,
}: {
  readonly messages: readonly OutgoingMessage[] | undefined;
  readonly labels: ChatUiLabels;
  readonly onDismiss: (id: string) => void;
}) {
  const { token } = theme.useToken();
  if (!messages?.length) return null;
  return (
    <section
      data-chat-outgoing
      aria-label={labels.outgoingMessages}
      aria-live="polite"
      style={{
        flexShrink: 0,
        maxHeight: "35%",
        overflow: "auto",
        borderTop: `1px solid ${token.colorBorderSecondary}`,
        padding: token.paddingSM,
      }}
    >
      {messages.map((message) => (
        <div
          key={message.id}
          data-send-status={message.status}
          style={{ paddingBlock: token.paddingXS, overflowWrap: "anywhere" }}
        >
          <div style={{ whiteSpace: "pre-wrap" }}>{message.text}</div>
          {message.attachmentCount > 0 ? (
            <div>
              {labels.outgoingAttachments}: {message.attachmentCount}
            </div>
          ) : null}
          <small>
            {message.status === "sending"
              ? labels.outgoingSending
              : message.status === "accepted"
                ? labels.outgoingAccepted
                : message.status === "failed"
                  ? labels.outgoingFailed
                  : labels.outgoingUnknown}
          </small>
          {message.status !== "sending" ? (
            <Button
              size="small"
              type="link"
              onClick={() => onDismiss(message.id)}
            >
              {labels.dismissOutgoing}
            </Button>
          ) : null}
        </div>
      ))}
    </section>
  );
}
