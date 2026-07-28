import { Alert, Card, Skeleton, Tag, Typography, theme } from "antd";
import {
  Component,
  Suspense,
  createElement,
  type ComponentType,
  type ReactNode,
} from "react";

import type { Message, TimelineItem } from "@turingfocus/chat-protocol";

export type ChatRendererKey =
  | "agent-event"
  | `agent-event:${string}`
  | "message"
  | `message:${Message["content"]["kind"]}`
  | "unknown-event"
  | `unknown-event:${string}`;

export interface ChatRendererProps {
  readonly formatTimestamp: (timestamp: number) => string;
  readonly item: TimelineItem;
}

export type ChatRenderer = ComponentType<ChatRendererProps>;
/**
 * A `null` entry explicitly stops candidate resolution and selects the safe
 * fallback. An absent entry continues to the next, more general key.
 */
export type ChatRendererRegistry = Readonly<
  Partial<Record<ChatRendererKey, ChatRenderer | null>>
>;

export interface ChatRendererFailure {
  readonly error: unknown;
  readonly item: TimelineItem;
}

export const formatChatTimestampUtc = (timestamp: number): string => {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "Unknown time";
  const iso = date.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;
};

const getItemSummary = (item: TimelineItem): string => {
  if (item.kind === "message") {
    return item.content.kind === "text"
      ? item.content.text
      : item.content.summary;
  }
  if (item.kind === "unknown-event") return item.summary;
  return (
    item.summary ??
    item.transitions.at(-1)?.summary ??
    `${item.eventType} (${item.status})`
  );
};

const MessageRenderer = ({ formatTimestamp, item }: ChatRendererProps) => {
  if (item.kind !== "message") return null;
  const { token } = theme.useToken();
  const isUser = item.role === "user";

  return (
    <div
      style={{
        display: "flex",
        justifyContent: isUser ? "flex-end" : "flex-start",
      }}
    >
      <div
        style={{
          background: isUser ? token.colorPrimaryBg : token.colorFillQuaternary,
          borderRadius: token.borderRadiusLG,
          maxWidth: "min(48rem, 85%)",
          padding: `${token.paddingXS}px ${token.paddingSM}px`,
          wordBreak: "break-word",
        }}
      >
        <Typography.Text
          style={{ display: "block", fontSize: token.fontSizeSM }}
          type="secondary"
        >
          {item.author?.displayName ?? item.role} ·{" "}
          {formatTimestamp(item.createdAt)}
        </Typography.Text>
        <Typography.Paragraph style={{ margin: 0, whiteSpace: "pre-wrap" }}>
          {getItemSummary(item)}
        </Typography.Paragraph>
      </div>
    </div>
  );
};

const AgentEventRenderer = ({ formatTimestamp, item }: ChatRendererProps) => {
  if (item.kind !== "agent-event") return null;
  const statusColor =
    item.status === "success"
      ? "success"
      : item.status === "failed" || item.status === "timeout"
        ? "error"
        : item.status === "running"
          ? "processing"
          : "default";

  return (
    <Card
      extra={<Tag color={statusColor}>{item.status}</Tag>}
      size="small"
      title={item.eventType}
    >
      <Typography.Paragraph style={{ marginBottom: 4, whiteSpace: "pre-wrap" }}>
        {getItemSummary(item)}
      </Typography.Paragraph>
      <Typography.Text type="secondary">
        {formatTimestamp(item.createdAt)}
      </Typography.Text>
    </Card>
  );
};

const UnknownEventRenderer = ({ formatTimestamp, item }: ChatRendererProps) => {
  if (item.kind !== "unknown-event") return null;

  return (
    <Alert
      description={
        <>
          <Typography.Paragraph
            style={{ marginBottom: 4, whiteSpace: "pre-wrap" }}
          >
            {item.summary}
          </Typography.Paragraph>
          <Typography.Text type="secondary">
            {formatTimestamp(item.createdAt)}
          </Typography.Text>
        </>
      }
      message={`Unknown event: ${item.originalType}`}
      showIcon
      type="warning"
    />
  );
};

export const defaultChatRendererRegistry: ChatRendererRegistry = Object.freeze({
  "agent-event": AgentEventRenderer,
  message: MessageRenderer,
  "unknown-event": UnknownEventRenderer,
});

