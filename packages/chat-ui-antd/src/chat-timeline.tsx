import { ResourceLabelsProvider } from "./resource-labels.js";
import { Button, Empty, Typography, theme } from "antd";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";

import {
  getTimelineItemKey,
  type TimelineItem,
} from "@turingfocus/chat-protocol";

import { isChatEventItem, type ChatEventItem } from "./chat-event-detail.js";
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

const INTERACTIVE_EVENT_TARGET_SELECTOR = [
  "a[href]",
  "button",
  "input",
  "label",
  "select",
  "summary",
  "textarea",
  '[contenteditable]:not([contenteditable="false"])',
  "[data-chat-event-interactive]",
  '[role="button"]',
  '[role="checkbox"]',
  '[role="combobox"]',
  '[role="gridcell"]',
  '[role="link"]',
  '[role="listbox"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
  '[role="option"]',
  '[role="radio"]',
  '[role="searchbox"]',
  '[role="slider"]',
  '[role="spinbutton"]',
  '[role="switch"]',
  '[role="tab"]',
  '[role="textbox"]',
  '[role="treeitem"]',
].join(", ");

const isInteractiveEventTarget = (
  target: EventTarget | null,
  row: HTMLElement,
): boolean => {
  if (!(target instanceof Element) || target === row) return false;
  const interactiveTarget = target.closest(INTERACTIVE_EVENT_TARGET_SELECTOR);
  return interactiveTarget !== null && row.contains(interactiveTarget);
};

export interface ChatTimelineProps {
  readonly "aria-label"?: string | undefined;
  readonly className?: string | undefined;
  readonly conversationId: string;
  readonly formatTimestamp?: ((timestamp: number) => string) | undefined;
  readonly items: readonly TimelineItem[];
  readonly labels?: ChatUiLabelOverrides | undefined;
  readonly onEventSelect?:
    ((item: ChatEventItem, trigger: HTMLElement) => void) | undefined;
  readonly onRendererError?:
    ((failure: ChatRendererFailure) => void) | undefined;
  readonly renderers?: ChatRendererRegistry | undefined;
  readonly selectedEventId?: string | null | undefined;
  readonly style?: CSSProperties | undefined;
}

export const ChatTimeline = ({
  "aria-label": ariaLabel,
  className,
  conversationId,
  formatTimestamp = formatChatTimestampUtc,
  items,
  labels: labelOverrides,
  onEventSelect,
  onRendererError,
  renderers,
  selectedEventId,
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
    (_index: number, item: TimelineItem | undefined) => {
      if (item === undefined) return <div aria-hidden="true" />;
      const selectable = isChatEventItem(item) && onEventSelect !== undefined;
      const selected = isChatEventItem(item) && item.id === selectedEventId;
      const select = (trigger: HTMLElement) => {
        if (!isChatEventItem(item)) return;
        onEventSelect?.(item, trigger);
      };
      const handleClick = (event: MouseEvent<HTMLDivElement>) => {
        if (isInteractiveEventTarget(event.target, event.currentTarget)) return;
        const trigger = event.currentTarget.querySelector<HTMLElement>(
          "[data-chat-event-trigger]",
        );
        if (trigger !== null) select(trigger);
      };
      const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        select(event.currentTarget);
      };
      const selectionLabel = isChatEventItem(item)
        ? `${labels.openEventDetail}: ${
            item.kind === "unknown-event" ? item.originalType : item.eventType
          }`
        : labels.openEventDetail;
      return (
        <div
          {...(selectable
            ? {
                "aria-label": selectionLabel,
                onClick: handleClick,
                role: "group",
              }
            : { role: "article" })}
          style={{
            alignItems: "stretch",
            cursor: selectable ? "pointer" : undefined,
            display: "flex",
            gap: selectable ? token.marginXXS : undefined,
            outlineOffset: 2,
            padding: `${token.paddingXXS}px ${token.paddingSM}px`,
          }}
        >
          {selectable ? (
            <button
              aria-label={selectionLabel}
              aria-pressed={selected}
              data-chat-event-trigger={item.id}
              onClick={(event) => {
                event.stopPropagation();
                select(event.currentTarget);
              }}
              onKeyDown={handleKeyDown}
              style={{
                background: selected
                  ? token.colorPrimaryBg
                  : token.colorBgContainer,
                border: `1px solid ${
                  selected ? token.colorPrimary : token.colorBorderSecondary
                }`,
                borderRadius: token.borderRadius,
                color: token.colorPrimary,
                cursor: "pointer",
                minWidth: 28,
                padding: 0,
              }}
              title={selectionLabel}
              type="button"
            >
              <span aria-hidden="true">›</span>
            </button>
          ) : null}
          <div style={{ flex: 1, minWidth: 0 }}>
            <MemoizedTimelineItem
              displayMode="timeline"
              formatTimestamp={formatTimestamp}
              item={item}
              onRendererError={onRendererError}
              registry={registry}
              selected={selected}
            />
          </div>
        </div>
      );
    },
    [
      formatTimestamp,
      labels.openEventDetail,
      onEventSelect,
      onRendererError,
      registry,
      selectedEventId,
      token.borderRadius,
      token.colorBgContainer,
      token.colorBorderSecondary,
      token.colorPrimary,
      token.colorPrimaryBg,
      token.marginXXS,
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
    <ResourceLabelsProvider labels={labelOverrides}>
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
          computeItemKey={(index, item: TimelineItem | undefined) =>
            item === undefined
              ? `timeline:${conversationId}:pending:${index}`
              : getTimelineItemKey(item)
          }
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
    </ResourceLabelsProvider>
  );
};
