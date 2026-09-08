import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  createResourceCancellationSignal,
  useChatDocumentSource,
  type ChatDocumentReference,
} from "@turingfocus/chat-react";

export function ChatReferencePicker({
  conversationId,
  onSelect,
  onClose,
}: {
  readonly conversationId: string;
  readonly onSelect: (reference: ChatDocumentReference) => void;
  readonly onClose: () => void;
}): ReactNode {
  const { source, scope } = useChatDocumentSource();
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<{
    source: typeof source;
    scope: unknown;
    conversationId: string;
    items: readonly ChatDocumentReference[];
  }>();
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const controller = useRef<AbortController>();
  useEffect(() => {
    setFailed(false);
    setBusy(false);
    return () => controller.current?.abort();
  }, [source, scope, conversationId]);
  const search = async (): Promise<void> => {
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    setBusy(true);
    setFailed(false);
    try {
      const items = await source?.list({
        query,
        conversationId,
        signal: createResourceCancellationSignal(request.signal),
      });
      if (request.signal.aborted) return;
      setResult({
        source,
        scope,
        conversationId,
        items: (items ?? [])
          .filter(
            (item) =>
              item !== null &&
              typeof item === "object" &&
              typeof item.id === "string" &&
              item.id.length > 0 &&
              typeof item.title === "string" &&
              item.title.length > 0 &&
              typeof item.content === "string",
          )
          .slice(0, 100),
      });
    } catch {
      if (!request.signal.aborted) setFailed(true);
    } finally {
      if (!request.signal.aborted) setBusy(false);
    }
  };
  const items =
    result !== undefined &&
    result.source === source &&
    result.scope === scope &&
    result.conversationId === conversationId
      ? result.items
      : [];
  return (
    <section aria-label="Document references">
      <label>
        Search documents{" "}
        <input
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
      </label>
      <button
        type="button"
        disabled={busy || source === undefined}
        onClick={() => {
          void search();
        }}
      >
        Load references
      </button>
      <button type="button" onClick={onClose}>
        Cancel references
      </button>
      {failed && <span role="alert">Document source failed. Try again.</span>}
      <ul>
        {items.map((item, index) => (
          <li key={`${item.id}:${index}`}>
            <button type="button" onClick={() => onSelect(item)}>
              {item.title}
            </button>
          </li>
        ))}
      </ul>
      {result !== undefined && items.length === 0 && !busy && (
        <span>No references available</span>
      )}
    </section>
  );
}
