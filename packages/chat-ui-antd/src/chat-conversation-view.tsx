import { ConversationFailureContext } from "./conversation-failure-card.js";
import { ChatOutgoingMessages } from "./chat-outgoing-messages.js";
import { ChatNotices, type ChatNoticeTiming } from "./chat-notices.js";
import { ChatErrorNotice } from "./chat-diagnostics.js";
import { Modal, Segmented, Typography, theme } from "antd";
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
  getConversationFailure,
  type TimelineItem,
  type ChatError,
  type ChatSnapshot,
} from "@turingfocus/chat-protocol";
import {
  useAskUserRemoteTool,
  useChatAttachmentUploader,
  useChatClient,
  useChatSelector,
  useComposerDraft,
  useConversationCache,
} from "@turingfocus/chat-react";

import {
  ChatComposer,
  type ChatComposerSendShortcut,
} from "./chat-composer.js";
import { chatErrorNoticeKey } from "./dismissible-chat-alert.js";
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
  AskUserInteractionResultView,
  type AskUserChatAboutThisRequest,
} from "./ask-user-interaction.js";
import { ChatRunStatus } from "./chat-run-status.js";
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
  /** Explicit developer controls. Product UI is the default. */
  readonly debug?: boolean | undefined;
  /** Show Auto / Split / Modal controls; defaults to true, independently of debug. */
  readonly showEventDetailModeSelector?: boolean | undefined;
  /** @deprecated Prefer debug. Explicit standard remains a legacy debug opt-in. */
  readonly presentation?: "standard" | "compact" | undefined;
  readonly sendShortcut?: ChatComposerSendShortcut | undefined;
  readonly noticeTiming?: ChatNoticeTiming | undefined;
  readonly onRequestAuthentication?: (() => void) | undefined;
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
  readonly errorNoticeKey: string;
  readonly lifecycle: ChatSnapshot["lifecycle"];
  readonly pendingInteraction: ChatSnapshot["pendingInteraction"];
  readonly run: ChatSnapshot["run"];
  readonly timeline: ChatSnapshot["timeline"];
  readonly outgoingMessages: ChatSnapshot["outgoingMessages"];
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
        errorNoticeKey: chatErrorNoticeKey(
          snapshot.error,
          snapshot.activeErrors?.at(-1),
        ),
        lifecycle: snapshot.lifecycle,
        pendingInteraction: snapshot.pendingInteraction,
        run: snapshot.run,
        timeline: snapshot.timeline,
        outgoingMessages: snapshot.outgoingMessages,
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
    left.errorNoticeKey === right.errorNoticeKey &&
    left.lifecycle === right.lifecycle &&
    left.pendingInteraction === right.pendingInteraction &&
    left.run === right.run &&
    left.timeline === right.timeline &&
    left.outgoingMessages === right.outgoingMessages);

