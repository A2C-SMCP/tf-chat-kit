import { ConversationFailureLabelsProvider } from "./conversation-failure-card.js";
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
  getConversationFailure,
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
import { isEmptyLlmEvent } from "./event-renderers.js";

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
  items: sourceItems,
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
  const items = useMemo(
    () =>
      sourceItems.filter((item) => {
        if (!isEmptyLlmEvent(item) || item.kind !== "agent-event") return true;
        return [
          `agent-event:${item.eventType}`,
          `agent-event:${item.eventCategory}`,
          "agent-event",
        ].some((key) =>
          Object.prototype.hasOwnProperty.call(renderers ?? {}, key),
        );
      }),
    [sourceItems, renderers],
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
      const selectable =
        isChatEventItem(item) &&
        getConversationFailure(item) === undefined &&
        onEventSelect !== undefined;
      const selected = isChatEventItem(item) && item.id === selectedEventId;
      const select = (trigger: HTMLElement) => {
        if (!isChatEventItem(item)) return;
        onEventSelect?.(item, trigger);
      };
      const handleClick = (event: MouseEvent<HTMLDivElement>) => {
        if (isInteractiveEventTarget(event.target, event.currentTarget)) return;
        const selection = event.currentTarget.ownerDocument.getSelection();
        if (
          selection &&
          !selection.isCollapsed &&
          (event.currentTarget.contains(selection.anchorNode) ||
            event.currentTarget.contains(selection.focusNode))
        )
          return;
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
            outlineOffset: 2,
            padding: `${token.paddingXXS}px ${token.paddingSM}px`,
          }}
        >
          <div
            className={selectable ? "tf-chat-event-card" : undefined}
            data-event-selected={selectable && selected ? "true" : undefined}
            style={
              {
                flex: 1,
                minWidth: 0,
                position: "relative",
                borderRadius: token.borderRadiusLG,
                "--tf-event-hover": token.colorFillTertiary,
                "--tf-event-outline": token.colorPrimaryBorder,
                "--tf-event-primary": token.colorPrimary,
                "--tf-event-button-bg": token.colorBgContainer,
              } as CSSProperties
            }
          >
            <div className={selectable ? "tf-chat-event-content" : undefined}>
              <MemoizedTimelineItem
                labels={labelOverrides}
                displayMode="timeline"
                formatTimestamp={formatTimestamp}
                item={item}
                onRendererError={onRendererError}
                registry={registry}
                selected={selected}
              />
            </div>
            {selectable ? (
              <button
                className="tf-chat-event-detail-action"
                aria-label={selectionLabel}
                aria-pressed={selected}
                data-chat-event-trigger={item.id}
                onClick={(event) => {
                  event.stopPropagation();
                  select(event.currentTarget);
                }}
                onKeyDown={handleKeyDown}
                title={selectionLabel}
                type="button"
              >
                <svg
                  aria-hidden="true"
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <rect x="3" y="4" width="18" height="16" rx="3" />
                  <path d="M14 4v16M6.5 9h4M6.5 13h4" />
                </svg>
              </button>
            ) : null}
          </div>
        </div>
      );
    },
    [
      formatTimestamp,
      labels.openEventDetail,
      labelOverrides,
      onEventSelect,
      onRendererError,
      registry,
      selectedEventId,
      token.borderRadiusLG,
      token.colorBgContainer,
      token.colorPrimaryBorder,
      token.colorFillTertiary,
      token.colorPrimary,
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
    <ConversationFailureLabelsProvider labels={labelOverrides}>
      <ResourceLabelsProvider labels={labelOverrides}>
        <style>{`
          .tf-chat-event-content { padding-inline-end: 36px; min-width: 0; }
          .tf-chat-event-content > [data-chat-event-row],
          .tf-chat-event-content > [data-chat-generated-text] { margin-inline-end: -36px; padding-inline-end: 44px !important; }
          .tf-chat-event-card:hover > .tf-chat-event-content > [data-chat-event-row],
          .tf-chat-event-card:hover > .tf-chat-event-content > [data-chat-generated-text] { background: var(--tf-event-hover) !important; }
          .tf-chat-event-card:hover { background: var(--tf-event-hover); box-shadow: 0 0 0 1px var(--tf-event-outline); }
          .tf-chat-event-card[data-event-selected="true"], .tf-chat-event-card:focus-within { box-shadow: 0 0 0 1px var(--tf-event-outline); }
          .tf-chat-event-detail-action { position: absolute; inset-inline-end: 8px; top: 8px; display: grid; place-items: center; width: 26px; height: 26px; padding: 0; border: 0; border-radius: 6px; color: var(--tf-event-primary); background: var(--tf-event-button-bg); cursor: pointer; opacity: 0; }
          .tf-chat-event-card:hover .tf-chat-event-detail-action,
          .tf-chat-event-card:focus-within .tf-chat-event-detail-action { opacity: 1; }
          .tf-chat-event-detail-action:focus-visible { outline: 2px solid var(--tf-event-primary); outline-offset: 2px; }
          @media (hover: none) { .tf-chat-event-detail-action { opacity: 1; } }
        `}</style>
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
    </ConversationFailureLabelsProvider>
  );
};
