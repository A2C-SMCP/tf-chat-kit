import { Alert, Badge, Button, List, Modal, Popover, Typography } from "antd";
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import {
  useInteractionClient,
  useInteractionQueue,
  type InteractionView,
} from "@turingfocus/chat-react";

import {
  InteractionCard,
  formatInteractionRemaining,
} from "./interaction-card.js";
import { resolveChatUiLabels } from "./labels.js";
import type { ChatUiLabelOverrides } from "./types.js";

export interface InteractionQueueProps {
  /**
   * The conversation whose inline card is actually mounted. Set only when the
   * conversation view is rendered for this id; otherwise the active item uses
   * the global modal.
   */
  readonly inlineConversationId?: string | undefined;
  readonly getPopupContainer?: (() => HTMLElement) | undefined;
  readonly labels?: ChatUiLabelOverrides | undefined;
}

const VISUALLY_HIDDEN: CSSProperties = {
  border: 0,
  clip: "rect(0, 0, 0, 0)",
  height: 1,
  margin: -1,
  overflow: "hidden",
  padding: 0,
  position: "absolute",
  whiteSpace: "nowrap",
  width: 1,
};

const InteractionIcon = () => (
  <span
    aria-hidden="true"
    style={{ display: "inline-flex", height: 16, width: 16 }}
  >
    <svg
      fill="none"
      height="16"
      stroke="currentColor"
      strokeWidth="1.5"
      viewBox="0 0 16 16"
      width="16"
    >
      <path d="M3 3.5h10v6H7l-3 2.5v-2.5H3z" strokeLinejoin="round" />
    </svg>
  </span>
);

/**
 * Global Interaction host: one active item and a floating queue for the rest.
 * Queue membership and active selection come from the Runtime snapshot.
 */
export const InteractionQueue = ({
  inlineConversationId,
  getPopupContainer,
  labels: labelOverrides,
}: InteractionQueueProps) => {
  const labels = resolveChatUiLabels(labelOverrides);
  const client = useInteractionClient();
  const {
    active,
    waiting,
    connection,
    now,
    activate,
    respond,
    getDraft,
    setDraft,
  } = useInteractionQueue();
  const [announcement, setAnnouncement] = useState("");
  const [dismissedId, setDismissedId] = useState<string | null>(null);
  const [error, setError] = useState<ReactNode | null>(null);

  useEffect(() => {
    setDismissedId(null);
    setError(null);
  }, [client]);
  useEffect(() => {
    setError(null);
  }, [active?.interactionId]);

  const inline =
    active !== null &&
    inlineConversationId !== undefined &&
    active.conversationId === inlineConversationId;
  const dismissedActive =
    !inline && active !== null && dismissedId === active.interactionId
      ? active
      : null;
  const badgeItems =
    dismissedActive === null ? waiting : [dismissedActive, ...waiting];
  const previousBadgeCount = useRef(badgeItems.length);
  useEffect(() => {
    if (badgeItems.length === previousBadgeCount.current) return;
    previousBadgeCount.current = badgeItems.length;
    setAnnouncement(
      `${labels.interactionQueueTitle ?? labels.interactionQueueLabel ?? "Pending questions"} (${badgeItems.length})`,
    );
  }, [
    badgeItems.length,
    labels.interactionQueueLabel,
    labels.interactionQueueTitle,
  ]);

  if (client === null) return null;

  const modalOpen =
    active !== null && !inline && dismissedId !== active.interactionId;
  const cancel = (interactionId: string): void => {
    setError(null);
    let sent = false;
    try {
      sent = respond(interactionId, { status: "cancelled" });
    } catch {
      sent = false;
    }
    if (!sent)
      setError(
        labels.interactionResponseFailed ??
          "The answer was not sent. Try again.",
      );
  };
  const open = (interactionId: string): void => {
    if (active?.interactionId === interactionId) setDismissedId(null);
    else {
      activate(interactionId);
      setDismissedId(null);
    }
  };

  const queueContent: ReactNode = (
    <>
      {error === null ? null : <Alert message={error} showIcon type="error" />}
      <List
        dataSource={[...badgeItems]}
        locale={{ emptyText: labels.interactionQueueEmpty }}
        size="small"
        renderItem={(entry: InteractionView) => (
          <List.Item
            actions={[
              <Button
                key="activate"
                onClick={() => open(entry.interactionId)}
                size="small"
                type="link"
              >
                {labels.interactionQueueActivate ?? "Open"}
              </Button>,
              <Button
                danger
                disabled={
                  entry.status !== "pending" || connection !== "connected"
                }
                key="cancel"
                onClick={() => cancel(entry.interactionId)}
                size="small"
                type="link"
              >
                {labels.askUserCancel}
              </Button>,
            ]}
            key={entry.interactionId}
          >
            <List.Item.Meta
              description={`${labels.formatInteractionConversationTitle?.(entry.conversationId, entry.conversationTitle) ?? entry.conversationTitle ?? entry.conversationId} · ${formatInteractionRemaining(entry.expiresAt, now)}`}
              title={
                <Typography.Text ellipsis={{ tooltip: entry.question }}>
                  {entry.question}
                </Typography.Text>
              }
            />
          </List.Item>
        )}
      />
    </>
  );

  const portalTarget =
    getPopupContainer?.() ??
    (typeof document === "undefined" ? null : document.body);

  return (
    <>
      <Modal
        destroyOnClose
        footer={null}
        {...(getPopupContainer === undefined
          ? {}
          : { getContainer: getPopupContainer })}
        onCancel={() => {
          if (active !== null) setDismissedId(active.interactionId);
        }}
        open={modalOpen}
        title={labels.askUserLabel}
        width={640}
      >
        {active === null ? null : (
          <InteractionCard
            connection={connection}
            draft={getDraft(active.interactionId)}
            key={active.interactionId}
            labels={labels}
            now={now}
            onDraftChange={(draft) => setDraft(active.interactionId, draft)}
            onRespond={respond}
            view={active}
          />
        )}
      </Modal>
      {portalTarget === null
        ? null
        : createPortal(
            <>
              <span aria-live="polite" role="status" style={VISUALLY_HIDDEN}>
                {announcement}
              </span>
              {badgeItems.length === 0 ? null : (
                <div
                  style={{
                    bottom: 16,
                    position: "fixed",
                    right: 16,
                    zIndex: 1000,
                  }}
                >
                  <Popover
                    content={queueContent}
                    {...(getPopupContainer === undefined
                      ? {}
                      : { getPopupContainer })}
                    placement="topRight"
                    title={`${labels.interactionQueueTitle ?? "Pending questions"} (${badgeItems.length})`}
                    trigger="click"
                  >
                    <Badge count={badgeItems.length} size="small">
                      <Button
                        aria-label={`${labels.interactionQueueLabel ?? "Pending questions"} (${badgeItems.length})`}
                        data-testid="interaction-queue-badge"
                        icon={<InteractionIcon />}
                        shape="circle"
                      />
                    </Badge>
                  </Popover>
                </div>
              )}
            </>,
            portalTarget,
          )}
    </>
  );
};
