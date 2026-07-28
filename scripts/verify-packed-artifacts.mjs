import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { PACKAGE_POLICY } from "./workspace-policy.mjs";
import { validatePackedArtifact } from "./packed-artifact-policy.mjs";

const rootDirectory = process.cwd();
const approvedLicense = await readFile(path.join(rootDirectory, "LICENSE"));

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

/** @param {string} directory */
const installBuildAndRunConsumer = (directory) => {
  run("pnpm", [
    "--dir",
    directory,
    "install",
    "--lockfile-only",
    "--ignore-scripts",
    "--config.strict-peer-dependencies=true",
  ]);
  run("pnpm", ["--dir", directory, "fetch", "--frozen-lockfile"]);
  run("pnpm", [
    "--dir",
    directory,
    "install",
    "--offline",
    "--frozen-lockfile",
    "--ignore-scripts",
    "--config.strict-peer-dependencies=true",
  ]);
  run("pnpm", ["--dir", directory, "exec", "tsc", "-p", "tsconfig.json"]);
  run("node", [path.join(directory, "dist", "index.js")]);
};

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
const minimumUiConsumerDirectory = await mkdtemp(
  path.join(os.tmpdir(), "tf-chat-kit-minimum-ui-consumer-"),
);
const reactConsumerDirectory = await mkdtemp(
  path.join(os.tmpdir(), "tf-chat-kit-react-consumer-"),
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
      expectedFileContents: { LICENSE: approvedLicense },
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
      "@types/react": "18.3.31",
      "@types/react-dom": "18.3.7",
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
    [
      'import { createElement } from "react";',
      'import { renderToStaticMarkup } from "react-dom/server";',
      'import type { TimelineItem } from "@turingfocus/chat-protocol";',
      ...packManifest.packages.map(
        ({ name }) =>
          `import * as ${name.replace(/\W/gu, "_")} from ${JSON.stringify(name)};`,
      ),
      "",
      "const shellMarkup = renderToStaticMarkup(",
      "  createElement(_turingfocus_chat_ui_antd.ChatUiShell, {",
      '    contentState: { kind: "empty" },',
      "    conversations: [],",
      "    onConversationSelect: () => undefined,",
      "  }),",
      ");",
      'if (!shellMarkup.includes("No conversation selected")) {',
      '  throw new Error("Packed Ant Design chat shell did not render.");',
      "}",
      "const unknownItem: TimelineItem = {",
      '  kind: "unknown-event",',
      '  id: "packed-unknown",',
      '  conversationId: "packed-conversation",',
      '  originalType: "future.packed-event",',
      "  createdAt: Date.UTC(2026, 6, 28),",
      '  summary: "Packed safe fallback",',
      '  raw: { token: "must-not-render" },',
      "};",
      "const timelineMarkup = renderToStaticMarkup(",
      "  createElement(_turingfocus_chat_ui_antd.ChatTimeline, {",
      '    conversationId: "packed-conversation",',
      "    items: [unknownItem],",
      "  }),",
      ");",
      'if (!timelineMarkup.includes("Packed safe fallback") || timelineMarkup.includes("must-not-render")) {',
      '  throw new Error("Packed Ant Design timeline fallback is unsafe or unavailable.");',
      "}",
      `console.log("Installed, built, imported, and rendered ${packManifest.packages.length} packed packages.");`,
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(consumerDirectory, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          exactOptionalPropertyTypes: true,
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

  installBuildAndRunConsumer(consumerDirectory);

  const minimumUiConsumerManifest = {
    ...consumerManifest,
    name: "tf-chat-kit-minimum-ui-consumer",
    dependencies: {
      ...consumerManifest.dependencies,
      antd: "5.23.4",
    },
  };
  await writeFile(
    path.join(minimumUiConsumerDirectory, "package.json"),
    `${JSON.stringify(minimumUiConsumerManifest, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(minimumUiConsumerDirectory, "index.ts"),
    await readFile(path.join(consumerDirectory, "index.ts"), "utf8"),
    "utf8",
  );
  await writeFile(
    path.join(minimumUiConsumerDirectory, "tsconfig.json"),
    await readFile(path.join(consumerDirectory, "tsconfig.json"), "utf8"),
    "utf8",
  );
  installBuildAndRunConsumer(minimumUiConsumerDirectory);

  const reactConsumerPackageNames = [
    "@turingfocus/chat-protocol",
    "@turingfocus/chat-runtime",
    "@turingfocus/chat-react",
  ];
  const reactConsumerPackageFiles = Object.fromEntries(
    reactConsumerPackageNames.map((name) => [name, packageFiles[name]]),
  );
  const reactConsumerManifest = {
    name: "tf-chat-kit-react-consumer",
    version: "0.0.0",
    private: true,
    type: "module",
    packageManager: "pnpm@10.34.5",
    dependencies: {
      ...reactConsumerPackageFiles,
      react: "18.3.1",
    },
    devDependencies: {
      "@types/react": "18.3.31",
      typescript: "5.9.3",
    },
    pnpm: { overrides: reactConsumerPackageFiles },
  };
  await writeFile(
    path.join(reactConsumerDirectory, "package.json"),
    `${JSON.stringify(reactConsumerManifest, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(reactConsumerDirectory, "index.ts"),
    [
      'import { createElement } from "react";',
      'import type { ChatSnapshot } from "@turingfocus/chat-protocol";',
      'import type { ChatClient } from "@turingfocus/chat-runtime";',
      'import { ChatProvider, useChatSelector } from "@turingfocus/chat-react";',
      "",
      "const ConversationTitle = () =>",
      '  createElement("span", null, useChatSelector((snapshot: ChatSnapshot | null) => snapshot?.conversation.title ?? ""));',
      "",
      "export const OfficeStyleConsumer = ({ client }: { readonly client: ChatClient }) =>",
      "  createElement(ChatProvider, { client }, createElement(ConversationTitle));",
      "",
      'console.log("Built a React consumer without Ant Design or a production Gateway.");',
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(reactConsumerDirectory, "tsconfig.json"),
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
  installBuildAndRunConsumer(reactConsumerDirectory);
} finally {
  await rm(extractionRoot, { recursive: true, force: true });
  await rm(consumerDirectory, { recursive: true, force: true });
  await rm(minimumUiConsumerDirectory, { recursive: true, force: true });
  await rm(reactConsumerDirectory, { recursive: true, force: true });
}

console.log("Packed artifact validation passed.");
