import { Button, Empty, Result, Spin, Typography } from "antd";
import type { CSSProperties, ReactNode } from "react";

import { resolveChatUiLabels } from "./labels.js";
import type {
  ChatContentState,
  ChatUiLabelOverrides,
  ChatUiLabels,
} from "./types.js";

type NonReadyChatContentState = Exclude<
  ChatContentState,
  { readonly kind: "ready" }
>;

export interface ChatStateViewProps {
  readonly className?: string | undefined;
  readonly labels?: ChatUiLabelOverrides | undefined;
  readonly state: NonReadyChatContentState;
  readonly style?: CSSProperties | undefined;
}

interface StateCopy {
  readonly description: ReactNode;
  readonly title: ReactNode;
}

const getStateCopy = (
  state: NonReadyChatContentState,
  labels: ChatUiLabels,
): StateCopy => {
  switch (state.kind) {
    case "loading":
      return {
        title: state.title ?? labels.loadingTitle,
        description: state.description ?? labels.loadingDescription,
      };
    case "empty":
      return {
        title: state.title ?? labels.emptyTitle,
        description: state.description ?? labels.emptyDescription,
      };
    case "error":
      return {
        title: state.title ?? labels.errorTitle,
        description: state.description ?? labels.errorDescription,
      };
    case "disconnected":
      return {
        title: state.title ?? labels.disconnectedTitle,
        description: state.description ?? labels.disconnectedDescription,
      };
    case "capability-unavailable":
      return {
        title: state.title ?? labels.capabilityUnavailableTitle,
        description:
          state.description ??
          (state.capability === undefined
            ? labels.capabilityUnavailableDescription
            : `${state.capability} is not available in the current session.`),
      };
  }
};

const defaultStyle: CSSProperties = {
  alignItems: "center",
  display: "flex",
  flexDirection: "column",
  height: "100%",
  justifyContent: "center",
  minHeight: 240,
  padding: 24,
  textAlign: "center",
};

export const ChatStateView = ({
  className,
  labels: labelOverrides,
  state,
  style,
}: ChatStateViewProps) => {
  const labels = resolveChatUiLabels(labelOverrides);
  const copy = getStateCopy(state, labels);

  if (state.kind === "loading") {
    return (
      <div
        aria-live="polite"
        className={className}
        role="status"
        style={{ ...defaultStyle, ...style }}
      >
        <Spin size="large" tip={copy.title}>
          <div style={{ minHeight: 80, minWidth: 240 }} />
        </Spin>
        <Typography.Text type="secondary" style={{ marginTop: 16 }}>
          {copy.description}
        </Typography.Text>
      </div>
    );
  }

  if (state.kind === "empty") {
    return (
      <div
        aria-live="polite"
        className={className}
        role="status"
        style={{ ...defaultStyle, ...style }}
      >
        <Empty description={copy.title}>
          <Typography.Text type="secondary">{copy.description}</Typography.Text>
        </Empty>
      </div>
    );
  }

  const canRetry =
    (state.kind === "error" || state.kind === "disconnected") &&
    state.onRetry !== undefined;

  return (
    <div
      aria-live="assertive"
      className={className}
      role="alert"
      style={{ ...defaultStyle, ...style }}
    >
      <Result
        extra={
          canRetry ? (
            <Button onClick={state.onRetry} type="primary">
              {labels.retry}
            </Button>
          ) : undefined
        }
        status={state.kind === "error" ? "error" : "warning"}
        subTitle={copy.description}
        title={copy.title}
      />
    </div>
  );
};
