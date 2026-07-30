import { execFileSync } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import readChangesets from "@changesets/read";

import { readChangesetPrereleaseState } from "./changeset-pre-state.mjs";
import {
  getReleaseChannelDecision,
  loadCompatibilityPolicy,
} from "./release-policy.mjs";
import { PACKAGE_POLICY } from "./workspace-policy.mjs";

const INITIAL_BOOTSTRAP_CHANGESET_ID = "quiet-chats-bootstrap";
const INITIAL_PUBLIC_VERSION = "0.1.0";
const INITIAL_VERSION_BASE = "0.0.0";

/** @param {string} file */
const fileExists = async (file) => {
  try {
    await access(file);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
};

/**
 * The repository was scaffolded with unpublished 0.1.0 manifests. Changesets
 * would otherwise apply the first queued minor release on top of that and
 * incorrectly create 0.2.0. The empty bootstrap changeset is a one-shot,
 * repository-owned signal: seed 0.0.0 only while every package is still at the
 * planned initial version and no package changelog exists.
 *
 * @param {string} rootDirectory
 * @param {readonly { id: string; releases: readonly unknown[] }[]} changesets
 * @param {{ mode: "pre" | "exit" } | undefined} prereleaseState
 * @returns {Promise<readonly { file: string; original: string }[]>}
 */
export async function seedInitialReleaseBase(
  rootDirectory,
  changesets,
  prereleaseState,
) {
  const bootstrapChangeset = changesets.find(
    ({ id }) => id === INITIAL_BOOTSTRAP_CHANGESET_ID,
  );
  if (bootstrapChangeset === undefined) {
    return [];
  }
  if (bootstrapChangeset.releases.length !== 0) {
    throw new Error(
      `${INITIAL_BOOTSTRAP_CHANGESET_ID} must remain an empty one-shot changeset.`,
    );
  }
  if (prereleaseState !== undefined) {
    throw new Error(
      `${INITIAL_BOOTSTRAP_CHANGESET_ID} cannot be consumed in Changesets prerelease mode.`,
    );
  }

  /** @type {{ file: string; original: string; manifest: Record<string, unknown> }[]} */
  const manifests = [];
  for (const [directory, { name }] of Object.entries(PACKAGE_POLICY)) {
    const packageDirectory = path.join(rootDirectory, "packages", directory);
    const file = path.join(packageDirectory, "package.json");
    const original = await readFile(file, "utf8");
    const manifest = JSON.parse(original);
    if (manifest.name !== name || manifest.version !== INITIAL_PUBLIC_VERSION) {
      throw new Error(
        `${INITIAL_BOOTSTRAP_CHANGESET_ID} requires ${name} to be unpublished at ${INITIAL_PUBLIC_VERSION}.`,
      );
    }
    if (await fileExists(path.join(packageDirectory, "CHANGELOG.md"))) {
      throw new Error(
        `${INITIAL_BOOTSTRAP_CHANGESET_ID} requires ${name} to have no existing changelog.`,
      );
    }
    manifests.push({ file, original, manifest });
  }

  /** @type {{ file: string; original: string }[]} */
  const seeded = [];
  try {
    for (const { file, original, manifest } of manifests) {
      await writeFile(
        file,
        `${JSON.stringify(
          { ...manifest, version: INITIAL_VERSION_BASE },
          null,
          2,
        )}\n`,
        "utf8",
      );
      seeded.push({ file, original });
    }
  } catch (error) {
    await Promise.all(
      seeded.map(({ file, original }) => writeFile(file, original, "utf8")),
    );
    throw error;
  }
  return seeded;
}

/**
 * @param {Parameters<typeof getReleaseChannelDecision>[0]} compatibility
 * @param {{ mode: "pre" | "exit"; tag?: string } | undefined} prereleaseState
 */
export function planReleaseVersionCommands(compatibility, prereleaseState) {
  const compatibilityDecision = getReleaseChannelDecision(
    compatibility,
    "latest",
  );
  if (!compatibilityDecision.allowed) {
    throw new Error(
      `release versioning is blocked by repository-owned compatibility evidence: ${compatibilityDecision.blockedBy.join(", ")}.`,
    );
  }
  if (prereleaseState?.mode === "pre" && prereleaseState.tag !== "next") {
    throw new Error("Changesets prerelease mode must use the next tag.");
  }
  return [["version"]];
}

export async function runReleaseVersioning() {
  const rootDirectory = process.cwd();
  const prereleaseState = await readChangesetPrereleaseState(rootDirectory);
  const commands = planReleaseVersionCommands(
    await loadCompatibilityPolicy(rootDirectory),
    prereleaseState,
  );
  const seededManifests = await seedInitialReleaseBase(
    rootDirectory,
    await readChangesets(rootDirectory),
    prereleaseState,
  );
  const changesetCli = path.join(
    rootDirectory,
    "node_modules",
    "@changesets",
    "cli",
    "bin.js",
  );
  try {
    for (const args of commands) {
      execFileSync(process.execPath, [changesetCli, ...args], {
        cwd: rootDirectory,
        stdio: "inherit",
      });
    }
  } catch (error) {
    await Promise.all(
      seededManifests.map(({ file, original }) =>
        writeFile(file, original, "utf8"),
      ),
    );
    throw error;
  }
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  pathToFileURL(path.resolve(invokedPath)).href === import.meta.url
) {
  try {
    await runReleaseVersioning();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
