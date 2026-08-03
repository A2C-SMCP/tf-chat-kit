import { Tag, Typography, theme } from "antd";

import type { MessageRole, Run, RunStatus } from "@turingfocus/chat-protocol";
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

const roleLabels: Readonly<Record<MessageRole, string>> = {
  assistant: "助手",
  system: "系统",
  tool: "工具",
  unknown: "未知角色",
  user: "用户",
};

const statusColor = (
  status: RunStatus,
): "default" | "error" | "processing" | "success" =>
  status === "succeeded"
    ? "success"
    : status === "failed"
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

export const playgroundRenderers: ChatRendererRegistry = Object.freeze({
  message: PlaygroundMessageRenderer,
});

export const PlaygroundRunStatus = ({ run }: { readonly run: Run | null }) => {
  if (run === null) return null;
  return (
    <div className="playground-run-status">
      <Typography.Text>
        运行状态：
        <Tag color={statusColor(run.status)}>{runStatusLabels[run.status]}</Tag>
      </Typography.Text>
    </div>
  );
};
