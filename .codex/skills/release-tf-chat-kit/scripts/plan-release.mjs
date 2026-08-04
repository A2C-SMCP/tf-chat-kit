#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const rootDirectory = process.cwd();

const fail = (message) => {
  throw new Error(message);
};

const normalizeVersion = (value, label) => {
  const normalized = value.startsWith("v") ? value.slice(1) : value;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(normalized);
  if (match === null) {
    fail(`${label} must be a stable SemVer value such as 0.2.1.`);
  }
  const parts = match.slice(1).map(Number);
  if (parts[0] !== 0) {
    fail(`${label} must remain on the repository's 0.x release line.`);
  }
  if (parts.some((part) => !Number.isSafeInteger(part))) {
    fail(`${label} contains an unsafe numeric component.`);
  }
  return { value: normalized, parts };
};

const compareVersions = (left, right) => {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
};

const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));

const loadFixedGroup = async () => {
  const config = await readJson(
    path.join(rootDirectory, ".changeset", "config.json"),
  );
  if (!Array.isArray(config.fixed) || config.fixed.length !== 1) {
    fail("Expected exactly one Changesets fixed group.");
  }
  const names = config.fixed[0];
  if (!Array.isArray(names) || names.length === 0) {
    fail("The Changesets fixed group is empty or invalid.");
  }

  const manifests = [];
  const packageRoot = path.join(rootDirectory, "packages");
  for (const entry of await readdir(packageRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(packageRoot, entry.name, "package.json");
    try {
      const manifest = await readJson(file);
      if (names.includes(manifest.name)) {
        manifests.push({
          name: manifest.name,
          version: manifest.version,
          file,
        });
      }
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        continue;
      }
      throw error;
    }
  }

  const foundNames = new Set(manifests.map(({ name }) => name));
  const missing = names.filter((name) => !foundNames.has(name));
  if (missing.length > 0 || manifests.length !== names.length) {
    fail(`Could not resolve the complete fixed group: ${missing.join(", ")}.`);
  }

  manifests.sort(
    (left, right) => names.indexOf(left.name) - names.indexOf(right.name),
  );
  return manifests;
};

const parseArguments = () => {
  const args = process.argv.slice(2);
  let requested;
  let verify;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--version" || argument === "--verify") {
      const value = args[index + 1];
      if (value === undefined) fail(`${argument} requires a value.`);
      if (argument === "--version") requested = value;
      else verify = value;
      index += 1;
      continue;
    }
    if (!argument.startsWith("-") && requested === undefined) {
      requested = argument;
      continue;
    }
    fail(`Unknown argument: ${argument}`);
  }
  if (requested !== undefined && verify !== undefined) {
    fail("--version and --verify cannot be used together.");
  }
  return { requested, verify };
};

try {
  const manifests = await loadFixedGroup();
  const versions = [...new Set(manifests.map(({ version }) => version))];
  if (versions.length !== 1) {
    fail(`Fixed-group versions diverged: ${versions.join(", ")}.`);
  }
  const current = normalizeVersion(versions[0], "Current version");
  const { requested, verify } = parseArguments();

  if (verify !== undefined) {
    const expected = normalizeVersion(verify, "Expected version");
    if (current.value !== expected.value) {
      fail(
        `Expected fixed-group version ${expected.value}; found ${current.value}.`,
      );
    }
    console.log(
      JSON.stringify(
        {
          verified: true,
          version: current.value,
          tag: `v${current.value}`,
          packages: manifests.map(({ name }) => name),
        },
        null,
        2,
      ),
    );
  } else {
    const target =
      requested === undefined
        ? {
            value: `${current.parts[0]}.${current.parts[1]}.${current.parts[2] + 1}`,
            parts: [current.parts[0], current.parts[1], current.parts[2] + 1],
          }
        : normalizeVersion(requested, "Requested version");
    if (compareVersions(target.parts, current.parts) <= 0) {
      fail(
        `Requested version ${target.value} must be greater than current version ${current.value}.`,
      );
    }
    console.log(
      JSON.stringify(
        {
          currentVersion: current.value,
          targetVersion: target.value,
          tag: `v${target.value}`,
          source: requested === undefined ? "next-patch" : "explicit",
          packages: manifests.map(({ name }) => name),
        },
        null,
        2,
      ),
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
