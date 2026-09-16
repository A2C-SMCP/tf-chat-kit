export {
  ChatClient,
  createChatClient,
  type ChatClientOptions,
  type ChatClientSubscription,
  type ChatSnapshotListener,
  type ChatSnapshotStateListener,
  type ChatClientUnhandledError,
  type ChatClientUnhandledErrorSource,
} from "./chat-client.js";
export {
  ConversationWorkspaceController,
  createConversationWorkspaceController,
  orderConversationsByUpdatedAt,
  type ConversationWorkspaceControllerOptions,
  type ConversationWorkspaceListStatus,
  type ConversationWorkspaceSelectionStatus,
  type ConversationWorkspaceSnapshot,
  type ConversationWorkspaceSubscription,
  type CreateWorkspaceConversationInput,
  type RenameWorkspaceConversationInput,
} from "./conversation-workspace.js";
export {
  emptyComposerDraft,
  rebaseComposerLongTexts,
  resolveComposerDraftText,
  type ComposerDraft,
  type ComposerDraftListener,
  type ComposerLongText,
  type ComposerTextEdit,
  type SetComposerDraftInput,
} from "./composer-draft.js";
export type {
  GatewayRequestOptions,
  GatewayResult,
  UploadCancellationSignal,
  UploadedAttachment,
} from "@turingfocus/chat-protocol";

export type {
  ChatResourcePort,
  ChatResourceRequest,
  ChatResourcePurpose,
  ChatResolvedResource,
  MessageResource,
} from "@turingfocus/chat-protocol";

export {
  appendComposerReference,
  type ChatDocumentReference,
  type ChatDocumentSource,
} from "./references.js";

export {
  ChatResourceError,
  normalizeChatResourceError,
  type ChatResourceFailure,
  type ChatResourceErrorCode,
} from "@turingfocus/chat-protocol";

export type {
  ConversationCacheOptions,
  ConversationCacheState,
  ConversationCacheStorage,
  ConversationCacheEvent,
  CachedAttachmentResolver,
} from "./conversation-cache.js";
export type { ConversationCacheRecord } from "./cache-record.js";

export type { ChatDiagnosticsOptions } from "./diagnostics.js";
export type { ChatDiagnosticRecord } from "@turingfocus/chat-protocol";

export {
  RemoteToolClient,
  createRemoteToolClient,
  type RemoteToolClientOptions,
  type RemoteToolClientState,
} from "./remote-tool-client.js";

export {
  AskUserRemoteTool,
  createAskUserRemoteTool,
  type AskUserRemoteToolOptions,
  type AskUserRemoteToolEntry,
} from "./ask-user-remote-tool.js";
