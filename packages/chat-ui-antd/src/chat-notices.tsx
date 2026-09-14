import { Alert, Button } from "antd";
import { useEffect, useRef, useState } from "react";
import {
  useChatClient,
  useChatSelector,
  useConversationCache,
} from "@turingfocus/chat-react";
import type { ChatError } from "@turingfocus/chat-protocol";
import { ChatDiagnostics, ChatErrorNotice } from "./chat-diagnostics.js";
import { resolveChatUiLabels } from "./labels.js";
import type { ChatUiLabelOverrides } from "./types.js";

export interface ChatNoticeTiming {
  readonly progressDelayMs?: number | undefined;
  readonly disconnectDelayMs?: number | undefined;
  readonly recoveredDurationMs?: number | undefined;
  readonly bestEffortDurationMs?: number | undefined;
}
const duration = (value: number | undefined, fallback: number) =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= 60000
    ? value
    : fallback;

function RecoveryNotice({
  text,
  durationMs,
}: {
  text: string;
  durationMs: number;
}) {
  const [visible, setVisible] = useState(true);
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const remaining = useRef(durationMs);
  useEffect(() => {
    if (!visible || hover || focus) return;
    const start = Date.now();
    const timer = setTimeout(() => setVisible(false), remaining.current);
    return () => {
      clearTimeout(timer);
      remaining.current = Math.max(0, remaining.current - (Date.now() - start));
    };
  }, [focus, hover, visible]);
  if (!visible) return null;
  return (
    <div
      tabIndex={0}
      role="status"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setFocus(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocus(false);
      }}
    >
      <Alert type="success" message={text} />
    </div>
  );
}

