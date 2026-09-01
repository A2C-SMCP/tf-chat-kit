import { Alert, Modal, Segmented, Typography, theme } from "antd";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";

import {
  isChatLifecycleOperable,
  type ChatError,
  type ChatSnapshot,
} from "@turingfocus/chat-protocol";
import {
  useChatAttachmentUploader,
  useChatClient,
  useChatSelector,
  useComposerDraft,
} from "@turingfocus/chat-react";

import { ChatComposer } from "./chat-composer.js";
import {
  ChatEventDetail,
  ChatEventDetailEmpty,
  isChatEventItem,
  type ChatEventDetailMode,
  type ChatEventItem,
  type ResolvedChatEventDetailMode,
} from "./chat-event-detail.js";
import {
  AskUserInteractionCard,
  type AskUserChatAboutThisRequest,
} from "./ask-user-interaction.js";
import { ChatRunStatus } from "./chat-run-status.js";
import { ChatStateView } from "./chat-state-view.js";
import { ChatTimeline } from "./chat-timeline.js";
import { resolveChatUiLabels } from "./labels.js";
import {
  EventDetailSplitLayout,
  normalizeEventDetailSplitRatio,
} from "./event-detail-split-layout.js";
import type {
  ChatRendererFailure,
  ChatRendererRegistry,
} from "./renderer-registry.js";
import type { ChatUiLabelOverrides } from "./types.js";
import {
  useChatCommandCoordinator,
  type ChatUiCommand,
  type ChatUiCommandFailure,
} from "./use-chat-command-coordinator.js";

export type { ChatUiCommand, ChatUiCommandFailure };

export interface ChatConversationViewProps {
  readonly className?: string | undefined;
  readonly defaultEventDetailMode?: ChatEventDetailMode | undefined;
  readonly defaultSelectedEventId?: string | null | undefined;
  readonly eventDetailMode?: ChatEventDetailMode | undefined;
  readonly eventDetailSplitBreakpoint?: number | undefined;
  /** Initial timeline share for uncontrolled split layout; clamped to 0.2–0.8. */
  readonly defaultEventDetailSplitRatio?: number | undefined;
  readonly formatTimestamp?: ((timestamp: number) => string) | undefined;
  readonly getDeadlineAt: () => number;
  readonly labels?: ChatUiLabelOverrides | undefined;
  readonly onCommandError?:
    ((failure: ChatUiCommandFailure) => void) | undefined;
  readonly onEventDetailModeChange?:
    ((mode: ChatEventDetailMode) => void) | undefined;
  /**
   * Called once when a pointer resize finishes and after each keyboard resize.
   * Hosts can persist the normalized timeline share supplied here.
   */
  readonly onEventDetailSplitRatioChange?:
    ((ratio: number) => void) | undefined;
  readonly onChatAboutThis?:
    ((request: AskUserChatAboutThisRequest) => void) | undefined;
  readonly onRendererError?:
    ((failure: ChatRendererFailure) => void) | undefined;
  readonly onSelectedEventChange?:
    ((eventId: string | null, item: ChatEventItem | null) => void) | undefined;
  readonly renderers?: ChatRendererRegistry | undefined;
  /** Controlled timeline share for split layout; clamped to 0.2–0.8. */
  readonly eventDetailSplitRatio?: number | undefined;
  readonly selectedEventId?: string | null | undefined;
  readonly style?: CSSProperties | undefined;
}

interface ChatConversationViewSnapshot {
  readonly capabilities: ChatSnapshot["capabilities"];
  readonly conversationId: string;
  readonly error: ChatError | undefined;
  readonly lifecycle: ChatSnapshot["lifecycle"];
  readonly pendingInteraction: ChatSnapshot["pendingInteraction"];
  readonly run: ChatSnapshot["run"];
  readonly timeline: ChatSnapshot["timeline"];
}

