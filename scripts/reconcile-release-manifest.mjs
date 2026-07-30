import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const AUDIT_FIELDS = new Set(["createdAt", "runUrl"]);

/** @param {unknown} value @param {string} label */
const requireManifest = (value, label) => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} release manifest must be an object.`);
  }
  const manifest = /** @type {Record<string, unknown>} */ (value);
  const runUrl = manifest["runUrl"];
  const createdAt = manifest["createdAt"];
  if (typeof runUrl !== "string" || typeof createdAt !== "string") {
    throw new Error(`${label} release manifest audit fields are invalid.`);
  }
  try {
    if (new URL(runUrl).protocol !== "https:") throw new Error();
  } catch {
    throw new Error(`${label} release manifest runUrl must be HTTPS.`);
  }
  if (Number.isNaN(Date.parse(createdAt))) {
    throw new Error(`${label} release manifest createdAt is invalid.`);
  }
  return manifest;
};

/** @param {unknown} value @returns {string} */
const canonicalJson = (value) => {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson(
            /** @type {Record<string, unknown>} */ (value)[key],
          )}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
};

/** @param {Record<string, unknown>} manifest */
const immutableIdentity = (manifest) =>
  Object.fromEntries(
    Object.entries(manifest).filter(([field]) => !AUDIT_FIELDS.has(field)),
  );

/**
 * A rerun has a new workflow run URL and creation timestamp, but every field
 * that identifies the immutable release must remain byte-for-byte equivalent
 * after canonical JSON normalization.
 *
 * @param {unknown} expected
 * @param {unknown} existing
 */
export function assertReleaseManifestReconciles(expected, existing) {
  const expectedManifest = requireManifest(expected, "current");
  const existingManifest = requireManifest(existing, "existing");
  if (
    canonicalJson(immutableIdentity(expectedManifest)) !==
    canonicalJson(immutableIdentity(existingManifest))
  ) {
    throw new Error(
      "existing GitHub Release manifest does not match the immutable current release identity.",
    );
  }
}

/** @param {string[]} args */
export async function runReconcileReleaseManifest(args) {
  /** @type {Record<string, string>} */
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error("manifest reconciliation arguments must be pairs.");
    }
    values[flag.slice(2)] = value;
  }
  if (!values["expected"] || !values["existing"]) {
    throw new Error("--expected and --existing are required.");
  }
  assertReleaseManifestReconciles(
    JSON.parse(await readFile(path.resolve(values["expected"]), "utf8")),
    JSON.parse(await readFile(path.resolve(values["existing"]), "utf8")),
  );
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  pathToFileURL(path.resolve(invokedPath)).href === import.meta.url
) {
  try {
    await runReconcileReleaseManifest(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
