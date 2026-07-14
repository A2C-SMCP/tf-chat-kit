import { describe, expect, it } from "vitest";

import {
  loadWorkspaceSnapshot,
  validateWorkspaceSnapshot,
} from "../scripts/workspace-policy.mjs";

const clone = <T>(value: T): T => structuredClone(value);

describe("workspace governance", () => {
  it("accepts the committed six-package architecture", async () => {
    const snapshot = await loadWorkspaceSnapshot(process.cwd());
    expect(validateWorkspaceSnapshot(snapshot)).toEqual([]);
  });

  it("rejects unified version drift", async () => {
    const snapshot = clone(await loadWorkspaceSnapshot(process.cwd()));
    snapshot.packages[0]!.manifest.version = "0.2.0";

    expect(validateWorkspaceSnapshot(snapshot)).toContainEqual(
      expect.stringContaining("workspace package versions must match"),
    );
  });

  it("accepts a fixed-group 0.x version bump", async () => {
    const snapshot = clone(await loadWorkspaceSnapshot(process.cwd()));
    for (const entry of snapshot.packages) entry.manifest.version = "0.2.0";

    expect(validateWorkspaceSnapshot(snapshot)).toEqual([]);
  });

  it("rejects a unified version outside the 0.x line", async () => {
    const snapshot = clone(await loadWorkspaceSnapshot(process.cwd()));
    for (const entry of snapshot.packages) entry.manifest.version = "1.0.0";

    expect(validateWorkspaceSnapshot(snapshot)).toContainEqual(
      expect.stringContaining("must be valid 0.x SemVer"),
    );
  });

  it("rejects reverse internal dependencies", async () => {
    const snapshot = clone(await loadWorkspaceSnapshot(process.cwd()));
    const protocol = snapshot.packages.find(
      ({ directory }) => directory === "chat-protocol",
    )!;
    protocol.manifest.dependencies = { "@tf/chat-ui-antd": "workspace:^" };

    expect(validateWorkspaceSnapshot(snapshot)).toContainEqual(
      expect.stringContaining("internal dependencies must be"),
    );
  });

  it("rejects React and Ant Design outside their allowed packages", async () => {
    const snapshot = clone(await loadWorkspaceSnapshot(process.cwd()));
    const runtime = snapshot.packages.find(
      ({ directory }) => directory === "chat-runtime",
    )!;
    runtime.manifest.peerDependencies = { antd: "^5.0.0", react: "^18.0.0" };

    const errors = validateWorkspaceSnapshot(snapshot);
    expect(errors).toContainEqual(
      expect.stringContaining("React is only allowed"),
    );
    expect(errors).toContainEqual(
      expect.stringContaining("Ant Design is only allowed"),
    );
  });

  it("rejects host source imports and local path consumption", async () => {
    const snapshot = clone(await loadWorkspaceSnapshot(process.cwd()));
    const runtime = snapshot.packages.find(
      ({ directory }) => directory === "chat-runtime",
    )!;
    runtime.manifest.dependencies["@tf/chat-protocol"] =
      "file:/Users/example/TFRobotFront/src/packages/chat-kit";
    snapshot.sourceFiles.push({
      path: "packages/chat-runtime/src/host-leak.ts",
      content: 'import "next/router";',
    });

    const errors = validateWorkspaceSnapshot(snapshot);
    expect(errors).toContainEqual(
      expect.stringContaining("forbidden source/path dependency"),
    );
    expect(errors).toContainEqual(
      expect.stringContaining("forbidden Next.js dependency"),
    );
  });
});