export const createChatRendererRegistry = (
  overrides?: ChatRendererRegistry | undefined,
): ChatRendererRegistry =>
  Object.freeze({ ...defaultChatRendererRegistry, ...overrides });

const getRendererCandidates = (
  item: TimelineItem,
): readonly ChatRendererKey[] => {
  switch (item.kind) {
    case "message":
      return [`message:${item.content.kind}`, "message"];
    case "agent-event":
      return [
        `agent-event:${item.eventType}`,
        `agent-event:${item.eventCategory}`,
        "agent-event",
      ];
    case "unknown-event":
      return [`unknown-event:${item.originalType}`, "unknown-event"];
  }
  throw new Error("Unsupported timeline item");
};

export const resolveChatRenderer = (
  registry: ChatRendererRegistry,
  item: TimelineItem,
): ChatRenderer | undefined => {
  for (const key of getRendererCandidates(item)) {
    const renderer = registry[key];
    if (renderer === null) return undefined;
    if (renderer !== undefined) return renderer;
  }
  return undefined;
};

const SafeItemFallback = ({
  failed,
  formatTimestamp,
  item,
}: {
  readonly failed: boolean;
  readonly formatTimestamp: (timestamp: number) => string;
  readonly item: TimelineItem;
}) => {
  const title =
    item.kind === "message"
      ? `Message from ${item.role}`
      : item.kind === "agent-event"
        ? item.eventType
        : item.originalType;

  return (
    <Alert
      description={
        <>
          <Typography.Paragraph
            style={{ marginBottom: 4, whiteSpace: "pre-wrap" }}
          >
            {getItemSummary(item)}
          </Typography.Paragraph>
          <Typography.Text type="secondary">
            {formatTimestamp(item.createdAt)}
          </Typography.Text>
        </>
      }
      message={failed ? `Renderer unavailable: ${title}` : title}
      showIcon
      type={failed ? "error" : "info"}
    />
  );
};

interface RendererBoundaryProps {
  readonly children: ReactNode;
  readonly fallback: ReactNode;
  readonly item: TimelineItem;
  readonly onError?: ((failure: ChatRendererFailure) => void) | undefined;
  readonly renderer?: ChatRenderer | undefined;
}

interface RendererBoundaryState {
  readonly failed: boolean;
}

class RendererBoundary extends Component<
  RendererBoundaryProps,
  RendererBoundaryState
> {
  override state: RendererBoundaryState = { failed: false };

  static getDerivedStateFromError(): RendererBoundaryState {
    return { failed: true };
  }

  override componentDidCatch(error: unknown): void {
    try {
      this.props.onError?.({ error, item: this.props.item });
    } catch {
      // Host diagnostics must not defeat the renderer isolation boundary.
    }
  }

  override componentDidUpdate(previous: RendererBoundaryProps): void {
    if (
      this.state.failed &&
      (previous.item !== this.props.item ||
        previous.renderer !== this.props.renderer)
    ) {
      this.setState({ failed: false });
    }
  }

  override render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export interface ChatTimelineItemProps {
  readonly formatTimestamp?: ((timestamp: number) => string) | undefined;
  readonly item: TimelineItem;
  readonly onRendererError?:
    ((failure: ChatRendererFailure) => void) | undefined;
  readonly registry: ChatRendererRegistry;
}

export const ChatTimelineItem = ({
  formatTimestamp = formatChatTimestampUtc,
  item,
  onRendererError,
  registry,
}: ChatTimelineItemProps) => {
  const renderer = resolveChatRenderer(registry, item);
  const fallback = (
    <SafeItemFallback
      failed={renderer !== undefined}
      formatTimestamp={formatTimestamp}
      item={item}
    />
  );

  if (renderer === undefined) return fallback;

  return (
    <RendererBoundary
      fallback={fallback}
      item={item}
      onError={onRendererError}
      renderer={renderer}
    >
      <Suspense fallback={<Skeleton active paragraph={{ rows: 2 }} />}>
        {createElement(renderer, { formatTimestamp, item })}
      </Suspense>
    </RendererBoundary>
  );
};