const selectChatConversationViewSnapshot = (
  snapshot: ChatSnapshot | null,
): ChatConversationViewSnapshot | null =>
  snapshot === null
    ? null
    : {
        capabilities: snapshot.capabilities,
        conversationId: snapshot.conversation.id,
        error: snapshot.error,
        lifecycle: snapshot.lifecycle,
        pendingInteraction: snapshot.pendingInteraction,
        run: snapshot.run,
        timeline: snapshot.timeline,
      };

const equalChatConversationViewSnapshot = (
  left: ChatConversationViewSnapshot | null,
  right: ChatConversationViewSnapshot | null,
): boolean =>
  left === right ||
  (left !== null &&
    right !== null &&
    left.capabilities === right.capabilities &&
    left.conversationId === right.conversationId &&
    left.error === right.error &&
    left.lifecycle === right.lifecycle &&
    left.pendingInteraction === right.pendingInteraction &&
    left.run === right.run &&
    left.timeline === right.timeline);

export const ChatConversationView = ({
  className,
  defaultEventDetailMode = "auto",
  defaultEventDetailSplitRatio,
  defaultSelectedEventId = null,
  eventDetailMode: controlledEventDetailMode,
  eventDetailSplitBreakpoint = 800,
  eventDetailSplitRatio,
  formatTimestamp,
  getDeadlineAt,
  labels: labelOverrides,
  onChatAboutThis,
  onCommandError,
  onEventDetailModeChange,
  onEventDetailSplitRatioChange,
  onRendererError,
  onSelectedEventChange,
  renderers,
  selectedEventId: controlledSelectedEventId,
  style,
}: ChatConversationViewProps) => {
  const { token } = theme.useToken();
  const labels = resolveChatUiLabels(labelOverrides);
  const client = useChatClient();
  const snapshot = useChatSelector(
    selectChatConversationViewSnapshot,
    equalChatConversationViewSnapshot,
  );
  const attachmentUploader = useChatAttachmentUploader();
  const composer = useComposerDraft(snapshot?.conversationId ?? "");
  const activeRecoveryUnverified =
    snapshot?.lifecycle?.status === "active" &&
    (snapshot.lifecycle.recovery?.complete === false ||
      ((snapshot.lifecycle.reconnectAttempt ?? 0) > 0 &&
        snapshot.lifecycle.recovery?.complete !== true));
  const lifecycleOperable = isChatLifecycleOperable(snapshot?.lifecycle);
  const lifecycleDisplayStatus = activeRecoveryUnverified
    ? "recovering"
    : snapshot?.lifecycle?.status;
  const {
    answerInteraction,
    dismissFailure,
    interrupt,
    sendText,
    viewResetKey,
    visibleCommandFailures,
    visibleSnapshotError,
  } = useChatCommandCoordinator({
    canAnswerInteraction:
      lifecycleOperable && snapshot?.capabilities.answerInteraction === true,
    canInterrupt:
      lifecycleOperable && (snapshot?.capabilities.interrupt ?? false),
    client,
    conversationId: snapshot?.conversationId ?? null,
    getDeadlineAt,
    interactionRequest:
      snapshot?.pendingInteraction === undefined
        ? undefined
        : {
            requestId: snapshot.pendingInteraction.requestId,
            revision: snapshot.pendingInteraction.revision,
          },
    onCommandError,
    run: snapshot?.run ?? null,
    snapshotError: snapshot?.error,
  });
  const [uncontrolledEventDetailMode, setUncontrolledEventDetailMode] =
    useState<ChatEventDetailMode>(defaultEventDetailMode);
  const [
    uncontrolledEventDetailSplitRatio,
    setUncontrolledEventDetailSplitRatio,
  ] = useState(() =>
    normalizeEventDetailSplitRatio(defaultEventDetailSplitRatio),
  );
  const [uncontrolledSelectedEventId, setUncontrolledSelectedEventId] =
    useState<string | null>(defaultSelectedEventId);
  const [containerWidth, setContainerWidth] = useState<number | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const layoutRef = useRef<HTMLDivElement | null>(null);
  const lastTriggerRef = useRef<HTMLElement | null>(null);
  const wasModalOpenRef = useRef(false);
  const currentConversationId = snapshot?.conversationId ?? null;
  const requestedEventDetailMode =
    controlledEventDetailMode ?? uncontrolledEventDetailMode;
  const selectedEventId =
    controlledSelectedEventId === undefined
      ? uncontrolledSelectedEventId
      : controlledSelectedEventId;
  const controlledEventDetailSplitRatio =
    eventDetailSplitRatio === undefined
      ? undefined
      : normalizeEventDetailSplitRatio(eventDetailSplitRatio);
  const resolvedEventDetailSplitRatio =
    controlledEventDetailSplitRatio ?? uncontrolledEventDetailSplitRatio;
  const splitBreakpoint =
    Number.isFinite(eventDetailSplitBreakpoint) &&
    eventDetailSplitBreakpoint > 0
      ? eventDetailSplitBreakpoint
      : 800;
  const resolvedEventDetailMode: ResolvedChatEventDetailMode =
    requestedEventDetailMode === "auto"
      ? containerWidth === null || containerWidth >= splitBreakpoint
        ? "split"
        : "modal"
      : requestedEventDetailMode;
  const selectedEvent = useMemo(
    () =>
      snapshot?.timeline.find(
        (item): item is ChatEventItem =>
          isChatEventItem(item) && item.id === selectedEventId,
      ),
    [selectedEventId, snapshot?.timeline],
  );
  const hasSelectedEvent = selectedEvent !== undefined;
  const eventDetailModalVisible =
    resolvedEventDetailMode === "modal" &&
    modalOpen &&
    selectedEvent !== undefined;

  useEffect(() => {
    const element = layoutRef.current;
    if (element === null) return;
    const measure = (width: number) => {
      if (Number.isFinite(width)) setContainerWidth(width);
    };
    measure(element.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry !== undefined) measure(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [currentConversationId]);

  const updateSelection = useCallback(
    (eventId: string | null, item: ChatEventItem | null) => {
      if (controlledSelectedEventId === undefined) {
        setUncontrolledSelectedEventId(eventId);
      }
      onSelectedEventChange?.(eventId, item);
    },
    [controlledSelectedEventId, onSelectedEventChange],
  );

  const previousConversationIdRef = useRef<string | null>(
    currentConversationId,
  );
  useEffect(() => {
    const previousConversationId = previousConversationIdRef.current;
    previousConversationIdRef.current = currentConversationId;
    if (
      previousConversationId === null ||
      previousConversationId === currentConversationId
    ) {
      return;
    }
    lastTriggerRef.current = null;
    setModalOpen(false);
    if (selectedEventId !== null) updateSelection(null, null);
  }, [currentConversationId, selectedEventId, updateSelection]);

  useEffect(() => {
    if (
      snapshot === null ||
      selectedEventId === null ||
      selectedEvent !== undefined
    ) {
      return;
    }
    lastTriggerRef.current = null;
    setModalOpen(false);
    updateSelection(null, null);
  }, [selectedEvent, selectedEventId, snapshot, updateSelection]);

  useEffect(() => {
    if (resolvedEventDetailMode === "split") {
      setModalOpen(false);
    } else if (hasSelectedEvent) {
      setModalOpen(true);
    }
  }, [hasSelectedEvent, resolvedEventDetailMode, selectedEventId]);

  const restoreTriggerFocus = useCallback(() => {
    if (lastTriggerRef.current?.isConnected === true) {
      lastTriggerRef.current.focus({ preventScroll: true });
    }
  }, []);

  useEffect(() => {
    const wasModalOpen = wasModalOpenRef.current;
    wasModalOpenRef.current = modalOpen;
    if (!wasModalOpen || modalOpen) return;
    const timer = setTimeout(restoreTriggerFocus, 0);
    return () => clearTimeout(timer);
  }, [modalOpen, restoreTriggerFocus]);

  useEffect(() => {
    if (!eventDetailModalVisible) return;
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setModalOpen(false);
    };
    document.addEventListener("keydown", closeOnEscape, true);
    return () => document.removeEventListener("keydown", closeOnEscape, true);
  }, [eventDetailModalVisible]);

  const selectEvent = useCallback(
    (item: ChatEventItem, trigger: HTMLElement) => {
      lastTriggerRef.current = trigger;
      updateSelection(item.id, item);
      setModalOpen(resolvedEventDetailMode === "modal");
    },
    [resolvedEventDetailMode, updateSelection],
  );

  const changeEventDetailMode = useCallback(
    (value: string | number) => {
      if (value !== "auto" && value !== "modal" && value !== "split") return;
      if (controlledEventDetailMode === undefined) {
        setUncontrolledEventDetailMode(value);
      }
      onEventDetailModeChange?.(value);
    },
    [controlledEventDetailMode, onEventDetailModeChange],
  );

  const changeEventDetailSplitRatio = useCallback(
    (ratio: number) => {
      if (controlledEventDetailSplitRatio === undefined) {
        setUncontrolledEventDetailSplitRatio(ratio);
      }
      onEventDetailSplitRatioChange?.(ratio);
    },
    [controlledEventDetailSplitRatio, onEventDetailSplitRatioChange],
  );

  const eventDetailModeOptions = useMemo(
    () => [
      { label: labels.eventDetailModeAuto, value: "auto" },
      { label: labels.eventDetailModeSplit, value: "split" },
      { label: labels.eventDetailModeModal, value: "modal" },
    ],
    [
      labels.eventDetailModeAuto,
      labels.eventDetailModeModal,
      labels.eventDetailModeSplit,
    ],
  );

  if (snapshot === null) {
    return <ChatStateView labels={labels} state={{ kind: "loading" }} />;
  }

  const conversationId = snapshot.conversationId;
  const timeline = (
    <ChatTimeline
      key={viewResetKey}
      conversationId={conversationId}
      formatTimestamp={formatTimestamp}
      items={snapshot.timeline}
      labels={labels}
      onEventSelect={selectEvent}
      onRendererError={onRendererError}
      renderers={renderers}
      selectedEventId={selectedEventId}
    />
  );
  const eventDetail = (
    <aside
      aria-label={String(labels.eventDetailTitle)}
      style={{
        boxSizing: "border-box",
        minHeight: 0,
        overflow: "auto",
        padding: token.paddingSM,
      }}
    >
      {selectedEvent === undefined ? (
        <ChatEventDetailEmpty labels={labels} />
      ) : (
        <ChatEventDetail
          formatTimestamp={formatTimestamp}
          item={selectedEvent}
          onRendererError={onRendererError}
          renderers={renderers}
        />
      )}
    </aside>
  );

  return (
    <section
      className={className}
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
        ...style,
      }}
    >
      <ChatRunStatus
        key={`${viewResetKey}:${snapshot.run?.id ?? "no-run"}`}
        canInterrupt={lifecycleOperable && snapshot.capabilities.interrupt}
        labels={labels}
        onInterrupt={interrupt}
        run={snapshot.run}
        showInterruptButton={false}
      />
      {snapshot.lifecycle === undefined ||
      (snapshot.lifecycle.status === "active" &&
        !activeRecoveryUnverified) ? null : (
        <Alert
          message={
            lifecycleDisplayStatus === undefined
              ? undefined
              : labels.lifecycleStatus?.[lifecycleDisplayStatus]
          }
          showIcon
          style={{ margin: token.marginXS }}
          type={
            snapshot.lifecycle.status === "auth-required" ||
            snapshot.lifecycle.status === "subscription-failed" ||
            snapshot.lifecycle.status === "offline"
              ? "warning"
              : "info"
          }
        />
      )}
      {visibleSnapshotError === undefined ? null : (
        <Alert
          message={visibleSnapshotError.message}
          showIcon
          style={{ margin: token.marginXS }}
          type="error"
        />
      )}
      {visibleCommandFailures.map((failure) => (
        <Alert
          key={failure.command}
          closable
          message={failure.error.message}
          onClose={() => {
            dismissFailure(failure.command);
          }}
          showIcon
          style={{ margin: token.marginXS }}
          type="error"
        />
      ))}
      <div
        style={{
          alignItems: "center",
          display: "flex",
          gap: token.marginXS,
          justifyContent: "flex-end",
          padding: `${token.paddingXXS}px ${token.paddingSM}px`,
        }}
      >
        <Typography.Text type="secondary">
          {labels.eventDetailModeLabel}
        </Typography.Text>
        <Segmented
          aria-label={labels.eventDetailModeLabel}
          onChange={changeEventDetailMode}
          options={eventDetailModeOptions}
          size="small"
          value={requestedEventDetailMode}
        />
      </div>
      <div
        data-chat-event-layout={resolvedEventDetailMode}
        ref={layoutRef}
        style={{ display: "flex", flex: 1, minHeight: 0, minWidth: 0 }}
      >
        <EventDetailSplitLayout
          ariaLabel={
            labels.eventDetailSplitHandleLabel ?? "Resize event detail panes"
          }
          detail={eventDetail}
          onRatioChange={changeEventDetailSplitRatio}
          ratio={resolvedEventDetailSplitRatio}
          resizable={
            controlledEventDetailSplitRatio === undefined ||
            onEventDetailSplitRatioChange !== undefined
          }
          split={resolvedEventDetailMode === "split"}
          timeline={timeline}
        />
      </div>
      {snapshot.pendingInteraction === undefined ? null : (
        <div style={{ padding: token.paddingXS }}>
          <AskUserInteractionCard
            key={JSON.stringify([
              conversationId,
              snapshot.pendingInteraction.requestId,
              snapshot.pendingInteraction.revision,
            ])}
            answerDisabled={
              !lifecycleOperable ||
              snapshot.capabilities.answerInteraction !== true
            }
            labels={labels}
            onAnswer={answerInteraction}
            onChatAboutThis={onChatAboutThis}
            request={snapshot.pendingInteraction}
          />
        </div>
      )}
      <ChatComposer
        attachmentUploader={
          snapshot.capabilities.sendAttachments === true
            ? attachmentUploader
            : undefined
        }
        draft={composer.draft}
        getDeadlineAt={getDeadlineAt}
        key={viewResetKey}
        disabled={
          !lifecycleOperable ||
          (!snapshot.capabilities.sendText &&
            !(
              snapshot.capabilities.sendAttachments === true &&
              attachmentUploader !== undefined
            ))
        }
        disabledReason={
          lifecycleOperable &&
          (snapshot.capabilities.sendText ||
            (snapshot.capabilities.sendAttachments === true &&
              attachmentUploader !== undefined))
            ? undefined
            : snapshot.lifecycle !== undefined && !lifecycleOperable
              ? lifecycleDisplayStatus === undefined
                ? undefined
                : labels.lifecycleStatus?.[lifecycleDisplayStatus]
              : labels.textSendingUnavailable
        }
        interruptAction={
          snapshot.run?.status === "running"
            ? {
                disabled:
                  !snapshot.capabilities.interrupt ||
                  !lifecycleOperable ||
                  !snapshot.run.canInterrupt,
                onInterrupt: interrupt,
                resetKey: snapshot.run.id,
              }
            : undefined
        }
        labels={labels}
        onSend={sendText}
        onDraftChange={composer.setDraft}
        resetKey={viewResetKey}
        textInputDisabled={!snapshot.capabilities.sendText}
      />
      <Modal
        afterOpenChange={(open) => {
          if (!open) restoreTriggerFocus();
        }}
        closeIcon={
          <span aria-label={labels.eventDetailClose} role="img">
            ×
          </span>
        }
        destroyOnClose
        footer={null}
        keyboard
        onCancel={() => setModalOpen(false)}
        open={eventDetailModalVisible}
        title={labels.eventDetailTitle}
      >
        {selectedEvent === undefined ? null : (
          <ChatEventDetail
            formatTimestamp={formatTimestamp}
            item={selectedEvent}
            onRendererError={onRendererError}
            renderers={renderers}
          />
        )}
      </Modal>
    </section>
  );
};
