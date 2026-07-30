import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { readChangesetPrereleaseState } from "./changeset-pre-state.mjs";
import {
  getReleaseChannelDecision,
  loadCompatibilityPolicy,
} from "./release-policy.mjs";

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
  const commands = planReleaseVersionCommands(
    await loadCompatibilityPolicy(rootDirectory),
    await readChangesetPrereleaseState(rootDirectory),
  );
  const changesetCli = path.join(
    rootDirectory,
    "node_modules",
    "@changesets",
    "cli",
    "bin.js",
  );
  for (const args of commands) {
    execFileSync(process.execPath, [changesetCli, ...args], {
      cwd: rootDirectory,
      stdio: "inherit",
    });
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
