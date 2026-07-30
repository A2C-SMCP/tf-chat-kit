import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * @typedef {{
 *   mode: "pre" | "exit";
 *   tag: string;
 *   changesets: string[];
 *   initialVersions: Record<string, string>;
 * }} ChangesetPrereleaseState
 */

/** @param {unknown} value @returns {ChangesetPrereleaseState} */
export function validateChangesetPrereleaseState(value) {
  if (typeof value !== "object" || value === null) {
    throw new Error(".changeset/pre.json has an invalid prerelease state.");
  }
  const state = /** @type {Record<string, unknown>} */ (value);
  if (
    (state["mode"] !== "pre" && state["mode"] !== "exit") ||
    typeof state["tag"] !== "string" ||
    !Array.isArray(state["changesets"]) ||
    state["changesets"].some(
      (changeset) => typeof changeset !== "string" || changeset.length === 0,
    ) ||
    typeof state["initialVersions"] !== "object" ||
    state["initialVersions"] === null ||
    Array.isArray(state["initialVersions"]) ||
    Object.values(state["initialVersions"]).some(
      (version) => typeof version !== "string",
    )
  ) {
    throw new Error(".changeset/pre.json has an invalid prerelease state.");
  }
  return /** @type {ChangesetPrereleaseState} */ (value);
}

/** @param {string} rootDirectory */
export async function readChangesetPrereleaseState(rootDirectory) {
  try {
    return validateChangesetPrereleaseState(
      JSON.parse(
        await readFile(
          path.join(rootDirectory, ".changeset", "pre.json"),
          "utf8",
        ),
      ),
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

/**
 * @template {{ id: string }} T
 * @param {readonly T[]} changesets
 * @param {{ changesets: readonly string[] } | undefined} prereleaseState
 */
export function unconsumedChangesets(changesets, prereleaseState) {
  const consumed = new Set(prereleaseState?.changesets ?? []);
  return changesets.filter(({ id }) => !consumed.has(id));
}
