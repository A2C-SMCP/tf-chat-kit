import { describe, expect, it } from "vitest";
import { historyDtoSchema } from "../packages/chat-gateway-tfrobot/src/dto.js";
import { mapSnapshot } from "../packages/chat-gateway-tfrobot/src/mapper.js";
import {
  chatSnapshotSchema,
  getConversationFailure,
  chatUpdateSchema,
} from "../packages/chat-protocol/src/index.js";

const original = {
  msgId: "original",
  conversationId: "42",
  createTimestamp: 10,
  role: "user",
  msgType: "text",
  content: "我选中的文字加粗",
};
const record = {
  id: "failure-1",
  conversationId: "42",
  createTimestamp: 20,
  error: "Token 使用量 139132 超过最大限制 128000。",
  code: null,
  message: original,
};
const snapshot = (errors?: unknown[]) =>
  mapSnapshot(
    { id: "42", title: "Conversation" },
    historyDtoSchema.parse({
      messages: [],
      events: [],
      ...(errors ? { errors } : {}),
    }),
    { working: true, taskId: "new-task" },
  );

describe("conversation failure history contract", () => {
  it("normalizes real errors[] and its authoritative original text independently of the active run", () => {
    const result = snapshot([record]);
    expect(result.timeline).toHaveLength(1);
    expect(result.timeline[0]).toMatchObject({
      kind: "agent-event",
      eventType: "conversation.failure",
      status: "failed",
      transitions: [
        {
          failure: {
            message: record.error,
            source: "history",
            recordId: "failure-1",
            originalMessage: { id: "original", text: original.content },
          },
        },
      ],
    });
    expect(result.run?.id).toBe("new-task");
    expect(result.run?.status).toBe("running");
    expect(chatSnapshotSchema.safeParse(result).success).toBe(true);
  });
  it("preserves distinct error records with identical bodies and accepts legacy missing errors", () => {
    expect(snapshot().timeline).toEqual([]);
    expect(
      snapshot([record, { ...record, id: "failure-2" }]).timeline,
    ).toHaveLength(2);
    expect(snapshot([record]).timeline[0]?.id).toBe(
      snapshot([record]).timeline[0]?.id,
    );
  });
  it("does not invent original text from non-text messages or foreign conversation messages", () => {
    for (const message of [
      { ...original, msgType: "file" },
      { ...original, conversationId: "other" },
      { ...original, role: "assistant" },
    ]) {
      const item = snapshot([{ ...record, message }]).timeline[0];
      expect(
        item?.kind === "agent-event" &&
          item.transitions[0]?.failure?.originalMessage,
      ).toBeUndefined();
    }
    expect(() => snapshot([{ ...record, conversationId: "other" }])).toThrow();
  });
  it("sanitizes credential-shaped fragments without hiding the actual business explanation", () => {
    const result = snapshot([
      {
        ...record,
        error: `${record.error} Bearer sensitive-value`,
        code: "future.code",
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("sensitive-value");
    expect(JSON.stringify(result)).toContain("139132");
  });
});

import {
  createCacheRecord,
  parseCacheRecord,
} from "../packages/chat-runtime/src/cache-record.js";
import { emptyComposerDraft } from "../packages/chat-runtime/src/composer-draft.js";
import { createChatClient } from "../packages/chat-runtime/src/index.js";
import { createMemoryChatGateway } from "../packages/chat-testing/src/index.js";

it("retains only safe display facts across a cache roundtrip and keeps legacy records readable", () => {
  const value = snapshot([record]);
  const encoded = createCacheRecord(
    "scope",
    value,
    emptyComposerDraft("42"),
    30,
    [],
  );
  const restored = parseCacheRecord(encoded, "scope", "42")!;
  expect(getConversationFailure(restored.snapshot.timeline[0]!)).toEqual({
    ...getConversationFailure(value.timeline[0]!),
    originalMessage: undefined,
  });
  expect(restored.snapshot.run).toBeNull();
  expect(restored.snapshot.capabilities.sendText).toBe(false);
  expect(restored.snapshot.lifecycle?.status).toBe("offline");
  expect(restored.snapshot.timeline[0]).toMatchObject({ status: "unknown" });
  expect(JSON.stringify(restored)).not.toMatch(
    /toolReturn|raw|details|activeErrors/,
  );
  expect(
    parseCacheRecord(
      createCacheRecord("scope", snapshot(), emptyComposerDraft("42"), 30, []),
      "scope",
      "42",
    ),
  ).toBeDefined();
});

it("uses immutable, instance-local events, deduplicates persisted IDs and stays silent after disposal", async () => {
  const memory = createMemoryChatGateway();
  const client = createChatClient({ gateway: memory.gateway });
  const secondMemory = createMemoryChatGateway();
  const second = createChatClient({ gateway: secondMemory.gateway });
  const options = { deadlineAt: Date.now() + 5000 };
  try {
    const conversationId = memory.fixtures.conversation.id;
    await client.loadConversation({ ...options, conversationId });
    await second.loadConversation({ ...options, conversationId });
    const item = mapSnapshot(
      { id: conversationId, title: "Test" },
      historyDtoSchema.parse({
        messages: [],
        events: [],
        errors: [
          {
            ...record,
            conversationId,
            message: { ...original, conversationId },
          },
        ],
      }),
      { working: false },
    ).timeline[0]!;
    const update = chatUpdateSchema.parse({
      kind: "timeline.upsert",
      conversationId,
      item,
    });
    const before = client.getSnapshot()!.timeline.length;
    memory.controller.emitUpdateToAll(update);
    memory.controller.emitUpdateToAll(update);
    expect(client.getSnapshot()!.timeline.length).toBe(before + 1);
    expect(
      second
        .getSnapshot()!
        .timeline.some((entry) => getConversationFailure(entry) !== undefined),
    ).toBe(false);
    expect(
      Object.isFrozen(
        getConversationFailure(
          client.getSnapshot()!.timeline.find((entry) => entry.id === item.id)!,
        ),
      ),
    ).toBe(true);
    await client.dispose(options);
    const final = client.getSnapshot();
    memory.controller.emitUpdateToAll({
      kind: "timeline.upsert",
      conversationId,
      item: { ...item, id: "late" },
    });
    expect(client.getSnapshot()).toBe(final);
  } finally {
    await client.dispose(options);
    await second.dispose(options);
  }
});

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatTimeline } from "../packages/chat-ui-antd/src/index.js";
import { compactChatZhCN } from "../packages/chat-ui-antd/src/compact-labels.js";

it.each([
  ["robot.acquisition.config_absent", "机器人配置缺失"],
  ["robot.acquisition.build_failed", "机器人构建失败"],
  ["robot.acquisition.dependency_permanent", "机器人依赖不可用"],
  ["robot.acquisition.id_mismatch", "机器人 ID 不匹配"],
  ["future.code", "本轮生成失败"],
  ["__proto__", "本轮生成失败"],
  ["constructor", "本轮生成失败"],
  [null, "本轮生成失败"],
])(
  "renders safe localized titles for business code %s in the standalone timeline",
  (code, title) => {
    const value = snapshot([{ ...record, code }]);
    const markup = renderToStaticMarkup(
      createElement(ChatTimeline, {
        conversationId: "42",
        items: value.timeline,
        labels: compactChatZhCN,
      }),
    );
    expect(markup).toContain(title);
    expect(markup).toContain("139132");
    expect(markup).not.toContain("Renderer unavailable");
    expect(markup).not.toContain("回填后编辑");
  },
);

it("bounds business display text and withholds oversized original input rather than refilling a partial message", () => {
  const value = snapshot([
    {
      ...record,
      error: "说明".repeat(40000),
      message: { ...original, content: "原文".repeat(140000) },
    },
  ]);
  const failure = getConversationFailure(value.timeline[0]!)!;
  expect(failure.message.length).toBeLessThanOrEqual(65536);
  expect(failure.originalMessage).toBeUndefined();
  expect(
    historyDtoSchema.safeParse({
      messages: [],
      events: [],
      errors: [{ ...record, code: 500 }],
    }).success,
  ).toBe(false);
});

it("bounds sanitized output, rejects expanded actionable text and keeps cache roundtrips valid", () => {
  const value = snapshot([record]);
  const item = value.timeline[0];
  if (item?.kind !== "agent-event") throw new Error("Missing failure");
  const custom = {
    ...value,
    timeline: [
      {
        ...item,
        transitions: [
          {
            ...item.transitions[0],
            failure: {
              ...getConversationFailure(item),
              message: "Details" + " token=a".repeat(7000),
            },
          },
        ],
      },
    ],
  };
  const normalized = chatSnapshotSchema.parse(custom);
  expect(
    getConversationFailure(normalized.timeline[0]!)!.message.length,
  ).toBeLessThanOrEqual(65536);
  expect(chatSnapshotSchema.safeParse(normalized).success).toBe(true);
  const expandedOriginal = snapshot([
    {
      ...record,
      message: { ...original, content: "Input" + " token=a".repeat(30000) },
    },
  ]);
  expect(
    getConversationFailure(expandedOriginal.timeline[0]!)?.originalMessage,
  ).toBeUndefined();
  const blobs = snapshot([
    { ...record, message: { ...original, content: "blob:x ".repeat(30000) } },
  ]);
  const cached = createCacheRecord(
    "scope",
    blobs,
    emptyComposerDraft("42"),
    30,
    [],
  );
  expect(parseCacheRecord(cached, "scope", "42")).toBeDefined();
});

it("preserves the existing generic renderer when a legacy event uses the reserved failure name without normalized failure data", () => {
  const value = snapshot([record]);
  const item = value.timeline[0];
  if (item?.kind !== "agent-event") throw new Error("Missing event");
  const legacy = {
    ...item,
    summary: "Legacy event explanation",
    transitions: [
      {
        id: "legacy",
        occurredAt: item.createdAt,
        status: "failed" as const,
        summary: "Legacy event explanation",
      },
    ],
  };
  const markup = renderToStaticMarkup(
    createElement(ChatTimeline, { conversationId: "42", items: [legacy] }),
  );
  expect(markup).toContain("Legacy event explanation");
});
