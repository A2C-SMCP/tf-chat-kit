import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { PACKAGE_POLICY } from "./workspace-policy.mjs";

/** @param {string} rootDirectory @param {string[]} args */
const runGit = (rootDirectory, args) =>
  execFileSync("git", args, {
    cwd: rootDirectory,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

/**
 * List tracked and untracked files changed in a worktree. Porcelain `-z`
 * keeps paths unquoted and unambiguous while `--no-renames` guarantees one
 * path per record.
 *
 * @param {string} rootDirectory
 * @param {string} pathspec
 */
const listChangedFiles = (rootDirectory, pathspec) =>
  execFileSync(
    "git",
    [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
      "--no-renames",
      "-z",
      "--",
      pathspec,
    ],
    {
      cwd: rootDirectory,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  )
    .split("\0")
    .filter(Boolean)
    .map((record) => record.slice(3));

/**
 * Generate the authoritative release output by running the pinned Changesets
 * CLI against an isolated worktree at the comparison base. Changesets consumes
 * every pending changeset in that tree, so the replay must preserve the base
 * exactly; pruning it to the deletions under review would let a hand-crafted
 * partial version commit validate against an input the real CLI never sees.
 *
 * @param {{
 *   rootDirectory: string;
 *   comparisonBase: string;
 * }} input
 * @returns {Promise<{
 *   outputFiles: string[];
 *   packageManifests: Record<string, Record<string, unknown>>;
 *   changelogs: Record<string, string>;
 * }>}
 */
export async function generateConsumedReleaseOutput({
  rootDirectory,
  comparisonBase,
}) {
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "tf-chat-kit-changesets-"),
  );
  let worktreeAdded = false;
  try {
    runGit(rootDirectory, [
      "worktree",
      "add",
      "--detach",
      temporaryDirectory,
      comparisonBase,
    ]);
    worktreeAdded = true;
    await symlink(
      path.join(rootDirectory, "node_modules"),
      path.join(temporaryDirectory, "node_modules"),
      "dir",
    );

    execFileSync(
      path.join(rootDirectory, "node_modules", ".bin", "changeset"),
      ["version"],
      {
        cwd: temporaryDirectory,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    const outputFiles = listChangedFiles(temporaryDirectory, "packages");
    /** @type {Record<string, Record<string, unknown>>} */
    const packageManifests = {};
    /** @type {Record<string, string>} */
    const changelogs = {};
    for (const [directory, { name }] of Object.entries(PACKAGE_POLICY)) {
      packageManifests[name] = JSON.parse(
        await readFile(
          path.join(temporaryDirectory, "packages", directory, "package.json"),
          "utf8",
        ),
      );
      changelogs[name] = await readFile(
        path.join(temporaryDirectory, "packages", directory, "CHANGELOG.md"),
        "utf8",
      );
    }

    return { outputFiles, packageManifests, changelogs };
  } finally {
    if (worktreeAdded) {
      try {
        runGit(rootDirectory, [
          "worktree",
          "remove",
          "--force",
          temporaryDirectory,
        ]);
      } catch {
        await rm(temporaryDirectory, { recursive: true, force: true });
        runGit(rootDirectory, ["worktree", "prune"]);
      }
    } else {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }
}
