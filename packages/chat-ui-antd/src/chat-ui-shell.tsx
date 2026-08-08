import {
  Button,
  Dropdown,
  Space,
  Tooltip,
  Typography,
  theme,
  type MenuProps,
} from "antd";
import type { CSSProperties, ReactNode } from "react";

import {
  ChatConversationList,
  type ConversationListError,
} from "./conversation-list.js";
import { resolveChatUiLabels } from "./labels.js";
import { ChatStateView } from "./chat-state-view.js";
import type {
  ChatCompactNavigationConfig,
  ChatContentState,
  ChatConversationListItem,
  ChatNavigationMode,
  ChatUiLabelOverrides,
  ChatUiLabels,
  ChatUiSlotStyles,
} from "./types.js";

export interface ChatUiShellProps {
  readonly children?: ReactNode;
  readonly className?: string | undefined;
  readonly compactNavigation?: ChatCompactNavigationConfig | undefined;
  readonly contentState: ChatContentState;
  readonly conversationListError?: ConversationListError | undefined;
  readonly conversationListLoading?: boolean | undefined;
  readonly conversations: readonly ChatConversationListItem[];
  readonly formatConversationUpdatedAt?:
    | ((updatedAt: number, item: ChatConversationListItem) => string)
    | undefined;
  readonly header?: ReactNode;
  readonly labels?: ChatUiLabelOverrides | undefined;
  readonly navigationMode?: ChatNavigationMode | undefined;
  readonly onConversationSelect: (conversationId: string) => void;
  readonly pendingConversationId?: string | undefined;
  readonly selectedConversationId?: string | undefined;
  readonly sidebarFooter?: ReactNode | undefined;
  readonly sidebarTitle?: ReactNode;
  readonly sidebarWidth?: CSSProperties["width"] | undefined;
  readonly styles?: ChatUiSlotStyles | undefined;
}

const PlusIcon = () => (
  <svg aria-hidden="true" height="16" viewBox="0 0 16 16" width="16">
    <path
      d="M8 2.5v11M2.5 8h11"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeWidth="1.5"
    />
  </svg>
);

const HistoryIcon = () => (
  <svg aria-hidden="true" height="16" viewBox="0 0 16 16" width="16">
    <path
      d="M5.25 4h7.5M5.25 8h7.5M5.25 12h7.5"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeWidth="1.4"
    />
    <path
      d="M2.5 3.25a.75.75 0 1 1 0 1.5.75.75 0 0 1 0-1.5Zm0 4a.75.75 0 1 1 0 1.5.75.75 0 0 1 0-1.5Zm0 4a.75.75 0 1 1 0 1.5.75.75 0 0 1 0-1.5Z"
      fill="currentColor"
    />
  </svg>
);

const mapConversationItems = (
  labels: ChatUiLabels,
  config: ChatCompactNavigationConfig,
): NonNullable<MenuProps["items"]> => {
  if (config.conversationHistoryLoading === true) {
    return [
      {
        disabled: true,
        key: "loading",
        label: labels.loadingHistoryConversations,
      },
    ];
  }

  if (config.conversationHistoryError !== undefined) {
    return [
      {
        disabled: true,
        key: "error",
        label: config.conversationHistoryError,
      },
    ];
  }

  if (config.conversationHistoryItems.length === 0) {
    return [
      {
        disabled: true,
        key: "empty",
        label: labels.noHistoryConversations,
      },
    ];
  }

  return config.conversationHistoryItems.map((item) => ({
    key: item.id,
    label: (
      <Typography.Text
        ellipsis={{ tooltip: item.title }}
        style={{ display: "block", maxWidth: 280 }}
      >
        {item.title}
      </Typography.Text>
    ),
  }));
};

const CompactNavigationHeader = ({
  config,
  labels,
  onConversationSelect,
  selectedConversationId,
}: {
  readonly config: ChatCompactNavigationConfig;
  readonly labels: ChatUiLabels;
  readonly onConversationSelect: (conversationId: string) => void;
  readonly selectedConversationId?: string | undefined;
}) => {
  const { token } = theme.useToken();

  const menu: MenuProps = {
    items: mapConversationItems(labels, config),
    onClick: ({ key }) => {
      if (
        key !== "loading" &&
        key !== "error" &&
        key !== "empty" &&
        config.conversationHistoryItems.some(({ id }) => id === key)
      ) {
        onConversationSelect(key);
      }
    },
    selectable: true,
    selectedKeys:
      selectedConversationId === undefined ? [] : [selectedConversationId],
  };

  return (
    <header
      style={{
        alignItems: "center",
        borderBlockEnd: `${token.lineWidth}px ${token.lineType} ${token.colorBorderSecondary}`,
        display: "flex",
        justifyContent: "space-between",
        padding: token.paddingSM,
      }}
    >
      <Typography.Text ellipsis strong>
        {config.conversationTitle}
      </Typography.Text>
      <Space size={4}>
        <Tooltip title={labels.newConversation}>
          <Button
            aria-label={String(labels.newConversation)}
            icon={<PlusIcon />}
            onClick={config.onNewConversation}
            shape="circle"
            type="text"
          />
        </Tooltip>
        <Dropdown
          menu={menu}
          onOpenChange={config.onConversationHistoryOpenChange}
          open={config.conversationHistoryOpen}
          placement="bottomRight"
          trigger={["click"]}
        >
          <Tooltip title={labels.historyConversations}>
            <Button
              aria-expanded={config.conversationHistoryOpen}
              aria-label={String(labels.historyConversations)}
              icon={<HistoryIcon />}
              loading={
                config.conversationHistoryOpen &&
                config.conversationHistoryLoading === true
              }
              shape="circle"
              type="text"
            />
          </Tooltip>
        </Dropdown>
      </Space>
    </header>
  );
};

export const ChatUiShell = ({
  children,
  className,
  compactNavigation,
  contentState,
  conversationListError,
  conversationListLoading,
  conversations,
  formatConversationUpdatedAt,
  header,
  labels: labelOverrides,
  navigationMode = "sidebar",
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

  const hasCompactMode =
    navigationMode === "compact" && compactNavigation !== undefined;

  return (
    <section
      className={className}
      style={{
        background: token.colorBgContainer,
        border: `${token.lineWidth}px ${token.lineType} ${token.colorBorderSecondary}`,
        borderRadius: token.borderRadiusLG,
        display: "grid",
        gridTemplateColumns: hasCompactMode
          ? "minmax(0, 1fr)"
          : `minmax(13rem, ${typeof sidebarWidth === "number" ? `${sidebarWidth}px` : sidebarWidth}) minmax(0, 1fr)`,
        height: "100%",
        minHeight: 360,
        minWidth: 0,
        overflow: "hidden",
        ...styles?.root,
      }}
    >
      {hasCompactMode ? null : (
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
      )}
      <main
        style={{
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
          minWidth: 0,
          ...styles?.content,
        }}
      >
        {hasCompactMode ? (
          <CompactNavigationHeader
            config={compactNavigation}
            labels={labels}
            onConversationSelect={onConversationSelect}
            selectedConversationId={selectedConversationId}
          />
        ) : header === undefined ? null : (
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
