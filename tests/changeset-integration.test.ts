import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { generateConsumedReleaseOutput } from "../scripts/changeset-release-output.mjs";
import { PACKAGE_POLICY } from "../scripts/workspace-policy.mjs";

const workspaceRoot = process.cwd();
const changesetExecutable = path.join(
  workspaceRoot,
  "node_modules",
  ".bin",
  "changeset",
);
const checkChangesetsScript = path.join(
  workspaceRoot,
  "scripts",
  "check-changesets.mjs",
);
const versionReleaseScript = path.join(
  workspaceRoot,
  "scripts",
  "version-release.mjs",
);
const packageEntries = Object.entries(PACKAGE_POLICY);

const runGit = (rootDirectory: string, args: string[]) =>
  execFileSync("git", args, {
    cwd: rootDirectory,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

const writeJson = (file: string, value: unknown) =>
  writeFile(file, `${JSON.stringify(value, null, 2)}\n`);

type ReleaseFixture = {
  baseCommit: string;
  directory: string;
};

async function createReleaseFixture(): Promise<ReleaseFixture> {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "tf-chat-kit-release-integration-"),
  );
  await mkdir(path.join(directory, ".changeset"), { recursive: true });
  await mkdir(path.join(directory, "packages"), { recursive: true });
  await mkdir(path.join(directory, "release"), { recursive: true });
  await symlink(
    path.join(workspaceRoot, "node_modules"),
    path.join(directory, "node_modules"),
    "dir",
  );

  await writeJson(path.join(directory, "package.json"), {
    name: "changeset-integration-fixture",
    version: "0.0.0",
    private: true,
    packageManager: "pnpm@10.34.5",
  });
  await writeFile(path.join(directory, ".gitignore"), "node_modules\n");
  await writeFile(
    path.join(directory, "pnpm-workspace.yaml"),
    "packages:\n  - packages/*\n",
  );
  await writeJson(path.join(directory, ".changeset", "config.json"), {
    $schema: "https://unpkg.com/@changesets/config/schema.json",
    changelog: "@changesets/cli/changelog",
    commit: false,
    fixed: [packageEntries.map(([, { name }]) => name)],
    linked: [],
    access: "public",
    baseBranch: "main",
    updateInternalDependencies: "patch",
    bumpVersionsWithWorkspaceProtocolOnly: true,
    ignore: [],
  });
  const compatibility = JSON.parse(
    await readFile(
      path.join(workspaceRoot, "release", "compatibility.json"),
      "utf8",
    ),
  ) as {
    server: { evidence: string };
    consumers: Record<string, { evidence?: string }>;
  };
  await writeJson(
    path.join(directory, "release", "compatibility.json"),
    compatibility,
  );
  const evidenceFiles = [
    compatibility.server.evidence,
    ...Object.values(compatibility.consumers).flatMap(({ evidence }) =>
      evidence ? [evidence] : [],
    ),
  ];
  for (const evidence of evidenceFiles) {
    const target = path.join(directory, evidence);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `# Fixture evidence for ${evidence}\n`);
  }
  await writeFile(
    path.join(directory, ".changeset", "first-release.md"),
    '---\n"@turingfocus/chat-runtime": minor\n---\n\nCreate the first fixed-group release.\n',
  );
  await writeFile(
    path.join(directory, ".changeset", "quiet-chats-bootstrap.md"),
    "---\n---\n\nRecord the initial unpublished six-package workspace bootstrap.\n",
  );

  for (const [packageDirectory, { name }] of packageEntries) {
    const packagePath = path.join(directory, "packages", packageDirectory);
    await mkdir(packagePath, { recursive: true });
    await writeJson(path.join(packagePath, "package.json"), {
      name,
      version: "0.1.0",
    });
  }

  runGit(directory, ["init", "--initial-branch=main"]);
  runGit(directory, ["config", "user.name", "Changeset Integration"]);
  runGit(directory, [
    "config",
    "user.email",
    "changeset-integration@example.com",
  ]);
  runGit(directory, ["add", "."]);
  runGit(directory, ["commit", "-m", "add pending changeset"]);

  return { directory, baseCommit: runGit(directory, ["rev-parse", "HEAD"]) };
}

const expectedInitialReleaseFiles = packageEntries
  .map(([directory]) => `packages/${directory}/CHANGELOG.md`)
  .sort();

