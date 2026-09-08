import { describe, expect, it } from "vitest";
import {
  mapEvent,
  mapEventUpdate,
} from "../packages/chat-gateway-tfrobot/src/mapper.js";
import {
  agentEventSchema,
  toolPresentationSchema,
} from "../packages/chat-protocol/src/index.js";

const event = (content: unknown, eventScene = "Tool") => ({
  eventId: "display",
  conversationId: "42",
  eventScene,
  status: "success",
  createTimestamp: 10,
  content,
});
const tool = (origin: unknown, transformed?: unknown) => ({
  toolCall: { functionCall: { name: "inspect", parameters: "{}" } },
  toolReturn: {
    origin,
    meta: {
      success: true,
      done: true,
      __MCP__: { a2c_vrl_transformed: transformed },
    },
  },
});

describe("tool presentation normalization (#59)", () => {
  it.each([
    [
      {
        url: "https://example.com",
        image: "s3://bucket/screen",
        content: "page",
      },
      "browser",
    ],
    [{ original: "", modified: "new", language: null }, "editor"],
    [{ content: "", language: "unknown" }, "preview"],
    [{ content: "\u001b[31mfailed", command: "ls", username: null }, "shell"],
    [{ url: "s3://bucket/report.pdf" }, "download"],
  ])("normalizes %j in history and realtime", (origin, kind) => {
    const dto = event(tool(origin), "Chain");
    const mapped = mapEvent(dto);
    expect(mapped.eventCategory).toBe("tool");
    if (mapped.eventCategory !== "tool") throw new Error("Expected tool");
    expect(mapped.transitions[0]?.toolReturn?.presentation?.kind).toBe(kind);
    expect(mapEventUpdate(dto)).toMatchObject({
      event: { transition: mapped.transitions[0] },
    });
  });

  it("prefers valid transformed data without changing result and falls back on invalid data", () => {
    for (const transformed of [
      "{",
      { nonsense: true },
      JSON.stringify({ content: "replacement", language: "ts" }),
    ]) {
      const origin = { url: "https://example.com" };
      const mapped = mapEvent(event(tool(origin, transformed)));
      if (mapped.eventCategory !== "tool") throw new Error("Expected tool");
      expect(mapped.transitions[0]?.toolReturn).toMatchObject({
        result: origin,
        success: true,
        done: true,
        presentation: {
          kind:
            typeof transformed === "string" && transformed.startsWith('{"')
              ? "preview"
              : "browser",
        },
      });
    }
  });

  it("retains safe generic objects and valid attachments around invalid parts", () => {
    expect(
      mapEvent(event({ body: "hello", token: "private" }, "Chain"))
        .transitions[0]?.content,
    ).toEqual({ body: "hello", token: "[REDACTED]" });
    const mapped = mapEvent(
      event({
        toolReturn: {
          origin: { future: true },
          attachments: [
            null,
            {
              category: "image",
              attachment: "https://example.com/a.png?token=secret",
            },
            { category: "new", attachment: "s3://bucket/a" },
            { attachment: 42 },
          ],
        },
      }),
    );
    if (mapped.eventCategory !== "tool") throw new Error("Expected tool");
    expect(mapped.transitions[0]?.toolReturn?.attachments).toHaveLength(2);
    expect(JSON.stringify(mapped)).not.toContain("secret");
    expect(mapped.transitions[0]?.toolReturn?.presentation).toBeUndefined();
    expect(
      toolPresentationSchema.safeParse({ kind: "editor", original: 42 })
        .success,
    ).toBe(false);
  });
});

it("accepts standard presentation and nonempty attachment returns without fabricated raw fields", () => {
  const base = mapEvent(event(tool({ content: "hello", language: "text" })));
  for (const toolReturn of [
    { presentation: { kind: "preview", code: "hello" } },
    { attachments: [{ kind: "file", resource: { uri: "private:report" } }] },
  ]) {
    const parsed = agentEventSchema.parse({
      ...base,
      transitions: [{ ...base.transitions[0], toolReturn }],
    });
    expect(
      parsed.eventCategory === "tool" && parsed.transitions[0]?.toolReturn,
    ).toEqual(toolReturn);
  }
  for (const toolReturn of [{}, { attachments: [] }]) {
    expect(
      agentEventSchema.safeParse({
        ...base,
        transitions: [{ ...base.transitions[0], toolReturn }],
      }).success,
    ).toBe(false);
  }
});

it("falls back from wholly invalid Shell transformations without hiding a valid origin", () => {
  for (const transformed of [
    { command: 42 },
    { command: null, content: 42 },
    { username: {}, hostname: false },
  ]) {
    const mapped = mapEvent(
      event(tool({ content: "VALID ORIGINAL", language: "text" }, transformed)),
    );
    expect(
      mapped.eventCategory === "tool" &&
        mapped.transitions[0]?.toolReturn?.presentation,
    ).toEqual({ kind: "preview", code: "VALID ORIGINAL", language: "text" });
  }
  const empty = mapEvent(
    event(
      tool(
        { content: "VALID ORIGINAL", language: "text" },
        { command: "", content: "" },
      ),
    ),
  );
  expect(
    empty.eventCategory === "tool" &&
      empty.transitions[0]?.toolReturn?.presentation,
  ).toMatchObject({ kind: "shell", output: "", command: "" });
});
