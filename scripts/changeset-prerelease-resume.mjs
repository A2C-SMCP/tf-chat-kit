import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { validateChangesetPrereleaseState } from "./changeset-pre-state.mjs";
import { generateConsumedReleaseOutput } from "./changeset-release-output.mjs";
import { PACKAGE_POLICY } from "./workspace-policy.mjs";

/**
 * A cancelled stable-version commit can be undone without hand-editing a new
 * version. Prove the exact historical Changesets output and its exact inverse
 * before comparing against its prerelease input. All ordinary coverage checks
 * still run against that input; public source changes cannot share this step.
 * This only changes local validation, never Registry versions or immutable tags.
 *
 * @param {{rootDirectory: string; comparisonBase: string; changedFiles: readonly string[];
 * replayRelease?: typeof generateConsumedReleaseOutput}} input
 */
export async function resolvePrereleaseResumeBase({
  rootDirectory,
  comparisonBase,
  changedFiles,
  replayRelease = generateConsumedReleaseOutput,
}) {
  /** @param {string[]} args */
  const git = (args) =>
    execFileSync("git", args, {
      cwd: rootDirectory,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  /** @param {string} ref @param {string} file */
  const at = (ref, file) => {
    try {
      return git(["show", `${ref}:${file}`]);
    } catch {
      return undefined;
    }
  };
  /** @param {string} file */
  const current = async (file) => {
    try {
      return await readFile(path.join(rootDirectory, file), "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return undefined;
      throw error;
    }
  };
  const preFile = ".changeset/pre.json";
  if (at(comparisonBase, preFile) !== undefined) return undefined;
  const restoredPre = await current(preFile);
  if (restoredPre === undefined) return undefined;
  const metadata = Object.keys(PACKAGE_POLICY).flatMap((directory) => [
    `packages/${directory}/package.json`,
    `packages/${directory}/CHANGELOG.md`,
  ]);
  const publicChanges = changedFiles.filter((file) =>
    file.startsWith("packages/"),
  );
  if (!publicChanges.some((file) => metadata.includes(file))) return undefined;
  let restoresSameVersion = false;
  for (const directory of Object.keys(PACKAGE_POLICY)) {
    const file = `packages/${directory}/package.json`;
    const before = JSON.parse(at(comparisonBase, file) ?? "null");
    const after = JSON.parse((await current(file)) ?? "null");
    if (
      typeof before?.version === "string" &&
      typeof after?.version === "string" &&
      /^\d+\.\d+\.\d+-next\.\d+$/.test(after.version) &&
      after.version.split("-")[0] === before.version
    )
      restoresSameVersion = true;
  }
  if (!restoresSameVersion) return undefined;
  /** @param {boolean} condition @param {string} message */
  const requireProof = (condition, message) => {
    if (!condition)
      throw new Error(`Prerelease restoration rejected: ${message}`);
  };
  requireProof(
    publicChanges.every((file) => metadata.includes(file)),
    "public source changes must be delivered separately from restoration.",
  );
  const versionCommit = git([
    "log",
    "-1",
    "--format=%H",
    "--diff-filter=D",
    comparisonBase,
    "--",
    preFile,
  ]).trim();
  requireProof(
    /^[a-f0-9]{40}$/.test(versionCommit),
    "no historical prerelease exit found.",
  );
  const inputCommit = git(["rev-parse", `${versionCommit}^`]).trim();
  const inputPre = at(inputCommit, preFile);
  requireProof(
    inputPre !== undefined,
    "historical prerelease input is absent.",
  );
  const state = validateChangesetPrereleaseState(
    JSON.parse(inputPre ?? "null"),
  );
  requireProof(
    state.mode === "exit" && state.tag === "next",
    "historical input must exit next mode.",
  );
  requireProof(
    JSON.stringify(
      validateChangesetPrereleaseState(JSON.parse(restoredPre)),
    ) === JSON.stringify({ ...state, mode: "pre" }),
    "state must restore the original counters, consumed changesets and next tag.",
  );
  const generated = await replayRelease({
    rootDirectory,
    comparisonBase: inputCommit,
  });
  for (const [directory, { name }] of Object.entries(PACKAGE_POLICY)) {
    const manifestFile = `packages/${directory}/package.json`;
    const logFile = `packages/${directory}/CHANGELOG.md`;
    requireProof(
      JSON.stringify(JSON.parse(at(versionCommit, manifestFile) ?? "null")) ===
        JSON.stringify(generated.packageManifests[name]) &&
        at(versionCommit, logFile) === generated.changelogs[name],
      `historical ${name} output must exactly match pinned Changesets replay.`,
    );
  }
  const beforeChangesets = git([
    "ls-tree",
    "-r",
    "--name-only",
    inputCommit,
    "--",
    ".changeset",
  ])
    .trim()
    .split("\n")
    .filter((file) => file.endsWith(".md") && file !== ".changeset/README.md");
  const expectedPaths = [
    ...new Set([...generated.outputFiles, ...beforeChangesets]),
  ].sort();
  const actualPaths = git([
    "diff",
    "--no-renames",
    "--name-only",
    inputCommit,
    versionCommit,
    "--",
  ])
    .trim()
    .split("\n")
    .filter(Boolean)
    .sort();
  requireProof(
    JSON.stringify(actualPaths) === JSON.stringify(expectedPaths),
    "historical commit must contain only complete generated version output.",
  );
  for (const file of expectedPaths) {
    if (file === preFile) continue;
    requireProof(
      at(comparisonBase, file) === at(versionCommit, file),
      `later changes to ${file} cannot be undone.`,
    );
    requireProof(
      (await current(file)) === at(inputCommit, file),
      `${file} must be restored byte for byte.`,
    );
  }
  const remainingBaseChangesets = git([
    "ls-tree",
    "-r",
    "--name-only",
    comparisonBase,
    "--",
    ".changeset",
  ])
    .trim()
    .split("\n")
    .filter((file) => file.endsWith(".md") && file !== ".changeset/README.md");
  for (const file of remainingBaseChangesets) {
    requireProof(
      (await current(file)) === at(comparisonBase, file),
      `pending ${file} must remain unchanged.`,
    );
  }
  const allowedChangesets = new Set([
    ...beforeChangesets,
    ...remainingBaseChangesets,
    preFile,
  ]);
  requireProof(
    changedFiles
      .filter((file) => file.startsWith(".changeset/"))
      .every((file) => allowedChangesets.has(file)),
    "restoration cannot add unrelated changesets or change configuration.",
  );
  return inputCommit;
}
