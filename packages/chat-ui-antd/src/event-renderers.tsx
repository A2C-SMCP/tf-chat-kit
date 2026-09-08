import { Alert, Card, Space, Tabs, Tag, Typography, theme } from "antd";
import type { ReactNode } from "react";

import type {
  AgentEvent,
  AgentEventStatus,
  AgentEventTransition,
  TimelineItem,
  ToolAgentEvent,
  ToolEventTransition,
  UnknownEvent,
} from "@turingfocus/chat-protocol";

import { AskUserInteractionResultView } from "./ask-user-interaction.js";
import type { ChatRendererProps } from "./renderer-registry.js";

import { ChatResourceView } from "./resource-content.js";
import { ToolPresentationView } from "./tool-presentation.js";

import { ValueInspector, serializeInspectionValue } from "./value-inspector.js";
import { ChatMarkdownContent } from "./markdown-content.js";

const statusColor = (
  status: string,
): "default" | "error" | "processing" | "success" =>
  status === "success"
    ? "success"
    : status === "failed" || status === "timeout"
      ? "error"
      : status === "running"
        ? "processing"
        : "default";

const isFailedStatus = (status: AgentEventStatus): boolean =>
  status === "failed" || status === "timeout";

const getEventTitle = (item: AgentEvent | UnknownEvent): string =>
  item.kind === "unknown-event" ? item.originalType : item.eventType;

export const getEventSummary = (item: TimelineItem): string => {
  if (item.kind === "message") {
    return item.content.kind === "text"
      ? item.content.text
      : item.content.summary;
  }
  if (item.kind === "unknown-event") return item.summary;
  if (item.eventCategory === "tool") {
    const call = latestToolField(item, (transition) => transition.toolCall);
    const presentation = latestToolField(
      item,
      (transition) => transition.toolReturn?.presentation,
    );
    if (call !== undefined)
      return `${presentation?.kind ?? "Tool"}: ${call.name} ${call.arguments === undefined ? "" : serializeInspectionValue(call.arguments).slice(0, 160)}`;
  }
  return (
    item.summary ??
    item.transitions.at(-1)?.summary ??
    `${item.eventType} (${item.status})`
  );
};

const EventCompactRow = ({
  failed: failedOverride,
  formatTimestamp,
  item,
  selected = false,
  status: statusOverride,
}: {
  readonly failed?: boolean | undefined;
  readonly formatTimestamp: (timestamp: number) => string;
  readonly item: AgentEvent | UnknownEvent;
  readonly selected?: boolean | undefined;
  readonly status?: string | undefined;
}) => {
  const { token } = theme.useToken();
  const status =
    statusOverride ?? (item.kind === "unknown-event" ? "unknown" : item.status);
  const failed =
    failedOverride ??
    (item.kind === "unknown-event" ? false : isFailedStatus(item.status));

  return (
    <div
      data-chat-event-row=""
      data-selected={selected ? "true" : "false"}
      style={{
        alignItems: "center",
        background: selected ? token.colorPrimaryBg : token.colorFillQuaternary,
        border: `1px solid ${
          failed
            ? token.colorError
            : selected
              ? token.colorPrimary
              : token.colorBorderSecondary
        }`,
        borderRadius: token.borderRadiusLG,
        display: "flex",
        gap: token.marginXS,
        minHeight: 42,
        padding: `${token.paddingXXS}px ${token.paddingSM}px`,
      }}
    >
      <Typography.Text
        aria-hidden="true"
        style={{ color: failed ? token.colorError : token.colorPrimary }}
      >
        ●
      </Typography.Text>
      <Typography.Text
        ellipsis={{ tooltip: getEventSummary(item) }}
        style={{ flex: 1, minWidth: 0 }}
      >
        {getEventSummary(item)}
      </Typography.Text>
      <Tag bordered={false} color={statusColor(status)}>
        {status}
      </Tag>
      <Typography.Text
        style={{ flexShrink: 0, fontSize: token.fontSizeSM }}
        type="secondary"
      >
        {formatTimestamp(item.createdAt)}
      </Typography.Text>
    </div>
  );
};

const TransitionContent = ({
  transition,
}: {
  readonly transition: AgentEventTransition;
}) => (
  <Space direction="vertical" size="small" style={{ width: "100%" }}>
    {transition.error === undefined ? null : (
      <Alert
        message={
          <ChatMarkdownContent>{transition.error.message}</ChatMarkdownContent>
        }
        showIcon
        type="error"
      />
    )}
    <Typography.Paragraph style={{ margin: 0, whiteSpace: "pre-wrap" }}>
      <ChatMarkdownContent>
        {transition.summary ?? `Transition ${transition.status}`}
      </ChatMarkdownContent>
    </Typography.Paragraph>
    {transition.content === undefined ? null : (
      <ValueInspector value={transition.content} />
    )}
  </Space>
);

