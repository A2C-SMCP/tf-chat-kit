import { Alert, Button, Modal, Typography } from "antd";
import { useState } from "react";
import {
  formatChatDiagnostic,
  safeDiagnosticError,
  type ChatError,
  type ChatDiagnosticRecord,
} from "@turingfocus/chat-protocol";
import { useChatDiagnostics } from "@turingfocus/chat-react";
import { resolveChatUiLabels } from "./labels.js";
import type { ChatUiLabelOverrides } from "./types.js";

export function errorSummary(error: ChatError): string {
  const names: Record<string, string> = {
    sendText: "Send message",
    sendMessage: "Send attachments",
    interrupt: "Stop run",
    answerInteraction: "Submit answer",
    uploadAttachment: "Upload attachment",
    loadConversation: "Load conversation",
    loadHistory: "Load history",
    subscribe: "Subscribe to live updates",
    cacheStorage: "Save or restore cache",
  };
  const d = error.diagnostic;
  const operation = names[d?.operation ?? ""] ?? "Chat operation";
  const cause =
    d?.httpStatus !== undefined &&
    d.httpStatus >= 400 &&
    error.code !== "timeout"
      ? `HTTP ${d.httpStatus}`
      : d?.businessCode !== undefined
        ? `business error ${d.businessCode}`
        : ((
            {
              authentication: "authentication failed",
              authorization: "access denied",
              timeout: "deadline exceeded",
              network: "request failed; underlying cause not provided",
              unknown: "cause not provided",
            } as Partial<Record<ChatError["code"], string>>
          )[error.code] ?? error.code);
  const impact =
    d?.outcome === "unknown"
      ? "Result unknown. Check conversation history before sending again."
      : "The operation did not complete.";
  return `${operation} failed${d?.phase ? ` during ${d.phase}` : ""}: ${cause}. ${impact}`;
}

function DiagnosticText({
  text,
  labels,
}: {
  text: string;
  labels?: ChatUiLabelOverrides | undefined;
}) {
  const copy = resolveChatUiLabels(labels);
  const [status, setStatus] = useState("");
  return (
    <div>
      <Button
        size="small"
        onClick={() => {
          void (async () => {
            try {
              if (typeof navigator === "undefined" || !navigator.clipboard)
                throw new Error();
              await navigator.clipboard.writeText(text);
              setStatus(copy.diagnosticCopied ?? "Copied");
            } catch {
              setStatus(
                copy.diagnosticCopyFailed ??
                  "Copy unavailable. Select the text below to copy manually.",
              );
            }
          })();
        }}
      >
        {copy.copyDiagnostic ?? "Copy diagnostic"}
      </Button>
      <span role="status">{status}</span>
      <pre
        tabIndex={0}
        style={{
          whiteSpace: "pre-wrap",
          overflowWrap: "anywhere",
          maxHeight: 320,
          overflow: "auto",
        }}
      >
        {text}
      </pre>
    </div>
  );
}

export function ChatDiagnostics({
  conversationId,
  labels,
}: {
  conversationId?: string | undefined;
  labels?: ChatUiLabelOverrides | undefined;
}) {
  const allRecords = useChatDiagnostics();
  const records = allRecords.filter(
    (record) =>
      record.conversationId === conversationId ||
      record.scope.kind === "global",
  );
  const copy = resolveChatUiLabels(labels);
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="small" onClick={() => setOpen(true)}>
        {copy.diagnostics ?? "Diagnostics"} ({records.length})
      </Button>
      <Modal
        title={copy.diagnostics ?? "Diagnostics"}
        open={open}
        onCancel={() => setOpen(false)}
        footer={null}
      >
        <DiagnosticText
          labels={labels}
          text={
            records.map(formatChatDiagnostic).join("\n\n") ||
            (copy.noDiagnostics ?? "No diagnostics recorded.")
          }
        />
        {records.map((record) => (
          <details key={record.id}>
            <summary>
              {record.source}: {record.error.code} ({record.count})
            </summary>
            <DiagnosticText
              labels={labels}
              text={formatChatDiagnostic(record)}
            />
          </details>
        ))}
      </Modal>
    </>
  );
}

export function ChatErrorNotice({
  error,
  operation,
  labels,
  onDismiss,
}: {
  error: ChatError;
  operation?: string | undefined;
  labels?: ChatUiLabelOverrides | undefined;
  onDismiss?: (() => void) | undefined;
}) {
  const records = useChatDiagnostics();
  const copy = resolveChatUiLabels(labels);
  const [open, setOpen] = useState(false);
  const safe = safeDiagnosticError({
    ...error,
    diagnostic: {
      ...error.diagnostic,
      operation: error.diagnostic?.operation ?? operation,
    },
  });
  const record: ChatDiagnosticRecord = records.find(
    (item) =>
      item.id === error.diagnostic?.errorId &&
      item.conversationId === error.conversationId,
  ) ?? {
    id: "local:unrecorded",
    conversationId: safe.conversationId,
    scope: { kind: "global" },
    source: "runtime",
    error: safe,
    firstAt: 0,
    lastAt: 0,
    count: 1,
    resolved: false,
  };
  return (
    <>
      <Alert
        type="error"
        showIcon
        closable={onDismiss !== undefined}
        onClose={() => onDismiss?.()}
        message={copy.formatChatError?.(safe) ?? errorSummary(safe)}
        action={
          <Button size="small" onClick={() => setOpen(true)}>
            {copy.diagnosticDetails ?? "Details"}
          </Button>
        }
      />
      <Modal
        title={copy.diagnosticDetails ?? "Details"}
        open={open}
        onCancel={() => setOpen(false)}
        footer={null}
      >
        <Typography.Paragraph>
          {copy.formatChatError?.(safe) ?? errorSummary(safe)}
        </Typography.Paragraph>
        <DiagnosticText text={formatChatDiagnostic(record)} labels={labels} />
      </Modal>
    </>
  );
}
