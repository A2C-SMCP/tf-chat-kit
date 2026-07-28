import { Button, Empty, Typography, theme } from "antd";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";

import {
  getTimelineItemKey,
  type TimelineItem,
} from "@turingfocus/chat-protocol";

import { resolveChatUiLabels } from "./labels.js";
import {
  ChatTimelineItem,
  createChatRendererRegistry,
  formatChatTimestampUtc,
  type ChatRendererFailure,
  type ChatRendererRegistry,
} from "./renderer-registry.js";
import {
  advanceTimelineTailState,
  createTimelineTailState,
  type TimelineTailState,
} from "./timeline-tail-tracker.js";
import type { ChatUiLabelOverrides } from "./types.js";

const MemoizedTimelineItem = memo(ChatTimelineItem);

const followNewOutput = (atBottom: boolean): "auto" | false =>
  atBottom ? "auto" : false;

export interface ChatTimelineProps {
  readonly "aria-label"?: string | undefined;
  readonly className?: string | undefined;
  readonly conversationId: string;
  readonly formatTimestamp?: ((timestamp: number) => string) | undefined;
  readonly items: readonly TimelineItem[];
  readonly labels?: ChatUiLabelOverrides | undefined;
  readonly onRendererError?:
    ((failure: ChatRendererFailure) => void) | undefined;
  readonly renderers?: ChatRendererRegistry | undefined;
  readonly style?: CSSProperties | undefined;
}

export const ChatTimeline = ({
  "aria-label": ariaLabel,
  className,
  conversationId,
  formatTimestamp = formatChatTimestampUtc,
  items,
  labels: labelOverrides,
  onRendererError,
  renderers,
  style,
}: ChatTimelineProps) => {
  const { token } = theme.useToken();
  const labels = resolveChatUiLabels(labelOverrides);
  const registry = useMemo(
    () => createChatRendererRegistry(renderers),
    [renderers],
  );
  const virtuosoRef = useRef<VirtuosoHandle | null>(null);
  const atBottomRef = useRef(true);
  const tailStateRef = useRef<TimelineTailState | null>(null);
  tailStateRef.current ??= createTimelineTailState(conversationId, items);
  const [newItemCount, setNewItemCount] = useState(0);

  useEffect(() => {
    const previous = tailStateRef.current!;
    const transition = advanceTimelineTailState(
      previous,
      conversationId,
      items,
    );

    if (previous.conversationId !== conversationId) {
      atBottomRef.current = true;
      setNewItemCount(0);
    } else if (!atBottomRef.current && transition.addedAfterTail > 0) {
      setNewItemCount((current) => current + transition.addedAfterTail);
    }

    tailStateRef.current = transition.state;
  }, [conversationId, items]);

  const handleAtBottomChange = useCallback((atBottom: boolean) => {
    atBottomRef.current = atBottom;
    if (atBottom) setNewItemCount(0);
  }, []);

  const jumpToLatest = useCallback(() => {
    if (items.length === 0) return;
    virtuosoRef.current?.scrollToIndex({
      align: "end",
      behavior: "smooth",
      index: items.length - 1,
    });
    setNewItemCount(0);
  }, [items.length]);

  const renderItem = useCallback(
    (_index: number, item: TimelineItem) => (
      <div
        role="article"
        style={{ padding: `${token.paddingXXS}px ${token.paddingSM}px` }}
      >
        <MemoizedTimelineItem
          formatTimestamp={formatTimestamp}
          item={item}
          onRendererError={onRendererError}
          registry={registry}
        />
      </div>
    ),
    [
      formatTimestamp,
      onRendererError,
      registry,
      token.paddingSM,
      token.paddingXXS,
    ],
  );

  if (items.length === 0) {
    return (
      <div
        aria-label={ariaLabel ?? labels.timelineLabel}
        className={className}
        role="log"
        style={{
          alignItems: "center",
          display: "flex",
          height: "100%",
          justifyContent: "center",
          minHeight: 240,
          ...style,
        }}
      >
        <Empty description={labels.emptyTimeline} />
      </div>
    );
  }

  return (
    <div
      className={className}
      style={{
        height: "100%",
        minHeight: 240,
        overflow: "hidden",
        position: "relative",
        ...style,
      }}
    >
      <Virtuoso
        key={conversationId}
        ref={virtuosoRef}
        aria-label={ariaLabel ?? labels.timelineLabel}
        atBottomStateChange={handleAtBottomChange}
        atBottomThreshold={150}
        computeItemKey={(_index, item) => getTimelineItemKey(item)}
        data={items}
        followOutput={followNewOutput}
        increaseViewportBy={{ bottom: 400, top: 200 }}
        initialItemCount={Math.min(items.length, 20)}
        initialTopMostItemIndex={Math.max(
          0,
          items.length - Math.min(items.length, 20),
        )}
        itemContent={renderItem}
        overscan={{ main: 300, reverse: 200 }}
        role="log"
        style={{ height: "100%" }}
      />
      {newItemCount === 0 ? null : (
        <Button
          onClick={jumpToLatest}
          size="small"
          style={{
            bottom: token.marginSM,
            boxShadow: token.boxShadowSecondary,
            left: "50%",
            position: "absolute",
            transform: "translateX(-50%)",
            zIndex: 1,
          }}
          type="primary"
        >
          <Typography.Text style={{ color: "inherit" }}>
            {newItemCount} {labels.newMessages} · {labels.jumpToLatest}
          </Typography.Text>
        </Button>
      )}
    </div>
  );
};