const transitionTabs = (
  transitions: readonly AgentEventTransition[],
  formatTimestamp: (timestamp: number) => string,
  renderTransition: (transition: AgentEventTransition) => ReactNode,
) => (
  <Tabs
    defaultActiveKey={transitions[transitions.length - 1]!.id}
    items={transitions.map((transition) => ({
      children: renderTransition(transition),
      key: transition.id,
      label: `${transition.status} · ${formatTimestamp(transition.occurredAt)}`,
    }))}
    size="small"
    type="card"
  />
);

const AgentEventDetail = ({
  formatTimestamp,
  item,
}: {
  readonly formatTimestamp: (timestamp: number) => string;
  readonly item: AgentEvent;
}) => {
  const failed = isFailedStatus(item.status);
  return (
    <Card
      data-chat-event-detail=""
      extra={<Tag color={statusColor(item.status)}>{item.status}</Tag>}
      size="small"
      title={item.eventType}
    >
      <Space direction="vertical" size="small" style={{ width: "100%" }}>
        {failed ? (
          <Alert
            message={
              item.transitions.at(-1)?.error?.message ??
              item.summary ??
              "Event failed"
            }
            showIcon
            type="error"
          />
        ) : null}
        {item.summary === undefined ? null : (
          <Typography.Paragraph style={{ margin: 0, whiteSpace: "pre-wrap" }}>
            <ChatMarkdownContent>{item.summary}</ChatMarkdownContent>
          </Typography.Paragraph>
        )}
        {item.transitions.length > 1 ? (
          transitionTabs(item.transitions, formatTimestamp, (transition) => (
            <TransitionContent transition={transition} />
          ))
        ) : (
          <TransitionContent transition={item.transitions[0]!} />
        )}
        <Typography.Text type="secondary">
          {formatTimestamp(item.createdAt)}
        </Typography.Text>
      </Space>
    </Card>
  );
};

const latestToolField = <T,>(
  item: ToolAgentEvent,
  select: (transition: ToolEventTransition) => T | undefined,
): T | undefined => {
  for (let index = item.transitions.length - 1; index >= 0; index -= 1) {
    const value = select(item.transitions[index]!);
    if (value !== undefined) return value;
  }
  return undefined;
};

const ToolTransitionContent = ({
  transition,
}: {
  readonly transition: ToolEventTransition;
}) => (
  <Space direction="vertical" size="small" style={{ width: "100%" }}>
    {transition.error === undefined ? null : (
      <Alert
        message={
          <ChatMarkdownContent>{transition.error.message}</ChatMarkdownContent>
        }
        showIcon
        type="error"
      />
    )}
    {transition.summary === undefined ? null : (
      <Typography.Paragraph style={{ margin: 0, whiteSpace: "pre-wrap" }}>
        <ChatMarkdownContent>{transition.summary}</ChatMarkdownContent>
      </Typography.Paragraph>
    )}
    {transition.toolCall === undefined ? null : (
      <>
        <Typography.Text strong>{transition.toolCall.name}</Typography.Text>
        {transition.toolCall.arguments === undefined ? null : (
          <ValueInspector value={transition.toolCall.arguments} />
        )}
      </>
    )}
    {transition.toolReturn?.presentation === undefined ? null : (
      <ToolPresentationView presentation={transition.toolReturn.presentation} />
    )}
    {transition.toolReturn?.result === undefined ||
    transition.toolReturn.presentation !== undefined ? null : (
      <ValueInspector value={transition.toolReturn.result} />
    )}
    {transition.toolReturn?.attachments?.map((attachment, index) => (
      <ChatResourceView
        key={index}
        resource={attachment.resource}
        kind={attachment.kind === "image" ? "image" : "file"}
        label={
          attachment.resource.name ??
          `${attachment.kind} attachment ${index + 1}`
        }
      />
    ))}
    {transition.toolReturn === undefined ||
    (transition.toolReturn.success === undefined &&
      transition.toolReturn.done === undefined) ? null : (
      <Typography.Text type="secondary">
        {[
          transition.toolReturn.success === undefined
            ? undefined
            : `success: ${String(transition.toolReturn.success)}`,
          transition.toolReturn.done === undefined
            ? undefined
            : `done: ${String(transition.toolReturn.done)}`,
        ]
          .filter((value) => value !== undefined)
          .join(" · ")}
      </Typography.Text>
    )}
    {transition.interaction === undefined ? null : (
      <AskUserInteractionResultView result={transition.interaction} />
    )}
  </Space>
);

