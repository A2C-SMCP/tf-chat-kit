import {
  askUserInteractionAnswerSchema,
  askUserInteractionRequestSchema,
  defineRemoteTool,
  getAskUserInteractionAnswerValidationError,
  type AskUserInteractionAnswer,
  type AskUserInteractionRequest,
  type AskUserInteractionResult,
  type MaybePromise,
  type RemoteTool,
  type RemoteToolExecutionContext,
  type RemoteToolJson,
  type RemoteToolResult,
} from "@turingfocus/chat-protocol";
import { cloneImmutable } from "./immutable.js";

export interface AskUserRemoteToolOptions {
  /** Resolve from trusted host routing evidence, never current selection or model parameters. */
  readonly resolveConversationId: (
    context: RemoteToolExecutionContext,
  ) => MaybePromise<string | undefined>;
}

export interface AskUserRemoteToolEntry {
  readonly request: AskUserInteractionRequest;
  readonly deadlineAt: number;
  readonly draft?: AskUserInteractionAnswer["answers"] | undefined;
  readonly result?: AskUserInteractionResult | undefined;
}

const record = (
  value: RemoteToolJson | undefined,
): Readonly<Record<string, RemoteToolJson>> => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected an object");
  return value as Readonly<Record<string, RemoteToolJson>>;
};

// The built-in tool accepts Front's published structured-question vocabulary.
const normalize = (params: Readonly<Record<string, RemoteToolJson>>) => {
  const questions = params["questions"];
  if (!Array.isArray(questions)) throw new Error("Questions required");
  return {
    title: params["title"] ?? "需要用户输入",
    questions: questions.map((value, index) => {
      const question = record(value);
      const options = question["options"] ?? [];
      if (!Array.isArray(options)) throw new Error("Invalid options");
      return {
        id: String(index),
        prompt: question["question"],
        title: question["header"],
        required: true,
        multiple: question["multiSelect"] ?? false,
        options: options.map((value) => {
          const option = record(value);
          return {
            label: option["label"],
            value: option["label"],
            description: option["description"],
          };
        }),
      };
    }),
  };
};

/** Host-owned built-in tool and conversation store. Register .tool with RemoteToolClient. */
export class AskUserRemoteTool {
  readonly tool: RemoteTool;
  readonly #listeners = new Set<() => void>();
  readonly #pending = new Map<
    string,
    {
      readonly context: RemoteToolExecutionContext;
      finish(result: RemoteToolResult, answer?: AskUserInteractionAnswer): void;
    }
  >();
  #snapshot: readonly AskUserRemoteToolEntry[] = Object.freeze([]);
  #disposed = false;

