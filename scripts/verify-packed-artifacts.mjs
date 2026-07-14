import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const rootDirectory = process.cwd();

const run = (command, args, options = {}) =>
  execFileSync(command, args, {
    cwd: rootDirectory,
    stdio: "inherit",
    ...options,
  });

run("pnpm", ["run", "build"]);

const packageDirectories = [
  "chat-protocol",
  "chat-runtime",
  "chat-gateway-tfrobot",
  "chat-react",
  "chat-ui-antd",
  "chat-testing",
];

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

run("node", ["scripts/pack-workspace.mjs"]);

const packManifest = JSON.parse(
  await readFile(
    path.join(rootDirectory, ".artifacts", "packages", "manifest.json"),
    "utf8",
  ),
);
const consumerDirectory = await mkdtemp(
  path.join(os.tmpdir(), "tf-chat-kit-consumer-"),
);

try {
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
    pnpm: { overrides: packageFiles },
  };
  await writeFile(
    path.join(consumerDirectory, "package.json"),
    `${JSON.stringify(consumerManifest, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(consumerDirectory, "index.mjs"),
    `${packManifest.packages.map(({ name }) => `import * as ${name.replace(/\W/gu, "_")} from ${JSON.stringify(name)};`).join("\n")}\nconsole.log("Installed and imported ${packManifest.packages.length} packed packages.");\n`,
    "utf8",
  );

  run("pnpm", [
    "--dir",
    consumerDirectory,
    "install",
    "--offline",
    "--ignore-scripts",
    "--config.strict-peer-dependencies=true",
  ]);
  run("node", [path.join(consumerDirectory, "index.mjs")]);
} finally {
  await rm(consumerDirectory, { recursive: true, force: true });
}

console.log("Packed artifact validation passed.");