export const ChatConversationView = ({
  showEventDetailModeSelector = true,
  presentation = "compact",
  debug = presentation === "standard",
  sendShortcut,
  className,
  noticeTiming,
  onRequestAuthentication,
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
  const cache = useConversationCache();
  const snapshot = useChatSelector(
    selectChatConversationViewSnapshot,
    equalChatConversationViewSnapshot,
  );
  const remoteAskUser = useAskUserRemoteTool(snapshot?.conversationId ?? "");
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

  const previousClientRef = useRef(client);
  const previousConversationIdRef = useRef<string | null>(
    currentConversationId,
  );
  useEffect(() => {
    const clientChanged = previousClientRef.current !== client;
    previousClientRef.current = client;
    const previousConversationId = previousConversationIdRef.current;
    previousConversationIdRef.current = currentConversationId;
    if (
      !clientChanged &&
      (previousConversationId === null ||
        previousConversationId === currentConversationId)
    ) {
      return;
    }
    lastTriggerRef.current = null;
    setModalOpen(false);
    if (selectedEventId !== null) updateSelection(null, null);
  }, [client, currentConversationId, selectedEventId, updateSelection]);

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

  const timelines = useMemo(() => {
    const items = snapshot?.timeline ?? [];
    const review = items.filter(
      (item) =>
        item.kind === "message" &&
        item.provenance?.kind === "provisional" &&
        item.provenance.reviewRequired === true,
    );
    const keys = new Set(review.map((item) => item.id));
    return {
      review,
      primary:
        review.length === 0
          ? items
          : items.filter(
              (item) => item.kind !== "message" || !keys.has(item.id),
            ),
    };
  }, [snapshot?.timeline]);

  const restoreScope = useMemo(
    () => ({ client, conversationId: snapshot?.conversationId }),
    [client, snapshot?.conversationId],
  );
  const liveRestoreScope = useRef(restoreScope);
  liveRestoreScope.current = restoreScope;
  const [composerFocus, setComposerFocus] = useState<{
    readonly scope: typeof restoreScope;
    readonly revision: number;
  }>();
  const focusRequest =
    composerFocus?.scope === restoreScope ? composerFocus.revision : undefined;
  const restoredScope = useRef<typeof restoreScope>();
  const [pendingRestore, setPendingRestore] = useState<{
    readonly scope: typeof restoreScope;
    readonly item: TimelineItem;
    readonly draft: typeof composer.draft;
  }>();
  useEffect(() => {
    liveRestoreScope.current = restoreScope;
    setPendingRestore(undefined);
    return () => {
      liveRestoreScope.current = { client, conversationId: undefined };
    };
  }, [restoreScope, client]);
  const pendingUploadsRef = useRef(0);
  const [pendingUploads, setPendingUploads] = useState(0);
  const onPendingUploadsChange = useCallback((count: number) => {
    pendingUploadsRef.current = count;
    setPendingUploads(count);
  }, []);
  const restoreDraft = useCallback(
    (request: {
      scope: typeof restoreScope;
      item: TimelineItem;
      draft: typeof composer.draft;
    }) => {
      const current = client.getSnapshot();
      const failure = getConversationFailure(request.item);
      if (
        pendingUploadsRef.current > 0 ||
        liveRestoreScope.current !== request.scope ||
        current?.conversation.id !== request.scope.conversationId ||
        !isChatLifecycleOperable(current?.lifecycle) ||
        current?.capabilities.sendText !== true ||
        client.getComposerDraft(current.conversation.id) !== request.draft ||
        !current.timeline.some((entry) => entry === request.item) ||
        failure?.originalMessage === undefined
      )
        return;
      client.setComposerDraft({
        conversationId: current.conversation.id,
        text: failure.originalMessage.text,
        longTexts: [],
        attachments: [],
      });
      restoredScope.current = request.scope;
      setComposerFocus((value) => ({
        scope: request.scope,
        revision: (value?.revision ?? 0) + 1,
      }));
    },
    [client],
  );
  const onRestoreFailure = useCallback(
    (item: TimelineItem) => {
      const conversationId = restoreScope.conversationId;
      if (conversationId === undefined) return;
      const draft = client.getComposerDraft(conversationId);
      const request = { scope: restoreScope, item, draft };
      if (
        draft.text.length > 0 ||
        draft.longTexts.length > 0 ||
        draft.attachments.length > 0
      )
        setPendingRestore(request);
      else restoreDraft(request);
    },
    [client, restoreScope, restoreDraft],
  );
  const failureActions = useMemo(
    () => ({
      labels: labelOverrides,
      onRestore:
        lifecycleOperable && snapshot?.capabilities.sendText === true
          ? onRestoreFailure
          : undefined,
      focusRequest,
      restorationBlocked: pendingUploads > 0,
      onPendingUploadsChange,
    }),
    [
      labelOverrides,
      lifecycleOperable,
      snapshot?.capabilities.sendText,
      onRestoreFailure,
      focusRequest,
      pendingUploads,
      onPendingUploadsChange,
    ],
  );

  if (snapshot === null) {
    return (
      <ChatNotices
        showDiagnostics={debug}
        loading
        labels={labels}
        timing={noticeTiming}
        getDeadlineAt={getDeadlineAt}
      />
    );
  }

  const conversationId = snapshot.conversationId;
  const timeline = (
    <div
      key={viewResetKey}
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
      }}
    >
      <ChatTimeline
        conversationId={conversationId}
        formatTimestamp={formatTimestamp}
        items={timelines.primary}
        labels={labels}
        onEventSelect={selectEvent}
        onRendererError={onRendererError}
        renderers={renderers}
        selectedEventId={selectedEventId}
        style={{ flex: 1, height: "auto", minHeight: 0 }}
      />
      <ChatOutgoingMessages
        messages={snapshot.outgoingMessages}
        labels={labels}
        onDismiss={(id) => client.dismissOutgoingMessage(id)}
      />
      {timelines.review.length > 0 ? (
        <details
          data-chat-unconfirmed
          style={{
            flexShrink: 0,
            maxHeight: "50%",
            overflow: "auto",
            borderTop: `1px solid ${token.colorBorderSecondary}`,
            padding: token.paddingSM,
          }}
        >
          <summary
            style={{ cursor: "pointer", color: token.colorTextSecondary }}
          >
            {labels.unconfirmedMessages ?? "Unconfirmed messages"} (
            {timelines.review.length})
          </summary>
          <p
            style={{
              color: token.colorTextSecondary,
              fontSize: token.fontSizeSM,
            }}
          >
            {labels.unconfirmedDescription}
          </p>
          <ChatTimeline
            aria-label={labels.unconfirmedMessages ?? "Unconfirmed messages"}
            conversationId={`${conversationId}:review`}
            items={timelines.review}
            labels={labels}
            formatTimestamp={formatTimestamp}
            renderers={renderers}
            onRendererError={onRendererError}
            style={{ height: 240, minHeight: 120 }}
          />
        </details>
      ) : null}
    </div>
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
          labels={labels}
          formatTimestamp={formatTimestamp}
          item={selectedEvent}
          onRendererError={onRendererError}
          renderers={renderers}
        />
      )}
    </aside>
  );

  return (
    <ConversationFailureContext.Provider value={failureActions}>
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
        <ChatNotices
          key={`notices:${viewResetKey}`}
          showDiagnostics={debug}
          conversationId={conversationId}
          timing={noticeTiming}
          labels={labels}
          getDeadlineAt={getDeadlineAt}
          onRequestAuthentication={onRequestAuthentication}
        />
        {debug ? (
          <ChatRunStatus
            key={`${viewResetKey}:${snapshot.run?.id ?? "no-run"}`}
            canInterrupt={lifecycleOperable && snapshot.capabilities.interrupt}
            labels={labels}
            onInterrupt={interrupt}
            run={snapshot.run}
            showInterruptButton={false}
            showError={false}
          />
        ) : snapshot.run?.status === "running" ? (
          <span role="status" style={{ padding: "4px 12px", fontSize: 12 }}>
            {labels.sending}
          </span>
        ) : null}
        {showEventDetailModeSelector ? (
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
        ) : null}
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
        {visibleCommandFailures
          .filter((failure) => failure.command === "answerInteraction")
          .map((failure) => (
            <ChatErrorNotice
              debug={debug}
              key={failure.command}
              error={failure.error}
              operation={failure.command}
              labels={labels}
              onDismiss={() => dismissFailure(failure.command)}
            />
          ))}
        {remoteAskUser.entries.length === 0 ? null : (
          <div
            role="region"
            aria-label={String(labels.askUserLabel)}
            style={{
              flex: "0 1 auto",
              minHeight: 0,
              maxHeight: "40%",
              overflowY: "auto",
            }}
          >
            {remoteAskUser.entries.map((entry) => (
              <div
                key={entry.request.requestId}
                style={{ padding: token.paddingXS }}
              >
                {entry.result === undefined ? (
                  <AskUserInteractionCard
                    answerDisabled={false}
                    labels={labels}
                    onAnswer={remoteAskUser.answer}
                    draft={entry.draft}
                    onDraftChange={remoteAskUser.setDraft}
                    onChatAboutThis={onChatAboutThis}
                    request={entry.request}
                  />
                ) : (
                  <AskUserInteractionResultView result={entry.result} />
                )}
              </div>
            ))}
          </div>
        )}
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
        {visibleCommandFailures
          .filter((failure) => failure.command !== "answerInteraction")
          .map((failure) => (
            <ChatErrorNotice
              debug={debug}
              key={failure.command}
              error={failure.error}
              operation={failure.command}
              labels={labels}
              onDismiss={() => dismissFailure(failure.command)}
            />
          ))}
        {cache.conversationId === conversationId &&
        cache.unavailableAttachments > 0 ? (
          <span role="status">{labels.cacheAttachmentUnavailable}</span>
        ) : null}
        <ChatComposer
          sendShortcut={sendShortcut}
          renderUploadError={(error) => (
            <ChatErrorNotice
              debug={debug}
              error={error}
              operation="uploadAttachment"
              labels={labels}
            />
          )}
          onUploadError={(error) =>
            client.recordDiagnostic({
              ...error,
              conversationId,
              diagnostic: {
                ...error.diagnostic,
                operation: "uploadAttachment",
              },
            })
          }
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
              : cache.conversationId === conversationId &&
                  cache.status === "syncing"
                ? undefined
                : snapshot.lifecycle?.status === "connecting" ||
                    snapshot.lifecycle?.status === "joining"
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
              labels={labels}
              formatTimestamp={formatTimestamp}
              item={selectedEvent}
              onRendererError={onRendererError}
              renderers={renderers}
            />
          )}
        </Modal>
        <Modal
          open={pendingRestore !== undefined}
          title={labels.overwriteFailureDraftTitle}
          okText={labels.overwriteFailureDraftConfirm}
          cancelText={labels.deleteConversationCancel}
          onCancel={() => setPendingRestore(undefined)}
          onOk={() => {
            if (pendingRestore !== undefined) restoreDraft(pendingRestore);
            setPendingRestore(undefined);
          }}
          focusTriggerAfterClose={false}
          afterClose={() => {
            if (restoredScope.current === liveRestoreScope.current) {
              const scope = restoredScope.current;
              setComposerFocus((value) => ({
                scope,
                revision: (value?.revision ?? 0) + 1,
              }));
            }
            restoredScope.current = undefined;
          }}
        >
          {labels.overwriteFailureDraftDescription}
        </Modal>
      </section>
    </ConversationFailureContext.Provider>
  );
};