  constructor(options: AskUserRemoteToolOptions) {
    this.tool = defineRemoteTool({
      definition: {
        toolName: "ask_user",
        description:
          "Ask the user structured questions in their chat conversation and wait for a response.",
        parameters: {
          type: "object",
          properties: {
            title: { type: "string" },
            questions: {
              type: "array",
              minItems: 1,
              maxItems: 20,
              items: {
                type: "object",
                properties: {
                  question: { type: "string" },
                  header: { type: "string" },
                  multiSelect: { type: "boolean" },
                  options: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        label: { type: "string" },
                        description: { type: "string" },
                      },
                      required: ["label", "description"],
                    },
                  },
                },
                required: ["question", "header", "options"],
              },
            },
          },
          required: ["questions"],
        },
        tags: ["remote", "interactive", "ask_user"],
      },
      validate: (params) => {
        // Reuse the standard request validator, including input bounds and option uniqueness.
        const request = askUserInteractionRequestSchema.parse({
          ...normalize(params),
          kind: "ask-user",
          conversationId: "validation",
          requestId: "validation",
          revision: "validation",
        });
        return { title: request.title, questions: request.questions };
      },
      execute: async (params, context) => {
        if (this.#disposed) return { ok: false, code: "disposed" };
        const conversationId = await options.resolveConversationId(context);
        if (this.#disposed) return { ok: false, code: "disposed" };
        if (context.signal.aborted)
          return { ok: false, code: context.cancellationReason ?? "cancelled" };
        if (
          typeof conversationId !== "string" ||
          conversationId.trim().length === 0
        )
          return { ok: false, code: "conversation-unavailable" };
        const request = askUserInteractionRequestSchema.parse({
          ...params,
          kind: "ask-user",
          conversationId,
          requestId: context.requestId,
          revision: context.requestId,
        });
        if (
          this.#snapshot.some(
            (entry) => entry.request.requestId === request.requestId,
          )
        )
          return { ok: false, code: "invalid-parameters" };
        if (this.#snapshot.length >= 100) {
          const index = this.#snapshot.findIndex(
            (entry) => entry.result !== undefined,
          );
          if (index < 0) return { ok: false, code: "capacity" };
          this.#snapshot = this.#snapshot.filter(
            (_, candidate) => candidate !== index,
          );
        }
        return new Promise<RemoteToolResult>((resolve) => {
          let settled = false;
          let unsubscribe = () => {};
          const finish = (
            result: RemoteToolResult,
            answer?: AskUserInteractionAnswer,
          ) => {
            if (settled) return;
            settled = true;
            unsubscribe();
            this.#pending.delete(request.requestId);
            const terminal: AskUserInteractionResult = {
              kind: "ask-user",
              requestId: request.requestId,
              revision: request.revision,
              questions: request.questions,
              status: result.ok
                ? "answered"
                : result.code === "timeout"
                  ? "timeout"
                  : result.code === "cancelled" || result.code === "disposed"
                    ? "cancelled"
                    : "failed",
              ...(answer?.action === "submit"
                ? { answers: answer.answers }
                : {}),
              ...(!result.ok ? { error: result.code } : {}),
            };
            this.#snapshot = cloneImmutable(
              this.#snapshot.map((entry) =>
                entry.request.requestId === request.requestId
                  ? { ...entry, result: terminal }
                  : entry,
              ),
            );
            resolve(result);
            this.#emit();
          };
          this.#pending.set(request.requestId, { context, finish });
          this.#snapshot = Object.freeze([
            ...this.#snapshot,
            Object.freeze({ request, deadlineAt: context.deadlineAt }),
          ]);
          unsubscribe = context.signal.subscribe(() =>
            finish({
              ok: false,
              code: context.cancellationReason ?? "cancelled",
            }),
          );
          this.#emit();
        });
      },
    });
  }

  getSnapshot = (): readonly AskUserRemoteToolEntry[] => this.#snapshot;
  subscribe = (listener: () => void): (() => void) => {
    if (this.#disposed) return () => {};
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  setDraft(conversationId: string, input: AskUserInteractionAnswer): boolean {
    const parsed = askUserInteractionAnswerSchema.safeParse(input);
    if (this.#disposed || !parsed.success) return false;
    const answer = parsed.data;
    const entry = this.#snapshot.find(
      (candidate) =>
        candidate.request.requestId === answer.requestId &&
        candidate.request.conversationId === conversationId &&
        candidate.request.revision === answer.revision,
    );
    const pending = this.#pending.get(answer.requestId);
    if (
      entry === undefined ||
      entry.result !== undefined ||
      pending === undefined ||
      pending.context.signal.aborted
    )
      return false;
    const questionIds = new Set(
      entry.request.questions.map((question) => question.id),
    );
    if (Object.keys(answer.answers).some((id) => !questionIds.has(id)))
      return false;
    this.#snapshot = cloneImmutable(
      this.#snapshot.map((candidate) =>
        candidate === entry
          ? { ...candidate, draft: answer.answers }
          : candidate,
      ),
    );
    this.#emit();
    return true;
  }

  answer(conversationId: string, input: AskUserInteractionAnswer): boolean {
    const parsed = askUserInteractionAnswerSchema.safeParse(input);
    if (this.#disposed || !parsed.success) return false;
    const answer = parsed.data;
    const entry = this.#snapshot.find(
      (candidate) =>
        candidate.request.requestId === answer.requestId &&
        candidate.request.conversationId === conversationId,
    );
    const pending = this.#pending.get(answer.requestId);
    if (
      entry === undefined ||
      entry.result !== undefined ||
      pending === undefined ||
      pending.context.signal.aborted ||
      entry.request.revision !== answer.revision
    )
      return false;
    if (pending.context.clock.now() >= pending.context.deadlineAt) {
      pending.finish({ ok: false, code: "timeout" });
      return false;
    }
    if (
      getAskUserInteractionAnswerValidationError(entry.request, answer) !==
      undefined
    )
      return false;
    if (answer.action === "cancel")
      pending.finish({ ok: false, code: "cancelled" });
    else
      pending.finish(
        {
          ok: true,
          resultForLlm: entry.request.questions
            .map(
              (question) =>
                `${Number(question.id) + 1}. ${question.prompt}: ${[answer.answers[question.id]].flat().join(", ")}`,
            )
            .join("\n"),
          origin: {
            type: "askUser",
            requestId: answer.requestId,
            status: "answered",
            questions: entry.request.questions.map((question) => ({
              question: question.prompt,
              header: question.title ?? question.prompt,
              multiSelect: question.multiple,
              options: question.options.map((option) => ({
                label: option.label,
                description: option.description ?? "",
              })),
            })),
            response: { requestId: answer.requestId, answers: answer.answers },
          },
        },
        answer,
      );
    return true;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const pending of [...this.#pending.values()])
      pending.finish({ ok: false, code: "disposed" });
    this.#snapshot = Object.freeze([]);
    this.#emit();
    this.#listeners.clear();
  }

  #emit(): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener();
      } catch {
        /* Isolate host UI listeners. */
      }
    }
  }
}

export const createAskUserRemoteTool = (
  options: AskUserRemoteToolOptions,
): AskUserRemoteTool => new AskUserRemoteTool(options);
