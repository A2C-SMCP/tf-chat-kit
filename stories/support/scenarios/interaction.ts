import { createInteractionClient } from "@turingfocus/chat-runtime";
import type {
  InteractionAck,
  InteractionRequest,
  InteractionResponse,
  InteractionTransport,
  InteractionTransportObserver,
} from "@turingfocus/chat-protocol";
import { conversationId } from "../fixtures/chat.js";

export type AnswerMode =
  "normal" | "hold" | "missing-ack" | "reject" | "accepted";
/** Controlled Protocol port. Queueing, countdown, attempts and drafts stay in Kit. */
export class ShowcaseInteractionTransport implements InteractionTransport {
  readonly namespace = "/remote-tool";
  readonly clock = {
    now: () => Date.now(),
    schedule: (callback: () => void, delay: number) => {
      const timer = setTimeout(callback, delay);
      return () => clearTimeout(timer);
    },
  };
  observer: InteractionTransportObserver | undefined;
  responses: InteractionResponse[] = [];
  mode: AnswerMode = "normal";
  readonly pending = new Map<string, InteractionRequest>();
  readonly timers = new Set<ReturnType<typeof setTimeout>>();
  connect() {
    this.observer?.connection("connected");
    this.observer?.hello({
      robotId: "showcase-robot",
      namespace: this.namespace,
      versions: ["interaction_v1"],
    });
    this.observer?.pending({
      kind: "snapshot",
      requests: [...this.pending.values()],
      knownIds: [...this.pending.keys()],
    });
  }
  attachInteraction(observer: InteractionTransportObserver) {
    this.observer = observer;
    return {
      respond: (
        response: InteractionResponse,
        ack: (value: InteractionAck | undefined) => void,
      ) => {
        if (this.mode === "reject") return false;
        this.responses.push(response);
        if (this.mode === "hold") return true;
        if (this.mode === "missing-ack") {
          ack(undefined);
          return true;
        }
        const timer = setTimeout(() => {
          this.timers.delete(timer);
          ack({ interactionId: response.interactionId, status: "accepted" });
          if (this.mode !== "accepted")
            this.close(response.interactionId, response.status);
        }, 400);
        this.timers.add(timer);
        return true;
      },
      detach: () => {
        this.observer = undefined;
        for (const t of this.timers) clearTimeout(t);
        this.timers.clear();
      },
    };
  }
  retryInteraction() {
    this.connect();
  }
  close(id: string, reason: string) {
    this.pending.delete(id);
    this.observer?.closed({
      interactionId: id,
      terminalReason: reason,
      answeredBy: "演示用户",
      answeredAt: Date.now(),
    });
  }
  request(
    id: string,
    options: {
      multi?: boolean;
      text?: boolean;
      seconds?: number;
      question?: string;
      conversationId?: string;
    } = {},
  ) {
    const request: InteractionRequest = {
      interactionId: id,
      conversationId: options.conversationId ?? conversationId,
      conversationTitle: "发布计划讨论",
      robotId: "showcase-robot",
      namespace: this.namespace,
      requester: { id: "assistant", name: "项目助理" },
      target: { kind: "human", id: "viewer", name: "当前用户" },
      question: options.question ?? "本次发布应优先支持哪些场景？",
      options: options.text
        ? []
        : [
            {
              value: "web",
              label: "Web 应用",
              description: "桌面浏览器内的完整聊天",
            },
            {
              value: "office",
              label: "Office 插件",
              description: "在窄侧栏中处理问询",
            },
            { value: "tauri", label: "Tauri 客户端" },
          ],
      multiSelect: options.multi ?? false,
      timeoutSeconds: options.seconds ?? 300,
      expiresAt: Date.now() + (options.seconds ?? 300) * 1000,
    };
    this.pending.set(id, request);
    this.observer?.requested(request);
  }
}
export async function createInteractionScene() {
  const transport = new ShowcaseInteractionTransport();
  const client = createInteractionClient({
    transport,
    robotId: "showcase-robot",
  });
  transport.connect();
  return { transport, client, dispose: () => client.dispose() };
}
export type InteractionScene = Awaited<
  ReturnType<typeof createInteractionScene>
>;
