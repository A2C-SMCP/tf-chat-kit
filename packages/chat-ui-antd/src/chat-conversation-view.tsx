import { Alert, theme } from "antd";
import type { CSSProperties } from "react";

import type { ChatError, ChatSnapshot } from "@turingfocus/chat-protocol";
import { useChatClient, useChatSelector } from "@turingfocus/chat-react";

import { ChatComposer } from "./chat-composer.js";
import {
  AskUserInteractionCard,
  type AskUserChatAboutThisRequest,
} from "./ask-user-interaction.js";
import { ChatRunStatus } from "./chat-run-status.js";
import { ChatStateView } from "./chat-state-view.js";
import { ChatTimeline } from "./chat-timeline.js";
import { resolveChatUiLabels } from "./labels.js";
import type {
  ChatRendererFailure,
  ChatRendererRegistry,
} from "./renderer-registry.js";
import type { ChatUiLabelOverrides } from "./types.js";
import {
  useChatCommandCoordinator,
  type ChatUiCommand,
  type ChatUiCommandFailure,
} from "./use-chat-command-coordinator.js";

export type { ChatUiCommand, ChatUiCommandFailure };

export interface ChatConversationViewProps {
  readonly className?: string | undefined;
  readonly formatTimestamp?: ((timestamp: number) => string) | undefined;
  readonly getDeadlineAt: () => number;
  readonly labels?: ChatUiLabelOverrides | undefined;
  readonly onCommandError?:
    ((failure: ChatUiCommandFailure) => void) | undefined;
  readonly onChatAboutThis?:
    ((request: AskUserChatAboutThisRequest) => void) | undefined;
  readonly onRendererError?:
    ((failure: ChatRendererFailure) => void) | undefined;
  readonly renderers?: ChatRendererRegistry | undefined;
  readonly style?: CSSProperties | undefined;
}

interface ChatConversationViewSnapshot {
  readonly capabilities: ChatSnapshot["capabilities"];
  readonly conversationId: string;
  readonly error: ChatError | undefined;
  readonly pendingInteraction: ChatSnapshot["pendingInteraction"];
  readonly run: ChatSnapshot["run"];
  readonly timeline: ChatSnapshot["timeline"];
}

const selectChatConversationViewSnapshot = (
  snapshot: ChatSnapshot | null,
): ChatConversationViewSnapshot | null =>
  snapshot === null
    ? null
    : {
        capabilities: snapshot.capabilities,
        conversationId: snapshot.conversation.id,
        error: snapshot.error,
        pendingInteraction: snapshot.pendingInteraction,
        run: snapshot.run,
        timeline: snapshot.timeline,
      };

const equalChatConversationViewSnapshot = (
  left: ChatConversationViewSnapshot | null,
  right: ChatConversationViewSnapshot | null,
): boolean =>
  left === right ||
  (left !== null &&
    right !== null &&
    left.capabilities === right.capabilities &&
    left.conversationId === right.conversationId &&
    left.error === right.error &&
    left.pendingInteraction === right.pendingInteraction &&
    left.run === right.run &&
    left.timeline === right.timeline);

export const ChatConversationView = ({
  className,
  formatTimestamp,
  getDeadlineAt,
  labels: labelOverrides,
  onChatAboutThis,
  onCommandError,
  onRendererError,
  renderers,
  style,
}: ChatConversationViewProps) => {
  const { token } = theme.useToken();
  const labels = resolveChatUiLabels(labelOverrides);
  const client = useChatClient();
  const snapshot = useChatSelector(
    selectChatConversationViewSnapshot,
    equalChatConversationViewSnapshot,
  );
  const {
    answerInteraction,
    dismissFailure,
    interrupt,
    sendText,
    viewResetKey,
    visibleCommandFailures,
    visibleSnapshotError,
  } = useChatCommandCoordinator({
    canAnswerInteraction: snapshot?.capabilities.answerInteraction === true,
    canInterrupt: snapshot?.capabilities.interrupt ?? false,
    client,
    conversationId: snapshot?.conversationId ?? null,
    getDeadlineAt,
    interactionRequest:
      snapshot?.pendingInteraction === undefined
        ? undefined
        : {
            requestId: snapshot.pendingInteraction.requestId,
            revision: snapshot.pendingInteraction.revision,
          },
    onCommandError,
    run: snapshot?.run ?? null,
    snapshotError: snapshot?.error,
  });

  if (snapshot === null) {
    return <ChatStateView labels={labels} state={{ kind: "loading" }} />;
  }

  const conversationId = snapshot.conversationId;

  return (
    <section
      className={className}
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
        ...style,
      }}
    >
      <ChatRunStatus
        key={`${viewResetKey}:${snapshot.run?.id ?? "no-run"}`}
        canInterrupt={snapshot.capabilities.interrupt}
        labels={labels}
        onInterrupt={interrupt}
        run={snapshot.run}
      />
      {visibleSnapshotError === undefined ? null : (
        <Alert
          message={visibleSnapshotError.message}
          showIcon
          style={{ margin: token.marginXS }}
          type="error"
        />
      )}
      {visibleCommandFailures.map((failure) => (
        <Alert
          key={failure.command}
          closable
          message={failure.error.message}
          onClose={() => {
            dismissFailure(failure.command);
          }}
          showIcon
          style={{ margin: token.marginXS }}
          type="error"
        />
      ))}
      <div style={{ flex: 1, minHeight: 0 }}>
        <ChatTimeline
          key={viewResetKey}
          conversationId={conversationId}
          formatTimestamp={formatTimestamp}
          items={snapshot.timeline}
          labels={labels}
          onRendererError={onRendererError}
          renderers={renderers}
        />
      </div>
      {snapshot.pendingInteraction === undefined ? null : (
        <div style={{ padding: token.paddingXS }}>
          <AskUserInteractionCard
            key={JSON.stringify([
              conversationId,
              snapshot.pendingInteraction.requestId,
              snapshot.pendingInteraction.revision,
            ])}
            answerDisabled={snapshot.capabilities.answerInteraction !== true}
            labels={labels}
            onAnswer={answerInteraction}
            onChatAboutThis={onChatAboutThis}
            request={snapshot.pendingInteraction}
          />
        </div>
      )}
      <ChatComposer
        key={viewResetKey}
        disabled={!snapshot.capabilities.sendText}
        disabledReason={
          snapshot.capabilities.sendText
            ? undefined
            : labels.textSendingUnavailable
        }
        labels={labels}
        onSend={sendText}
        resetKey={viewResetKey}
      />
    </section>
  );
};
