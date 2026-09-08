import { describe, expect, it } from "vitest";

import {
  sanitizeCredentialPayload,
  sanitizeCredentialRaw,
  TransportPayloadError,
} from "../packages/chat-gateway-tfrobot/src/redaction.js";
import { TFRobotHttpClient } from "../packages/chat-gateway-tfrobot/src/http.js";
import { historyDtoSchema } from "../packages/chat-gateway-tfrobot/src/dto.js";

describe("transport redaction independently of diagnostic retention", () => {
  it("preserves large business strings and pages while redacting credentials", () => {
    const secret = "opaque-session-value";
    const text = "x".repeat(551_510);
    const input = {
      content: `${text} ${secret}`,
      rows: Array.from({ length: 12_000 }, () => ({ text: "normal" })),
      token: secret,
      metadata: { headers: [["Authorization", `Bearer ${secret}`]] },
      [secret]: "safe",
    };
    expect(() => sanitizeCredentialRaw(input, [secret])).toThrow();
    const output = sanitizeCredentialPayload(input, [secret]);
    expect(output).toEqual({
      rows: input.rows,
      content: `${text} [REDACTED]`,
      token: "[REDACTED]",
      metadata: { headers: [["Authorization", "[REDACTED]"]] },
      "[REDACTED]": "safe",
    });
    expect(JSON.stringify(output)).not.toContain(secret);
    expect(input.content).toContain(secret);
    expect(Object.isFrozen(output)).toBe(true);
  });

  it("retains the existing credential-shaped key, tuple and string protection", () => {
    const input = {
      api_key: "private-value",
      notes: "Bearer private-value",
      url: "https://example.test/?token=private-value&safe=yes",
      headers: [["Cookie", "private-value"]],
      nested: { password: "private-value", ordinary: "opaque-value" },
    };
    expect(sanitizeCredentialPayload(input, ["opaque-value"])).toEqual(
      sanitizeCredentialRaw(input, ["opaque-value"]),
    );
  });

  it("protects prototype keys, collisions, and the original input", () => {
    const input: unknown = JSON.parse(
      '{"__proto__":{"safe":true},"secret-a":"first","secret-b":"second"}',
    );
    const output = sanitizeCredentialPayload(input, ["secret-a", "secret-b"]);
    expect(Object.getPrototypeOf(output)).toBe(Object.prototype);
    expect(Object.hasOwn(output as object, "__proto__")).toBe(true);
    expect(output).toMatchObject({ "[REDACTED]": "first" });
    expect(Object.prototype).not.toHaveProperty("safe");
  });

  it("distinguishes structural limits and invalid injected JSON from raw limits", () => {
    const cycle: Record<string, unknown> = {};
    cycle["self"] = cycle;
    for (const input of [
      cycle,
      new Date(),
      undefined,
      Number.NaN,
      new Array(2),
    ]) {
      expect(() => sanitizeCredentialPayload(input, [])).toThrow(
        TransportPayloadError,
      );
    }
    expect(() =>
      sanitizeCredentialPayload(Array(100_001).fill(null), []),
    ).toThrow(/transport node limit/u);
    let deep: unknown = "safe";
    for (let index = 0; index < 65; index += 1) deep = { child: deep };
    expect(() => sanitizeCredentialPayload(deep, [])).toThrow(
      /transport structure limits/u,
    );
  });

  it.each([
    {
      label: "malformed envelope",
      status: 200,
      body: { data: {} },
      message: "TFRobot response envelope is invalid",
      code: "validation",
    },
    {
      label: "malformed data",
      status: 200,
      body: { code: 200, message: "ok", data: { messages: 7, events: [] } },
      message: "TFRobot response data is invalid",
      code: "validation",
    },
    {
      label: "large authentication error",
      status: 401,
      body: {
        message: "Expired opaque-session-value",
        extra: "x".repeat(551_510),
      },
      message: "Expired [REDACTED]",
      code: "authentication",
    },
    {
      label: "large business error",
      status: 200,
      body: {
        code: 400,
        message: "Failed opaque-session-value",
        data: "x".repeat(551_510),
      },
      message: "Failed [REDACTED]",
      code: "validation",
    },
    {
      label: "transport structure limit",
      status: 200,
      body: {
        code: 200,
        message: "ok",
        data: { messages: [], events: [], extra: Array(100_001).fill(null) },
      },
      message: "TFRobot payload exceeds transport node limit (100000)",
      code: "validation",
    },
  ])(
    "classifies $label without echoing the payload",
    async ({ status, body, message, code }) => {
      const invalidations: unknown[] = [];
      const client = new TFRobotHttpClient({
        baseUrl: "https://example.test/",
        messageCreatorProvider: () => ({ uid: "test-user", name: "Test user" }),
        sessionProvider: {
          getSession: () => ({ kind: "bearer", token: "opaque-session-value" }),
          onSessionInvalid: (event) => {
            invalidations.push(event);
          },
        },
        fetch: async () => new Response(JSON.stringify(body), { status }),
      });
      try {
        const result = await client.request({
          method: "GET",
          path: "history",
          operation: "read",
          options: { deadlineAt: Date.now() + 60_000 },
          schema: historyDtoSchema,
        });
        expect(result).toMatchObject({ ok: false, error: { code, message } });
        expect(JSON.stringify(result)).not.toContain("opaque-session-value");
        expect(invalidations).toHaveLength(status === 401 ? 1 : 0);
      } finally {
        client.dispose();
      }
    },
  );
});
