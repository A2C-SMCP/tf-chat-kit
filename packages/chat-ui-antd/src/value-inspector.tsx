import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Button, Tooltip, theme } from "antd";
import { ChatMarkdownContent } from "./markdown-content.js";

export function serializeInspectionValue(value: unknown): string {
  try {
    return typeof value === "string"
      ? value
      : (JSON.stringify(value, null, 2) ?? "[Value unavailable]");
  } catch {
    return "[Value could not be serialized]";
  }
}

export function ValueInspector({
  value,
  markdown = false,
  label = "执行结果",
}: {
  readonly value: unknown;
  readonly markdown?: boolean | undefined;
  readonly label?: string | undefined;
}): ReactNode {
  const { token } = theme.useToken();
  const text = useMemo(() => serializeInspectionValue(value), [value]);
  const [limit, setLimit] = useState(4_000);
  const [copyStatus, setCopyStatus] = useState<"Copied" | "Copy failed">();
  const visible = text.slice(0, limit);
  const structured = useMemo(() => {
    if (text.length <= limit) {
      try {
        const parsed: unknown = JSON.parse(text);
        return typeof parsed === "object" && parsed !== null
          ? parsed
          : undefined;
      } catch {
        return undefined;
      }
    }
    return undefined;
  }, [text, limit]);
  const renderMarkdown =
    markdown ||
    (label === "执行结果" &&
      typeof value === "string" &&
      structured === undefined &&
      /(?:^|\n)\s{0,3}(?:#{1,6}\s|[-*+]\s|\d+\.\s|```|>\s)|\*\*[^\n]+\*\*|\[[^\]\n]+\]\([^\n]+\)/.test(
        text,
      ));
  useEffect(() => {
    setCopyStatus(undefined);
    setLimit(4_000);
  }, [text]);
  useEffect(() => {
    if (!copyStatus) return;
    const timer = setTimeout(() => setCopyStatus(undefined), 2000);
    return () => clearTimeout(timer);
  }, [copyStatus]);
  return (
    <section
      aria-label="Result inspector"
      style={{
        minWidth: 0,
        width: "100%",
        overflowWrap: "anywhere",
        border: `1px solid ${token.colorBorderSecondary}`,
        borderRadius: token.borderRadiusLG,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "6px 12px",
          background: token.colorFillQuaternary,
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
        }}
      >
        <strong style={{ fontSize: 12, color: token.colorTextSecondary }}>
          {label}
        </strong>
        <Tooltip title={copyStatus === "Copied" ? "已复制" : `复制${label}`}>
          <Button
            type="text"
            size="small"
            aria-label={`复制${label}`}
            onClick={() => {
              void Promise.resolve()
                .then(() => navigator.clipboard.writeText(text))
                .then(() => setCopyStatus("Copied"))
                .catch(() => setCopyStatus("Copy failed"));
            }}
            icon={
              copyStatus === "Copied" ? (
                <span aria-hidden="true">✓</span>
              ) : (
                <svg
                  aria-hidden="true"
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                >
                  <rect x="8" y="8" width="12" height="13" rx="2" />
                  <path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" />
                </svg>
              )
            }
          />
        </Tooltip>
      </div>
      <div
        style={{ padding: "12px 14px", maxHeight: "32rem", overflow: "auto" }}
      >
        {renderMarkdown ? (
          <>
            <ChatMarkdownContent>{visible}</ChatMarkdownContent>
            <details>
              <summary
                style={{
                  cursor: "pointer",
                  color: token.colorTextSecondary,
                  fontSize: 12,
                }}
              >
                查看原文
              </summary>
              <pre style={{ whiteSpace: "pre-wrap" }}>{visible}</pre>
            </details>
          </>
        ) : structured !== undefined && text.length <= limit ? (
          <>
            <InspectionTree value={structured} />
            <details style={{ marginTop: 12 }}>
              <summary
                style={{
                  cursor: "pointer",
                  color: token.colorTextSecondary,
                  fontSize: 12,
                }}
              >
                查看原文
              </summary>
              <pre style={{ whiteSpace: "pre-wrap", marginBottom: 0 }}>
                {visible}
              </pre>
            </details>
          </>
        ) : (
          <pre
            style={{
              margin: 0,
              whiteSpace: "pre-wrap",
              maxHeight: "32rem",
              overflow: "auto",
            }}
          >
            {visible}
          </pre>
        )}
        {text.length > limit && (
          <>
            <span role="status">
              Showing {limit} of {text.length} received characters. [Result
              truncated]
            </span>
            <button
              type="button"
              onClick={() => setLimit((current) => current + 64_000)}
            >
              Show more result
            </button>
          </>
        )}
        {limit > 4_000 && (
          <button type="button" onClick={() => setLimit(4_000)}>
            Collapse result
          </button>
        )}
        {copyStatus !== undefined && <span role="status">{copyStatus}</span>}
      </div>
    </section>
  );
}

