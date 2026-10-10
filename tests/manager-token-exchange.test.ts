import { describe, expect, it } from "vitest";
import { managerAuthFixture } from "./support/manager-auth.js";
import { createManagerClient } from "../packages/chat-auth/src/manager.js";

describe("public Manager robot sessions", () => {
  it("uses receiver-free fetch, single-flight and demand-driven expiry", async () => {
    const auth = await managerAuthFixture();
    let calls = 0,
      now = 1000;
    const manager = createManagerClient({
      auth,
      baseUrl: "https://manager.example",
      routing: { allowedOrigins: [], http: { kind: "direct" } },
      now: () => now,
      fetch: async function (this: unknown, _input, init) {
        expect(this).toBeUndefined();
        calls++;
        expect(new URLSearchParams(String(init?.body)).get("audience")).toBe(
          "robot:robot-account",
        );
        expect(
          new URLSearchParams(String(init?.body)).get("subject_token"),
        ).toBe("manager-secret");
        return Response.json({
          access_token: `short-${calls}`,
          expires_in: 40,
        });
      },
    });
    const source = manager.createRobotSessionProvider("robot-account");
    const first = await Promise.all([source.getSession(), source.getSession()]);
    expect(first[0]).toEqual(first[1]);
    expect(calls).toBe(1);
    now += 11_000;
    expect((await source.getSession()).token).toBe("short-2");
    await auth.switchAccount("b");
    await expect(source.getSession()).rejects.toMatchObject({
      code: "cancelled",
    });
    expect(JSON.stringify(manager.getSnapshot())).not.toContain("short-");
    await manager.dispose();
    await auth.dispose();
  });
  it("rejects late credentials after invalidation, even when fetch ignores abort", async () => {
    const auth = await managerAuthFixture();
    let finish!: (r: Response) => void;
    let start!: () => void;
    const started = new Promise<void>((r) => {
      start = r;
    });
    const manager = createManagerClient({
      auth,
      baseUrl: "https://manager.example",
      routing: { allowedOrigins: [], http: { kind: "direct" } },
      fetch: async () => {
        start();
        return new Promise<Response>((r) => {
          finish = r;
        });
      },
    });
    const source = manager.createRobotSessionProvider("robot");
    const result = source.getSession();
    const assertion = expect(result).rejects.toMatchObject({
      code: "cancelled",
    });
    await started;
    source.invalidate();
    finish(Response.json({ access_token: "late-secret", expires_in: 60 }));
    await assertion;
    await manager.dispose();
    await auth.dispose();
  });
});
