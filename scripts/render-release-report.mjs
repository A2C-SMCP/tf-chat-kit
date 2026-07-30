import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** @param {unknown} value */
const requireObject = (value) => {
  if (typeof value !== "object" || value === null) {
    throw new Error("release report input must be an object.");
  }
  return /** @type {Record<string, unknown>} */ (value);
};

/** @param {Record<string, unknown>} manifest */
export function renderReleaseNotes(manifest) {
  const packages = Array.isArray(manifest["packages"])
    ? manifest["packages"].map(requireObject)
    : [];
  const compatibility = requireObject(manifest["compatibility"]);
  const consumers = requireObject(compatibility["consumers"]);
  const limitations = Array.isArray(compatibility["knownLimitations"])
    ? compatibility["knownLimitations"]
    : [];
  return [
    `# tf-chat-kit ${String(manifest["version"])}`,
    "",
    `- Channel: \`${String(manifest["channel"])}\``,
    `- Source commit: \`${String(manifest["commit"])}\``,
    `- Workflow: ${String(manifest["runUrl"])}`,
    "",
    "## Published packages",
    "",
    ...packages.map(
      (entry) =>
        `- \`${String(entry["name"])}@${String(entry["version"])}\` — \`${String(entry["integrity"])}\``,
    ),
    "",
    "## Consumer evidence",
    "",
    ...Object.entries(consumers).map(([name, evidence]) => {
      const entry = requireObject(evidence);
      return `- ${name}: **${String(entry["status"])}**${entry["evidence"] ? ` — ${String(entry["evidence"])}` : ""}`;
    }),
    "",
    "## Known limitations",
    "",
    ...limitations.map((limitation) => `- ${String(limitation)}`),
    "",
    "## Rollback",
    "",
    "Published npm versions and the source tag are immutable. If this release is unsuitable, reconcile each dist-tag against the recorded before/current mapping, restore the previous mapping (or remove only a newly created tag), open or update the Release Incident, fix forward, and publish a new patch version. Never overwrite the version or move the tag.",
    "",
  ].join("\n");
}

/**
 * @param {Record<string, unknown>} manifest
 * @param {Record<string, unknown>} progress
 */
export function renderReleaseIncident(manifest, progress) {
  const states = requireObject(progress["states"]);
  const beforeTags = requireObject(progress["beforeTags"] ?? {});
  const currentTags = requireObject(progress["currentTags"] ?? {});
  const published = Object.entries(states)
    .filter(([, state]) => state !== "pending")
    .map(([name, state]) => {
      const before = beforeTags[name];
      const current = currentTags[name];
      return `- \`${name}\`: ${String(state)}; before=${before ? `\`${String(before)}\`` : "`<none>`"}; current=${current ? `\`${String(current)}\`` : "`<none>`"}`;
    });
  const targetVersion = String(manifest["version"]);
  const channel = String(manifest["channel"]);
  const recoveryCommands = Object.keys(states).flatMap((name) => {
    if (currentTags[name] !== targetVersion) return [];
    const before = beforeTags[name];
    if (before === targetVersion) return [];
    return before
      ? [`- \`npm dist-tag add ${name}@${String(before)} ${channel}\``]
      : [`- \`npm dist-tag rm ${name} ${channel}\``];
  });
  return [
    `# Release Incident ${String(manifest["tag"])}`,
    "",
    `- Source commit: \`${String(manifest["commit"])}\``,
    `- Workflow: ${String(progress["runUrl"] ?? manifest["runUrl"])}`,
    `- Error: ${String(progress["error"] ?? "workflow failed after manifest creation")}`,
    "",
    "## Registry reconciliation",
    "",
    ...(published.length > 0 ? published : ["- No package was confirmed."]),
    "",
    "## Dist-tag response",
    "",
    ...(recoveryCommands.length > 0
      ? [
          "After Registry reconciliation, a Release Owner may approve only the following commands. They restore the recorded previous mapping, or remove a tag that had no previous mapping:",
          "",
          ...recoveryCommands,
        ]
      : [
          "No dist-tag currently points to the failed target version; do not change existing tags.",
        ]),
    "",
    "Do not move the source tag or overwrite this npm version. First reconcile Registry integrity. If no dist-tag has been removed, an approved rerun of the same commit may finish an identical partial batch. After any dist-tag removal, fix forward with a new patch version.",
    "",
  ].join("\n");
}

/** @param {string[]} args */
export async function runRenderReleaseReport(args) {
  /** @type {Record<string, string>} */
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error("release report arguments must be --flag value pairs.");
    }
    values[flag.slice(2)] = value;
  }
  if (!values["kind"] || !values["manifest"] || !values["output"]) {
    throw new Error("--kind, --manifest, and --output are required.");
  }
  const manifest = requireObject(
    JSON.parse(await readFile(path.resolve(values["manifest"]), "utf8")),
  );
  let report;
  if (values["kind"] === "release") {
    report = renderReleaseNotes(manifest);
  } else if (values["kind"] === "incident") {
    const progress = values["progress"];
    if (!progress) {
      throw new Error("incident reports require --progress.");
    }
    report = renderReleaseIncident(
      manifest,
      requireObject(JSON.parse(await readFile(path.resolve(progress), "utf8"))),
    );
  } else {
    throw new Error("--kind must be release or incident.");
  }
  await writeFile(path.resolve(values["output"]), report, "utf8");
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  pathToFileURL(path.resolve(invokedPath)).href === import.meta.url
) {
  try {
    await runRenderReleaseReport(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
