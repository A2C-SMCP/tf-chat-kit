import {
  Alert,
  Button,
  Card,
  Checkbox,
  Input,
  Radio,
  Space,
  Tag,
  Typography,
} from "antd";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { INTERACTION_MAX_ANSWER_CHARACTERS } from "@turingfocus/chat-protocol";
import type {
  InteractionClientSnapshot,
  InteractionDraft,
  InteractionResponseInput,
  InteractionView,
} from "@turingfocus/chat-react";

import { resolveChatUiLabels } from "./labels.js";
import type { ChatUiLabelOverrides, ChatUiLabels } from "./types.js";

export interface InteractionCardProps {
  readonly view: InteractionView;
  readonly connection: InteractionClientSnapshot["connection"];
  readonly now: number;
  /** Partial copy is resolved against the built-in English defaults. */
  readonly labels?: ChatUiLabelOverrides | undefined;
  /** Restored UI draft; survives ack-timeout retries and inline/modal switches. */
  readonly draft?: InteractionDraft | undefined;
  readonly onDraftChange?: ((draft: InteractionDraft) => void) | undefined;
  readonly onRespond: (
    interactionId: string,
    input: InteractionResponseInput,
  ) => boolean;
}

/** Countdown and EDF use `expiresAt`; `timeoutSeconds` is display-only. */
export const formatInteractionRemaining = (
  expiresAt: number,
  now: number,
): string => {
  const totalSeconds = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}:${String(totalSeconds % 60).padStart(2, "0")}`;
};

const getConversationTitle = (
  view: InteractionView,
  labels: ChatUiLabels,
): string =>
  labels.formatInteractionConversationTitle?.(
    view.conversationId,
    view.conversationTitle,
  ) ??
  view.conversationTitle?.trim() ??
  view.conversationId;

const getRequesterName = (
  view: InteractionView,
  labels: ChatUiLabels,
): string =>
  view.requester.name?.trim() ||
  labels.interactionCurrentUser ||
  "Current user";

const getTargetName = (view: InteractionView, labels: ChatUiLabels): string =>
  view.target.name?.trim() ||
  view.target.id?.trim() ||
  labels.interactionColleague ||
  "Colleague";

const getSourceText = (view: InteractionView, labels: ChatUiLabels): string => {
  if (view.target.kind === "human")
    return `${labels.interactionRobotPrefix ?? "Robot"} ${view.robotId} → ${labels.interactionYou ?? "you"}`;
  return `${getRequesterName(view, labels)} → ${getTargetName(view, labels)}`;
};

/**
 * One Interaction question. It consumes the Runtime entry directly and never
 * maps it through AskUserInteractionRequest (that projection is lossy).
 */
export const InteractionCard = ({
  view,
  connection,
  now,
  labels: labelOverrides,
  draft,
  onDraftChange,
  onRespond,
}: InteractionCardProps) => {
  const labels = resolveChatUiLabels(labelOverrides);
  const [rawSelected, setSelected] = useState<readonly string[]>(
    draft?.selected ?? [],
  );
  const [customText, setCustomText] = useState(draft?.customText ?? "");
  const [error, setError] = useState<ReactNode | null>(null);
  const onDraftChangeRef = useRef(onDraftChange);
  onDraftChangeRef.current = onDraftChange;
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const draftSignature =
    draft === undefined
      ? ""
      : JSON.stringify([draft.selected, draft.customText]);
  const publishedSignature = useRef(draftSignature);
  const lastInteractionId = useRef(view.interactionId);

  const options = view.options;
  const optionValues = new Set(options.map((option) => option.value));
  // A draft can outlive the options it was typed for (server edits, retries);
  // never submit a stale value that the current question no longer offers.
  const selected = rawSelected.filter((value) => optionValues.has(value));

  useEffect(() => {
    publishedSignature.current = JSON.stringify([selected, customText]);
    onDraftChangeRef.current?.({ customText, selected });
  }, [customText, selected]);
  useEffect(() => {
    const interactionChanged = lastInteractionId.current !== view.interactionId;
    lastInteractionId.current = view.interactionId;
    // The provider echoes the draft this card just published on the next
    // snapshot; only an external draft/interaction change resets local state
    // (and must not erase a submit error on a one-second tick).
    if (!interactionChanged && draftSignature === publishedSignature.current)
      return;
    const currentDraft = draftRef.current;
    setSelected(currentDraft?.selected ?? []);
    setCustomText(currentDraft?.customText ?? "");
    setError(null);
  }, [draftSignature, view.interactionId]);

  const pending = view.status === "pending";
  const connected = connection === "connected";
  const disabled = !pending || !connected;
  const customAnswer = customText.trim();
  const canSubmit =
    !disabled && (selected.length > 0 || customAnswer.length > 0);

  const toggle = (value: string): void => {
    if (view.multiSelect) {
      setSelected((previous) =>
        previous.includes(value)
          ? previous.filter((candidate) => candidate !== value)
          : [
              ...previous.filter((candidate) => optionValues.has(candidate)),
              value,
            ],
      );
      return;
    }
    setSelected([value]);
  };

  const send = (input: InteractionResponseInput): void => {
    setError(null);
    let sent = false;
    try {
      sent = onRespond(view.interactionId, input);
    } catch {
      sent = false;
    }
    if (!sent)
      setError(
        labels.interactionResponseFailed ??
          "The answer was not sent. Try again.",
      );
  };

  const submit = (): void => {
    if (!canSubmit) return;
    send({
      status: "answered",
      ...(selected.length === 0 ? {} : { selectedOptions: selected }),
      ...(customAnswer.length === 0 ? {} : { answer: customAnswer }),
    });
  };

  const cancel = (): void => {
    send({ status: "cancelled" });
  };

  const optionItems = options.map((option) => ({
    label:
      option.description === undefined
        ? (option.label ?? option.value)
        : `${option.label ?? option.value} — ${option.description}`,
    value: option.value,
  }));

  return (
    <div
      data-interaction-id={view.interactionId}
      data-interaction-status={view.status}
    >
      <Card size="small">
        <Space direction="vertical" size="small" style={{ width: "100%" }}>
          <Space
            align="center"
            style={{ justifyContent: "space-between", width: "100%" }}
            wrap
          >
            <Typography.Text strong>
              {getConversationTitle(view, labels)}
            </Typography.Text>
            <Space size={8} wrap>
              <Tag>{view.robotId}</Tag>
              {view.target.kind === "agent" ? (
                <Tag color="blue">{labels.interactionFromColleague}</Tag>
              ) : null}
              <Typography.Text
                aria-label={labels.interactionRemaining ?? "Time remaining"}
                type="secondary"
              >
                {formatInteractionRemaining(view.expiresAt, now)}
              </Typography.Text>
            </Space>
          </Space>
          <Typography.Text type="secondary">
            {getSourceText(view, labels)}
          </Typography.Text>
          <Typography.Paragraph style={{ margin: 0, whiteSpace: "pre-wrap" }}>
            {view.question}
          </Typography.Paragraph>

          {view.status === "pending" && view.staleReason === "ack_timeout" ? (
            <Alert
              description={labels.interactionAckTimeoutDescription}
              message={labels.interactionAckTimeout}
              showIcon
              type="warning"
            />
          ) : null}
          {view.status === "submitting" ? (
            <Alert
              message={labels.interactionSubmittingNotice}
              showIcon
              type="info"
            />
          ) : null}
          {view.status === "accepted" ? (
            <Alert
              message={labels.interactionAccepted}
              showIcon
              type="success"
            />
          ) : null}
          {connection === "disconnected" ? (
            <Alert
              message={labels.interactionDisconnected}
              showIcon
              type="warning"
            />
          ) : null}
          {connection === "awaiting-snapshot" ? (
            <Alert
              message={labels.interactionAwaitingSnapshot}
              showIcon
              type="info"
            />
          ) : null}
          {error === null ? null : (
            <Alert message={error} showIcon type="error" />
          )}

          {options.length === 0 ? (
            <Input.TextArea
              aria-label={labels.interactionFreeTextPlaceholder ?? "Answer"}
              disabled={disabled}
              maxLength={INTERACTION_MAX_ANSWER_CHARACTERS}
              onChange={(event) => setCustomText(event.target.value)}
              placeholder={labels.interactionFreeTextPlaceholder}
              rows={3}
              value={customText}
            />
          ) : (
            <>
              {view.multiSelect ? (
                <Checkbox.Group
                  disabled={disabled}
                  onChange={(values) => setSelected(values.map(String))}
                  options={optionItems}
                  value={[...selected]}
                />
              ) : (
                <Radio.Group
                  disabled={disabled}
                  onChange={(event) => toggle(String(event.target.value))}
                  options={optionItems}
                  value={selected[0]}
                />
              )}
              <Input
                aria-label={labels.interactionOtherOption ?? "Other"}
                disabled={disabled}
                maxLength={INTERACTION_MAX_ANSWER_CHARACTERS}
                onChange={(event) => setCustomText(event.target.value)}
                placeholder={labels.interactionOtherOption ?? "Other"}
                value={customText}
              />
            </>
          )}

          <Space wrap>
            <Button
              disabled={!canSubmit}
              loading={view.status === "submitting"}
              onClick={submit}
              type="primary"
            >
              {view.status === "submitting"
                ? labels.askUserSubmitting
                : labels.askUserSubmit}
            </Button>
            <Button disabled={disabled} onClick={cancel}>
              {labels.askUserCancel}
            </Button>
          </Space>
        </Space>
      </Card>
    </div>
  );
};
