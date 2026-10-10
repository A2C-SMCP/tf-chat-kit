import { describe, expect, it } from "vitest";
import {
  parseManagerRobots,
  parseManagerConnectionInfo,
  resolveManagerTarget,
} from "../packages/chat-auth/src/manager.js";
const robot = {
  id: 41,
  robotId: "robot-41",
  robotAccountId: "org:robot-41",
  status: "running",
  templateType: "tfrserver",
};
const info = {
  socketBaseURL: "https://robot.example",
  namespace: "tenant-a",
  rid: "robot-41",
  robotType: "tfrobot",
  sioPath: "/socket.io/",
};
const policy = {
  allowedOrigins: ["https://robot.example", "https://bff.example"],
  http: { kind: "routed-api" as const },
};
describe("public Manager directory and routing", () => {
  it("keeps employee, robot and account identities separate, deduplicating directory rows", () => {
    const parsed = parseManagerRobots({
      data: { items: [robot, robot, { id: 42 }] },
    });
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({
      id: "41",
      employeeId: "41",
      robotId: "robot-41",
      robotAccountId: "org:robot-41",
      eligibility: "ready",
    });
    expect(parsed[1]).toMatchObject({
      eligibility: "missing_robot_id",
      canAutoConnect: false,
    });
    expect(
      parseManagerRobots({ items: [{ ...robot, status: "stopped" }] })[0]
        ?.eligibility,
    ).toBe("not_running");
    expect(
      parseManagerRobots({ items: [{ ...robot, templateType: "openclaw" }] })[0]
        ?.eligibility,
    ).toBe("unsupported_template");
    expect(() => parseManagerRobots({ error: "forbidden" })).toThrow();
  });
  it.each([
    "/socket.io/",
    "/c/tfrobot/tenant-a/robot-41/socket.io/",
    "/c/tfrobot/robot-41/socket.io/",
  ])("handles exact contract %s without double prefix", (path) => {
    const parsed = parseManagerConnectionInfo({
      data: { ...info, sioPath: path, accessToken: "secret" },
    });
    const result = resolveManagerTarget(
      parsed,
      { robotId: "robot-41" },
      policy,
    );
    expect(result.socketPath).toBe(
      path === "/socket.io/" ? "/c/tfrobot/tenant-a/robot-41/socket.io/" : path,
    );
    expect(result.baseUrl).toBe(
      path === "/c/tfrobot/robot-41/socket.io/"
        ? "https://robot.example/c/tfrobot/robot-41/api"
        : "https://robot.example/c/tfrobot/tenant-a/robot-41/api",
    );
    expect(JSON.stringify(parsed)).not.toContain("secret");
    expect(
      resolveManagerTarget(
        parsed,
        {},
        {
          ...policy,
          http: { kind: "bff", baseUrl: "https://bff.example/api" },
        },
      ).baseUrl,
    ).toBe("https://bff.example/api");
  });
  it.each([
    "https://u:p@robot.example",
    "https://robot.example/?token=secret",
    "https://robot.example/a",
    "https://evil.example",
    "https://robot.example/../",
  ])("rejects unsafe origins %s", (origin) => {
    expect(() =>
      resolveManagerTarget(
        parseManagerConnectionInfo({ ...info, socketBaseURL: origin }),
        {},
        policy,
      ),
    ).toThrow();
  });
  it.each([
    "/other/socket.io/",
    "/c/tfrobot/other/socket.io/",
    "/c/tfrobot/tenant-a/robot-41/../socket.io/",
  ])("rejects unknown or conflicting paths %s", (path) => {
    expect(() =>
      resolveManagerTarget(
        parseManagerConnectionInfo({ ...info, sioPath: path }),
        {},
        policy,
      ),
    ).toThrow();
  });
  it("rejects identity and routing-header conflicts", () => {
    expect(() =>
      resolveManagerTarget(
        parseManagerConnectionInfo(info),
        { robotId: "other" },
        policy,
      ),
    ).toThrow();
    expect(() =>
      parseManagerConnectionInfo({
        ...info,
        routingHeaders: { Authorization: "secret" },
      }),
    ).toThrow();
  });
});
