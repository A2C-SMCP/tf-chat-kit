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
import { build } from "vite";

import { registryConsumerPackages } from "./release-group-policy.mjs";
import { validateReleaseManifestForPublish } from "./publish-release.mjs";

import { PACKAGE_POLICY } from "./workspace-policy.mjs";
import { validatePackedArtifact } from "./packed-artifact-policy.mjs";

const rootDirectory = process.cwd();
const approvedLicense = await readFile(path.join(rootDirectory, "LICENSE"));
const sourceFlagIndex = process.argv.indexOf("--source");
const versionFlagIndex = process.argv.indexOf("--version");
const packageSource =
  sourceFlagIndex < 0 ? "packed" : process.argv[sourceFlagIndex + 1];
const manifestFlagIndex = process.argv.indexOf("--manifest");
const registryManifestPath =
  manifestFlagIndex < 0 ? undefined : process.argv[manifestFlagIndex + 1];
const registryVersion =
  versionFlagIndex < 0 ? undefined : process.argv[versionFlagIndex + 1];
if (packageSource !== "packed" && packageSource !== "registry") {
  throw new Error("--source must be packed or registry.");
}
if (
  packageSource === "registry" &&
  registryManifestPath === undefined &&
  (registryVersion === undefined ||
    !/^0\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u.test(
      registryVersion,
    ))
) {
  throw new Error("registry verification requires --version with 0.x SemVer.");
}
if (registryManifestPath !== undefined && versionFlagIndex >= 0)
  throw new Error("choose --manifest or --version, not both.");
