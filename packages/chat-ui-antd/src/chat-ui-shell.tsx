import { Typography, theme } from "antd";
import type { CSSProperties, ReactNode } from "react";

import {
  ChatConversationList,
  type ConversationListError,
} from "./conversation-list.js";
import { resolveChatUiLabels } from "./labels.js";
import { ChatStateView } from "./chat-state-view.js";
import type {
  ChatContentState,
  ChatConversationListItem,
  ChatUiLabelOverrides,
  ChatUiSlotStyles,
} from "./types.js";

export interface ChatUiShellProps {
  readonly children?: ReactNode;
  readonly className?: string | undefined;
  readonly contentState: ChatContentState;
  readonly conversationListError?: ConversationListError | undefined;
  readonly conversationListLoading?: boolean | undefined;
  readonly conversations: readonly ChatConversationListItem[];
  readonly formatConversationUpdatedAt?:
    ((updatedAt: number, item: ChatConversationListItem) => string) | undefined;
  readonly header?: ReactNode;
  readonly labels?: ChatUiLabelOverrides | undefined;
  readonly onConversationSelect: (conversationId: string) => void;
  readonly pendingConversationId?: string | undefined;
  readonly selectedConversationId?: string | undefined;
  readonly sidebarFooter?: ReactNode | undefined;
  readonly sidebarTitle?: ReactNode;
  readonly sidebarWidth?: CSSProperties["width"] | undefined;
  readonly styles?: ChatUiSlotStyles | undefined;
}

export const ChatUiShell = ({
  children,
  className,
  contentState,
  conversationListError,
  conversationListLoading,
  conversations,
  formatConversationUpdatedAt,
  header,
  labels: labelOverrides,
  onConversationSelect,
  pendingConversationId,
  selectedConversationId,
  sidebarFooter,
  sidebarTitle,
  sidebarWidth = 280,
  styles,
}: ChatUiShellProps) => {
  const { token } = theme.useToken();
  const labels = resolveChatUiLabels(labelOverrides);

  return (
    <section
      className={className}
      style={{
        background: token.colorBgContainer,
        border: `${token.lineWidth}px ${token.lineType} ${token.colorBorderSecondary}`,
        borderRadius: token.borderRadiusLG,
        display: "grid",
        gridTemplateColumns: `minmax(13rem, ${typeof sidebarWidth === "number" ? `${sidebarWidth}px` : sidebarWidth}) minmax(0, 1fr)`,
        height: "100%",
        minHeight: 360,
        minWidth: 0,
        overflow: "hidden",
        ...styles?.root,
      }}
    >
      <aside
        aria-label={labels.conversationListLabel}
        style={{
          borderInlineEnd: `${token.lineWidth}px ${token.lineType} ${token.colorBorderSecondary}`,
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
          minWidth: 0,
          ...styles?.sidebar,
        }}
      >
        <header
          style={{
            borderBlockEnd: `${token.lineWidth}px ${token.lineType} ${token.colorBorderSecondary}`,
            padding: token.paddingSM,
          }}
        >
          {sidebarTitle ?? (
            <Typography.Title level={5} style={{ margin: 0 }}>
              {labels.conversationListLabel}
            </Typography.Title>
          )}
        </header>
        <div style={{ flex: 1, minHeight: 0 }}>
          <ChatConversationList
            error={conversationListError}
            formatUpdatedAt={formatConversationUpdatedAt}
            items={conversations}
            labels={labels}
            loading={conversationListLoading}
            onSelect={onConversationSelect}
            pendingConversationId={pendingConversationId}
            selectedConversationId={selectedConversationId}
            style={styles?.conversationList}
          />
        </div>
        {sidebarFooter === undefined ? null : (
          <footer
            style={{
              borderBlockStart: `${token.lineWidth}px ${token.lineType} ${token.colorBorderSecondary}`,
              padding: token.paddingSM,
            }}
          >
            {sidebarFooter}
          </footer>
        )}
      </aside>
      <main
        style={{
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
          minWidth: 0,
          ...styles?.content,
        }}
      >
        {header === undefined ? null : (
          <header
            style={{
              borderBlockEnd: `${token.lineWidth}px ${token.lineType} ${token.colorBorderSecondary}`,
              padding: token.paddingSM,
            }}
          >
            {header}
          </header>
        )}
        <div style={{ flex: 1, minHeight: 0 }}>
          {contentState.kind === "ready" ? (
            children
          ) : (
            <ChatStateView labels={labels} state={contentState} />
          )}
        </div>
      </main>
    </section>
  );
};
