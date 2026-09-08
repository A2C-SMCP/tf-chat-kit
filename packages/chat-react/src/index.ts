export {
  ChatProvider,
  OwnedChatProvider,
  type ChatClientDisposeOptions,
  type ChatClientFactory,
  type ChatProviderProps,
  type OwnedChatProviderProps,
} from "./provider.js";
export {
  useChatClient,
  useChatAttachmentUploader,
  useComposerDraft,
  useChatSelector,
  useChatSnapshot,
  type ChatSelector,
  type ComposerDraftBinding,
  type ChatSelectorEquality,
} from "./hooks.js";
export {
  useConversationWorkspace,
  type ConversationWorkspaceBinding,
  type UseConversationWorkspaceOptions,
} from "./conversation-workspace.js";
export type {
  ChatAttachmentUploader,
  ChatAttachmentUploadInput,
} from "./attachment-upload.js";
export type {
  ComposerDraft,
  ComposerLongText,
  ComposerTextEdit,
  SetComposerDraftInput,
} from "@turingfocus/chat-runtime";
export {
  rebaseComposerLongTexts,
  resolveComposerDraftText,
} from "@turingfocus/chat-runtime";

export {
  ChatResourceProvider,
  useChatResource,
  useChatResourcePort,
  type ChatResourceProviderProps,
  type ChatResourceBinding,
} from "./resources.js";

export {
  getSafeChatResourceUrl,
  createResourceCancellationSignal,
} from "./resources.js";

export {
  useChatEventNavigation,
  type ChatEventNavigationMode,
  type ChatEventNavigationBinding,
  type UseChatEventNavigationOptions,
} from "./event-navigation.js";

export {
  ChatDocumentSourceProvider,
  useChatDocumentSource,
  type ChatDocumentSourceProviderProps,
} from "./document-source.js";
export {
  appendComposerReference,
  type ChatDocumentReference,
  type ChatDocumentSource,
} from "@turingfocus/chat-runtime";
