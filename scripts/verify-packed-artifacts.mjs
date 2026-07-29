import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
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

/**
 * @param {string} directory
 * @param {readonly string[]} packageNames
 * @param {readonly PackedPackage[]} packedPackages
 */
const verifyInstalledPackageMetadata = async (
  directory,
  packageNames,
  packedPackages,
) => {
  for (const packageName of packageNames) {
    const packedPackage = packedPackages.find(
      ({ name }) => name === packageName,
    );
    if (packedPackage === undefined) {
      throw new Error(`missing packed package ${packageName}`);
    }
    const installedManifest = JSON.parse(
      await readFile(
        path.join(
          directory,
          "node_modules",
          ...packageName.split("/"),
          "package.json",
        ),
        "utf8",
      ),
    );
    if (
      installedManifest.name !== packedPackage.name ||
      installedManifest.version !== packedPackage.version ||
      installedManifest.repository?.url !==
        "git+https://github.com/A2C-SMCP/tf-chat-kit.git"
    ) {
      throw new Error(
        `${packageName}: installed consumer package metadata did not match the packed artifact`,
      );
    }
  }
};

/**
 * @param {string} directory
 * @param {readonly string[]} forbiddenMarkers
 */
const assertPackagesAbsent = async (directory, forbiddenMarkers) => {
  const virtualStoreEntries = await readdir(
    path.join(directory, "node_modules", ".pnpm"),
  );
  for (const marker of forbiddenMarkers) {
    if (virtualStoreEntries.some((entry) => entry.startsWith(marker))) {
      throw new Error(
        `${path.basename(directory)} unexpectedly installed ${marker}`,
      );
    }
  }
};

/**
 * @typedef {{
 *   directory: string;
 *   manifest: Record<string, unknown>;
 *   sourceFiles: Readonly<Record<string, string>>;
 *   tsconfig: Record<string, unknown>;
 *   packageNames?: readonly string[];
 *   forbiddenPackageMarkers?: readonly string[];
 * }} ConsumerProject
 */

/**
 * Writes, installs, builds, runs and inspects one isolated packed-package
 * consumer. Consumer definitions own their dependency and compiler choices;
 * this helper owns the shared verification lifecycle.
 *
 * @param {ConsumerProject} project
 * @param {readonly PackedPackage[]} packedPackages
 */
