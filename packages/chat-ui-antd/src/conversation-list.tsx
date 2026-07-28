import { Alert, Button, Empty, Spin, Typography, theme } from "antd";
import type { CSSProperties } from "react";
import { Virtuoso } from "react-virtuoso";

import { resolveChatUiLabels } from "./labels.js";
import type {
  ChatConversationListItem,
  ChatUiLabelOverrides,
} from "./types.js";

export interface ConversationListError {
  readonly message: string;
  readonly onRetry?: (() => void) | undefined;
}

export interface ChatConversationListProps {
  readonly "aria-label"?: string | undefined;
  readonly className?: string | undefined;
  readonly error?: ConversationListError | undefined;
  readonly formatUpdatedAt?:
    ((updatedAt: number, item: ChatConversationListItem) => string) | undefined;
  readonly items: readonly ChatConversationListItem[];
  readonly labels?: ChatUiLabelOverrides | undefined;
  readonly loading?: boolean | undefined;
  readonly onSelect: (conversationId: string) => void;
  readonly pendingConversationId?: string | undefined;
  readonly selectedConversationId?: string | undefined;
  readonly style?: CSSProperties | undefined;
}

const padDatePart = (value: number): string => String(value).padStart(2, "0");

const defaultFormatUpdatedAt = (updatedAt: number): string => {
  const date = new Date(updatedAt);

  return `${date.getUTCFullYear()}-${padDatePart(
    date.getUTCMonth() + 1,
  )}-${padDatePart(date.getUTCDate())}`;
};

export const ChatConversationList = ({
  "aria-label": ariaLabel,
  className,
  error,
  formatUpdatedAt = defaultFormatUpdatedAt,
  items,
  labels: labelOverrides,
  loading = false,
  onSelect,
  pendingConversationId,
  selectedConversationId,
  style,
}: ChatConversationListProps) => {
  const { token } = theme.useToken();
  const labels = resolveChatUiLabels(labelOverrides);

  if (error !== undefined) {
    return (
      <div className={className} style={{ padding: token.paddingSM, ...style }}>
        <Alert
          action={
            error.onRetry === undefined ? undefined : (
              <Button onClick={error.onRetry} size="small">
                {labels.retry}
              </Button>
            )
          }
          message={error.message}
          role="alert"
          showIcon
          type="error"
        />
      </div>
    );
  }

  if (!loading && items.length === 0) {
    return (
      <div
        aria-label={ariaLabel ?? labels.conversationListLabel}
        className={className}
        role="list"
        style={{
          alignItems: "center",
          display: "flex",
          height: "100%",
          justifyContent: "center",
          minHeight: 160,
          padding: token.paddingSM,
          ...style,
        }}
      >
        <Empty
          description={labels.noConversations}
          image={Empty.PRESENTED_IMAGE_SIMPLE}
        />
      </div>
    );
  }

  return (
    <div
      className={className}
      style={{
        height: "100%",
        minHeight: 160,
        overflow: "hidden",
        position: "relative",
        ...style,
      }}
    >
      <div
        aria-busy={loading}
        aria-label={ariaLabel ?? labels.conversationListLabel}
        role="list"
        style={{ height: "100%", minHeight: 0 }}
      >
        <Virtuoso
          computeItemKey={(_index, item) => item.id}
          data={items}
          increaseViewportBy={200}
          initialItemCount={Math.min(items.length, 20)}
          itemContent={(_index, item) => {
            const selected = item.id === selectedConversationId;
            const pending = item.id === pendingConversationId;
            const updatedAt =
              item.updatedAt === undefined
                ? undefined
                : formatUpdatedAt(item.updatedAt, item);

            return (
              <div
                role="listitem"
                style={{
                  padding: `${token.paddingXXS}px ${token.paddingXS}px`,
                }}
              >
                <Button
                  aria-current={selected ? "true" : undefined}
                  block
                  disabled={item.disabled === true || loading}
                  loading={pending}
                  onClick={() => {
                    onSelect(item.id);
                  }}
                  style={{
                    background: selected ? token.colorPrimaryBg : undefined,
                    height: "auto",
                    minHeight: 48,
                    padding: `${token.paddingXS}px ${token.paddingSM}px`,
                    textAlign: "start",
                  }}
                  type="text"
                >
                  <span
                    style={{
                      alignItems: "center",
                      display: "flex",
                      gap: token.marginXS,
                      justifyContent: "space-between",
                      minWidth: 0,
                      width: "100%",
                    }}
                  >
                    <span style={{ minWidth: 0 }}>
                      <Typography.Text
                        ellipsis
                        strong={selected}
                        style={{ display: "block" }}
                      >
                        {item.title}
                      </Typography.Text>
                      {item.description === undefined ? null : (
                        <Typography.Text
                          ellipsis
                          style={{
                            display: "block",
                            fontSize: token.fontSizeSM,
                          }}
                          type="secondary"
                        >
                          {item.description}
                        </Typography.Text>
                      )}
                    </span>
                    {updatedAt === undefined ? null : (
                      <Typography.Text
                        style={{
                          flex: "0 0 auto",
                          fontSize: token.fontSizeSM,
                        }}
                        type="secondary"
                      >
                        {updatedAt}
                      </Typography.Text>
                    )}
                  </span>
                </Button>
              </div>
            );
          }}
          overscan={200}
          style={{ height: "100%" }}
        />
      </div>
      {loading ? (
        <div
          aria-live="polite"
          role="status"
          style={{
            alignItems: "center",
            background: token.colorBgContainer,
            display: "flex",
            flexDirection: "column",
            gap: token.marginXS,
            inset: 0,
            justifyContent: "center",
            position: "absolute",
            zIndex: 1,
          }}
        >
          <Spin size="small" />
          <Typography.Text type="secondary">
            {labels.loadingTitle}
          </Typography.Text>
        </div>
      ) : null}
    </div>
  );
};
