import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolvePrereleaseResumeBase } from "../scripts/changeset-prerelease-resume.mjs";
import { PACKAGE_POLICY } from "../scripts/workspace-policy.mjs";

describe("exact historical prerelease restoration", () => {
  let root: string;
  let inputCommit: string;
  let comparisonBase: string;
  let generated: {
    outputFiles: string[];
    packageManifests: Record<string, Record<string, unknown>>;
    changelogs: Record<string, string>;
  };
  let original: Record<string, string>;
  let pre: Record<string, unknown>;
  const preFile = ".changeset/pre.json";
  const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const write = async (file: string, value: string) => {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), value);
  };
  const commit = (message: string) => {
    git("add", "--all");
    git("commit", "-m", message);
    return git("rev-parse", "HEAD");
  };
  const resolve = () =>
    resolvePrereleaseResumeBase({
      rootDirectory: root,
      comparisonBase,
      changedFiles: [
        ...new Set([
          ...git("diff", "--name-only", comparisonBase).split("\n"),
          ...git("ls-files", "--others", "--exclude-standard").split("\n"),
        ]),
      ].filter(Boolean),
      replayRelease: async () => generated,
    });

  beforeEach(async () => {
    root = await mkdtemp(
      path.join(os.tmpdir(), "tfck-prerelease-resume-test-"),
    );
    git("init", "--initial-branch=main");
    git("config", "user.email", "fixture@example.invalid");
    git("config", "user.name", "Fixture");
    generated = {
      outputFiles: [preFile],
      packageManifests: {},
      changelogs: {},
    };
    original = {};
    pre = {
      mode: "exit",
      tag: "next",
      initialVersions: Object.fromEntries(
        Object.values(PACKAGE_POLICY).map(({ name }) => [
          name,
          name.endsWith("chat-auth") ? "0.11.0" : "0.9.0",
        ]),
      ),
      changesets: ["old"],
    };
    original[preFile] = json(pre);
    original[".changeset/old.md"] =
      '---\n"@turingfocus/chat-kit": minor\n---\nOld change.\n';
    original[".changeset/pending.md"] =
      '---\n"@turingfocus/chat-ui-antd": patch\n---\nPending change.\n';
    for (const [directory, { name }] of Object.entries(PACKAGE_POLICY)) {
      const manifestFile = `packages/${directory}/package.json`;
      const logFile = `packages/${directory}/CHANGELOG.md`;
      original[manifestFile] = json({
        name,
        version: directory === "chat-auth" ? "0.12.0-next.1" : "0.10.0-next.4",
      });
      original[logFile] = "# Previous prerelease\n";
      generated.packageManifests[name] = {
        name,
        version: directory === "chat-auth" ? "0.12.0" : "0.10.0",
      };
      generated.changelogs[name] = "# Stable release\n# Previous prerelease\n";
      generated.outputFiles.push(manifestFile, logFile);
    }
    for (const [file, value] of Object.entries(original))
      await write(file, value);
    inputCommit = commit("prerelease exit input");
    for (const [directory, { name }] of Object.entries(PACKAGE_POLICY)) {
      await write(
        `packages/${directory}/package.json`,
        json(generated.packageManifests[name]),
      );
      await write(
        `packages/${directory}/CHANGELOG.md`,
        generated.changelogs[name]!,
      );
    }
    for (const file of [preFile, ".changeset/old.md", ".changeset/pending.md"])
      await rm(path.join(root, file));
    commit("generated stable version");
    await write(
      ".changeset/fresh.md",
      '---\n"@turingfocus/chat-kit": minor\n---\nFresh feature.\n',
    );
    comparisonBase = commit("subsequent feature keeps pending changeset");
    for (const [file, value] of Object.entries(original))
      await write(file, value);
    await write(preFile, json({ ...pre, mode: "pre" }));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("returns the exact historical input after proving generated output and its byte-for-byte inverse", async () => {
    expect(await resolve()).toBe(inputCommit);
  });

  it("rejects source changes, including untracked files", async () => {
    await write(
      "packages/chat-kit/src/surprise.ts",
      "export const surprise = true;\n",
    );
    await expect(resolve()).rejects.toThrow("public source changes");
  });

  it("rejects hand-edited versions and changelogs", async () => {
    await write(
      "packages/chat-kit/package.json",
      json({ name: "@turingfocus/chat-kit", version: "0.10.0-next.99" }),
    );
    await expect(resolve()).rejects.toThrow("byte for byte");
  });

  it("rejects historical output that the pinned replay did not generate", async () => {
    generated.changelogs["@turingfocus/chat-kit"] = "Forged output\n";
    await expect(resolve()).rejects.toThrow("pinned Changesets replay");
  });

  it("cannot undo metadata changed after the stable version commit", async () => {
    git("restore", "--worktree", "--", ".");
    for (const file of [preFile, ".changeset/old.md", ".changeset/pending.md"])
      await rm(path.join(root, file));
    await write("packages/chat-kit/CHANGELOG.md", "Later changelog\n");
    comparisonBase = commit("later metadata");
    for (const [file, value] of Object.entries(original))
      await write(file, value);
    await write(preFile, json({ ...pre, mode: "pre" }));
    await expect(resolve()).rejects.toThrow("later changes");
  });

  it("rejects altered counters and consumed identities", async () => {
    await write(preFile, json({ ...pre, mode: "pre", changesets: [] }));
    await expect(resolve()).rejects.toThrow("original counters");
  });

  it("preserves new pending changesets", async () => {
    await write(".changeset/fresh.md", "Changed feature\n");
    await expect(resolve()).rejects.toThrow("pending .changeset/fresh.md");
  });

  it("rejects modified historical changesets and unrelated new entries", async () => {
    await write(".changeset/old.md", "Altered history\n");
    await expect(resolve()).rejects.toThrow("byte for byte");
    await write(".changeset/old.md", original[".changeset/old.md"]!);
    await write(".changeset/extra.md", "Unrelated entry\n");
    await expect(resolve()).rejects.toThrow("unrelated changesets");
  });

  it("does not change normal checks when the comparison base already has prerelease state", async () => {
    comparisonBase = inputCommit;
    expect(await resolve()).toBeUndefined();
  });

  it("does not activate when prerelease state is absent", async () => {
    await rm(path.join(root, preFile));
    expect(await resolve()).toBeUndefined();
  });

  it("keeps normal forward prerelease versioning on the ordinary validation path", async () => {
    for (const [directory, { name }] of Object.entries(PACKAGE_POLICY))
      await write(
        `packages/${directory}/package.json`,
        json({
          name,
          version:
            directory === "chat-auth" ? "0.13.0-next.0" : "0.11.0-next.0",
        }),
      );
    await write(preFile, json({ ...pre, mode: "pre", changesets: [] }));
    expect(await resolve()).toBeUndefined();
  });
});
