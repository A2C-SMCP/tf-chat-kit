import {
  Alert,
  Button,
  Card,
  Space,
  Spin,
  Tabs,
  Tag,
  Typography,
  theme,
} from "antd";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { resolveChatUiLabels } from "./labels.js";
import type { ChatUiLabelOverrides } from "./types.js";

import { getGeneratedEventTexts } from "@turingfocus/chat-protocol";
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

import { ValueInspector } from "./value-inspector.js";
import { ChatMarkdownContent } from "./markdown-content.js";

export const EventTime = ({
  timestamp,
  formatTimestamp,
}: {
  timestamp: number;
  formatTimestamp: (timestamp: number) => string;
}) => {
  const full = formatTimestamp(timestamp);
  const time = full.match(/\b\d{2}:\d{2}:\d{2}\b/u)?.[0] ?? full;
  return <span title={full}>{time}</span>;
};

const IntermediateMessage = ({
  item,
  texts,
  formatTimestamp,
  labels: overrides,
}: {
  item: AgentEvent;
  texts: readonly string[];
  formatTimestamp: (timestamp: number) => string;
  labels?: ChatUiLabelOverrides | undefined;
}) => {
  const { token } = theme.useToken();
  const labels = resolveChatUiLabels(overrides);
  const content = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const id = useId();
  const [long, setLong] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const lineHeight = token.fontSize * token.lineHeight;
  useEffect(() => {
    const element = content.current;
    if (!element) return;
    const measure = () => {
      const first = element.firstElementChild?.getBoundingClientRect();
      const last = element.lastElementChild?.getBoundingClientRect();
      const height =
        first && last ? last.bottom - first.top : element.scrollHeight;
      setLong(height > lineHeight * 5 + 1);
    };
    measure();
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(measure);
    observer?.observe(element);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [texts, lineHeight]);
  const collapsed = long && !expanded;
  return (
    <div
      data-chat-generated-text=""
      style={{
        padding: "10px 16px",
        minWidth: 0,
        overflowWrap: "anywhere",
        borderLeft: `3px solid ${token.colorPrimaryBorder}`,
        background: token.colorFillQuaternary,
        borderRadius: 8,
      }}
    >
      <Typography.Text
        type="secondary"
        style={{ fontSize: 12, display: "block", marginBottom: 4 }}
      >
        {item.status === "running" ? <Spin size="small" /> : null}
        <EventTime
          timestamp={item.createdAt}
          formatTimestamp={formatTimestamp}
        />
      </Typography.Text>
      {isFailedStatus(item.status) ? (
        <Alert
          type="error"
          message={item.transitions.at(-1)?.error?.message ?? "Event failed"}
        />
      ) : null}
      <div
        ref={viewport}
        id={id}
        data-chat-progress-collapsed={collapsed ? "true" : "false"}
        onScroll={(event) => {
          if (collapsed && event.currentTarget.scrollTop !== 0) {
            event.currentTarget.scrollTop = 0;
            toggle.current?.focus({ preventScroll: true });
          }
        }}
        style={{
          maxHeight: collapsed ? lineHeight * 3 : undefined,
          overflow: collapsed ? "hidden" : undefined,
        }}
        onFocusCapture={(event) => {
          if (
            collapsed &&
            viewport.current &&
            event.target instanceof HTMLElement &&
            event.target.getBoundingClientRect().bottom >
              viewport.current.getBoundingClientRect().bottom
          )
            toggle.current?.focus({ preventScroll: true });
        }}
      >
        <div
          ref={content}
          style={{ display: "flow-root", lineHeight: `${lineHeight}px` }}
        >
          {texts
            .filter((text) => text.trim().length > 0)
            .map((text, index) => (
              <ChatMarkdownContent key={index}>{text}</ChatMarkdownContent>
            ))}
        </div>
      </div>
      {long ? (
        <Button
          ref={toggle}
          type="link"
          size="small"
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => setExpanded((value) => !value)}
          style={{ paddingInline: 0, marginTop: 4, height: "auto" }}
        >
          {expanded
            ? labels.collapseIntermediateMessage
            : labels.expandIntermediateMessage}
        </Button>
      ) : null}
    </div>
  );
};

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

export const isEmptyLlmEvent = (item: TimelineItem): boolean => {
  if (
    item.kind !== "agent-event" ||
    item.eventCategory !== "generic" ||
    item.eventType.toLowerCase() !== "llm"
  )
    return false;
  const texts = getGeneratedEventTexts(item) ?? [
    item.transitions.at(-1)?.summary ?? item.summary ?? "",
  ];
  return (
    !texts.some((text) => text.trim()) &&
    !isFailedStatus(item.status) &&
    item.status !== "running"
  );
};

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
      return `${presentation?.kind ?? "Tool"} · ${call.name.split("__").at(-1) ?? call.name}`;
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
        <EventTime
          timestamp={item.createdAt}
          formatTimestamp={formatTimestamp}
        />
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
          <ValueInspector
            value={transition.toolCall.arguments}
            label="输入参数"
          />
        )}
      </>
    )}
    {transition.toolReturn?.presentation === undefined ? null : (
      <ToolPresentationView presentation={transition.toolReturn.presentation} />
    )}
    {transition.toolReturn?.result === undefined ||
    transition.toolReturn.presentation !== undefined ? null : (
      <ValueInspector value={transition.toolReturn.result} label="执行结果" />
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
  labels,
  displayMode = "detail",
  formatTimestamp,
  item,
  selected,
}: ChatRendererProps) => {
  if (item.kind !== "agent-event") return null;
  const generated = getGeneratedEventTexts(item);
  const isLlm =
    item.eventCategory === "generic" && item.eventType.toLowerCase() === "llm";
  const texts = generated ?? [
    item.transitions.at(-1)?.summary ?? item.summary ?? "",
  ];
  if (isLlm && displayMode === "timeline") {
    if (isEmptyLlmEvent(item)) return null;
    return (
      <IntermediateMessage
        item={item}
        texts={texts}
        formatTimestamp={formatTimestamp}
        labels={labels}
      />
    );
  }
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
