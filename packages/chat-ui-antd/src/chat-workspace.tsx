import { Alert, Button, Input, Modal, Space, Typography } from "antd";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import {
  useConversationWorkspace,
  type ConversationWorkspaceBinding,
  type UseConversationWorkspaceOptions,
} from "@turingfocus/chat-react";

import {
  ChatConversationView,
  type ChatConversationViewProps,
} from "./chat-conversation-view.js";
import { ChatUiShell, type ChatUiShellProps } from "./chat-ui-shell.js";
import { resolveChatUiLabels } from "./labels.js";
import type {
  ChatContentState,
  ChatUiLabelOverrides,
  ChatUiSlotStyles,
} from "./types.js";

type ConversationWorkspaceSnapshot = ConversationWorkspaceBinding["snapshot"];

export interface ChatWorkspaceProps {
  /** Shows a managed creation dialog. Defaults to false. */
  readonly allowCreate?: boolean | undefined;
  /** Shows per-conversation deletion with confirmation. Defaults to false. */
  readonly allowDelete?: boolean | undefined;
  /** Shows per-conversation title editing. Defaults to false. */
  readonly allowRename?: boolean | undefined;
  readonly className?: string | undefined;
  readonly conversationViewProps?:
    Omit<ChatConversationViewProps, "getDeadlineAt" | "labels"> | undefined;
  readonly formatConversationUpdatedAt?: ChatUiShellProps["formatConversationUpdatedAt"];
  readonly getDeadlineAt: () => number;
  readonly header?: ReactNode;
  readonly initialSelection?: "first" | "none" | undefined;
  readonly labels?: ChatUiLabelOverrides | undefined;
  readonly onUnhandledError?: ((error: unknown) => void) | undefined;
  readonly orderConversations?: UseConversationWorkspaceOptions["orderConversations"];
  readonly pageSize?: number | undefined;
  readonly sidebarTitle?: ReactNode;
  readonly sidebarWidth?: ChatUiShellProps["sidebarWidth"];
  readonly styles?: ChatUiSlotStyles | undefined;
}

const contentStateFor = (
  ready: boolean,
  snapshot: ConversationWorkspaceSnapshot,
  refresh: () => void,
  retrySelection: (() => void) | undefined,
): ChatContentState => {
  if (!ready) return { kind: "loading" };
  if (snapshot.selectionStatus === "ready") return { kind: "ready" };
  if (snapshot.selectionStatus === "loading") return { kind: "loading" };
  if (snapshot.selectionStatus === "error") {
    const error = snapshot.selectionError;
    return {
      kind: error?.code === "network" ? "disconnected" : "error",
      ...(error === undefined ? {} : { description: error.message }),
      ...(retrySelection === undefined ? {} : { onRetry: retrySelection }),
    };
  }
  if (
    snapshot.listStatus === "error" &&
    snapshot.selectedConversationId === undefined
  ) {
    return {
      kind: snapshot.listError?.code === "network" ? "disconnected" : "error",
      ...(snapshot.listError === undefined
        ? {}
        : { description: snapshot.listError.message }),
      onRetry: refresh,
    };
  }
  if (snapshot.listStatus === "loading" || snapshot.listStatus === "idle") {
    return { kind: "loading" };
  }
  return { kind: "empty" };
};

