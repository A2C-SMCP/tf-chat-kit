import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import readChangesets from "@changesets/read";

import {
  readChangesetPrereleaseState,
  unconsumedChangesets,
} from "./changeset-pre-state.mjs";
import {
  buildReleasePackages,
  createReleaseManifest,
  loadCompatibilityPolicy,
} from "./release-policy.mjs";

const REQUIRED_ARGUMENTS = Object.freeze([
  "channel",
  "commit",
  "run-url",
  "expected-version",
  "output",
]);
const RETIRED_ARGUMENTS = Object.freeze(
  new Set([
    "group",
    "expected-auth-version",
    "consumer-core-version",
    "consumer-auth-version",
  ]),
);

/**
 * @param {readonly { id: string }[]} changesets
 * @param {{ mode: "pre" | "exit"; changesets: string[] } | undefined} prereleaseState
 */
export function assertReleaseQueueConsumed(changesets, prereleaseState) {
  if (prereleaseState?.mode === "exit") {
    throw new Error(
      "release requires Changesets prerelease exit versioning to finish before publication.",
    );
  }
  const unconsumed = unconsumedChangesets(changesets, prereleaseState);
  if (unconsumed.length > 0) {
    throw new Error(
      `release requires a merged Changesets version commit with no pending entries; found ${unconsumed
        .map(({ id }) => id)
        .sort()
        .join(", ")}.`,
    );
  }
}

/** @param {string[]} args */
export function parseReleaseManifestArguments(args) {
  /** @type {Record<string, string>} */
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error("release manifest arguments must be --flag value pairs.");
    }
    const name = flag.slice(2);
    if (RETIRED_ARGUMENTS.has(name)) {
      throw new Error(
        `--${name} is retired; releases always include the complete unified package group.`,
      );
    }
    if (!REQUIRED_ARGUMENTS.includes(name)) {
      throw new Error(`unknown release manifest argument --${name}.`);
    }
    if (values[name] !== undefined) {
      throw new Error(`duplicate release manifest argument --${name}.`);
    }
    values[name] = value;
  }
  for (const required of REQUIRED_ARGUMENTS) {
    if (!values[required]) {
      throw new Error(`missing required --${required} argument.`);
    }
  }
  return {
    channel: values["channel"] ?? "",
    commit: values["commit"] ?? "",
    runUrl: values["run-url"] ?? "",
    expectedVersion: values["expected-version"] ?? "",
    output: values["output"] ?? "",
  };
}

/** @param {string[]} args */
export async function runCreateReleaseManifest(args) {
  const rootDirectory = process.cwd();
  const options = parseReleaseManifestArguments(args);
  assertReleaseQueueConsumed(
    await readChangesets(rootDirectory),
    await readChangesetPrereleaseState(rootDirectory),
  );
  const packManifest = JSON.parse(
    await readFile(
      path.join(rootDirectory, ".artifacts", "packages", "manifest.json"),
      "utf8",
    ),
  );
  const { packages } = await buildReleasePackages({
    rootDirectory,
    packManifest,
  });
  const version = packages[0]?.version;
  if (version !== options.expectedVersion) {
    throw new Error(
      `packed version ${version} does not match requested ${options.expectedVersion}.`,
    );
  }
  const manifest = createReleaseManifest({
    version: version ?? "",
    channel: options.channel,
    commit: options.commit,
    runUrl: options.runUrl,
    createdAt: new Date().toISOString(),
    compatibility: await loadCompatibilityPolicy(rootDirectory),
    packages,
  });
  const output = path.resolve(options.output);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`Created release manifest for ${manifest.tag}.`);
  return manifest;
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  pathToFileURL(path.resolve(invokedPath)).href === import.meta.url
) {
  try {
    await runCreateReleaseManifest(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
