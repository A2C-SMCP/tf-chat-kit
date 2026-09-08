import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  type ChatResolvedResource,
  type MessageResource,
} from "@turingfocus/chat-protocol";
import {
  useChatResource,
  useChatResourcePort,
  getSafeChatResourceUrl,
  createResourceCancellationSignal,
} from "@turingfocus/chat-react";

export interface ChatResourceViewProps {
  readonly resource: MessageResource;
  readonly kind?: "image" | "audio" | "video" | "file" | undefined;
  readonly label?: string | undefined;
  readonly inline?: boolean | undefined;
  readonly children?: ReactNode;
}

/** All built-in resource views share cancellation and host authorization policy. */
export function ChatResourceView({
  resource,
  kind = "file",
  label,
  inline = false,
  children,
}: ChatResourceViewProps): ReactNode {
  const stableResource = useMemo(
    () => ({
      uri: resource.uri,
      name: resource.name,
      mimeType: resource.mimeType,
      size: resource.size,
    }),
    [resource.uri, resource.name, resource.mimeType, resource.size],
  );
  const resolved = useChatResource(stableResource);
  const { port, scope, client, conversationId } = useChatResourcePort();
  const [failed, setFailed] = useState(false);
  const [actionError, setActionError] = useState(false);
  const [busy, setBusy] = useState(false);
  const operation = useRef<AbortController>();
  const completedLeases = useRef(new Set<ChatResolvedResource>());
  const media = useRef<HTMLMediaElement | null>(null);
  useEffect(() => {
    setFailed(false);
    setActionError(false);
    setBusy(false);
    const leases = completedLeases.current;
    return () => {
      operation.current?.abort();
      for (const lease of leases) {
        try {
          lease.dispose?.();
        } catch {
          /* Host cleanup must not interrupt disposal of other leases. */
        }
      }
      leases.clear();
    };
  }, [stableResource, port, scope, client, conversationId]);
  // Ref cleanup follows the actual DOM node, including error/retry with an unchanged URL.
  const bindMedia = useCallback(
    (element: HTMLMediaElement | null) => {
      const previous = media.current;
      if (previous !== null && previous !== element) {
        previous.pause();
        previous.removeAttribute("src");
        previous.load();
      }
      media.current = element;
      if (
        element !== null &&
        resolved.url !== undefined &&
        element.getAttribute("src") !== resolved.url
      ) {
        element.setAttribute("src", resolved.url);
      }
    },
    [resolved.url, port, scope, client, conversationId],
  );
  const title = label ?? resource.name ?? "File";
  const act = async (purpose: "open" | "download"): Promise<void> => {
    operation.current?.abort();
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    setActionError(false);
    let lease: ChatResolvedResource | undefined;
    try {
      const request = {
        resource: stableResource,
        purpose,
        conversationId,
        signal: createResourceCancellationSignal(controller.signal),
      };
      const action = port?.[purpose];
      if (action !== undefined) {
        await action.call(port, request);
        return;
      }
      lease =
        port?.resolve === undefined
          ? { url: resource.uri }
          : await port.resolve(request);
      if (controller.signal.aborted) return;
      const url = getSafeChatResourceUrl(
        lease.url,
        purpose === "open"
          ? { baseUrl: document.baseURI, allowMailto: inline }
          : undefined,
      );
      if (url === undefined) throw new Error("Resource unavailable");
      if (purpose === "open") {
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.target = "_blank";
        anchor.rel = "noopener noreferrer";
        anchor.click();
        completedLeases.current.add(lease);
        lease = undefined;
      } else {
        const response = await fetch(url, {
          signal: controller.signal,
          credentials: "omit",
          referrerPolicy: "no-referrer",
        });
        if (!response.ok) throw new Error("Download failed");
        const blob = await response.blob();
        if (controller.signal.aborted) return;
        const objectUrl = URL.createObjectURL(blob);
        // Keep the URL valid until the resource leaves this scope; navigation consumes it asynchronously.
        completedLeases.current.add({
          url: objectUrl,
          dispose: () => URL.revokeObjectURL(objectUrl),
        });
        const anchor = document.createElement("a");
        anchor.href = objectUrl;
        anchor.download = resource.name ?? "download";
        anchor.click();
      }
    } catch {
      if (!controller.signal.aborted) setActionError(true);
    } finally {
      try {
        lease?.dispose?.();
      } catch {
        if (!controller.signal.aborted) setActionError(true);
      } finally {
        if (!controller.signal.aborted) setBusy(false);
      }
    }
  };
  if (inline)
    return (
      <span data-chat-resource="link">
        <a
          href={
            resolved.url ??
            getSafeChatResourceUrl(resource.uri, {
              baseUrl:
                typeof document === "undefined" ? undefined : document.baseURI,
              allowMailto: true,
            }) ??
            "#"
          }
          aria-disabled={busy}
          onClick={(event) => {
            event.preventDefault();
            if (!busy) void act("open");
          }}
        >
          {children ?? title}
        </a>
        {actionError && (
          <span role="alert">Resource action failed. Try again.</span>
        )}
      </span>
    );
  return (
    <div data-chat-resource={kind} style={{ maxWidth: "100%" }}>
      {kind === "file" ? (
        <span>{title}</span>
      ) : resolved.url !== undefined && !failed ? (
        kind === "image" ? (
          <img
            src={resolved.url}
            alt={title}
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={() => setFailed(true)}
            style={{
              maxWidth: "100%",
              maxHeight: "32rem",
              objectFit: "contain",
            }}
          />
        ) : kind === "audio" ? (
          <audio
            key={resolved.url}
            ref={bindMedia}
            src={resolved.url}
            controls
            preload="none"
            aria-label={title}
            onError={() => setFailed(true)}
          />
        ) : (
          <video
            key={resolved.url}
            ref={bindMedia}
            src={resolved.url}
            controls
            preload="none"
            aria-label={title}
            onError={() => setFailed(true)}
            style={{ maxWidth: "100%" }}
          />
        )
      ) : (
        <span>
          {title} — {resolved.status === "loading" ? "Loading" : "Unavailable"}
        </span>
      )}
      {(failed || resolved.status === "unavailable") && (
        <button
          type="button"
          onClick={() => {
            setFailed(false);
            resolved.retry();
          }}
        >
          Retry resource
        </button>
      )}
      {kind === "file" && (
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            void act("open");
          }}
        >
          Open
        </button>
      )}
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          void act("download");
        }}
      >
        Download
      </button>
      {actionError && (
        <span role="alert">Resource action failed. Try again.</span>
      )}
    </div>
  );
}