/** A managed conversation workspace; hosts only inject a ChatClient and policy. */
export const ChatWorkspace = ({
  allowCreate = false,
  allowDelete = false,
  allowRename = false,
  className,
  conversationViewProps,
  formatConversationUpdatedAt,
  getDeadlineAt,
  header,
  initialSelection,
  labels: labelOverrides,
  onUnhandledError,
  orderConversations,
  pageSize,
  sidebarTitle,
  sidebarWidth,
  styles,
}: ChatWorkspaceProps) => {
  const labels = resolveChatUiLabels(labelOverrides);
  const workspace = useConversationWorkspace({
    getDeadlineAt,
    initialSelection,
    onUnhandledError,
    orderConversations,
    pageSize,
  });
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<
    ConversationWorkspaceSnapshot["conversations"][number] | undefined
  >();
  const [deleteError, setDeleteError] =
    useState<ConversationWorkspaceSnapshot["conversationMutationError"]>();
  const [renameTarget, setRenameTarget] = useState<
    ConversationWorkspaceSnapshot["conversations"][number] | undefined
  >();
  const [renameError, setRenameError] =
    useState<ConversationWorkspaceSnapshot["conversationMutationError"]>();
  const [renameTitle, setRenameTitle] = useState("");
  const [title, setTitle] = useState("");

  useEffect(() => {
    setCreateOpen(false);
    setDeleteError(undefined);
    setDeleteTarget(undefined);
    setRenameError(undefined);
    setRenameTarget(undefined);
    setRenameTitle("");
    setTitle("");
  }, [workspace.controller]);

  const refresh = useCallback(() => {
    void workspace.refresh();
  }, [workspace]);
  const retryConversationId =
    workspace.snapshot.selectionError?.conversationId ??
    workspace.snapshot.pendingConversationId;
  const retrySelection = useMemo(
    () =>
      retryConversationId === undefined
        ? undefined
        : () => {
            void workspace.selectConversation(retryConversationId);
          },
    [retryConversationId, workspace],
  );
  const contentState = contentStateFor(
    workspace.ready,
    workspace.snapshot,
    refresh,
    retrySelection,
  );
  const create = useCallback(async () => {
    const normalizedTitle = title.trim();
    if (normalizedTitle.length === 0 || workspace.snapshot.creating) return;
    const result = await workspace.createConversation({
      title: normalizedTitle,
    });
    if (result?.ok === true) {
      setCreateOpen(false);
      setTitle("");
    }
  }, [title, workspace]);
  const rename = useCallback(async () => {
    const normalizedTitle = renameTitle.trim();
    if (renameTarget === undefined || normalizedTitle.length === 0) return;
    const result = await workspace.renameConversation({
      conversationId: renameTarget.id,
      title: normalizedTitle,
    });
    if (result?.ok === true) {
      setRenameTarget(undefined);
      setRenameTitle("");
    } else if (result?.ok === false) {
      setRenameError(result.error);
    }
  }, [renameTarget, renameTitle, workspace]);
  const deleteConversation = useCallback(async () => {
    if (deleteTarget === undefined) return;
    const result = await workspace.deleteConversation(deleteTarget.id);
    if (result?.ok === true) setDeleteTarget(undefined);
    else if (result?.ok === false) setDeleteError(result.error);
  }, [deleteTarget, workspace]);
  const deletingTarget =
    deleteTarget !== undefined &&
    workspace.snapshot.deletingConversationIds.includes(deleteTarget.id);
  const renamingTarget =
    renameTarget !== undefined &&
    workspace.snapshot.renamingConversationIds.includes(renameTarget.id);

  const resolvedSidebarTitle = allowCreate ? (
    <Space
      align="center"
      style={{ justifyContent: "space-between", width: "100%" }}
    >
      <Typography.Title level={5} style={{ margin: 0 }}>
        {sidebarTitle ?? labels.conversationListLabel}
      </Typography.Title>
      <Button
        disabled={!workspace.ready}
        onClick={() => setCreateOpen(true)}
        size="small"
        type="text"
      >
        {labels.createConversation ?? "New conversation"}
      </Button>
    </Space>
  ) : (
    sidebarTitle
  );

  return (
    <>
      <ChatUiShell
        className={className}
        contentState={contentState}
        conversationListError={
          workspace.snapshot.listStatus !== "error" ||
          workspace.snapshot.listError === undefined
            ? undefined
            : {
                message: workspace.snapshot.listError.message,
                onRetry: refresh,
              }
        }
        conversationListLoading={
          !workspace.ready || workspace.snapshot.listStatus === "loading"
        }
        conversations={workspace.snapshot.conversations}
        formatConversationUpdatedAt={formatConversationUpdatedAt}
        header={header}
        labels={labels}
        mutatingConversationIds={[
          ...workspace.snapshot.deletingConversationIds,
          ...workspace.snapshot.renamingConversationIds,
        ]}
        onConversationDelete={
          allowDelete
            ? (conversation) => {
                setDeleteError(undefined);
                setRenameTarget(undefined);
                setDeleteTarget(conversation);
              }
            : undefined
        }
        onConversationRename={
          allowRename
            ? (conversation) => {
                setDeleteTarget(undefined);
                setRenameError(undefined);
                setRenameTarget(conversation);
                setRenameTitle(conversation.title);
              }
            : undefined
        }
        onConversationSelect={(conversationId) => {
          void workspace.selectConversation(conversationId);
        }}
        pendingConversationId={workspace.snapshot.pendingConversationId}
        selectedConversationId={workspace.snapshot.selectedConversationId}
        sidebarFooter={
          workspace.snapshot.nextCursor === undefined ? undefined : (
            <Button
              block
              loading={workspace.snapshot.listStatus === "loading-more"}
              onClick={() => void workspace.loadMore()}
              size="small"
            >
              {labels.loadMoreConversations ?? "Load more conversations"}
            </Button>
          )
        }
        sidebarTitle={resolvedSidebarTitle}
        sidebarWidth={sidebarWidth}
        styles={styles}
      >
        <ChatConversationView
          {...conversationViewProps}
          getDeadlineAt={getDeadlineAt}
          labels={labels}
        />
      </ChatUiShell>
      <Modal
        cancelButtonProps={{ disabled: workspace.snapshot.creating }}
        closable={!workspace.snapshot.creating}
        confirmLoading={workspace.snapshot.creating}
        keyboard={!workspace.snapshot.creating}
        maskClosable={!workspace.snapshot.creating}
        okButtonProps={{ disabled: title.trim().length === 0 }}
        okText={labels.createConversationConfirm ?? "Create"}
        onCancel={() => setCreateOpen(false)}
        onOk={() => void create()}
        open={createOpen}
        title={labels.createConversation ?? "New conversation"}
      >
        <Space direction="vertical" style={{ width: "100%" }}>
          {workspace.snapshot.creationError === undefined ? null : (
            <Alert
              message={workspace.snapshot.creationError.message}
              role="alert"
              showIcon
              type="error"
            />
          )}
          <label>
            <Typography.Text>
              {labels.createConversationTitleLabel ?? "Conversation title"}
            </Typography.Text>
            <Input
              aria-label={
                labels.createConversationTitleLabel ?? "Conversation title"
              }
              autoFocus
              disabled={workspace.snapshot.creating}
              onChange={(event) => setTitle(event.target.value)}
              onPressEnter={() => void create()}
              placeholder={
                labels.createConversationTitlePlaceholder ??
                "Enter a conversation title"
              }
              value={title}
            />
          </label>
        </Space>
      </Modal>
      <Modal
        cancelButtonProps={{ disabled: deletingTarget }}
        cancelText={labels.deleteConversationCancel ?? "Cancel"}
        closable={!deletingTarget}
        confirmLoading={deletingTarget}
        okButtonProps={{ danger: true }}
        okText={labels.deleteConversationConfirm ?? "Delete"}
        keyboard={!deletingTarget}
        maskClosable={!deletingTarget}
        onCancel={() => {
          setDeleteError(undefined);
          setDeleteTarget(undefined);
        }}
        onOk={() => void deleteConversation()}
        open={deleteTarget !== undefined}
        title={labels.deleteConversation ?? "Delete conversation"}
      >
        <Space direction="vertical" style={{ width: "100%" }}>
          <Typography.Text>
            {labels.deleteConversationPrompt ??
              "Delete this conversation permanently?"}
          </Typography.Text>
          {deleteError === undefined ? null : (
            <Alert
              message={deleteError.message}
              role="alert"
              showIcon
              type="error"
            />
          )}
        </Space>
      </Modal>
      <Modal
        cancelButtonProps={{ disabled: renamingTarget }}
        closable={!renamingTarget}
        confirmLoading={renamingTarget}
        okButtonProps={{ disabled: renameTitle.trim().length === 0 }}
        okText={labels.renameConversationConfirm ?? "Rename"}
        keyboard={!renamingTarget}
        maskClosable={!renamingTarget}
        onCancel={() => {
          setRenameError(undefined);
          setRenameTarget(undefined);
          setRenameTitle("");
        }}
        onOk={() => void rename()}
        open={renameTarget !== undefined}
        title={labels.renameConversation ?? "Rename conversation"}
      >
        <Space direction="vertical" style={{ width: "100%" }}>
          {renameError === undefined ? null : (
            <Alert
              message={renameError.message}
              role="alert"
              showIcon
              type="error"
            />
          )}
          <Input
            aria-label={labels.createConversationTitleLabel}
            autoFocus
            onChange={(event) => setRenameTitle(event.target.value)}
            onPressEnter={() => void rename()}
            value={renameTitle}
          />
        </Space>
      </Modal>
    </>
  );
};
