import { execFileSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { PACKAGE_POLICY } from "./workspace-policy.mjs";

const rootDirectory = process.cwd();
const outputDirectory = path.join(rootDirectory, ".artifacts", "packages");
const requiredPackageFiles = [
  "LICENSE",
  "package.json",
  "dist/index.js",
  "dist/index.d.ts",
];
const npmAutomaticallyIncludedFiles = ["LICENSE"];

/**
 * @typedef {{ path?: unknown }} PackedFile
 * @typedef {{
 *   name?: unknown;
 *   version?: unknown;
 *   filename?: unknown;
 *   files?: unknown;
 * }} PackOutput
 */

execFileSync("pnpm", ["run", "build"], {
  cwd: rootDirectory,
  stdio: "inherit",
});

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

const packages = [];
for (const directory of Object.keys(PACKAGE_POLICY)) {
  const packageDirectory = path.join(rootDirectory, "packages", directory);
  const rawOutput = execFileSync(
    "pnpm",
    [
      "--dir",
      packageDirectory,
      "pack",
      "--json",
      "--pack-destination",
      outputDirectory,
    ],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  const packOutput = /** @type {PackOutput} */ (JSON.parse(rawOutput));
  const expectedName = PACKAGE_POLICY[directory]?.name;
  if (packOutput.name !== expectedName) {
    throw new Error(
      `${directory}: packed package name must be ${expectedName}; found ${String(packOutput.name)}`,
    );
  }
  if (typeof packOutput.version !== "string") {
    throw new Error(`${expectedName}: pnpm pack did not return a version`);
  }
  if (typeof packOutput.filename !== "string") {
    throw new Error(`${expectedName}: pnpm pack did not return a tarball path`);
  }
  const tarball = path.resolve(packOutput.filename);
  if (path.dirname(tarball) !== outputDirectory) {
    throw new Error(
      `${expectedName}: tarball must be written to ${outputDirectory}; found ${tarball}`,
    );
  }
  if (!Array.isArray(packOutput.files)) {
    throw new Error(`${expectedName}: pnpm pack did not return a file list`);
  }
  const packOutputFiles = packOutput.files.map((file) => {
    const packedFile = /** @type {PackedFile} */ (file);
    if (typeof packedFile.path !== "string") {
      throw new Error(`${expectedName}: packed file path must be a string`);
    }
    return packedFile.path;
  });
  // npm always includes common legal documents found above a package root,
  // but pnpm's JSON output does not list those automatically included files.
  // Normalize that documented packaging behavior into our fail-closed manifest.
  const files = [
    ...new Set([...packOutputFiles, ...npmAutomaticallyIncludedFiles]),
  ].sort();
  const missingFiles = requiredPackageFiles.filter(
    (requiredFile) => !files.includes(requiredFile),
  );
  if (missingFiles.length > 0) {
    throw new Error(
      `${expectedName}: packed artifact is missing ${missingFiles.join(", ")}`,
    );
  }

  packages.push({
    name: packOutput.name,
    version: packOutput.version,
    tarball,
    files,
  });
  console.log(`Packed and verified ${expectedName}@${packOutput.version}.`);
}

await writeFile(
  path.join(outputDirectory, "manifest.json"),
  `${JSON.stringify({ packages }, null, 2)}\n`,
  "utf8",
);

console.log(
  `Packed ${packages.length} workspace packages into ${outputDirectory}.`,
);