const InspectionTree = ({
  value,
  depth = 0,
}: {
  readonly value: unknown;
  readonly depth?: number;
}): ReactNode => {
  const { token } = theme.useToken();
  if (typeof value !== "object" || value === null || depth >= 6)
    return (
      <span style={{ whiteSpace: "pre-wrap" }}>
        {serializeInspectionValue(value)}
      </span>
    );
  const entries = Object.entries(value);
  if (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 50 &&
    value.every(
      (row) => typeof row === "object" && row !== null && !Array.isArray(row),
    )
  ) {
    const rows = value as Record<string, unknown>[];
    const keys = [...new Set(rows.flatMap((row) => Object.keys(row)))];
    if (
      keys.length > 0 &&
      keys.length <= 8 &&
      rows.every((row) =>
        Object.values(row).every(
          (cell) => typeof cell !== "object" || cell === null,
        ),
      )
    ) {
      return (
        <div style={{ overflowX: "auto", maxWidth: "100%" }}>
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              textAlign: "left",
              fontSize: 13,
            }}
          >
            <thead>
              <tr>
                {keys.map((key) => (
                  <th
                    key={key}
                    style={{
                      padding: "8px 10px",
                      background: token.colorFillQuaternary,
                      borderBottom: `1px solid ${token.colorBorderSecondary}`,
                    }}
                  >
                    {key}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={index}>
                  {keys.map((key) => (
                    <td
                      key={key}
                      style={{
                        padding: "8px 10px",
                        verticalAlign: "top",
                        borderBottom: `1px solid ${token.colorBorderSecondary}`,
                        whiteSpace: "pre-wrap",
                      }}
                    >
                      {row[key] === undefined
                        ? "—"
                        : serializeInspectionValue(row[key])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
  }
  return (
    <div>
      {entries.slice(0, 50).map(([key, child]) => (
        <div
          key={key}
          style={{
            padding: "7px 0",
            borderBottom: `1px solid ${token.colorBorderSecondary}`,
            display: "grid",
            gridTemplateColumns: "minmax(65px, 28%) minmax(0, 1fr)",
            gap: 12,
          }}
        >
          <span
            style={{
              color: token.colorTextSecondary,
              fontFamily: "monospace",
              fontSize: 12,
            }}
          >
            {Array.isArray(value) ? Number(key) + 1 : key}
          </span>
          {typeof child === "object" && child !== null ? (
            <details open={depth < 2}>
              <summary style={{ cursor: "pointer", fontSize: 12 }}>
                {Array.isArray(child) ? "列表" : "对象"} ·{" "}
                {Object.keys(child).length} 项
              </summary>
              <InspectionTree value={child} depth={depth + 1} />
            </details>
          ) : (
            <InspectionTree value={child} depth={depth + 1} />
          )}
        </div>
      ))}
      {entries.length > 50 ? (
        <small>另有 {entries.length - 50} 项，请展开“查看原文”。</small>
      ) : null}
    </div>
  );
};