export function ChatNotices({
  conversationId,
  timing,
  labels,
  getDeadlineAt,
  onRequestAuthentication,
  onRetry,
  loading = false,
  error: loadError,
}: {
  conversationId?: string | undefined;
  timing?: ChatNoticeTiming | undefined;
  labels?: ChatUiLabelOverrides | undefined;
  getDeadlineAt: () => number;
  onRequestAuthentication?: (() => void) | undefined;
  onRetry?: (() => void) | undefined;
  loading?: boolean;
  error?: ChatError | undefined;
}) {
  const client = useChatClient();
  const snapshot = useChatSelector((value) =>
    value?.conversation.id === conversationId ? value : null,
  );
  const cache = useConversationCache();
  const copy = resolveChatUiLabels(labels);
  const lifecycle = snapshot?.lifecycle;
  const status =
    loadError?.code === "authentication" ? "auth-required" : lifecycle?.status;
  const syncing =
    cache.conversationId === conversationId && cache.status === "syncing";
  const initial =
    loading || syncing || status === "connecting" || status === "joining";
  const disconnected =
    !initial &&
    (status === "reconnecting" ||
      status === "recovering" ||
      status === "offline");
  const terminal =
    status === "auth-required" ||
    status === "subscription-failed" ||
    (status === "offline" && (lifecycle?.reconnectAttempt ?? 0) > 0);
  const [progress, setProgress] = useState(false);
  const [persistent, setPersistent] = useState(false);
  const [recovery, setRecovery] = useState<{
    id: number;
    bestEffort: boolean;
  } | null>(null);
  const seenFault = useRef(false);
  const sequence = useRef(0);
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  useEffect(() => {
    setProgress(false);
    if (!initial) return;
    const timer = setTimeout(
      () => setProgress(true),
      duration(timing?.progressDelayMs, 2000),
    );
    return () => clearTimeout(timer);
  }, [initial, timing?.progressDelayMs]);
  useEffect(() => {
    setPersistent(false);
    if (!disconnected) return;
    const timer = setTimeout(
      () => setPersistent(true),
      duration(timing?.disconnectDelayMs, 5000),
    );
    return () => clearTimeout(timer);
  }, [disconnected, timing?.disconnectDelayMs]);
  useEffect(() => {
    if (disconnected || terminal) {
      seenFault.current = true;
      setRecovery(null);
      return;
    }
    if (seenFault.current && (status === "active" || status === "degraded")) {
      seenFault.current = false;
      if (
        (lifecycle?.reconnectAttempt ?? 0) > 0 &&
        (status === "degraded" || lifecycle?.recovery?.complete === true)
      )
        setRecovery({
          id: ++sequence.current,
          bestEffort: status === "degraded",
        });
    }
  }, [disconnected, terminal, status, lifecycle]);
  const active = (snapshot?.activeErrors ?? [])
    .filter((item) => item.scope.kind !== "command")
    .slice()
    .reverse()
    .sort(
      (a, b) =>
        Number(b.source === "authentication") -
        Number(a.source === "authentication"),
    );
  const candidate = active.find((item) => !dismissed.has(item.id));
  const failure =
    loadError ??
    candidate?.error ??
    (snapshot?.run?.error
      ? {
          ...snapshot.run.error,
          conversationId,
          diagnostic: {
            ...snapshot.run.error.diagnostic,
            errorId:
              snapshot.run.error.diagnostic?.errorId ??
              `run:${snapshot.run.id}`,
          },
        }
      : undefined) ??
    (snapshot?.activeErrors === undefined ? snapshot?.error : undefined);
  const failureKey =
    candidate?.id ?? failure?.diagnostic?.errorId ?? "legacy-error";
  const connectionKey = `${lifecycle?.subscriptionId}:${lifecycle?.generation}:${terminal ? status : "connection"}`;
  const showConnection = terminal || persistent;
  const noticeKey = failure ? failureKey : connectionKey;
  const cacheFailed =
    cache.conversationId === conversationId && cache.status === "error";
  const summary = initial
    ? progress
      ? syncing
        ? copy.cacheSyncing
        : copy.lifecycleStatus?.[status ?? "connecting"]
      : undefined
    : cacheFailed
      ? copy.cacheSyncFailed
      : status === undefined
        ? undefined
        : copy.lifecycleStatus?.[status];
  // Active connection errors obey the same escalation threshold as their lifecycle.
  const connectionFailure =
    candidate?.source === "connection" || candidate?.source === "recovery";
  const showFailure =
    failure !== undefined && (!connectionFailure || showConnection);
  return (
    <div data-chat-notices="true">
      <div
        style={{ display: "flex", alignItems: "center", gap: 8, padding: 4 }}
      >
        <span role="status">{summary}</span>
        <ChatDiagnostics conversationId={conversationId} labels={labels} />
        {active.length > 1 ? (
          <span>
            {active.length} {copy.activeFaults ?? "active faults"}
          </span>
        ) : null}
      </div>
      {(showFailure || showConnection) && !dismissed.has(noticeKey) ? (
        <div>
          {showFailure && failure ? (
            <ChatErrorNotice
              error={failure}
              labels={labels}
              onDismiss={() =>
                setDismissed(
                  (current) => new Set([...current, noticeKey].slice(-50)),
                )
              }
            />
          ) : (
            <Alert
              type="warning"
              showIcon
              closable
              onClose={() =>
                setDismissed(
                  (current) => new Set([...current, noticeKey].slice(-50)),
                )
              }
              message={summary}
            />
          )}
          {terminal && status === "auth-required" ? (
            onRequestAuthentication ? (
              <Button onClick={onRequestAuthentication}>
                {copy.signInAgain ?? "Sign in again"}
              </Button>
            ) : null
          ) : conversationId && (terminal || loadError) ? (
            <Button
              onClick={() => {
                if (onRetry) {
                  onRetry();
                  return;
                }
                void client
                  .loadConversation({
                    conversationId,
                    deadlineAt: getDeadlineAt(),
                  })
                  .catch(() => undefined);
              }}
            >
              {copy.retry}
            </Button>
          ) : null}
        </div>
      ) : null}
      {recovery ? (
        <RecoveryNotice
          key={recovery.id}
          text={
            (recovery.bestEffort
              ? copy.recoveredBestEffort
              : copy.recoveredComplete) ??
            (recovery.bestEffort
              ? "Connection restored with limited recovery; some updates may be missing."
              : "Connection and missed updates restored.")
          }
          durationMs={duration(
            recovery.bestEffort
              ? timing?.bestEffortDurationMs
              : timing?.recoveredDurationMs,
            recovery.bestEffort ? 5000 : 3000,
          )}
        />
      ) : null}
    </div>
  );
}
