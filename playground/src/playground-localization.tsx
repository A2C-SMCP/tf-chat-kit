import { Alert, Button, Card, Space, Tag, Typography, theme } from "antd";

import type {
  AgentEventStatus,
  MessageRole,
  Run,
  RunStatus,
} from "@turingfocus/chat-protocol";
import {
  ChatMessageContent,
  type ChatRenderer,
  type ChatRendererRegistry,
} from "@turingfocus/chat-ui-antd";

const runStatusLabels: Readonly<Record<RunStatus, string>> = {
  aborted: "已中断",
  failed: "失败",
  running: "运行中",
  succeeded: "已完成",
  unknown: "状态未知",
};

const eventStatusLabels: Readonly<Record<AgentEventStatus, string>> = {
  aborted: "已中断",
  failed: "失败",
  running: "运行中",
  success: "已完成",
  timeout: "已超时",
  unknown: "状态未知",
};

const roleLabels: Readonly<Record<MessageRole, string>> = {
  assistant: "助手",
  system: "系统",
  tool: "工具",
  unknown: "未知角色",
  user: "用户",
};

const statusColor = (
  status: AgentEventStatus | RunStatus,
): "default" | "error" | "processing" | "success" =>
  status === "success" || status === "succeeded"
    ? "success"
    : status === "failed" || status === "timeout"
      ? "error"
      : status === "running"
        ? "processing"
        : "default";

export const formatPlaygroundTimestamp = (timestamp: number): string => {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    month: "2-digit",
    second: "2-digit",
    timeZone: "Asia/Shanghai",
    year: "numeric",
  }).format(date);
};

const PlaygroundMessageRenderer: ChatRenderer = ({ formatTimestamp, item }) => {
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
          {item.author?.displayName ?? roleLabels[item.role]} ·{" "}
          {formatTimestamp(item.createdAt)}
        </Typography.Text>
        <ChatMessageContent message={item} />
      </div>
    </div>
  );
};

const PlaygroundAgentEventRenderer: ChatRenderer = ({
  formatTimestamp,
  item,
}) => {
  if (item.kind !== "agent-event") return null;
  const failed = item.status === "failed" || item.status === "timeout";
  const latest = item.transitions.at(-1);
  const summary =
    item.summary ?? latest?.summary ?? `${item.eventType} 事件暂无摘要`;
  return (
    <Card
      extra={
        <Tag color={statusColor(item.status)}>
          {eventStatusLabels[item.status]}
        </Tag>
      }
      size="small"
      title={item.eventCategory === "tool" ? "工具事件" : "智能体事件"}
    >
      <Space direction="vertical" size="small">
        {failed ? (
          <Alert
            message={latest?.error?.message ?? item.summary ?? "事件执行失败"}
            showIcon
            type="error"
          />
        ) : null}
        <Typography.Paragraph style={{ margin: 0, whiteSpace: "pre-wrap" }}>
          {summary}
        </Typography.Paragraph>
        <Typography.Text type="secondary">
          类型：{item.eventType} · {formatTimestamp(item.createdAt)}
        </Typography.Text>
      </Space>
    </Card>
  );
};

const PlaygroundUnknownEventRenderer: ChatRenderer = ({
  formatTimestamp,
  item,
}) => {
  if (item.kind !== "unknown-event") return null;
  return (
    <Alert
      description={
        <>
          <Typography.Paragraph style={{ marginBottom: 4 }}>
            {item.summary}
          </Typography.Paragraph>
          <Typography.Text type="secondary">
            {formatTimestamp(item.createdAt)}
          </Typography.Text>
        </>
      }
      message={`未知事件：${item.originalType}`}
      showIcon
      type="warning"
    />
  );
};

export const playgroundRenderers: ChatRendererRegistry = Object.freeze({
  "agent-event:tool": PlaygroundAgentEventRenderer,
  "agent-event": PlaygroundAgentEventRenderer,
  message: PlaygroundMessageRenderer,
  "unknown-event": PlaygroundUnknownEventRenderer,
});

export const PlaygroundRunStatus = ({
  onInterrupt,
  run,
}: {
  readonly onInterrupt: () => void;
  readonly run: Run | null;
}) => {
  if (run === null) return null;
  const interruptAvailable = run.status === "running" && run.canInterrupt;
  return (
    <div className="playground-run-status">
      <Typography.Text>
        运行状态：
        <Tag color={statusColor(run.status)}>{runStatusLabels[run.status]}</Tag>
      </Typography.Text>
      {run.status === "running" ? (
        <Button
          danger
          disabled={!interruptAvailable}
          onClick={onInterrupt}
          size="small"
        >
          {interruptAvailable ? "停止" : "当前无法停止"}
        </Button>
      ) : null}
    </div>
  );
};
