import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const workflowPath = new URL("../.github/workflows/ci.yml", import.meta.url);

describe("GitHub Actions quality gate", () => {
  it("runs the complete gate on pull requests and main pushes", async () => {
    const workflow = await readFile(workflowPath, "utf8");

    expect(workflow).toContain("pull_request:");
    expect(workflow).toMatch(/push:\n\s+branches:\n\s+- main/u);
    expect(workflow).toContain(
      "uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0",
    );
    expect(workflow).toContain("fetch-depth: 0");
    expect(workflow).toContain(
      "uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0",
    );
    expect(workflow).toContain("node-version-file: .nvmrc");
    expect(workflow).not.toContain("node-version: 24.x");
    expect(workflow).toContain("GITHUB_BASE_SHA:");
    expect(workflow).toContain("GITHUB_EVENT_BEFORE:");
    expect(workflow).toContain("run: pnpm check");
  });

  it("does not grant package write permission or publish", async () => {
    const workflow = await readFile(workflowPath, "utf8");

    expect(workflow).toContain("contents: read");
    expect(workflow).not.toContain("packages: write");
    expect(workflow).not.toMatch(/npm\s+(?:pub|publish)|changeset\s+publish/u);
  });

  it("never cancels or supersedes a main push quality gate", async () => {
    const workflow = await readFile(workflowPath, "utf8");

    expect(workflow).toContain(
      "github.event_name == 'push' && github.run_id || github.ref",
    );
    expect(workflow).toContain(
      "cancel-in-progress: ${{ github.event_name == 'pull_request' }}",
    );
  });
});
