import {
  AgentEventRenderer,
  EventTime,
  ToolEventRenderer,
} from "./event-renderers.js";
import { Alert, Button, Typography } from "antd";
import { createContext, useContext, useMemo, type ReactNode } from "react";
import {
  getConversationFailure,
  type TimelineItem,
} from "@turingfocus/chat-protocol";
import { resolveChatUiLabels } from "./labels.js";
import type { ChatRendererProps } from "./renderer-registry.js";
import type { ChatUiLabelOverrides } from "./types.js";

/** Private, view-scoped actions; standalone renderers remain display-only. */
export const ConversationFailureContext = createContext<{
  readonly labels?: ChatUiLabelOverrides | undefined;
  readonly onRestore?: ((item: TimelineItem) => void) | undefined;
  readonly focusRequest?: number | undefined;
  readonly restorationBlocked?: boolean | undefined;
  readonly onPendingUploadsChange?: ((count: number) => void) | undefined;
}>({});

export function ConversationFailureLabelsProvider({
  labels,
  children,
}: {
  readonly labels?: ChatUiLabelOverrides | undefined;
  readonly children: ReactNode;
}) {
  const inherited = useContext(ConversationFailureContext);
  const value = useMemo(
    () => ({ ...inherited, labels: { ...inherited.labels, ...labels } }),
    [inherited, labels],
  );
  return (
    <ConversationFailureContext.Provider value={value}>
      {children}
    </ConversationFailureContext.Provider>
  );
}

export const ConversationFailureCard = (
  props: ChatRendererProps,
): ReactNode => {
  const { item, formatTimestamp } = props;
  const context = useContext(ConversationFailureContext);
  const labels = resolveChatUiLabels(context.labels);
  const failure = getConversationFailure(item);
  if (failure === undefined)
    return item.kind === "agent-event" && item.eventCategory === "tool" ? (
      <ToolEventRenderer {...props} />
    ) : (
      <AgentEventRenderer {...props} />
    );
  const title =
    labels.formatConversationFailureTitle?.(failure.businessCode) ??
    labels.conversationFailureTitle;
  const text = (value: string) => (
    <Typography.Paragraph
      ellipsis={
        value.length > 600
          ? { rows: 5, expandable: true, symbol: labels.expandFailure }
          : false
      }
      style={{
        whiteSpace: "pre-wrap",
        overflowWrap: "anywhere",
        margin: "8px 0",
      }}
    >
      {value}
    </Typography.Paragraph>
  );
  return (
    <div data-chat-conversation-failure={item.id}>
      <Alert
        type="error"
        showIcon
        message={title}
        description={
          <>
            <Typography.Text type="secondary">
              {props.displayMode === "timeline" ? (
                <EventTime
                  timestamp={item.createdAt}
                  formatTimestamp={formatTimestamp}
                />
              ) : (
                formatTimestamp(item.createdAt)
              )}{" "}
              ·{" "}
              {failure.source === "history"
                ? labels.failureHistory
                : labels.failureRealtime}
            </Typography.Text>
            {text(failure.message)}
            {failure.originalMessage === undefined ? null : (
              <>
                <Typography.Text type="secondary">
                  {labels.failureOriginalMessage}
                </Typography.Text>
                {text(failure.originalMessage.text)}
                {context.onRestore === undefined ? null : (
                  <Button
                    size="small"
                    disabled={context.restorationBlocked === true}
                    onClick={() => context.onRestore?.(item)}
                  >
                    {labels.restoreFailureDraft}
                  </Button>
                )}
                {context.restorationBlocked ? (
                  <Typography.Paragraph type="secondary">
                    {labels.failureUploadsPending}
                  </Typography.Paragraph>
                ) : null}
              </>
            )}
          </>
        }
      />
    </div>
  );
};