const ToolEventDetail = ({
  formatTimestamp,
  item,
}: {
  readonly formatTimestamp: (timestamp: number) => string;
  readonly item: ToolAgentEvent;
}) => {
  const latestCall = latestToolField(item, (transition) => transition.toolCall);
  const latestReturn = latestToolField(
    item,
    (transition) => transition.toolReturn,
  );
  const latestInteraction = latestToolField(
    item,
    (transition) => transition.interaction,
  );
  const failed =
    isFailedStatus(item.status) ||
    latestReturn?.success === false ||
    latestInteraction?.status === "failed" ||
    latestInteraction?.status === "timeout";
  const displayStatus =
    latestInteraction?.status ??
    (latestReturn?.success === false ? "failed" : item.status);

  return (
    <Card
      data-chat-event-detail=""
      extra={
        <Tag color={failed ? "error" : statusColor(displayStatus)}>
          {displayStatus}
        </Tag>
      }
      size="small"
      title={latestCall?.name ?? item.eventType}
    >
      <Space direction="vertical" size="small" style={{ width: "100%" }}>
        {failed ? (
          <Alert
            message={
              latestInteraction?.error ??
              item.transitions.at(-1)?.error?.message ??
              item.summary ??
              "Tool failed"
            }
            showIcon
            type="error"
          />
        ) : null}
        {item.transitions.length > 1 ? (
          transitionTabs(item.transitions, formatTimestamp, (transition) => (
            <ToolTransitionContent
              transition={transition as ToolEventTransition}
            />
          ))
        ) : (
          <ToolTransitionContent transition={item.transitions[0]!} />
        )}
        <Typography.Text type="secondary">
          {formatTimestamp(item.createdAt)}
        </Typography.Text>
      </Space>
    </Card>
  );
};

export const AgentEventRenderer = ({
  displayMode = "detail",
  formatTimestamp,
  item,
  selected,
}: ChatRendererProps) => {
  if (item.kind !== "agent-event") return null;
  if (displayMode === "timeline") {
    return (
      <EventCompactRow
        formatTimestamp={formatTimestamp}
        item={item}
        selected={selected}
      />
    );
  }
  return <AgentEventDetail formatTimestamp={formatTimestamp} item={item} />;
};

export const ToolEventRenderer = ({
  displayMode = "detail",
  formatTimestamp,
  item,
  selected,
}: ChatRendererProps) => {
  if (item.kind !== "agent-event" || item.eventCategory !== "tool") return null;
  if (displayMode === "timeline") {
    const toolReturn = latestToolField(
      item,
      (transition) => transition.toolReturn,
    );
    const interaction = latestToolField(
      item,
      (transition) => transition.interaction,
    );
    const failed =
      isFailedStatus(item.status) ||
      toolReturn?.success === false ||
      interaction?.status === "failed" ||
      interaction?.status === "timeout";
    const displayStatus =
      interaction?.status ??
      (toolReturn?.success === false ? "failed" : item.status);
    return (
      <EventCompactRow
        failed={failed}
        formatTimestamp={formatTimestamp}
        item={item}
        selected={selected}
        status={displayStatus}
      />
    );
  }
  return <ToolEventDetail formatTimestamp={formatTimestamp} item={item} />;
};

export const UnknownEventRenderer = ({
  displayMode = "detail",
  formatTimestamp,
  item,
  selected,
}: ChatRendererProps) => {
  if (item.kind !== "unknown-event") return null;
  if (displayMode === "timeline") {
    return (
      <EventCompactRow
        formatTimestamp={formatTimestamp}
        item={item}
        selected={selected}
      />
    );
  }
  return (
    <Alert
      data-chat-event-detail=""
      description={
        <>
          <Typography.Paragraph
            style={{ marginBottom: 4, whiteSpace: "pre-wrap" }}
          >
            <ChatMarkdownContent>{item.summary}</ChatMarkdownContent>
          </Typography.Paragraph>
          <Typography.Text type="secondary">
            {formatTimestamp(item.createdAt)}
          </Typography.Text>
        </>
      }
      message={`Unknown event: ${getEventTitle(item)}`}
      showIcon
      type="warning"
    />
  );
};
