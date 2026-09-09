import type { CSSProperties, ReactNode } from "react";
import type { ChatLifecycleStatus } from "@turingfocus/chat-protocol";

export type ChatNavigationMode = "compact" | "sidebar";

export interface ChatCompactNavigationConfig {
  /** 当前会话标题 */
  readonly conversationTitle: string;
  /** 历史会话 dropdown 是否打开 */
  readonly conversationHistoryOpen: boolean;
  /** 历史会话列表项（非加载/错误态） */
  readonly conversationHistoryItems: readonly ChatConversationListItem[];
  /** 历史会话列表是否加载中 */
  readonly conversationHistoryLoading?: boolean | undefined;
  /** 历史会话列表错误信息 */
  readonly conversationHistoryError?: string | undefined;
  /** 历史会话 dropdown 开关回调 */
  readonly onConversationHistoryOpenChange: (open: boolean) => void;
  /** 新建会话回调 */
  readonly onNewConversation: () => void;
}

export interface ChatConversationListItem {
  readonly description?: string | undefined;
  readonly disabled?: boolean | undefined;
  readonly id: string;
  readonly title: string;
  /** Unix epoch milliseconds. */
  readonly updatedAt?: number | undefined;
}

export type ChatContentState =
  | { readonly kind: "ready" }
  | {
      readonly description?: ReactNode | undefined;
      readonly kind: "loading";
      readonly title?: ReactNode | undefined;
    }
  | {
      readonly description?: ReactNode | undefined;
      readonly kind: "empty";
      readonly title?: ReactNode | undefined;
    }
  | {
      readonly description?: ReactNode | undefined;
      readonly kind: "error";
      readonly onRetry?: (() => void) | undefined;
      readonly title?: ReactNode | undefined;
    }
  | {
      readonly description?: ReactNode | undefined;
      readonly kind: "disconnected";
      readonly onRetry?: (() => void) | undefined;
      readonly title?: ReactNode | undefined;
    }
  | {
      readonly capability?: string | undefined;
      readonly description?: ReactNode | undefined;
      readonly kind: "capability-unavailable";
      readonly title?: ReactNode | undefined;
    };

export interface ChatResourceLabels {
  readonly screenshot: string;
  readonly generatedFile: string;
  readonly fileTitle: string;
  readonly image: string;
  readonly audio: string;
  readonly video: string;
  readonly loading: string;
  readonly retry: string;
  readonly open: string;
  readonly download: string;
  readonly opening: string;
  readonly downloading: string;
  readonly unauthorized: string;
  readonly network: string;
  readonly "not-found": string;
  readonly expired: string;
  readonly unsupported: string;
  readonly cancelled: string;
  readonly unknown: string;
}

export interface ChatUiLabels {
  /** Resource copy is optional so existing complete host dictionaries remain valid. */
  readonly resource?: Readonly<Partial<ChatResourceLabels>> | undefined;
  readonly attach: ReactNode;
  readonly askUserCancel: ReactNode;
  readonly askUserChatAboutThis: ReactNode;
  readonly askUserLabel: string;
  readonly askUserRequired: string;
  readonly askUserSubmit: ReactNode;
  readonly askUserSubmitting: ReactNode;
  readonly askUserUnavailable: ReactNode;
  readonly capabilityUnavailableDescription: ReactNode;
  readonly capabilityUnavailableTitle: ReactNode;
  readonly composerLabel: string;
  readonly composerPlaceholder: string;
  readonly conversationListLabel: string;
  /** Optional for backward compatibility with complete host label objects. */
  readonly createConversation?: ReactNode | undefined;
  /** Optional for backward compatibility with complete host label objects. */
  readonly createConversationConfirm?: ReactNode | undefined;
  /** Optional for backward compatibility with complete host label objects. */
  readonly createConversationTitleLabel?: string | undefined;
  /** Optional for backward compatibility with complete host label objects. */
  readonly createConversationTitlePlaceholder?: string | undefined;
  /** Optional conversation-management copy. */
  readonly deleteConversation?: ReactNode | undefined;
  readonly deleteConversationCancel?: ReactNode | undefined;
  readonly deleteConversationConfirm?: ReactNode | undefined;
  readonly deleteConversationPrompt?: ReactNode | undefined;
  readonly disconnectedDescription: ReactNode;
  readonly disconnectedTitle: ReactNode;
  readonly emptyDescription: ReactNode;
  readonly emptyTitle: ReactNode;
  readonly errorDescription: ReactNode;
  readonly errorTitle: ReactNode;
  readonly loadingDescription: ReactNode;
  readonly loadingTitle: ReactNode;
  readonly emptyTimeline: ReactNode;
  readonly eventDetailClose: string;
  readonly eventDetailEmpty: ReactNode;
  readonly eventDetailModeAuto: ReactNode;
  readonly eventDetailModeLabel: string;
  readonly eventDetailModeModal: ReactNode;
  readonly eventDetailModeSplit: ReactNode;
  /** Optional for backward compatibility with complete host label objects. */
  readonly eventDetailSplitHandleLabel?: string | undefined;
  readonly eventDetailTitle: string;
  readonly interrupt: ReactNode;
  readonly interruptUnavailable: ReactNode;
  readonly interrupting: ReactNode;
  readonly jumpToLatest: ReactNode;
  /** Optional for backward compatibility with complete host label objects. */
  readonly loadMoreConversations?: ReactNode | undefined;
  readonly renameConversation?: ReactNode | undefined;
  readonly renameConversationConfirm?: ReactNode | undefined;
  readonly newMessages: ReactNode;
  readonly noConversations: ReactNode;
  readonly openEventDetail: string;
  readonly pastedTextTitle: ReactNode;
  readonly removeAttachment: string;
  readonly removeLongText: string;
  readonly retry: ReactNode;
  readonly retryUpload: string;
  readonly runStatusLabel: ReactNode;
  readonly send: ReactNode;
  readonly sending: ReactNode;
  readonly textSendingUnavailable: string;
  readonly timelineLabel: string;
  readonly newConversation: ReactNode;
  readonly historyConversations: ReactNode;
  readonly noHistoryConversations: ReactNode;
  readonly loadingHistoryConversations: ReactNode;
  /** Optional lifecycle copy; omitted keys use the built-in English labels. */
  readonly lifecycleStatus?:
    Readonly<Partial<Record<ChatLifecycleStatus, ReactNode>>> | undefined;
}

export type ChatUiLabelOverrides = Partial<ChatUiLabels>;

export interface ChatUiSlotStyles {
  readonly content?: CSSProperties | undefined;
  readonly conversationList?: CSSProperties | undefined;
  readonly root?: CSSProperties | undefined;
  readonly sidebar?: CSSProperties | undefined;
}
