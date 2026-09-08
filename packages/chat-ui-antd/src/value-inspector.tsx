import { useMemo, useState, type ReactNode } from "react";
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
}: {
  readonly value: unknown;
  readonly markdown?: boolean | undefined;
}): ReactNode {
  const text = useMemo(() => serializeInspectionValue(value), [value]);
  const [limit, setLimit] = useState(4_000);
  const [copyStatus, setCopyStatus] = useState<"Copied" | "Copy failed">();
  const visible = text.slice(0, limit);
  return (
    <section
      aria-label="Result inspector"
      style={{ minWidth: 0, overflowWrap: "anywhere" }}
    >
      {markdown ? (
        <ChatMarkdownContent>{visible}</ChatMarkdownContent>
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
      <button
        type="button"
        onClick={() => {
          void Promise.resolve()
            .then(() => navigator.clipboard.writeText(text))
            .then(() => setCopyStatus("Copied"))
            .catch(() => setCopyStatus("Copy failed"));
        }}
      >
        Copy received result
      </button>
      {copyStatus !== undefined && <span role="status">{copyStatus}</span>}
    </section>
  );
}
