import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { PACKAGE_POLICY } from "./workspace-policy.mjs";
import { validatePackedArtifact } from "./packed-artifact-policy.mjs";

const rootDirectory = process.cwd();

/**
 * @param {string} command
 * @param {readonly string[]} args
 * @param {import("node:child_process").ExecFileSyncOptions} [options]
 */
const run = (command, args, options = {}) =>
  execFileSync(command, args, {
    cwd: rootDirectory,
    stdio: "inherit",
    ...options,
  });

const packageDirectories = Object.keys(PACKAGE_POLICY);

/**
 * @param {string} directory
 * @param {string} root
 * @returns {Promise<{ path: string; bytes: Uint8Array }[]>}
 */
const readExtractedFiles = async (directory, root = directory) => {
  /** @type {{ path: string; bytes: Uint8Array }[]} */
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(
        `${path.relative(root, absolutePath)}: symbolic links are not allowed in packed artifacts`,
      );
    }
    if (entry.isDirectory()) {
      files.push(...(await readExtractedFiles(absolutePath, root)));
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(
        `${path.relative(root, absolutePath)}: unsupported tarball entry type`,
      );
    }
    const buffer = await readFile(absolutePath);
    files.push({
      path: path.relative(root, absolutePath).split(path.sep).join("/"),
      bytes: buffer,
    });
  }
  return files;
};

run("node", ["scripts/pack-workspace.mjs"]);

for (const directory of packageDirectories) {
  const packageDirectory = path.join(rootDirectory, "packages", directory);
  run("pnpm", ["exec", "publint", packageDirectory]);
  run("pnpm", [
    "exec",
    "attw",
    "--pack",
    packageDirectory,
    "--profile",
    "esm-only",
  ]);
}

/** @typedef {{ name: string; version: string; tarball: string; files: string[] }} PackedPackage */
/** @type {{ packages: PackedPackage[] }} */
const packManifest = JSON.parse(
  await readFile(
    path.join(rootDirectory, ".artifacts", "packages", "manifest.json"),
    "utf8",
  ),
);
const extractionRoot = await mkdtemp(
  path.join(os.tmpdir(), "tf-chat-kit-artifacts-"),
);
const consumerDirectory = await mkdtemp(
  path.join(os.tmpdir(), "tf-chat-kit-consumer-"),
);

try {
  for (const packedPackage of packManifest.packages) {
    const policyEntry = Object.entries(PACKAGE_POLICY).find(
      ([, { name }]) => name === packedPackage.name,
    );
    if (!policyEntry) {
      throw new Error(`unexpected packed package ${packedPackage.name}`);
    }
    const [directory] = policyEntry;
    const extractionDirectory = path.join(extractionRoot, directory);
    await run("tar", ["-xzf", packedPackage.tarball, "-C", extractionRoot]);
    const extractedPackageDirectory = path.join(extractionRoot, "package");
    const extractedFiles = await readExtractedFiles(extractedPackageDirectory);
    const sourceManifest = JSON.parse(
      await readFile(
        path.join(rootDirectory, "packages", directory, "package.json"),
        "utf8",
      ),
    );
    const packedManifest = JSON.parse(
      await readFile(
        path.join(extractedPackageDirectory, "package.json"),
        "utf8",
      ),
    );
    const errors = validatePackedArtifact({
      packageName: packedPackage.name,
      sourceManifest,
      packedManifest,
      declaredFiles: packedPackage.files,
      extractedFiles,
    });
    if (errors.length > 0) throw new Error(errors.join("\n"));
    await rm(extractedPackageDirectory, { recursive: true, force: true });
    await rm(extractionDirectory, { recursive: true, force: true });
  }

  const packageFiles = Object.fromEntries(
    packManifest.packages.map(({ name, tarball }) => [name, `file:${tarball}`]),
  );
  const consumerManifest = {
    name: "tf-chat-kit-package-smoke",
    version: "0.0.0",
    private: true,
    type: "module",
    packageManager: "pnpm@10.34.5",
    dependencies: {
      ...packageFiles,
      antd: "5.29.3",
      react: "18.3.1",
      "react-dom": "18.3.1",
    },
    devDependencies: {
      typescript: "5.9.3",
    },
    pnpm: { overrides: packageFiles },
  };
  await writeFile(
    path.join(consumerDirectory, "package.json"),
    `${JSON.stringify(consumerManifest, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(consumerDirectory, "index.ts"),
    `${packManifest.packages.map(({ name }) => `import * as ${name.replace(/\W/gu, "_")} from ${JSON.stringify(name)};`).join("\n")}\nconsole.log("Installed, built, and imported ${packManifest.packages.length} packed packages.");\n`,
    "utf8",
  );
  await writeFile(
    path.join(consumerDirectory, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          outDir: "dist",
          strict: true,
          target: "ES2022",
        },
        include: ["index.ts"],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  run("pnpm", [
    "--dir",
    consumerDirectory,
    "install",
    "--lockfile-only",
    "--ignore-scripts",
    "--config.strict-peer-dependencies=true",
  ]);
  run("pnpm", ["--dir", consumerDirectory, "fetch", "--frozen-lockfile"]);
  run("pnpm", [
    "--dir",
    consumerDirectory,
    "install",
    "--offline",
    "--frozen-lockfile",
    "--ignore-scripts",
    "--config.strict-peer-dependencies=true",
  ]);
  run("pnpm", [
    "--dir",
    consumerDirectory,
    "exec",
    "tsc",
    "-p",
    "tsconfig.json",
  ]);
  run("node", [path.join(consumerDirectory, "dist", "index.js")]);
} finally {
  await rm(extractionRoot, { recursive: true, force: true });
  await rm(consumerDirectory, { recursive: true, force: true });
}

console.log("Packed artifact validation passed.");
