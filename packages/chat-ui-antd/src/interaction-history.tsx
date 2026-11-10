import { Space, Typography } from "antd";

import type { InteractionHistory } from "@turingfocus/chat-protocol";

import type { ChatUiLabels } from "./types.js";

export interface InteractionHistoryViewProps {
  readonly history: InteractionHistory;
  readonly labels: ChatUiLabels;
}

const formatAnsweredAtUtc = (
  timestamp: number,
): { readonly dateTime: string; readonly text: string } | undefined => {
  const date = new Date(timestamp);
  // Out-of-range timestamps (for example 1e20) are finite but produce an
  // invalid Date; omit them instead of throwing during render.
  if (!Number.isFinite(date.getTime())) return undefined;
  const iso = date.toISOString();
  return {
    dateTime: iso,
    text: `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`,
  };
};

/** Read-only replay of historical ask_colleague / answer_colleague tool events. */
export const InteractionHistoryView = ({
  history,
  labels,
}: InteractionHistoryViewProps) => {
  const answeredAt =
    history.answeredAt === undefined
      ? undefined
      : formatAnsweredAtUtc(history.answeredAt);
  return (
    <Space direction="vertical" size="small" style={{ width: "100%" }}>
      <Typography.Text strong>
        {labels.interactionHistoryTitle ?? "Interaction history"}
      </Typography.Text>
      <Typography.Text type="secondary">
        {history.direction === "ask"
          ? (labels.interactionHistoryAsk ?? "Asked")
          : (labels.interactionHistoryAnswer ?? "Answered")}
        {" · "}
        {history.status}
      </Typography.Text>
      {history.question === undefined ? null : (
        <Typography.Paragraph style={{ margin: 0, whiteSpace: "pre-wrap" }}>
          {history.question}
        </Typography.Paragraph>
      )}
      {history.answer === undefined ? null : (
        <Typography.Paragraph
          style={{ margin: 0, whiteSpace: "pre-wrap" }}
          type="secondary"
        >
          {history.answer}
        </Typography.Paragraph>
      )}
      {history.answeredBy === undefined ? null : (
        <Typography.Text type="secondary">
          {labels.interactionHistoryAnsweredBy ?? "Answered by"}:{" "}
          {history.answeredBy}
        </Typography.Text>
      )}
      {answeredAt === undefined ? null : (
        <Typography.Text type="secondary">
          {labels.interactionHistoryAnsweredAt ?? "Answered at"}:{" "}
          <time dateTime={answeredAt.dateTime}>{answeredAt.text}</time>
        </Typography.Text>
      )}
      {history.error === undefined ? null : (
        <Typography.Text type="danger">
          {labels.interactionHistoryError ?? "Error"}: {history.error}
        </Typography.Text>
      )}
    </Space>
  );
};
