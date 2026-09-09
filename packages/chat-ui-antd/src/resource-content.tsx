import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ChatResourceError,
  normalizeChatResourceError,
  type ChatResourceFailure,
  type ChatResolvedResource,
  type MessageResource,
} from "@turingfocus/chat-protocol";
import {
  useChatResource,
  useChatResourcePort,
  getSafeChatResourceUrl,
  createResourceCancellationSignal,
} from "@turingfocus/chat-react";

import { useResourceLabels } from "./resource-labels.js";
import type { ChatUiLabelOverrides } from "./types.js";

export interface ChatResourceViewProps {
  readonly labels?: ChatUiLabelOverrides | undefined;
  readonly resource: MessageResource;
  readonly kind?: "image" | "audio" | "video" | "file" | undefined;
  readonly label?: string | undefined;
  readonly inline?: boolean | undefined;
  readonly children?: ReactNode;
}

/** All built-in resource views share cancellation and host authorization policy. */
export function ChatResourceView({
  resource,
  labels: labelOverrides,
  kind = "file",
  label,
  inline = false,
  children,
}: ChatResourceViewProps): ReactNode {
  const labels = useResourceLabels(labelOverrides);
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
  const [mediaError, setMediaError] = useState<ChatResourceFailure>();
  const [actionError, setActionError] = useState<ChatResourceFailure>();
  const [busy, setBusy] = useState<"open" | "download">();
  const operation = useRef<AbortController>();
  const completedLeases = useRef(new Set<ChatResolvedResource>());
  const media = useRef<HTMLMediaElement | null>(null);
  useEffect(() => {
    setMediaError(undefined);
    setActionError(undefined);
    setBusy(undefined);
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
  const title =
    label ??
    resource.name ??
    (kind === "file" ? labels.fileTitle : labels[kind]);
  const displayError = mediaError ?? resolved.error;
  const failure = displayError?.code === "cancelled" ? undefined : displayError;
  const onMediaError = (element?: HTMLMediaElement): void => {
    // MediaError codes are standardized; image events expose no reliable cause.
    const code = element?.error?.code;
    setMediaError(
      normalizeChatResourceError({
        code:
          code === 1
            ? "cancelled"
            : code === 2
              ? "network"
              : code === 3 || code === 4
                ? "unsupported"
                : "unknown",
      }),
    );
  };
  const act = async (purpose: "open" | "download"): Promise<void> => {
    operation.current?.abort();
    const controller = new AbortController();
    operation.current = controller;
    setBusy(purpose);
    setActionError(undefined);
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
      if (url === undefined) throw new ChatResourceError("unsupported");
      if (purpose === "open") {
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.target = "_blank";
        anchor.rel = "noopener noreferrer";
        anchor.click();
        completedLeases.current.add(lease);
        lease = undefined;
      } else {
        let blob: Blob;
        try {
          const response = await fetch(url, {
            signal: controller.signal,
            credentials: "omit",
            referrerPolicy: "no-referrer",
          });
          if (!response.ok)
            throw new ChatResourceError(
              response.status === 401 || response.status === 403
                ? "unauthorized"
                : response.status === 404
                  ? "not-found"
                  : response.status === 410
                    ? "expired"
                    : response.status === 415
                      ? "unsupported"
                      : "unknown",
            );
          blob = await response.blob();
        } catch (error) {
          if (error instanceof TypeError)
            throw new ChatResourceError("network");
          throw error;
        }
        if (controller.signal.aborted) return;
        const objectUrl = URL.createObjectURL(blob);
        // Keep the URL valid until the resource leaves this scope; navigation consumes it asynchronously.
        completedLeases.current.add({
          url: objectUrl,
          dispose: () => URL.revokeObjectURL(objectUrl),
        });
        const anchor = document.createElement("a");
        anchor.href = objectUrl;
        anchor.download = resource.name ?? labels.fileTitle;
        anchor.click();
      }
    } catch (error) {
      const failure = normalizeChatResourceError(error);
      if (!controller.signal.aborted && failure.code !== "cancelled")
        setActionError(failure);
    } finally {
      try {
        lease?.dispose?.();
      } catch {
        // Releasing a host lease is cleanup, not a failed user action.
      } finally {
        if (!controller.signal.aborted) setBusy(undefined);
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
          aria-disabled={busy !== undefined}
          onClick={(event) => {
            event.preventDefault();
            if (!busy) void act("open");
          }}
        >
          {children ?? title}
        </a>
        {busy && <span role="status">{labels.opening}</span>}
        {actionError && <span role="alert">{labels[actionError.code]}</span>}
      </span>
    );
  return (
    <div data-chat-resource={kind} style={{ maxWidth: "100%" }}>
      {kind === "file" ? (
        <span>{title}</span>
      ) : resolved.url !== undefined && mediaError === undefined ? (
        kind === "image" ? (
          <img
            src={resolved.url}
            alt={title}
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={() => onMediaError()}
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
            onError={(event) => onMediaError(event.currentTarget)}
          />
        ) : (
          <video
            key={resolved.url}
            ref={bindMedia}
            src={resolved.url}
            controls
            preload="none"
            aria-label={title}
            onError={(event) => onMediaError(event.currentTarget)}
            style={{ maxWidth: "100%" }}
          />
        )
      ) : (
        <span>{title}</span>
      )}
      {resolved.status === "loading" && (
        <span role="status">{labels.loading}</span>
      )}
      {displayError?.code === "cancelled" && <span>{labels.cancelled}</span>}
      {failure && <span role="alert">{labels[failure.code]}</span>}
      {failure?.retryable && (
        <button
          type="button"
          onClick={() => {
            setMediaError(undefined);
            resolved.retry();
          }}
        >
          {labels.retry}
        </button>
      )}
      {kind === "file" && (
        <button
          type="button"
          disabled={busy !== undefined}
          onClick={() => {
            void act("open");
          }}
        >
          {labels.open}
        </button>
      )}
      <button
        type="button"
        disabled={busy !== undefined}
        onClick={() => {
          void act("download");
        }}
      >
        {labels.download}
      </button>
      {busy && (
        <span role="status">
          {busy === "open" ? labels.opening : labels.downloading}
        </span>
      )}
      {actionError && <span role="alert">{labels[actionError.code]}</span>}
    </div>
  );
}
