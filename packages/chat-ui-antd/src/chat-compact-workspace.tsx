import {
  Alert,
  Button,
  Dropdown,
  Input,
  Modal,
  Space,
  Tooltip,
  Typography,
  type GetRef,
} from "antd";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  resolveComposerDraftText,
  type ComposerDraft,
  useChatClient,
  useChatSnapshot,
  useComposerDraft,
  useConversationWorkspace,
} from "@turingfocus/chat-react";
import type { ChatError, Conversation } from "@turingfocus/chat-protocol";
import { ChatConversationView } from "./chat-conversation-view.js";
import { ChatComposer } from "./chat-composer.js";
import { ChatConversationList } from "./conversation-list.js";
import { ChatDiagnostics } from "./chat-diagnostics.js";
import { compactChatZhCN } from "./compact-labels.js";
import { resolveChatUiLabels } from "./labels.js";
import { HistoryIcon, MoreIcon, PlusIcon } from "./navigation-icons.js";

export interface ChatCompactDraft {
  readonly conversationId?: string | undefined;
  readonly text: string;
}
/** Host actions share the compact overflow menu without coupling UI to a host. */
export interface ChatCompactAction {
  readonly label: string;
  readonly disabled?: boolean | undefined;
  readonly onSelect: (trigger: HTMLElement) => void;
}
export interface ChatCompactWorkspaceProps {
  readonly locale?: "zh-CN" | "en-US" | undefined;
  readonly getDeadlineAt: () => number;
  readonly header?: ReactNode;
  readonly moreActions?: readonly ChatCompactAction[] | undefined;
  readonly onActivityChange?:
    | ((activity: {
        readonly running: boolean;
        readonly draft: ChatCompactDraft;
      }) => void)
    | undefined;
  readonly onAccessDenied?: (() => void) | undefined;
  readonly getPopupContainer?: (() => HTMLElement) | undefined;
  readonly restoredDraft?: ChatCompactDraft | undefined;
  readonly onRequestAuthentication?: (() => void) | undefined;
}

function CompactMenuContent({
  open,
  children,
}: {
  readonly open: boolean;
  readonly children: ReactNode;
}) {
  const content = useRef<HTMLDivElement>(null);
  // Focus only while open. Dropdown's delayed autofocus can otherwise steal
  // focus back into the hidden menu after a quick Escape.
  useEffect(() => {
    if (open)
      content.current
        ?.querySelector<HTMLElement>(
          '[role="menuitem"]:not([aria-disabled="true"])',
        )
        ?.focus({ preventScroll: true });
  }, [open]);
  return <div ref={content}>{children}</div>;
}