if (
  packageSource === "packed" &&
  (versionFlagIndex >= 0 || manifestFlagIndex >= 0)
) {
  throw new Error("--version is only valid with --source registry.");
}

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
 *   bundle?: boolean;
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
    ...Object.entries(project.sourceFiles).map(async ([fileName, source]) => {
      const filePath = path.join(project.directory, fileName);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, source, "utf8");
    }),
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
  if (project.bundle) {
    const bundleDirectory = path.join(project.directory, "bundled");
    const result = await (async () => {
      const previousNodeEnvironment = process.env["NODE_ENV"];
      try {
        return await build({
          configFile: false,
          root: project.directory,
          logLevel: "warn",
          build: {
            target: "es2022",
            minify: false,
            outDir: bundleDirectory,
            lib: {
              entry: path.join(project.directory, "index.ts"),
              formats: ["es"],
              fileName: () => "consumer.mjs",
            },
          },
        });
      } finally {
        if (previousNodeEnvironment === undefined)
          delete process.env["NODE_ENV"];
        else process.env["NODE_ENV"] = previousNodeEnvironment;
      }
    })();
    for (const output of Array.isArray(result) ? result : [result]) {
      if (!("output" in output))
        throw new Error("Bundler did not return artifacts");
      for (const chunk of output.output) {
        if (chunk.type !== "chunk") continue;
        for (const moduleId of chunk.moduleIds) {
          if (
            /node_modules\/(?:\.pnpm\/)?(?:react|react-dom|antd)(?:@|\/)/u.test(
              moduleId.replaceAll("\\", "/"),
            )
          )
            throw new Error("Headless bundle unexpectedly includes UI modules");
        }
      }
    }
    run("node", [path.join(bundleDirectory, "consumer.mjs")]);
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

if (packageSource === "packed") {
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
}

/** @typedef {{ name: string; version: string; tarball?: string; files: string[] }} PackedPackage */
const registryPackages =
  registryManifestPath === undefined
    ? Object.values(PACKAGE_POLICY).map(({ name }) => ({
        name,
        version: /** @type {string} */ (registryVersion),
      }))
    : registryConsumerPackages(
        validateReleaseManifestForPublish(
          JSON.parse(
            await readFile(path.resolve(registryManifestPath), "utf8"),
          ),
        ),
      );
/** @type {{ packages: PackedPackage[] }} */
const packManifest =
  packageSource === "packed"
    ? JSON.parse(
        await readFile(
          path.join(rootDirectory, ".artifacts", "packages", "manifest.json"),
          "utf8",
        ),
      )
    : {
        packages: registryPackages.map(({ name, version }) => ({
          name,
          version,
          files: [],
        })),
      };
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
const headlessFacadeConsumerDirectory = path.join(
  verificationRoot,
  "headless-facade-consumer",
);
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
const authHeadlessConsumerDirectory = path.join(
  verificationRoot,
  "auth-headless-consumer",
);
const authReactConsumerDirectory = path.join(
  verificationRoot,
  "auth-react-consumer",
);
const authAntdConsumerDirectory = path.join(
  verificationRoot,
  "auth-antd-consumer",
);

try {
  await Promise.all([
    mkdir(extractionRoot),
    mkdir(consumerDirectory),
    mkdir(minimumUiConsumerDirectory),
    mkdir(reactConsumerDirectory),
    mkdir(headlessFacadeConsumerDirectory),
    mkdir(officeStyleConsumerDirectory),
    mkdir(tauriStyleConsumerDirectory),
    mkdir(tfrobotfrontStyleConsumerDirectory),
    mkdir(authHeadlessConsumerDirectory),
    mkdir(authReactConsumerDirectory),
    mkdir(authAntdConsumerDirectory),
  ]);
  if (packageSource === "packed") {
    for (const packedPackage of packManifest.packages) {
      const policyEntry = Object.entries(PACKAGE_POLICY).find(
        ([, { name }]) => name === packedPackage.name,
      );
      if (!policyEntry) {
        throw new Error(`unexpected packed package ${packedPackage.name}`);
      }
      const [directory] = policyEntry;
      const extractionDirectory = path.join(extractionRoot, directory);
      if (packedPackage.tarball === undefined) {
        throw new Error(`missing packed tarball for ${packedPackage.name}`);
      }
      await run("tar", ["-xzf", packedPackage.tarball, "-C", extractionRoot]);
      const extractedPackageDirectory = path.join(extractionRoot, "package");
      const extractedFiles = await readExtractedFiles(
        extractedPackageDirectory,
      );
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
      if (packedPackage.name === "@turingfocus/chat-gateway-tfrobot") {
        const uploaderDeclaration = extractedFiles.find(
          ({ path: filePath }) => filePath === "dist/attachment-uploader.d.ts",
        );
        const declarationText =
          uploaderDeclaration?.bytes === undefined
            ? ""
            : new TextDecoder().decode(uploaderDeclaration.bytes);
        if (/\bBlob\b/u.test(declarationText)) {
          errors.push(
            `${packedPackage.name}: public attachment uploader declaration must be DOM-free`,
          );
        }
      }
      if (errors.length > 0) throw new Error(errors.join("\n"));
      await rm(extractedPackageDirectory, { recursive: true, force: true });
      await rm(extractionDirectory, { recursive: true, force: true });
    }
  }

  const packageFiles = Object.fromEntries(
    packManifest.packages.map(({ name, version, tarball }) => [
      name,
      packageSource === "packed" ? `file:${tarball}` : version,
    ]),
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
    'const shortcut: _turingfocus_chat_kit.ChatComposerSendShortcut = "ctrl-enter";',
    "const composerMarkup = renderToStaticMarkup(createElement(_turingfocus_chat_kit.ChatComposer, { sendShortcut: shortcut, onSend: () => false }));",
    'if (!composerMarkup.includes("Ctrl+Enter to send") || !composerMarkup.includes(\'aria-keyshortcuts="Control+Enter"\')) throw new Error("Packed composer shortcut configuration is unavailable");',
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

  const authHeadlessConsumerManifest = {
    name: "tf-chat-kit-auth-headless-consumer",
    version: "0.0.0",
    private: true,
    type: "module",
    packageManager: "pnpm@10.34.5",
    dependencies: {
      "@turingfocus/chat-auth": packageFiles["@turingfocus/chat-auth"],
    },
    devDependencies: {
      typescript: "5.9.3",
    },
    pnpm: {
      overrides: {
        "@turingfocus/chat-auth": packageFiles["@turingfocus/chat-auth"],
      },
    },
  };
  const authHeadlessConsumerSource = await readFile(
    path.join(
      rootDirectory,
      "tests",
      "consumers",
      "auth-headless",
      "consumer.ts",
    ),
    "utf8",
  );
  await verifyConsumerProject(
    {
      directory: authHeadlessConsumerDirectory,
      bundle: true,
      manifest: authHeadlessConsumerManifest,
      packageNames: ["@turingfocus/chat-auth"],
      forbiddenPackageMarkers: ["react@", "antd@", "react-dom@"],
      sourceFiles: {
        "consumer.ts": authHeadlessConsumerSource,
        "index.ts": [
          'import { runAuthHeadlessConsumerVerification } from "./consumer.js";',
          "await runAuthHeadlessConsumerVerification();",
          "",
        ].join("\n"),
      },
      tsconfig: {
        compilerOptions: {
          lib: ["ES2022"],
          types: [],
          module: "NodeNext",
          moduleResolution: "NodeNext",
          outDir: "dist",
          strict: true,
          target: "ES2022",
        },
        include: ["consumer.ts", "index.ts"],
      },
    },
    packManifest.packages,
  );

  console.log(
    "Verified packed auth headless lifecycle without UI dependencies.",
  );
  const authCommonSource = await readFile(
    path.join(rootDirectory, "tests", "consumers", "auth-common.ts"),
    "utf8",
  );
  for (const ui of [false, true]) {
    const kind = ui ? "auth-antd" : "auth-react";
    const runName = ui
      ? "runAuthAntdConsumerVerification"
      : "runAuthReactConsumerVerification";
    const source = await readFile(
      path.join(rootDirectory, "tests", "consumers", kind, "consumer.ts"),
      "utf8",
    );
    await verifyConsumerProject(
      {
        directory: ui ? authAntdConsumerDirectory : authReactConsumerDirectory,
        manifest: {
          name: `tf-chat-kit-${kind}-consumer`,
          version: "0.0.0",
          private: true,
          type: "module",
          packageManager: "pnpm@10.34.5",
          dependencies: {
            "@turingfocus/chat-auth": packageFiles["@turingfocus/chat-auth"],
            react: "18.3.1",
            "react-dom": "18.3.1",
            jsdom: "29.1.1",
            ...(ui ? { antd: "5.23.4" } : {}),
          },
          devDependencies: {
            typescript: "5.9.3",
            "@types/react": "18.3.31",
            "@types/react-dom": "18.3.7",
            "@types/jsdom": "28.0.3",
            "@types/node": "24.13.3",
          },
          pnpm: {
            overrides: {
              "@turingfocus/chat-auth": packageFiles["@turingfocus/chat-auth"],
            },
          },
        },
        packageNames: ["@turingfocus/chat-auth"],
        forbiddenPackageMarkers: ui
          ? ["next@", "office-js@", "@tauri-apps+"]
          : ["antd@", "next@", "office-js@", "@tauri-apps+"],
        sourceFiles: {
          "auth-common.ts": authCommonSource,
          [`${kind}/consumer.ts`]: source,
          "index.ts": `import { ${runName} } from "./${kind}/consumer.js";\nawait ${runName}();\n`,
        },
        tsconfig: {
          compilerOptions: {
            module: "NodeNext",
            moduleResolution: "NodeNext",
            target: "ES2022",
            outDir: "dist",
            strict: true,
            skipLibCheck: true,
            exactOptionalPropertyTypes: true,
            lib: ["ES2022", "DOM", "DOM.Iterable"],
          },
          include: ["**/*.ts"],
        },
      },
      packManifest.packages,
    );
    console.log(`Verified packed ${kind} lifecycle and dependency isolation.`);
  }

  const managerSource = await readFile(
    path.join(rootDirectory, "tests/consumers/manager/consumer.ts"),
    "utf8",
  );
  for (const host of ["web", "office"]) {
    const directory = path.join(verificationRoot, `manager-${host}-consumer`);
    await mkdir(directory);
    await verifyConsumerProject(
      {
        directory,
        manifest: {
          name: `manager-${host}-consumer`,
          version: "0.0.0",
          private: true,
          type: "module",
          packageManager: "pnpm@10.34.5",
          dependencies: {
            "@turingfocus/chat-auth": packageFiles["@turingfocus/chat-auth"],
            "@turingfocus/chat-kit": packageFiles["@turingfocus/chat-kit"],
            "socket.io": "4.8.3",
          },
          devDependencies: { typescript: "5.9.3", "@types/node": "24.13.3" },
          pnpm: {
            overrides: packageFiles,
            peerDependencyRules: {
              ignoreMissing: ["react", "react-dom", "antd", "@types/react"],
            },
          },
        },
        packageNames: ["@turingfocus/chat-auth", "@turingfocus/chat-kit"],
        forbiddenPackageMarkers: [
          "react@",
          "react-dom@",
          "antd@",
          "office-js@",
          "next@",
        ],
        sourceFiles: {
          ".npmrc": "auto-install-peers=false\n",
          "consumer.ts": managerSource,
          "index.ts": `import { runManagerConsumerVerification } from "./consumer.js";\nawait runManagerConsumerVerification("${host}");\n`,
        },
        tsconfig: {
          compilerOptions: {
            module: "NodeNext",
            moduleResolution: "NodeNext",
            target: "ES2022",
            outDir: "dist",
            strict: true,
            skipLibCheck: true,
            exactOptionalPropertyTypes: true,
            lib: ["ES2022"],
            types: ["node"],
          },
          include: ["**/*.ts"],
        },
      },
      packManifest.packages,
    );
  }

  const authChatSource = await readFile(
    path.join(rootDirectory, "tests/consumers/auth-chat/consumer.ts"),
    "utf8",
  );
  const authChatUiSource = await readFile(
    path.join(rootDirectory, "tests/consumers/auth-chat/ui.ts"),
    "utf8",
  );
  for (const ui of [false, true]) {
    const directory = path.join(
      verificationRoot,
      ui ? "auth-chat-ui-consumer" : "auth-chat-headless-consumer",
    );
    await mkdir(directory);
    const runName = ui
      ? "runAuthChatUiConsumerVerification"
      : "runAuthChatConsumerVerification";
    await verifyConsumerProject(
      {
        directory,
        manifest: {
          name: ui
            ? "tf-chat-kit-auth-chat-ui-consumer"
            : "tf-chat-kit-auth-chat-headless-consumer",
          version: "0.0.0",
          private: true,
          type: "module",
          packageManager: "pnpm@10.34.5",
          dependencies: {
            "@turingfocus/chat-auth": packageFiles["@turingfocus/chat-auth"],
            "@turingfocus/chat-kit": packageFiles["@turingfocus/chat-kit"],
            "socket.io": "4.8.1",
            ...(ui
              ? {
                  react: "18.3.1",
                  "react-dom": "18.3.1",
                  antd: "5.23.4",
                  jsdom: "29.1.1",
                }
              : {}),
          },
          devDependencies: {
            typescript: "5.9.3",
            "@types/node": "24.13.3",
            ...(ui
              ? {
                  "@types/react": "18.3.31",
                  "@types/react-dom": "18.3.7",
                  "@types/jsdom": "28.0.3",
                }
              : {}),
          },
          pnpm: {
            overrides: packageFiles,
            ...(ui
              ? {}
              : {
                  peerDependencyRules: {
                    ignoreMissing: [
                      "react",
                      "react-dom",
                      "antd",
                      "@types/react",
                    ],
                  },
                }),
          },
        },
        packageNames: ["@turingfocus/chat-auth", "@turingfocus/chat-kit"],
        forbiddenPackageMarkers: ui
          ? ["next@", "office-js@", "@tauri-apps+"]
          : ["react@", "react-dom@", "antd@"],
        sourceFiles: {
          ...(!ui ? { ".npmrc": "auto-install-peers=false\n" } : {}),
          "auth-chat/consumer.ts": authChatSource,
          ...(ui
            ? {
                "auth-chat/ui.ts": authChatUiSource,
                "auth-common.ts": authCommonSource,
              }
            : {}),
          "index.ts": `import { ${runName} } from "./auth-chat/${ui ? "ui" : "consumer"}.js";\nawait ${runName}();\n`,
        },
        tsconfig: {
          compilerOptions: {
            module: "NodeNext",
            moduleResolution: "NodeNext",
            target: "ES2022",
            outDir: "dist",
            strict: true,
            skipLibCheck: true,
            exactOptionalPropertyTypes: true,
            lib: ui ? ["ES2022", "DOM", "DOM.Iterable"] : ["ES2022"],
            types: ["node"],
          },
          include: ["**/*.ts"],
        },
      },
      packManifest.packages,
    );
    console.log(
      `Verified packed authenticated chat ${ui ? "UI" : "headless"} through real HTTP/Socket.IO.`,
    );
  }

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

  const facadeProductionPackageNames = [
    "@turingfocus/chat-kit",
    "@turingfocus/chat-gateway-tfrobot",
    "@turingfocus/chat-protocol",
    "@turingfocus/chat-react",
    "@turingfocus/chat-runtime",
    "@turingfocus/chat-ui-antd",
  ];
  const reactConsumerPackageFiles = Object.fromEntries(
    facadeProductionPackageNames.map((name) => [name, packageFiles[name]]),
  );
  const reactConsumerManifest = {
    name: "tf-chat-kit-react-consumer",
    version: "0.0.0",
    private: true,
    type: "module",
    packageManager: "pnpm@10.34.5",
    dependencies: {
      "@turingfocus/chat-kit": packageFiles["@turingfocus/chat-kit"],
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
      forbiddenPackageMarkers: ["@turingfocus+chat-auth@"],
      manifest: reactConsumerManifest,
      sourceFiles: {
        "index.ts": [
          'import { createElement } from "react";',
          'import { ChatProvider, ChatResourceProvider, useChatResource, ChatDocumentSourceProvider, useChatEventNavigation, useConversationWorkspace, useChatSelector, type ChatClient, type ChatSnapshot } from "@turingfocus/chat-kit/react";',
          "",
          'if (typeof useConversationWorkspace !== "function") throw new Error("React facade workspace hook is unavailable");',
          'if ([ChatResourceProvider, useChatResource, ChatDocumentSourceProvider, useChatEventNavigation].some(value => typeof value !== "function")) throw new Error("React parity facade unavailable");',
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
      packageNames: ["@turingfocus/chat-kit"],
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

  const headlessFacadeConsumerManifest = {
    name: "tf-chat-kit-headless-facade-consumer",
    version: "0.0.0",
    private: true,
    type: "module",
    packageManager: "pnpm@10.34.5",
    dependencies: {
      "@turingfocus/chat-kit": packageFiles["@turingfocus/chat-kit"],
    },
    devDependencies: {
      typescript: "5.9.3",
      "@types/node": "24.13.3",
      "socket.io": "4.8.3",
    },
    pnpm: { overrides: reactConsumerPackageFiles },
  };
  await verifyConsumerProject(
    {
      directory: headlessFacadeConsumerDirectory,
      manifest: headlessFacadeConsumerManifest,
      packageNames: ["@turingfocus/chat-kit"],
      sourceFiles: {
        "remote-tool-consumer.ts": await readFile(
          path.join(
            rootDirectory,
            "docs/baselines/issue-80/remote-tool-consumer.ts",
          ),
          "utf8",
        ),
        "index.ts": [
          'import { verifyRemoteToolConsumer } from "./remote-tool-consumer.js";',
          "await verifyRemoteToolConsumer();",
          'import { formatChatDiagnostic, appendComposerReference, resolveComposerDraftText, createConversationWorkspaceController, createTFRobotChatClient, type ChatResourcePort, type SessionProvider, type TFRobotSession } from "@turingfocus/chat-kit/headless";',
          "",
          'if (typeof formatChatDiagnostic !== "function") throw new Error("Headless diagnostic formatter is unavailable");',
          'if (typeof createConversationWorkspaceController !== "function") throw new Error("Headless facade workspace controller is unavailable");',
          "",
          'const resourcePort: ChatResourcePort = { download: ({ resource, signal }) => { if (signal.aborted || resource.uri !== "private:report") throw new Error("Invalid headless resource operation"); } };',
          'await resourcePort.download?.({ resource: { uri: "private:report" }, purpose: "download", signal: { aborted: false, subscribe: () => () => undefined } });',
          'const draft = { conversationId: "headless", text: "", revision: 0, longTexts: [], attachments: [] };',
          'const referenced = appendComposerReference(draft, { id: "doc", title: "Guide", content: "Full text" }, "reference");',
          'if (resolveComposerDraftText({ ...draft, ...referenced }) !== "Guide\\nFull text") throw new Error("Headless reference expansion failed");',
          "let sessionReads = 0;",
          "const sessionProvider: SessionProvider<TFRobotSession> = {",
          '  getSession: () => { sessionReads += 1; return { kind: "bearer", token: "headless-facade-token" }; },',
          "  onSessionInvalid: () => undefined,",
          "};",
          "const client = createTFRobotChatClient({",
          '  baseUrl: "https://headless.example.test/api/",',
          '  messageCreatorProvider: () => ({ uid: "headless-user", name: "Headless User" }),',
          "  sessionProvider,",
          '  socketFactory: () => { throw new Error("Headless construction must not create a Socket"); },',
          "});",
          'if (sessionReads !== 0) throw new Error("Headless construction read session material eagerly");',
          "await client.dispose({ deadlineAt: Date.now() + 1_000 });",
          'if (!client.disposed) throw new Error("Headless facade client did not dispose");',
          'console.log("Verified the packed Headless facade entry without importing React APIs.");',
          "",
        ].join("\n"),
      },
      tsconfig: {
        compilerOptions: {
          exactOptionalPropertyTypes: true,
          lib: ["ES2023", "DOM"],
          module: "NodeNext",
          moduleResolution: "NodeNext",
          outDir: "dist",
          strict: true,
          target: "ES2023",
        },
        include: ["index.ts", "remote-tool-consumer.ts"],
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
        "@turingfocus+chat-auth@",
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
    ...facadeProductionPackageNames,
    "@turingfocus/chat-testing",
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
      "@turingfocus/chat-kit": packageFiles["@turingfocus/chat-kit"],
      "@turingfocus/chat-testing": packageFiles["@turingfocus/chat-testing"],
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
  for (const forbiddenLeafImport of [
    "@turingfocus/chat-gateway-tfrobot",
    "@turingfocus/chat-protocol",
    "@turingfocus/chat-react",
    "@turingfocus/chat-runtime",
    "@turingfocus/chat-ui-antd",
  ]) {
    if (tauriConsumerSource.includes(`from "${forbiddenLeafImport}"`)) {
      throw new Error(
        `Tauri-style default consumer must import production APIs from @turingfocus/chat-kit; found ${forbiddenLeafImport}`,
      );
    }
  }
  await verifyConsumerProject(
    {
      directory: tauriStyleConsumerDirectory,
      forbiddenPackageMarkers: [
        "@turingfocus+chat-auth@",
        "@tauri-apps+",
        "next@",
        "office-js@",
      ],
      manifest: tauriStyleConsumerManifest,
      packageNames: ["@turingfocus/chat-kit", "@turingfocus/chat-testing"],
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
    "@turingfocus/chat-kit",
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
      "@turingfocus/chat-kit": packageFiles["@turingfocus/chat-kit"],
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
  for (const forbiddenLeafImport of [
    "@turingfocus/chat-gateway-tfrobot",
    "@turingfocus/chat-protocol",
    "@turingfocus/chat-react",
    "@turingfocus/chat-runtime",
    "@turingfocus/chat-ui-antd",
  ]) {
    if (tfrobotfrontConsumerSource.includes(`from "${forbiddenLeafImport}"`)) {
      throw new Error(
        `TFRobotFront-style default consumer must import only @turingfocus/chat-kit; found ${forbiddenLeafImport}`,
      );
    }
  }
  await verifyConsumerProject(
    {
      directory: tfrobotfrontStyleConsumerDirectory,
      manifest: tfrobotfrontStyleConsumerManifest,
      packageNames: ["@turingfocus/chat-kit"],
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

console.log(
  packageSource === "packed"
    ? "Packed artifact validation passed."
    : `Public Registry consumer validation passed for ${registryPackages.map(({ name, version }) => `${name}@${version}`).join(", ")}.`,
);