describe("changeset release integration", () => {
  it("models first-release changelogs that Changesets creates as untracked files", async () => {
    const fixture = await createReleaseFixture();
    try {
      const output = await generateConsumedReleaseOutput({
        rootDirectory: fixture.directory,
        comparisonBase: fixture.baseCommit,
      });

      expect([...output.outputFiles].sort()).toEqual(
        expectedInitialReleaseFiles,
      );
      for (const [, { name }] of packageEntries) {
        expect(output.packageManifests[name]).toMatchObject({
          version: "0.1.0",
        });
        expect(output.changelogs[name]).toContain(`# ${name}`);
        expect(output.changelogs[name]).toContain("## 0.1.0");
      }
      expect(
        runGit(fixture.directory, ["worktree", "list", "--porcelain"]),
      ).not.toContain("tf-chat-kit-changesets-");
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  }, 30_000);

  it("accepts a version branch that consumes a target-branch changeset", async () => {
    const fixture = await createReleaseFixture();
    try {
      execFileSync(process.execPath, [versionReleaseScript], {
        cwd: fixture.directory,
        stdio: ["ignore", "pipe", "pipe"],
      });
      for (const [packageDirectory] of packageEntries) {
        const packageDirectoryPath = path.join(
          fixture.directory,
          "packages",
          packageDirectory,
        );
        expect(
          JSON.parse(
            await readFile(
              path.join(packageDirectoryPath, "package.json"),
              "utf8",
            ),
          ),
        ).toMatchObject({
          version: "0.1.0",
        });
        expect(
          await readFile(
            path.join(packageDirectoryPath, "CHANGELOG.md"),
            "utf8",
          ),
        ).toContain("## 0.1.0");
      }
      runGit(fixture.directory, ["add", "--all"]);
      runGit(fixture.directory, ["commit", "-m", "version packages"]);

      const result = spawnSync(process.execPath, [checkChangesetsScript], {
        cwd: fixture.directory,
        encoding: "utf8",
        env: {
          ...process.env,
          CHANGESET_BASE_REF: fixture.baseCommit,
          CI: "false",
          GITHUB_ACTIONS: "false",
        },
      });

      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      expect(result.stdout).toContain("Changeset coverage passed against");
      expect(
        runGit(fixture.directory, ["worktree", "list", "--porcelain"]),
      ).not.toContain("tf-chat-kit-changesets-");
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  }, 30_000);

  it("applies the unpublished 0.1.0 bootstrap only once", async () => {
    const fixture = await createReleaseFixture();
    try {
      execFileSync(process.execPath, [versionReleaseScript], {
        cwd: fixture.directory,
        stdio: ["ignore", "pipe", "pipe"],
      });
      runGit(fixture.directory, ["add", "--all"]);
      runGit(fixture.directory, ["commit", "-m", "release 0.1.0"]);

      await writeFile(
        path.join(fixture.directory, ".changeset", "second-release.md"),
        '---\n"@turingfocus/chat-runtime": minor\n---\n\nCreate the next fixed-group release.\n',
      );
      execFileSync(process.execPath, [versionReleaseScript], {
        cwd: fixture.directory,
        stdio: ["ignore", "pipe", "pipe"],
      });

      for (const [packageDirectory] of packageEntries) {
        expect(
          JSON.parse(
            await readFile(
              path.join(
                fixture.directory,
                "packages",
                packageDirectory,
                "package.json",
              ),
              "utf8",
            ),
          ),
        ).toMatchObject({
          version: "0.2.0",
        });
      }
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  }, 30_000);

  it("fails closed when the initial bootstrap no longer matches repository state", async () => {
    const fixture = await createReleaseFixture();
    try {
      const runtimeDirectory = path.join(
        fixture.directory,
        "packages",
        "chat-runtime",
      );
      await writeFile(
        path.join(runtimeDirectory, "CHANGELOG.md"),
        "# @turingfocus/chat-runtime\n",
      );

      const result = spawnSync(process.execPath, [versionReleaseScript], {
        cwd: fixture.directory,
        encoding: "utf8",
      });

      expect(result.status).toBe(1);
      expect(`${result.stdout}${result.stderr}`).toContain(
        "quiet-chats-bootstrap requires @turingfocus/chat-runtime to have no existing changelog",
      );
      expect(
        JSON.parse(
          await readFile(path.join(runtimeDirectory, "package.json"), "utf8"),
        ),
      ).toMatchObject({
        version: "0.1.0",
      });
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  }, 30_000);

  it("rejects unrelated files in a Changesets version commit", async () => {
    const fixture = await createReleaseFixture();
    try {
      execFileSync(changesetExecutable, ["version"], {
        cwd: fixture.directory,
        stdio: ["ignore", "pipe", "pipe"],
      });
      await mkdir(path.join(fixture.directory, ".github", "workflows"), {
        recursive: true,
      });
      await writeFile(
        path.join(fixture.directory, ".github", "workflows", "ci.yml"),
        "unexpected: release-side edit\n",
      );
      runGit(fixture.directory, ["add", "--all"]);
      runGit(fixture.directory, ["commit", "-m", "mix release output"]);

      const result = spawnSync(process.execPath, [checkChangesetsScript], {
        cwd: fixture.directory,
        encoding: "utf8",
        env: {
          ...process.env,
          CHANGESET_BASE_REF: fixture.baseCommit,
          CI: "false",
          GITHUB_ACTIONS: "false",
        },
      });

      expect(result.status).toBe(1);
      expect(`${result.stdout}${result.stderr}`).toContain(
        "and contain no other files",
      );
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  }, 30_000);

  it("rejects a hand-crafted version commit that consumes only part of the base changesets", async () => {
    const fixture = await createReleaseFixture();
    const secondChangeset = path.join(
      fixture.directory,
      ".changeset",
      "second-release.md",
    );
    const secondChangesetContent = [
      "---",
      '"@turingfocus/chat-ui-antd": minor',
      "---",
      "",
      "Add a second pending public change.",
      "",
    ].join("\n");

    try {
      await writeFile(secondChangeset, secondChangesetContent);
      runGit(fixture.directory, ["add", ".changeset/second-release.md"]);
      runGit(fixture.directory, ["commit", "-m", "add second changeset"]);
      const comparisonBase = runGit(fixture.directory, ["rev-parse", "HEAD"]);

      await rm(secondChangeset);
      execFileSync(changesetExecutable, ["version"], {
        cwd: fixture.directory,
        stdio: ["ignore", "pipe", "pipe"],
      });
      await writeFile(secondChangeset, secondChangesetContent);
      runGit(fixture.directory, ["add", "--all"]);
      runGit(fixture.directory, ["commit", "-m", "partially version packages"]);

      const result = spawnSync(process.execPath, [checkChangesetsScript], {
        cwd: fixture.directory,
        encoding: "utf8",
        env: {
          ...process.env,
          CHANGESET_BASE_REF: comparisonBase,
          CI: "false",
          GITHUB_ACTIONS: "false",
        },
      });

      expect(result.status).toBe(1);
      expect(`${result.stdout}${result.stderr}`).toMatch(
        /CHANGELOG\.md must exactly match Changesets output|expected .*second-release/u,
      );
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  }, 30_000);

  it("rejects restoring one changeset after generating output from the full base set", async () => {
    const fixture = await createReleaseFixture();
    const secondChangeset = path.join(
      fixture.directory,
      ".changeset",
      "second-release.md",
    );
    const secondChangesetContent = [
      "---",
      '"@turingfocus/chat-ui-antd": minor',
      "---",
      "",
      "Add a second pending public change.",
      "",
    ].join("\n");

    try {
      await writeFile(secondChangeset, secondChangesetContent);
      runGit(fixture.directory, ["add", ".changeset/second-release.md"]);
      runGit(fixture.directory, ["commit", "-m", "add second changeset"]);
      const comparisonBase = runGit(fixture.directory, ["rev-parse", "HEAD"]);

      execFileSync(changesetExecutable, ["version"], {
        cwd: fixture.directory,
        stdio: ["ignore", "pipe", "pipe"],
      });
      await writeFile(secondChangeset, secondChangesetContent);
      runGit(fixture.directory, ["add", "--all"]);
      runGit(fixture.directory, [
        "commit",
        "-m",
        "restore one consumed changeset",
      ]);

      const result = spawnSync(process.execPath, [checkChangesetsScript], {
        cwd: fixture.directory,
        encoding: "utf8",
        env: {
          ...process.env,
          CHANGESET_BASE_REF: comparisonBase,
          CI: "false",
          GITHUB_ACTIONS: "false",
        },
      });

      expect(result.status).toBe(1);
      expect(`${result.stdout}${result.stderr}`).toContain(
        "consumed release must delete every changeset pending at the comparison base",
      );
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  }, 30_000);

  it("treats a tracked source file changed to a symlink as a public package change", async () => {
    const fixture = await createReleaseFixture();
    const runtimeSourceDirectory = path.join(
      fixture.directory,
      "packages",
      "chat-runtime",
      "src",
    );
    const runtimeSource = path.join(runtimeSourceDirectory, "index.ts");

    try {
      await mkdir(runtimeSourceDirectory, { recursive: true });
      await writeFile(runtimeSource, "export const runtime = true;\n");
      runGit(fixture.directory, ["add", "packages/chat-runtime/src/index.ts"]);
      runGit(fixture.directory, ["commit", "-m", "add runtime source"]);
      const comparisonBase = runGit(fixture.directory, ["rev-parse", "HEAD"]);

      await rm(runtimeSource);
      await symlink("../package.json", runtimeSource);
      runGit(fixture.directory, ["add", "packages/chat-runtime/src/index.ts"]);
      runGit(fixture.directory, [
        "commit",
        "-m",
        "replace source with symlink",
      ]);

      const result = spawnSync(process.execPath, [checkChangesetsScript], {
        cwd: fixture.directory,
        encoding: "utf8",
        env: {
          ...process.env,
          CHANGESET_BASE_REF: comparisonBase,
          CI: "false",
          GITHUB_ACTIONS: "false",
        },
      });

      expect(result.status).toBe(1);
      expect(`${result.stdout}${result.stderr}`).toContain(
        "public package changes require a new changeset",
      );
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  }, 30_000);
});