/** Single-column, opt-in UI. Conversation state and commands remain in Runtime. */
export function ChatCompactWorkspace({
  locale = "zh-CN",
  getDeadlineAt,
  header,
  moreActions = [],
  onActivityChange,
  restoredDraft,
  onRequestAuthentication,
  onAccessDenied,
  getPopupContainer,
}: ChatCompactWorkspaceProps) {
  const zh = locale === "zh-CN";
  const labels = resolveChatUiLabels(zh ? compactChatZhCN : undefined);
  const client = useChatClient();
  const snapshot = useChatSnapshot();
  const workspace = useConversationWorkspace({
    getDeadlineAt,
    initialSelection: "none",
  });
  const [page, setPage] = useState<"chat" | "history" | "help">("chat");
  const [fresh, setFresh] = useState(true);
  const emptyDraft = (): ComposerDraft => ({
    conversationId: "",
    revision: 0,
    text: "",
    attachments: [],
    longTexts: [],
  });
  const [welcomeDraft, setWelcomeDraft] = useState<ComposerDraft>(() => ({
    ...emptyDraft(),
    text: restoredDraft?.text ?? "",
  }));
  const text = resolveComposerDraftText(welcomeDraft);
  const setText = (value: string) =>
    setWelcomeDraft({ ...emptyDraft(), text: value });
  const selectedTarget = useRef<string>();
  const composer = useComposerDraft(snapshot?.conversation.id ?? "");
  const [error, setError] = useState<ChatError>();
  const [rename, setRename] = useState<Conversation>();
  const [deleting, setDeleting] = useState<Conversation>();
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const generation = useRef(0);
  const root = useRef<HTMLDivElement>(null);
  const moreTrigger = useRef<GetRef<typeof Button>>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const restoreDone = useRef(false);
  const creatingId = useRef<string>();
  const [pendingNavigation, setPendingNavigation] = useState<() => void>();
  const running = snapshot?.run?.status === "running";
  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );
  useEffect(() => {
    onActivityChange?.({
      running,
      draft: fresh
        ? { text }
        : {
            conversationId: snapshot?.conversation.id,
            text: resolveComposerDraftText(composer.draft),
          },
    });
  }, [
    running,
    fresh,
    text,
    snapshot?.conversation.id,
    composer.draft,
    onActivityChange,
  ]);
  useEffect(() => {
    if (!workspace.ready || restoreDone.current) return;
    restoreDone.current = true;
    if (restoredDraft?.conversationId) {
      const id = restoredDraft.conversationId;
      client.setComposerDraft({ conversationId: id, text: restoredDraft.text });
      setFresh(false);
      selectedTarget.current = id;
      void workspace.selectConversation(id);
    }
  }, [workspace, restoredDraft, client]);
  const navigate = (action: () => void) => {
    if (busyRef.current) return;
    if (running) setPendingNavigation(() => action);
    else action();
  };
  const firstSend = useCallback(
    async (message: string): Promise<boolean> => {
      if (busyRef.current || !workspace.ready) return false;
      busyRef.current = true;
      setBusy(true);
      setError(undefined);
      const revision = generation.current;
      try {
        let id = creatingId.current;
        if (!id) {
          const created = await workspace.createConversation({
            title: message.slice(0, 60),
            select: false,
          });
          if (revision !== generation.current) return false;
          if (!created?.ok) {
            if (created) setError(created.error);
            return false;
          }
          id = created.value.id;
          creatingId.current = id;
        }
        client.setComposerDraft({ conversationId: id, text: message });
        const selected = await workspace.selectConversation(id);
        if (revision !== generation.current) return false;
        if (!selected?.ok) {
          if (selected) setError(selected.error);
          return false;
        }
        // A creation/load failure must never trigger a second automatic send.
        const result = await client.sendText({
          conversationId: id,
          text: message,
          deadlineAt: getDeadlineAt(),
        });
        if (revision !== generation.current) return false;
        setFresh(false);
        creatingId.current = undefined;
        if (result.ok) {
          client.setComposerDraft({ conversationId: id, text: "" });
          setText("");
        } else setError(result.error);
        return result.ok;
      } catch {
        if (revision === generation.current)
          setError({
            code: "unknown",
            message: "Request failed",
            retryable: false,
          });
        return false;
      } finally {
        if (revision === generation.current) {
          busyRef.current = false;
          setBusy(false);
        }
      }
    },
    [workspace, client, getDeadlineAt],
  );
  const mutate = async (kind: "rename" | "delete") => {
    if (busyRef.current) return;
    const target = kind === "rename" ? rename : deleting;
    if (!target) return;
    busyRef.current = true;
    setBusy(true);
    setError(undefined);
    const revision = generation.current;
    try {
      const result =
        kind === "rename"
          ? await workspace.renameConversation({
              conversationId: target.id,
              title: title.trim(),
            })
          : await workspace.deleteConversation(target.id);
      if (revision !== generation.current) return;
      if (result?.ok) {
        setRename(undefined);
        setDeleting(undefined);
        if (kind === "delete" && snapshot?.conversation.id === target.id) {
          setFresh(true);
          setText("");
        }
      } else if (result) setError(result.error);
    } catch {
      if (revision === generation.current)
        setError({
          code: "unknown",
          message: "Request failed",
          retryable: false,
        });
    } finally {
      if (revision === generation.current) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  };
  const errorText = (value: ChatError) =>
    zh
      ? value.code === "authentication"
        ? "登录已过期，请重新登录。"
        : value.code === "authorization"
          ? "你没有执行此操作的权限。"
          : "操作未完成，请核对当前状态后重试。"
      : "The action could not be completed. Check its status before retrying.";
  const selectedError = workspace.snapshot.selectionError;
  const accessDenied =
    error?.code === "authorization" ||
    selectedError?.code === "authorization" ||
    workspace.snapshot.listError?.code === "authorization" ||
    snapshot?.error?.code === "authorization" ||
    snapshot?.activeErrors?.some(
      (item) => item.error.code === "authorization",
    ) === true;
  useEffect(() => {
    if (accessDenied) onAccessDenied?.();
  }, [accessDenied, onAccessDenied]);
  const navigationTrigger = useRef<HTMLElement>();
  const openPage = (
    next: "chat" | "history" | "help",
    trigger?: HTMLElement,
  ) => {
    const active = trigger ?? root.current?.ownerDocument.activeElement;
    if (
      page === "chat" &&
      active instanceof HTMLElement &&
      root.current?.contains(active)
    )
      navigationTrigger.current = active;
    setPage(next);
  };
  useEffect(() => {
    if (page === "chat" && navigationTrigger.current?.isConnected)
      navigationTrigger.current.focus({ preventScroll: true });
  }, [page]);
  return (
    <div
      ref={root}
      onKeyDownCapture={(event) => {
        if (event.key === "Escape" && moreOpen) {
          event.preventDefault();
          event.stopPropagation();
          setMoreOpen(false);
          moreTrigger.current?.focus({ preventScroll: true });
          return;
        }
        if (
          event.key !== "Escape" ||
          busy ||
          (!rename && !deleting && !pendingNavigation)
        )
          return;
        event.stopPropagation();
        setRename(undefined);
        setDeleting(undefined);
        setPendingNavigation(undefined);
        setError(undefined);
      }}
      data-chat-compact-workspace="true"
      style={{
        height: "100%",
        minHeight: 0,
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        position: "relative",
        overflow: "hidden",
      }}
    >
      {header}
      <div
        data-chat-compact-toolbar="true"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 2,
          padding: "4px 12px",
          borderBottom: "1px solid #e3e9e5",
          flexShrink: 0,
        }}
      >
        <Typography.Text
          ellipsis={{
            tooltip: {
              title: fresh
                ? labels.newConversation
                : snapshot?.conversation.title,
              getPopupContainer: getPopupContainer ?? (() => root.current!),
            },
          }}
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 12,
            fontWeight: 500,
            color: "#647366",
          }}
        >
          {fresh ? labels.newConversation : snapshot?.conversation.title}
        </Typography.Text>
        <Tooltip
          title={labels.historyConversations}
          getPopupContainer={getPopupContainer ?? (() => root.current!)}
        >
          <Button
            size="small"
            type="text"
            aria-label={String(labels.historyConversations)}
            aria-pressed={page === "history"}
            icon={<HistoryIcon size={14} />}
            style={{ width: 28, height: 28, flexShrink: 0, borderRadius: 6 }}
            disabled={busy}
            onClick={(event) =>
              openPage(
                page === "history" ? "chat" : "history",
                event.currentTarget,
              )
            }
          ></Button>
        </Tooltip>
        <Tooltip
          title={labels.newConversation}
          getPopupContainer={getPopupContainer ?? (() => root.current!)}
        >
          <Button
            size="small"
            type="text"
            aria-label={String(labels.newConversation)}
            icon={<PlusIcon size={14} />}
            style={{ width: 28, height: 28, flexShrink: 0, borderRadius: 6 }}
            disabled={busy}
            onClick={() =>
              navigate(() => {
                setFresh(true);
                setError(undefined);
                creatingId.current = undefined;
                setPage("chat");
              })
            }
          ></Button>
        </Tooltip>
        <Dropdown
          trigger={["click"]}
          placement="bottomRight"
          dropdownRender={(menu) => (
            <CompactMenuContent open={moreOpen}>{menu}</CompactMenuContent>
          )}
          open={moreOpen}
          onOpenChange={setMoreOpen}
          getPopupContainer={getPopupContainer ?? (() => root.current!)}
          menu={{
            items: [
              ...moreActions.map((action, index) => ({
                key: `action:${index}`,
                label: action.label,
                disabled: action.disabled ?? false,
              })),
              ...(moreActions.length
                ? [{ key: "separator", type: "divider" as const }]
                : []),
              {
                key: "help",
                label: zh ? "帮助与诊断" : "Help and diagnostics",
              },
            ],
            onClick: ({ key }) => {
              setMoreOpen(false);
              const trigger = moreTrigger.current;
              if (!trigger) return;
              if (key === "help") openPage("help", trigger);
              else {
                const action = moreActions[Number(key.slice("action:".length))];
                if (action && !action.disabled) action.onSelect(trigger);
              }
            },
          }}
        >
          <Button
            ref={moreTrigger}
            size="small"
            type="text"
            aria-label={zh ? "更多操作" : "More actions"}
            aria-haspopup="menu"
            aria-expanded={moreOpen}
            icon={<MoreIcon size={14} />}
            style={{ width: 28, height: 28, flexShrink: 0, borderRadius: 6 }}
            disabled={busy}
          ></Button>
        </Dropdown>
      </div>
      {accessDenied ? (
        <Alert
          role="alert"
          type="error"
          message={
            zh
              ? "你没有访问此对话的权限，请联系管理员或切换机器人。"
              : "You no longer have access to this conversation. Contact your administrator or switch assistants."
          }
        />
      ) : page !== "chat" ? (
        <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 16 }}>
          <Button type="text" onClick={() => setPage("chat")}>
            ← {zh ? "返回对话" : "Back to chat"}
          </Button>
          {page === "help" ? (
            <>
              <h3>{zh ? "帮助与诊断" : "Help and diagnostics"}</h3>
              <ChatDiagnostics labels={labels} />
            </>
          ) : (
            <>
              <ChatConversationList
                labels={labels}
                items={workspace.snapshot.conversations}
                loading={workspace.snapshot.listStatus === "loading"}
                selectedConversationId={
                  fresh ? undefined : workspace.snapshot.selectedConversationId
                }
                onSelect={(id) =>
                  navigate(() => {
                    selectedTarget.current = id;
                    setFresh(false);
                    setError(undefined);
                    setPage("chat");
                    void workspace.selectConversation(id);
                  })
                }
                onRename={(item) => {
                  setRename(item);
                  setTitle(item.title);
                  setError(undefined);
                }}
                onDelete={(item) => {
                  setDeleting(item);
                  setError(undefined);
                }}
                error={
                  workspace.snapshot.listError
                    ? {
                        message: errorText(workspace.snapshot.listError),
                        onRetry: () => {
                          void workspace.refresh();
                        },
                      }
                    : undefined
                }
              />
              {workspace.snapshot.nextCursor ? (
                <Button
                  loading={workspace.snapshot.listStatus === "loading-more"}
                  onClick={() => {
                    void workspace.loadMore();
                  }}
                >
                  {labels.loadMoreConversations}
                </Button>
              ) : null}
            </>
          )}
        </div>
      ) : (
        <>
          {error ? (
            <Alert role="alert" type="error" message={errorText(error)} />
          ) : null}
          {fresh ? (
            <>
              <div
                style={{
                  flex: 1,
                  overflow: "auto",
                  padding: "32px 24px",
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "center",
                }}
              >
                <span style={{ fontSize: 30, color: "#236653" }}>✧</span>
                <h2 style={{ fontWeight: 500 }}>
                  {zh ? "从一个想法开始。" : "Start with an idea."}
                </h2>
                <Typography.Text type="secondary">
                  {zh
                    ? "把问题或需要整理的内容发给助手，我们一起让它更清晰。"
                    : "Share a question or a passage. Let’s make it clearer together."}
                </Typography.Text>
              </div>
              <ChatComposer
                labels={labels}
                disabled={!workspace.ready || busy}
                textInputDisabled={busy}
                getDeadlineAt={getDeadlineAt}
                draft={welcomeDraft}
                onDraftChange={(draft) =>
                  setWelcomeDraft((previous) => ({
                    ...previous,
                    ...draft,
                    revision: previous.revision + 1,
                  }))
                }
                onSend={firstSend}
                style={{ margin: 12 }}
              />
            </>
          ) : selectedError ||
            workspace.snapshot.selectionStatus === "loading" ? (
            <div style={{ padding: 20 }}>
              <Alert
                type={selectedError ? "error" : "info"}
                message={
                  selectedError ? errorText(selectedError) : labels.loadingTitle
                }
              />
              {selectedError && (
                <Button
                  onClick={() => {
                    const id =
                      workspace.snapshot.pendingConversationId ??
                      selectedError.conversationId ??
                      selectedTarget.current;
                    if (id) void workspace.selectConversation(id);
                  }}
                >
                  {labels.retry}
                </Button>
              )}
            </div>
          ) : (
            <ChatConversationView
              presentation="compact"
              defaultEventDetailMode="modal"
              labels={labels}
              getDeadlineAt={getDeadlineAt}
              onRequestAuthentication={onRequestAuthentication}
              style={{ flex: 1, minHeight: 0, minWidth: 0 }}
            />
          )}
          <span
            style={{
              textAlign: "center",
              padding: "2px 8px 8px",
              fontSize: 11,
              color: "#647366",
            }}
          >
            {zh
              ? "AI 生成内容，请核实后使用"
              : "Check AI-generated content before using it."}
          </span>
        </>
      )}
      <Modal
        getContainer={getPopupContainer ?? false}
        open={!!rename || !!deleting}
        title={rename ? labels.renameConversation : labels.deleteConversation}
        onCancel={() => {
          setRename(undefined);
          setDeleting(undefined);
          setError(undefined);
        }}
        onOk={() => {
          void mutate(rename ? "rename" : "delete");
        }}
        confirmLoading={busy}
        cancelButtonProps={{ disabled: busy }}
        closable={!busy}
        keyboard={!busy}
        maskClosable={!busy}
        okButtonProps={{
          disabled: !!rename && !title.trim(),
          danger: !!deleting,
        }}
        okText={
          rename
            ? labels.renameConversationConfirm
            : labels.deleteConversationConfirm
        }
        cancelText={labels.deleteConversationCancel}
        styles={{
          mask: { position: "absolute" },
          wrapper: { position: "absolute" },
        }}
        width="calc(100% - 32px)"
      >
        <Space direction="vertical" style={{ width: "100%" }}>
          {error ? <Alert type="error" message={errorText(error)} /> : null}
          {rename ? (
            <Input
              aria-label={labels.createConversationTitleLabel}
              value={title}
              maxLength={80}
              onChange={(e) => setTitle(e.target.value)}
            />
          ) : (
            labels.deleteConversationPrompt
          )}
        </Space>
      </Modal>
      <Modal
        getContainer={getPopupContainer ?? false}
        open={!!pendingNavigation}
        onCancel={() => setPendingNavigation(undefined)}
        onOk={() => {
          pendingNavigation?.();
          setPendingNavigation(undefined);
        }}
        title={zh ? "离开当前对话？" : "Leave this conversation?"}
        okText={zh ? "确认切换" : "Switch"}
        cancelText={zh ? "取消" : "Cancel"}
        styles={{
          mask: { position: "absolute" },
          wrapper: { position: "absolute" },
        }}
        width="calc(100% - 32px)"
      >
        {zh
          ? "回复可能仍在服务端继续。返回这段对话可查看最新结果，草稿保留在本次会话。"
          : "The reply may continue on the server. Return to see updates. Your draft stays in this session."}
      </Modal>
    </div>
  );
}
