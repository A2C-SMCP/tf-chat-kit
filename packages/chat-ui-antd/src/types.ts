import type { CSSProperties, ReactNode } from "react";

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

export interface ChatUiLabels {
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
  readonly newMessages: ReactNode;
  readonly noConversations: ReactNode;
  readonly openEventDetail: string;
  readonly retry: ReactNode;
  readonly runStatusLabel: ReactNode;
  readonly send: ReactNode;
  readonly sending: ReactNode;
  readonly textSendingUnavailable: string;
  readonly timelineLabel: string;
}

export type ChatUiLabelOverrides = Partial<ChatUiLabels>;

export interface ChatUiSlotStyles {
  readonly content?: CSSProperties | undefined;
  readonly conversationList?: CSSProperties | undefined;
  readonly root?: CSSProperties | undefined;
  readonly sidebar?: CSSProperties | undefined;
}
