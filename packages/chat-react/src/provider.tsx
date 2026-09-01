import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type { ChatClient } from "@turingfocus/chat-runtime";
import type { ChatAttachmentUploader } from "./attachment-upload.js";

import {
  ChatContext,
  type ChatContextValue,
  type ChatSnapshotValue,
} from "./context.js";

export type ChatClientDisposeOptions = Parameters<ChatClient["dispose"]>[0];

export interface ChatClientFactory {
  /**
   * Creates one new provider-owned client per call. React may replay effects
   * in development StrictMode, so factories must never reuse an instance.
   * Changing the factory object replaces the client, so hosts should keep this
   * object referentially stable.
   */
  create(): ChatClient;
  /**
   * Supplies a fresh deadline and other disposal options at cleanup time.
   * If this throws, the Provider reports the error and disposes immediately.
   */
  getDisposeOptions(): ChatClientDisposeOptions;
  /** Optional companion capability created from the same host configuration. */
  createAttachmentUploader?(): ChatAttachmentUploader;
}

export interface ChatProviderProps {
  readonly children?: ReactNode;
  /** A host-owned client. ChatProvider never disposes this instance. */
  readonly client: ChatClient;
  readonly attachmentUploader?: ChatAttachmentUploader | undefined;
  /** Snapshot used by React during server rendering and hydration. */
  readonly serverSnapshot?: ChatSnapshotValue | undefined;
}

export const ChatProvider = ({
  children,
  attachmentUploader,
  client,
  serverSnapshot = null,
}: ChatProviderProps) => {
  const value = useMemo<ChatContextValue>(
    () => ({ client, serverSnapshot, attachmentUploader }),
    [attachmentUploader, client, serverSnapshot],
  );

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
};

export interface OwnedChatProviderProps {
  readonly children?: ReactNode;
  /** Rendered until the effect-owned client is available. */
  readonly fallback?: ReactNode;
  /** A stable factory whose identity controls client replacement. */
  readonly factory: ChatClientFactory;
  /** Receives synchronous and asynchronous disposal failures. */
  readonly onDisposeError: (error: unknown) => void;
  /** Snapshot used by React during server rendering and hydration. */
  readonly serverSnapshot?: ChatSnapshotValue | undefined;
}

interface OwnedClientEntry {
  readonly attachmentUploader?: ChatAttachmentUploader | undefined;
  readonly client: ChatClient;
  readonly factory: ChatClientFactory;
}

/** Epoch zero is a valid, deterministically expired Protocol deadline. */
const IMMEDIATE_DISPOSE_OPTIONS: ChatClientDisposeOptions = Object.freeze({
  deadlineAt: 0,
});

const disposeOwnedClient = (
  entry: OwnedClientEntry,
  onDisposeError: (error: unknown) => void,
): void => {
  let disposeOptions = IMMEDIATE_DISPOSE_OPTIONS;
  let disposeOptionsError: unknown;
  let hasDisposeOptionsError = false;

  try {
    disposeOptions = entry.factory.getDisposeOptions();
  } catch (error) {
    hasDisposeOptionsError = true;
    disposeOptionsError = error;
  }

  try {
    void entry.client.dispose(disposeOptions).catch(onDisposeError);
  } catch (error) {
    onDisposeError(error);
  }

  try {
    void Promise.resolve(entry.attachmentUploader?.dispose?.()).catch(
      onDisposeError,
    );
  } catch (error) {
    onDisposeError(error);
  }

  if (hasDisposeOptionsError) onDisposeError(disposeOptionsError);
};

/**
 * Creates a client after mount and owns its lifecycle. The factory is never
 * called during render or SSR, avoiding leaked clients from abandoned renders.
 */
export const OwnedChatProvider = ({
  children,
  factory,
  fallback = null,
  onDisposeError,
  serverSnapshot = null,
}: OwnedChatProviderProps) => {
  const [entry, setEntry] = useState<OwnedClientEntry | null>(null);
  const onDisposeErrorRef = useRef(onDisposeError);

  useEffect(() => {
    onDisposeErrorRef.current = onDisposeError;
  }, [onDisposeError]);

  useEffect(() => {
    let client: ChatClient;
    try {
      client = factory.create();
    } catch (error) {
      onDisposeErrorRef.current(error);
      return undefined;
    }

    let nextEntry: OwnedClientEntry;
    try {
      nextEntry = {
        client,
        factory,
        ...(factory.createAttachmentUploader === undefined
          ? {}
          : { attachmentUploader: factory.createAttachmentUploader() }),
      };
    } catch (error) {
      onDisposeErrorRef.current(error);
      disposeOwnedClient({ client, factory }, (disposeError) => {
        onDisposeErrorRef.current(disposeError);
      });
      return undefined;
    }
    setEntry(nextEntry);

    return () => {
      setEntry((current) => (current === nextEntry ? null : current));
      disposeOwnedClient(nextEntry, (error) => {
        onDisposeErrorRef.current(error);
      });
    };
  }, [factory]);

  const activeEntry = entry?.factory === factory ? entry : null;
  if (activeEntry === null) return fallback;

  return (
    <ChatProvider
      attachmentUploader={activeEntry.attachmentUploader}
      client={activeEntry.client}
      serverSnapshot={serverSnapshot}
    >
      {children}
    </ChatProvider>
  );
};
