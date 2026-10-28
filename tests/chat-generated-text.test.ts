import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { getGeneratedEventTexts } from "../packages/chat-protocol/src/index.js";
import {
  mapEvent,
  mapEventUpdate,
} from "../packages/chat-gateway-tfrobot/src/mapper.js";
import { eventDtoSchema } from "../packages/chat-gateway-tfrobot/src/dto.js";
import {
  createChatRendererRegistry,
  ChatTimelineItem,
} from "../packages/chat-ui-antd/src/renderer-registry.js";
import {
  createCacheRecord,
  parseCacheRecord,
} from "../packages/chat-runtime/src/cache-record.js";
import { createMemoryChatGateway } from "../packages/chat-testing/src/index.js";
import { ChatTimeline } from "../packages/chat-ui-antd/src/chat-timeline.js";

it("filters empty LLM timeline rows without an orphaned detail trigger and preserves host overrides", () => {
  const item = mapEvent({ ...input, content: "", generatedTexts: [] });
  const html = renderToStaticMarkup(
    createElement(ChatTimeline, {
      items: [item],
      conversationId: "42",
      onEventSelect: () => undefined,
    }),
  );
  expect(html).not.toContain("data-chat-event-trigger");
  expect(html).not.toContain("打开事件详情");
  const custom = renderToStaticMarkup(
    createElement(ChatTimeline, {
      items: [item],
      conversationId: "42",
      renderers: {
        "agent-event:LLM": () => createElement("p", null, "host diagnostic"),
      },
    }),
  );
  expect(custom).toContain("host diagnostic");
});

const input = {
  eventId: "model-output",
  conversationId: "42",
  eventScene: "LLM",
  status: "success",
  createTimestamp: 1000,
  content: "diagnostic summary only",
};
const render = (generatedTexts?: readonly string[], eventScene = "LLM") =>
  renderToStaticMarkup(
    createElement(ChatTimelineItem, {
      item: mapEvent({
        ...input,
        eventScene,
        generatedTexts:
          generatedTexts === undefined ? undefined : [...generatedTexts],
      }),
      displayMode: "timeline",
      registry: createChatRendererRegistry(),
    }),
  );

it("expands only explicit model text as safe Markdown and keeps history/realtime aligned", () => {
  const dto = {
    ...input,
    generatedTexts: ["**找到文件了**\n\n- 已核对数据", "第二段", " "],
  };
  const event = mapEvent(dto);
  expect(getGeneratedEventTexts(event)).toEqual([
    "**找到文件了**\n\n- 已核对数据",
    "第二段",
  ]);
  expect(mapEventUpdate(dto)).toMatchObject({
    event: { transition: event.transitions[0] },
  });
  const html = render(dto.generatedTexts);
  expect(html).toContain("data-chat-generated-text");
  expect(html).toContain("<strong>找到文件了</strong>");
  expect(html).toContain("第二段");
  expect(html).not.toContain("diagnostic summary only");
  expect(html).not.toContain("data-chat-event-row");
  expect(
    render(["<script>alert('private')</script>**安全正文**"]),
  ).not.toContain("<script>");
});

it.each([undefined, [], ["", " "]])(
  "uses LLM content when the optional legacy field is absent, and hides explicit empty output %j",
  (texts) => {
    const html = render(texts);
    if (texts === undefined) expect(html).toContain("data-chat-generated-text");
    else expect(html).not.toContain("data-chat-generated-text");
    expect(html).not.toContain("data-chat-event-row");
  },
);

it("ignores the field for other scenes and malformed data falls back without losing the event", () => {
  expect(render(["not model output"], "Memory")).not.toContain(
    "data-chat-generated-text",
  );
  const parsed = eventDtoSchema.parse({
    ...input,
    generatedTexts: { text: "invalid" },
  });
  expect(getGeneratedEventTexts(mapEvent(parsed))).toBeUndefined();
  expect(mapEvent(parsed).id).toContain("model-output");
});

it("keeps renderer overrides and uses the latest explicit generation rather than concatenating transitions", () => {
  const event = mapEvent({ ...input, generatedTexts: ["old"] });
  const item = {
    ...event,
    transitions: [
      ...event.transitions,
      {
        id: "new",
        status: "success" as const,
        occurredAt: 1001,
        generatedTexts: ["current"],
      },
    ],
  };
  expect(getGeneratedEventTexts(item)).toEqual(["current"]);
  const html = renderToStaticMarkup(
    createElement(ChatTimelineItem, {
      item,
      displayMode: "timeline",
      registry: createChatRendererRegistry({
        "agent-event:LLM": () => createElement("p", null, "host override"),
      }),
    }),
  );
  expect(html).toContain("host override");
  expect(html).not.toContain("current");
});

it("retains display-only output in cache with resource/credential sanitization", () => {
  const memory = createMemoryChatGateway();
  const event = mapEvent({
    ...input,
    conversationId: memory.fixtures.conversation.id,
    generatedTexts: [
      "Generated text token=private https://example.test/image?token=private",
    ],
  });
  const snapshot = { ...memory.fixtures.initialSnapshot, timeline: [event] };
  const record = createCacheRecord(
    "test",
    snapshot,
    {
      conversationId: snapshot.conversation.id,
      revision: 0,
      text: "",
      attachments: [],
      longTexts: [],
    },
    1000,
    [],
  );
  const encoded = JSON.stringify(record);
  expect(encoded).not.toContain("private");
  expect(getGeneratedEventTexts(record.snapshot.timeline[0]!)).toEqual([
    "Generated text token=[removed] [resource requires revalidation]",
  ]);
  expect(record.snapshot.capabilities.sendText).toBe(false);
  expect(
    parseCacheRecord(JSON.parse(encoded), "test", snapshot.conversation.id)
      ?.snapshot.timeline,
  ).toHaveLength(1);
});

it("keeps a later failure visible alongside already observed text", () => {
  const event = mapEvent({ ...input, generatedTexts: ["已有正文"] });
  const item = {
    ...event,
    status: "failed" as const,
    transitions: [
      ...event.transitions,
      {
        id: "failed",
        status: "failed" as const,
        occurredAt: 2000,
        error: {
          code: "server" as const,
          message: "后续执行失败",
          retryable: false,
        },
      },
    ],
  };
  const html = renderToStaticMarkup(
    createElement(ChatTimelineItem, {
      item,
      displayMode: "timeline",
      registry: createChatRendererRegistry(),
    }),
  );
  expect(html).toContain("已有正文");
  expect(html).toContain("后续执行失败");
});

it("renders existing LLM content directly as intermediate Markdown without a success badge", () => {
  const html = renderToStaticMarkup(
    createElement(ChatTimelineItem, {
      item: mapEvent({
        ...input,
        content: "**已找到文件**\n\n接下来读取明细。",
      }),
      displayMode: "timeline",
      registry: createChatRendererRegistry(),
    }),
  );
  expect(html).not.toContain("思考进展");
  expect(html).toContain("<strong>已找到文件</strong>");
  expect(html).not.toContain("data-chat-event-row");
  expect(html).not.toContain(">success<");
});
