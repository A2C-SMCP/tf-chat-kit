import { Alert, Skeleton, Typography, theme } from "antd";
import {
  Component,
  Suspense,
  createElement,
  type ComponentType,
  type ReactNode,
} from "react";

import type { Message, TimelineItem } from "@turingfocus/chat-protocol";

import {
  AgentEventRenderer,
  ToolEventRenderer,
  UnknownEventRenderer,
  getEventSummary,
} from "./event-renderers.js";
import { ChatResourceView } from "./resource-content.js";
import { ChatMarkdownContent } from "./markdown-content.js";

export type ChatRendererKey =
  | "agent-event"
  | `agent-event:${string}`
  | "message"
  | `message:${Message["content"]["kind"]}`
  | "unknown-event"
  | `unknown-event:${string}`;

export interface ChatRendererProps {
  readonly displayMode?: ChatRendererDisplayMode | undefined;
  readonly formatTimestamp: (timestamp: number) => string;
  readonly item: TimelineItem;
  readonly selected?: boolean | undefined;
}

export type ChatRendererDisplayMode = "detail" | "timeline";

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

export interface ChatMessageContentProps {
  readonly message: Message;
}

const MessageContentPartView = ({
  content,
}: {
  readonly content: Exclude<Message["content"], { readonly kind: "multipart" }>;
}) => {
  if (content.kind === "text") {
    return <ChatMarkdownContent>{content.text}</ChatMarkdownContent>;
  }
  if (
    (content.kind === "media" ||
      content.kind === "file" ||
      content.kind === "url") &&
    content.resource !== undefined
  ) {
    return (
      <ChatResourceView
        resource={content.resource}
        kind={content.kind === "media" ? content.mediaType : "file"}
        label={content.summary}
      />
    );
  }
  if (content.kind === "contact")
    return (
      <div aria-label="Contact card">
        {content.avatar === undefined ? null : (
          <ChatResourceView
            resource={content.avatar}
            kind="image"
            label={content.displayName ?? content.summary}
          />
        )}
        <Typography.Text>
          {content.displayName ?? content.summary}
        </Typography.Text>
      </div>
    );
  return (
    <Typography.Paragraph style={{ margin: 0, whiteSpace: "pre-wrap" }}>
      {content.summary}
    </Typography.Paragraph>
  );
};

export const ChatMessageContent = ({ message }: ChatMessageContentProps) =>
  message.content.kind === "multipart" ? (
    <div style={{ display: "grid", gap: 8 }}>
      {message.content.parts.map((part, index) => (
        <MessageContentPartView content={part} key={`${part.kind}:${index}`} />
      ))}
    </div>
  ) : (
    <MessageContentPartView content={message.content} />
  );

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
        <ChatMessageContent message={item} />
      </div>
    </div>
  );
};

export const defaultChatRendererRegistry: ChatRendererRegistry = Object.freeze({
  "agent-event:tool": ToolEventRenderer,
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
            {getEventSummary(item)}
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
  readonly displayMode: ChatRendererDisplayMode;
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
        previous.displayMode !== this.props.displayMode ||
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
  readonly displayMode?: ChatRendererDisplayMode | undefined;
  readonly formatTimestamp?: ((timestamp: number) => string) | undefined;
  readonly item: TimelineItem;
  readonly onRendererError?:
    ((failure: ChatRendererFailure) => void) | undefined;
  readonly registry: ChatRendererRegistry;
  readonly selected?: boolean | undefined;
}

export const ChatTimelineItem = ({
  displayMode = "detail",
  formatTimestamp = formatChatTimestampUtc,
  item,
  onRendererError,
  registry,
  selected,
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
      displayMode={displayMode}
      fallback={fallback}
      item={item}
      onError={onRendererError}
      renderer={renderer}
    >
      <Suspense fallback={<Skeleton active paragraph={{ rows: 2 }} />}>
        {createElement(renderer, {
          displayMode,
          formatTimestamp,
          item,
          selected,
        })}
      </Suspense>
    </RendererBoundary>
  );
};