const verifyConsumerProject = async (project, packedPackages) => {
  await Promise.all([
    writeFile(
      path.join(project.directory, "package.json"),
      `${JSON.stringify(project.manifest, null, 2)}\n`,
      "utf8",
    ),
    writeFile(
      path.join(project.directory, "tsconfig.json"),
      `${JSON.stringify(project.tsconfig, null, 2)}\n`,
      "utf8",
    ),
    ...Object.entries(project.sourceFiles).map(([fileName, source]) =>
      writeFile(path.join(project.directory, fileName), source, "utf8"),
    ),
  ]);

  installBuildAndRunConsumer(project.directory);

  if (project.packageNames !== undefined) {
    await verifyInstalledPackageMetadata(
      project.directory,
      project.packageNames,
      packedPackages,
    );
  }
  if (project.forbiddenPackageMarkers !== undefined) {
    await assertPackagesAbsent(
      project.directory,
      project.forbiddenPackageMarkers,
    );
  }
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
const verificationRoot = await mkdtemp(
  path.join(os.tmpdir(), "tf-chat-kit-packed-verification-"),
);
const extractionRoot = path.join(verificationRoot, "artifacts");
const consumerDirectory = path.join(verificationRoot, "consumer");
const minimumUiConsumerDirectory = path.join(
  verificationRoot,
  "minimum-ui-consumer",
);
const reactConsumerDirectory = path.join(verificationRoot, "react-consumer");
const officeStyleConsumerDirectory = path.join(
  verificationRoot,
  "office-style-consumer",
);
const tauriStyleConsumerDirectory = path.join(
  verificationRoot,
  "tauri-style-consumer",
);
const tfrobotfrontStyleConsumerDirectory = path.join(
  verificationRoot,
  "tfrobotfront-style-consumer",
);

try {
  await Promise.all([
    mkdir(extractionRoot),
    mkdir(consumerDirectory),
    mkdir(minimumUiConsumerDirectory),
    mkdir(reactConsumerDirectory),
    mkdir(officeStyleConsumerDirectory),
    mkdir(tauriStyleConsumerDirectory),
    mkdir(tfrobotfrontStyleConsumerDirectory),
  ]);
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
  const packageSmokeSource = [
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
  ].join("\n");
  const packageSmokeTsconfig = {
    compilerOptions: {
      exactOptionalPropertyTypes: true,
      module: "NodeNext",
      moduleResolution: "NodeNext",
      outDir: "dist",
      strict: true,
      target: "ES2022",
    },
    include: ["index.ts"],
  };

  await verifyConsumerProject(
    {
      directory: consumerDirectory,
      manifest: consumerManifest,
      sourceFiles: { "index.ts": packageSmokeSource },
      tsconfig: packageSmokeTsconfig,
    },
    packManifest.packages,
  );

  const minimumUiConsumerManifest = {
    ...consumerManifest,
    name: "tf-chat-kit-minimum-ui-consumer",
    dependencies: {
      ...consumerManifest.dependencies,
      antd: "5.23.4",
    },
  };
  await verifyConsumerProject(
    {
      directory: minimumUiConsumerDirectory,
      manifest: minimumUiConsumerManifest,
      sourceFiles: { "index.ts": packageSmokeSource },
      tsconfig: packageSmokeTsconfig,
    },
    packManifest.packages,
  );

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
  await verifyConsumerProject(
    {
      directory: reactConsumerDirectory,
      manifest: reactConsumerManifest,
      sourceFiles: {
        "index.ts": [
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
      },
      tsconfig: {
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          outDir: "dist",
          strict: true,
          target: "ES2022",
        },
        include: ["index.ts"],
      },
    },
    packManifest.packages,
  );

  const officeStylePackageNames = [
    "@turingfocus/chat-protocol",
    "@turingfocus/chat-react",
    "@turingfocus/chat-runtime",
    "@turingfocus/chat-testing",
  ];
  const officeStylePackageFiles = Object.fromEntries(
    officeStylePackageNames.map((name) => [name, packageFiles[name]]),
  );
  const officeStyleConsumerManifest = {
    name: "tf-chat-kit-office-style-consumer",
    version: "0.0.0",
    private: true,
    type: "module",
    packageManager: "pnpm@10.34.5",
    dependencies: {
      ...officeStylePackageFiles,
      react: "18.2.0",
      "react-test-renderer": "18.2.0",
    },
    devDependencies: {
      "@types/react": "18.2.64",
      "@types/react-test-renderer": "18.3.1",
      "@types/scheduler": "0.16.8",
      typescript: "5.9.3",
    },
    pnpm: { overrides: officeStylePackageFiles },
  };
  const officeConsumerSource = await readFile(
    path.join(
      rootDirectory,
      "tests",
      "consumers",
      "office-style",
      "consumer.ts",
    ),
    "utf8",
  );
  for (const forbiddenSourceToken of [
    'from "antd"',
    "react-dom",
    "Office.",
    "window.",
    "document.",
    "@tauri-apps",
    "TFRobotFront",
  ]) {
    if (officeConsumerSource.includes(forbiddenSourceToken)) {
      throw new Error(
        `Office-style consumer contains forbidden host/UI token ${forbiddenSourceToken}`,
      );
    }
  }
  await verifyConsumerProject(
    {
      directory: officeStyleConsumerDirectory,
      forbiddenPackageMarkers: [
        "@microsoft+office-js@",
        "@tauri-apps+",
        "@turingfocus+chat-gateway-tfrobot@",
        "@turingfocus+chat-ui-antd@",
        "antd@",
        "next@",
        "office-js@",
        "react-dom@",
      ],
      manifest: officeStyleConsumerManifest,
      packageNames: officeStylePackageNames,
      sourceFiles: {
        "consumer.ts": officeConsumerSource,
        "index.ts": [
          'import { runOfficeConsumerVerification } from "./consumer.js";',
          "",
          "await runOfficeConsumerVerification();",
          "",
        ].join("\n"),
      },
      tsconfig: {
        compilerOptions: {
          exactOptionalPropertyTypes: true,
          lib: ["ES2023"],
          module: "NodeNext",
          moduleResolution: "NodeNext",
          outDir: "dist",
          strict: true,
          target: "ES2023",
        },
        include: ["consumer.ts", "index.ts"],
      },
    },
    packManifest.packages,
  );

  const tauriStylePackageNames = [
    "@turingfocus/chat-protocol",
    "@turingfocus/chat-react",
    "@turingfocus/chat-runtime",
    "@turingfocus/chat-testing",
    "@turingfocus/chat-ui-antd",
  ];
  const tauriStylePackageFiles = Object.fromEntries(
    tauriStylePackageNames.map((name) => [name, packageFiles[name]]),
  );
  const tauriStyleConsumerManifest = {
    name: "tf-chat-kit-tauri-style-consumer",
    version: "0.0.0",
    private: true,
    type: "module",
    packageManager: "pnpm@10.34.5",
    dependencies: {
      ...tauriStylePackageFiles,
      antd: "5.23.4",
      jsdom: "29.1.1",
      react: "18.3.1",
      "react-dom": "18.3.1",
    },
    devDependencies: {
      "@types/jsdom": "28.0.3",
      "@types/react": "18.3.31",
      "@types/react-dom": "18.3.7",
      typescript: "5.9.3",
    },
    pnpm: { overrides: tauriStylePackageFiles },
  };
  const tauriConsumerSource = await readFile(
    path.join(
      rootDirectory,
      "tests",
      "consumers",
      "tauri-style",
      "consumer.ts",
    ),
    "utf8",
  );
  await verifyConsumerProject(
    {
      directory: tauriStyleConsumerDirectory,
      forbiddenPackageMarkers: [
        "@tauri-apps+",
        "@turingfocus+chat-gateway-tfrobot@",
        "next@",
        "office-js@",
      ],
      manifest: tauriStyleConsumerManifest,
      packageNames: tauriStylePackageNames,
      sourceFiles: {
        "consumer.ts": tauriConsumerSource,
        "index.ts": [
          'import { runTauriConsumerVerification } from "./consumer.js";',
          "",
          "await runTauriConsumerVerification();",
          "",
        ].join("\n"),
      },
      tsconfig: {
        compilerOptions: {
          exactOptionalPropertyTypes: true,
          lib: ["ES2023", "DOM", "DOM.Iterable"],
          module: "NodeNext",
          moduleResolution: "NodeNext",
          outDir: "dist",
          skipLibCheck: true,
          strict: true,
          target: "ES2023",
        },
        include: ["consumer.ts", "index.ts"],
      },
    },
    packManifest.packages,
  );

  const tfrobotfrontStylePackageNames = [
    "@turingfocus/chat-gateway-tfrobot",
    "@turingfocus/chat-protocol",
    "@turingfocus/chat-react",
    "@turingfocus/chat-runtime",
    "@turingfocus/chat-ui-antd",
  ];
  const tfrobotfrontStylePackageFiles = Object.fromEntries(
    tfrobotfrontStylePackageNames.map((name) => [name, packageFiles[name]]),
  );
  const tfrobotfrontStyleConsumerManifest = {
    name: "tf-chat-kit-tfrobotfront-style-consumer",
    version: "0.0.0",
    private: true,
    type: "module",
    packageManager: "pnpm@10.34.5",
    dependencies: {
      ...tfrobotfrontStylePackageFiles,
      antd: "5.29.3",
      react: "18.3.1",
      "react-dom": "18.3.1",
      "react-test-renderer": "18.3.1",
    },
    devDependencies: {
      "@types/node": "24.13.3",
      "@types/react": "18.3.31",
      "@types/react-dom": "18.3.7",
      "@types/react-test-renderer": "18.3.1",
      typescript: "5.9.3",
    },
    pnpm: { overrides: tfrobotfrontStylePackageFiles },
  };
  const tfrobotfrontConsumerSource = await readFile(
    path.join(
      rootDirectory,
      "tests",
      "consumers",
      "tfrobotfront-style",
      "consumer.ts",
    ),
    "utf8",
  );
  await verifyConsumerProject(
    {
      directory: tfrobotfrontStyleConsumerDirectory,
      manifest: tfrobotfrontStyleConsumerManifest,
      packageNames: tfrobotfrontStylePackageNames,
      sourceFiles: {
        "consumer.ts": tfrobotfrontConsumerSource,
        "index.ts": [
          'import { runHostConsumerVerification } from "./consumer.js";',
          "",
          "await runHostConsumerVerification();",
          'console.log("Verified the versioned TFRobotFront-style host consumer.");',
          "",
        ].join("\n"),
      },
      tsconfig: {
        compilerOptions: {
          exactOptionalPropertyTypes: true,
          lib: ["ES2023", "DOM", "DOM.Iterable"],
          module: "NodeNext",
          moduleResolution: "NodeNext",
          outDir: "dist",
          skipLibCheck: true,
          strict: true,
          target: "ES2023",
          types: ["node"],
        },
        include: ["consumer.ts", "index.ts"],
      },
    },
    packManifest.packages,
  );
} finally {
  await rm(verificationRoot, { recursive: true, force: true });
}

console.log("Packed artifact validation passed.");
