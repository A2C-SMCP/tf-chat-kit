import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

import parseChangeset from "@changesets/parse";
import readChangesets from "@changesets/read";

import {
  readChangesetPrereleaseState,
  unconsumedChangesets,
  validateChangesetPrereleaseState,
} from "./changeset-pre-state.mjs";
import { selectGithubComparisonBase } from "./changeset-base.mjs";
import { validateChangesetCoverage } from "./changeset-policy.mjs";
import { generateConsumedReleaseOutput } from "./changeset-release-output.mjs";
import { assembleWorkspaceReleasePlan } from "./changeset-release-plan.mjs";
import { PACKAGE_POLICY } from "./workspace-policy.mjs";

const rootDirectory = process.cwd();

/**
 * @param {string[]} args
 * @returns {string}
 */
const runGit = (args) =>
  execFileSync("git", args, {
    cwd: rootDirectory,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

/**
 * @param {string} ref
 * @returns {boolean}
 */
const refExists = (ref) => {
  try {
    runGit(["rev-parse", "--verify", `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
};

/**
 * @param {string} ref
 * @returns {string}
 */
const resolveCommit = (ref) => runGit(["rev-parse", `${ref}^{commit}`]);

/**
 * @param {string} ref
 * @returns {boolean}
 */
const treeExists = (ref) => {
  try {
    runGit(["cat-file", "-e", `${ref}^{tree}`]);
    return true;
  } catch {
    return false;
  }
};

/**
 * @param {string} ref
 * @param {string} file
 * @returns {boolean}
 */
const fileExistsAtRef = (ref, file) => {
  try {
    runGit(["cat-file", "-e", `${ref}:${file}`]);
    return true;
  } catch {
    return false;
  }
};

/** @returns {string} */
const resolveHeadParent = () => {
  if (!refExists("HEAD^")) {
    throw new Error(
      "Cannot validate local main without its parent commit. Set CHANGESET_BASE_REF explicitly.",
    );
  }
  return resolveCommit("HEAD^");
};

/** @returns {string} */
function resolveComparisonBase() {
  const githubBase = selectGithubComparisonBase(process.env);
  if (githubBase) {
    if (!treeExists(githubBase.ref)) {
      throw new Error(
        `${githubBase.source} does not exist in the checkout: ${githubBase.ref}. Ensure GitHub Actions checks out complete history.`,
      );
    }
    return githubBase.strategy === "merge-base"
      ? runGit(["merge-base", githubBase.ref, "HEAD"])
      : githubBase.ref;
  }

  const explicitBase = process.env["CHANGESET_BASE_REF"];
  if (explicitBase) {
    if (!refExists(explicitBase)) {
      throw new Error(
        `CHANGESET_BASE_REF does not resolve to a commit: ${explicitBase}`,
      );
    }
    return runGit(["merge-base", explicitBase, "HEAD"]);
  }

  if (process.env["CI"] === "true") {
    throw new Error(
      "CI outside the supported GitHub Actions events must set CHANGESET_BASE_REF to the target branch ref.",
    );
  }

  const head = resolveCommit("HEAD");
  const mainRefs = ["origin/main", "main"].filter(refExists);
  const headIsMain = mainRefs.some((ref) => resolveCommit(ref) === head);
  if (headIsMain) return resolveHeadParent();

  const baseRef = mainRefs[0];
  if (!baseRef) {
    throw new Error(
      "Cannot find origin/main or main. Set CHANGESET_BASE_REF to the target branch ref.",
    );
  }
  return runGit(["merge-base", baseRef, "HEAD"]);
}

/**
 * @param {string} output
 * @returns {string[]}
 */
const lines = (output) => output.split("\n").filter(Boolean);

/**
 * @param {string} file
 * @returns {boolean}
 */
const isChangesetFile = (file) =>
  file.startsWith(".changeset/") &&
  file.endsWith(".md") &&
  file.toLowerCase() !== ".changeset/readme.md";

/**
 * @param {string} ref
 * @param {string} file
 */
const readChangesetAtRef = (ref, file) => ({
  ...parseChangeset(runGit(["show", `${ref}:${file}`])),
  id: file.slice(".changeset/".length, -".md".length),
});

/** @param {string} ref */
const readPrereleaseStateAtRef = (ref) =>
  fileExistsAtRef(ref, ".changeset/pre.json")
    ? validateChangesetPrereleaseState(
        JSON.parse(runGit(["show", `${ref}:.changeset/pre.json`])),
      )
    : undefined;

/**
 * @typedef {{
 *   name: string;
 *   version: string;
 *   dependencies?: Record<string, string>;
 *   devDependencies?: Record<string, string>;
 *   optionalDependencies?: Record<string, string>;
 *   peerDependencies?: Record<string, string>;
 *   [key: string]: unknown;
 * }} ReleasePackageManifest
 */

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {ReleasePackageManifest}
 */
const requireReleaseManifest = (value, label) => {
  if (
    typeof value !== "object" ||
    value === null ||
    !("name" in value) ||
    typeof value.name !== "string" ||
    !("version" in value) ||
    typeof value.version !== "string"
  ) {
    throw new Error(`${label} must contain string name and version fields.`);
  }
  return /** @type {ReleasePackageManifest} */ (value);
};

/** @param {string} file */
const readCurrentManifest = async (file) =>
  requireReleaseManifest(
    JSON.parse(await readFile(path.join(rootDirectory, file), "utf8")),
    file,
  );

/**
 * @param {string} ref
 * @param {string} file
 */
const readManifestAtRef = (ref, file) =>
  requireReleaseManifest(
    JSON.parse(runGit(["show", `${ref}:${file}`])),
    `${ref}:${file}`,
  );

/** @returns {Promise<Record<string, ReleasePackageManifest>>} */
const readCurrentPackageManifests = async () =>
  Object.fromEntries(
    await Promise.all(
      Object.entries(PACKAGE_POLICY).map(async ([directory, { name }]) => [
        name,
        await readCurrentManifest(`packages/${directory}/package.json`),
      ]),
    ),
  );

/**
 * @param {string} ref
 * @returns {Record<string, ReleasePackageManifest>}
 */
const readPackageManifestsAtRef = (ref) =>
  Object.fromEntries(
    Object.entries(PACKAGE_POLICY)
      .filter(([directory]) =>
        fileExistsAtRef(ref, `packages/${directory}/package.json`),
      )
      .map(([directory, { name }]) => [
        name,
        readManifestAtRef(ref, `packages/${directory}/package.json`),
      ]),
  );

/** @returns {Promise<Record<string, string>>} */
const readCurrentChangelogs = async () =>
  Object.fromEntries(
    await Promise.all(
      Object.entries(PACKAGE_POLICY).map(async ([directory, { name }]) => {
        try {
          return [
            name,
            await readFile(
              path.join(rootDirectory, "packages", directory, "CHANGELOG.md"),
              "utf8",
            ),
          ];
        } catch (error) {
          if (
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          ) {
            return [name, ""];
          }
          throw error;
        }
      }),
    ),
  );

try {
  const comparisonBase = resolveComparisonBase();
  const trackedChanges = lines(
    runGit(["diff", "--no-renames", "--name-only", comparisonBase, "--"]),
  );
  const untrackedFiles = lines(
    runGit(["ls-files", "--others", "--exclude-standard"]),
  );
  const changedFiles = [...new Set([...trackedChanges, ...untrackedFiles])];
  const trackedAddedChangesets = lines(
    runGit([
      "diff",
      "--name-only",
      "--diff-filter=A",
      comparisonBase,
      "--",
      ".changeset",
    ]),
  );
  const addedChangesetFiles = [
    ...new Set([
      ...trackedAddedChangesets,
      ...untrackedFiles.filter((file) => file.startsWith(".changeset/")),
    ]),
  ];
  const addedChangesetPaths = new Set(addedChangesetFiles);
  const allChangesets = await readChangesets(rootDirectory);
  const currentPrereleaseState =
    await readChangesetPrereleaseState(rootDirectory);
  const pendingChangesets = unconsumedChangesets(
    allChangesets,
    currentPrereleaseState,
  );
  const addedChangesets = pendingChangesets.filter(({ id }) =>
    addedChangesetPaths.has(`.changeset/${id}.md`),
  );
  const deletedChangesetIds = lines(
    runGit([
      "diff",
      "--no-renames",
      "--name-only",
      "--diff-filter=D",
      comparisonBase,
      "--",
      ".changeset",
    ]),
  )
    .filter(isChangesetFile)
    .map((file) => file.slice(".changeset/".length, -".md".length));
  const basePrereleaseState = readPrereleaseStateAtRef(comparisonBase);
  const basePrereleaseChangesets = new Set(
    basePrereleaseState?.changesets ?? [],
  );
  const prereleaseConsumedIds = (
    currentPrereleaseState?.changesets ?? []
  ).filter((id) => !basePrereleaseChangesets.has(id));
  const consumedChangesetIds = [
    ...new Set([...deletedChangesetIds, ...prereleaseConsumedIds]),
  ];
  const consumedChangesets = consumedChangesetIds.map((id) =>
    readChangesetAtRef(comparisonBase, `.changeset/${id}.md`),
  );
  const baseChangesetIds = lines(
    runGit([
      "ls-tree",
      "-r",
      "--name-only",
      comparisonBase,
      "--",
      ".changeset",
    ]),
  )
    .filter(isChangesetFile)
    .map((file) => file.slice(".changeset/".length, -".md".length));
  const expectedConsumedChangesetIds =
    currentPrereleaseState?.mode === "pre"
      ? baseChangesetIds.filter((id) => !basePrereleaseChangesets.has(id))
      : baseChangesetIds;
  const isInitialWorkspaceBootstrap = Object.keys(PACKAGE_POLICY).every(
    (directory) =>
      !fileExistsAtRef(comparisonBase, `packages/${directory}/package.json`),
  );
  const currentRootManifest = await readCurrentManifest("package.json");
  const currentPackageManifests = await readCurrentPackageManifests();
  const pendingReleasePlan = await assembleWorkspaceReleasePlan({
    rootDirectory,
    rootManifest: currentRootManifest,
    packageManifests: currentPackageManifests,
    changesets: pendingChangesets,
    ...(currentPrereleaseState
      ? { prereleaseState: currentPrereleaseState }
      : {}),
  });
  const basePackageManifests = isInitialWorkspaceBootstrap
    ? {}
    : readPackageManifestsAtRef(comparisonBase);
  /** @type {{
   *   outputFiles: string[];
   *   packageManifests: Record<string, Record<string, unknown>>;
   *   changelogs: Record<string, string>;
   * }} */
  const expectedConsumedReleaseOutput =
    consumedChangesets.length === 0
      ? { outputFiles: [], packageManifests: {}, changelogs: {} }
      : await generateConsumedReleaseOutput({
          rootDirectory,
          comparisonBase,
        });
  const consumedReleasePlan =
    consumedChangesets.length === 0
      ? { releases: [] }
      : {
          releases: Object.values(PACKAGE_POLICY).map(({ name }) => ({
            name,
            type: /** @type {const} */ ("patch"),
            oldVersion: String(basePackageManifests[name]?.["version"]),
            newVersion: String(
              expectedConsumedReleaseOutput.packageManifests[name]?.["version"],
            ),
            changesets: consumedChangesets.map(({ id }) => id),
          })),
        };
  const errors = validateChangesetCoverage({
    changedFiles,
    addedChangesets,
    pendingChangesets,
    consumedChangesets,
    consumedChangesetDeletionIds: deletedChangesetIds,
    expectedConsumedChangesetIds,
    pendingReleasePlan,
    consumedReleasePlan,
    basePackageManifests,
    currentPackageManifests,
    expectedPackageManifests: expectedConsumedReleaseOutput.packageManifests,
    currentChangelogs: await readCurrentChangelogs(),
    expectedChangelogs: expectedConsumedReleaseOutput.changelogs,
    expectedReleaseOutputFiles: expectedConsumedReleaseOutput.outputFiles,
    isInitialWorkspaceBootstrap,
  });

  if (errors.length > 0) {
    throw new Error(errors.map((error) => `- ${error}`).join("\n"));
  }

  console.log(
    `Changeset coverage passed against ${comparisonBase.slice(0, 12)}.`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
