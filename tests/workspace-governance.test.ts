import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  collectSourceFiles,
  loadWorkspaceSnapshot,
  validateWorkspaceSnapshot,
} from "../scripts/workspace-policy.mjs";

const clone = <T>(value: T): T => structuredClone(value);

const replacePackageSource = (
  snapshot: Awaited<ReturnType<typeof loadWorkspaceSnapshot>>,
  directory: string,
  content: string,
) => {
  const source = snapshot.sourceFiles.find(({ path }) =>
    path.startsWith(`packages/${directory}/src/`),
  );
  if (!source) throw new Error(`Missing source fixture for ${directory}`);
  source.content = content;
};

describe("workspace governance", () => {
  it("accepts the committed six-package architecture", async () => {
    const snapshot = await loadWorkspaceSnapshot(process.cwd());
    expect(validateWorkspaceSnapshot(snapshot)).toEqual([]);
  });

  it("rejects unified version drift", async () => {
    const snapshot = clone(await loadWorkspaceSnapshot(process.cwd()));
    snapshot.packages[0]!.manifest.version = "0.2.0";

    expect(validateWorkspaceSnapshot(snapshot)).toContainEqual(
      expect.stringContaining("workspace package versions must match"),
    );
  });

  it("accepts a fixed-group 0.x version bump", async () => {
    const snapshot = clone(await loadWorkspaceSnapshot(process.cwd()));
    for (const entry of snapshot.packages) entry.manifest.version = "0.2.0";

    expect(validateWorkspaceSnapshot(snapshot)).toEqual([]);
  });

  it("rejects changeset configuration drift from the approved fixed group", async () => {
    const snapshot = clone(await loadWorkspaceSnapshot(process.cwd()));
    snapshot.changesetConfig = {
      fixed: [["@turingfocus/chat-runtime"]],
      changelog: false,
    };

    expect(validateWorkspaceSnapshot(snapshot)).toContainEqual(
      expect.stringContaining(
        "changeset configuration must exactly match the approved fixed-group policy",
      ),
    );
  });

  it("rejects public package release metadata drift", async () => {
    const snapshot = clone(await loadWorkspaceSnapshot(process.cwd()));
    const runtime = snapshot.packages.find(
      ({ directory }) => directory === "chat-runtime",
    )!;
    runtime.manifest.license = "UNLICENSED";
    runtime.manifest.publishConfig = {
      access: "restricted",
      registry: "https://npm.pkg.github.com/",
    };
    runtime.manifest.repository = {
      type: "git",
      url: "git+https://github.com/A2C-SMCP/not-tf-chat-kit.git",
      directory: "packages/not-chat-runtime",
    };

    const errors = validateWorkspaceSnapshot(snapshot);
    expect(errors).toContain("@turingfocus/chat-runtime: license must be MIT");
    expect(errors).toContain(
      "@turingfocus/chat-runtime: publishConfig.access must be public",
    );
    expect(errors).toContain(
      "@turingfocus/chat-runtime: publishConfig.registry must be https://registry.npmjs.org/",
    );
    expect(errors).toContainEqual(
      expect.stringContaining("repository.url must be"),
    );
    expect(errors).toContain(
      "@turingfocus/chat-runtime: repository.directory must be packages/chat-runtime",
    );
  });

  it("rejects root repository metadata drift", async () => {
    const snapshot = clone(await loadWorkspaceSnapshot(process.cwd()));
    snapshot.rootManifest.license = "UNLICENSED";
    snapshot.rootManifest.homepage = "https://example.com";

    const errors = validateWorkspaceSnapshot(snapshot);
    expect(errors).toContain("root license must be MIT");
    expect(errors).toContainEqual(
      expect.stringContaining("root: homepage must"),
    );
  });

  it("rejects a unified version outside the 0.x line", async () => {
    const snapshot = clone(await loadWorkspaceSnapshot(process.cwd()));
    for (const entry of snapshot.packages) entry.manifest.version = "1.0.0";

    expect(validateWorkspaceSnapshot(snapshot)).toContainEqual(
      expect.stringContaining("must be valid 0.x SemVer"),
    );
  });

  it("rejects reverse internal dependencies", async () => {
    const snapshot = clone(await loadWorkspaceSnapshot(process.cwd()));
    const protocol = snapshot.packages.find(
      ({ directory }) => directory === "chat-protocol",
    )!;
    protocol.manifest.dependencies = {
      "@turingfocus/chat-ui-antd": "workspace:^",
    };

    expect(validateWorkspaceSnapshot(snapshot)).toContainEqual(
      expect.stringContaining("internal dependencies must be"),
    );
  });

  it("keeps chat-testing independent of the future Runtime implementation", async () => {
    const snapshot = clone(await loadWorkspaceSnapshot(process.cwd()));
    const testing = snapshot.packages.find(
      ({ directory }) => directory === "chat-testing",
    )!;
    testing.manifest.dependencies ??= {};
    testing.manifest.dependencies["@turingfocus/chat-runtime"] = "workspace:^";

    expect(validateWorkspaceSnapshot(snapshot)).toContainEqual(
      expect.stringContaining(
        '@turingfocus/chat-testing: internal dependencies must be {"@turingfocus/chat-protocol":"workspace:^"}',
      ),
    );
  });

  it("rejects React and Ant Design outside their allowed packages", async () => {
    const snapshot = clone(await loadWorkspaceSnapshot(process.cwd()));
    const runtime = snapshot.packages.find(
      ({ directory }) => directory === "chat-runtime",
    )!;
    runtime.manifest.peerDependencies = { antd: "^5.0.0", react: "^18.0.0" };

    const errors = validateWorkspaceSnapshot(snapshot);
    expect(errors).toContainEqual(
      expect.stringContaining("React is only allowed"),
    );
    expect(errors).toContainEqual(
      expect.stringContaining("Ant Design is only allowed"),
    );
  });

  it.each(["chat-protocol", "chat-runtime"])(
    "rejects a React runtime import from %s without a manifest declaration",
    async (directory) => {
      const snapshot = clone(await loadWorkspaceSnapshot(process.cwd()));
      replacePackageSource(
        snapshot,
        directory,
        'import { createElement } from "react";\nexport const element = createElement("span");',
      );

      expect(validateWorkspaceSnapshot(snapshot)).toContainEqual(
        expect.stringContaining(
          `@turingfocus/${directory} source runtime import react is not allowed by package policy`,
        ),
      );
    },
  );

  it("rejects Ant Design imports from chat-react", async () => {
    const snapshot = clone(await loadWorkspaceSnapshot(process.cwd()));
    replacePackageSource(
      snapshot,
      "chat-react",
      'export { Button } from "antd";',
    );

    expect(validateWorkspaceSnapshot(snapshot)).toContainEqual(
      expect.stringContaining(
        "@turingfocus/chat-react source runtime import antd is not allowed by package policy",
      ),
    );
  });

  it.each(["react-dom/client", "monaco-editor", "@xterm/xterm"])(
    "rejects the %s renderer import from a headless package",
    async (specifier) => {
      const snapshot = clone(await loadWorkspaceSnapshot(process.cwd()));
      replacePackageSource(
        snapshot,
        "chat-runtime",
        `export * from ${JSON.stringify(specifier)};`,
      );

      expect(validateWorkspaceSnapshot(snapshot)).toContainEqual(
        expect.stringContaining("is not allowed by package policy"),
      );
    },
  );

  it("rejects an undeclared ordinary npm import", async () => {
    const snapshot = clone(await loadWorkspaceSnapshot(process.cwd()));
    replacePackageSource(
      snapshot,
      "chat-testing",
      'import "unreviewed-package/subpath";',
    );

    expect(validateWorkspaceSnapshot(snapshot)).toContainEqual(
      expect.stringContaining(
        "source runtime import unreviewed-package is not allowed by package policy",
      ),
    );
  });

  it("requires allowed runtime imports to be declared in a runtime section", async () => {
    const snapshot = clone(await loadWorkspaceSnapshot(process.cwd()));
    replacePackageSource(
      snapshot,
      "chat-ui-antd",
      'const editor = import("monaco-editor");\nvoid editor;',
    );

    expect(validateWorkspaceSnapshot(snapshot)).toContainEqual(
      expect.stringContaining(
        "source runtime import monaco-editor must be declared in dependencies",
      ),
    );
  });

  it("accepts declared peer, renderer, internal, and relative imports", async () => {
    const snapshot = clone(await loadWorkspaceSnapshot(process.cwd()));
    const ui = snapshot.packages.find(
      ({ directory }) => directory === "chat-ui-antd",
    )!;
    ui.manifest.dependencies ??= {};
    ui.manifest.dependencies["monaco-editor"] = "^0.52.0";
    replacePackageSource(
      snapshot,
      "chat-ui-antd",
      [
        'import type { ReactNode } from "react";',
        'export { createElement } from "react";',
        'export type { ComponentType } from "react";',
        'type LazyExotic = import("react").LazyExoticComponent<never>;',
        'import "monaco-editor/esm/vs/editor/editor.api.js";',
        'import "@turingfocus/chat-react";',
        'import "./styles.js";',
        "export type { LazyExotic, ReactNode };",
      ].join("\n"),
    );

    expect(validateWorkspaceSnapshot(snapshot)).toEqual([]);
  });

  it("allows socket.io-client only as a Gateway production dependency", async () => {
    const snapshot = clone(await loadWorkspaceSnapshot(process.cwd()));
    const gateway = snapshot.packages.find(
      ({ directory }) => directory === "chat-gateway-tfrobot",
    )!;
    gateway.manifest.dependencies ??= {};
    gateway.manifest.dependencies["socket.io-client"] = "^4.8.1";
    replacePackageSource(
      snapshot,
      "chat-gateway-tfrobot",
      'import { io } from "socket.io-client"; void io;',
    );

    expect(validateWorkspaceSnapshot(snapshot)).toEqual([]);
  });

  it.each([
    "chat-protocol",
    "chat-runtime",
    "chat-react",
    "chat-ui-antd",
    "chat-testing",
  ])("rejects socket.io-client outside the Gateway: %s", async (directory) => {
    const snapshot = clone(await loadWorkspaceSnapshot(process.cwd()));
    const target = snapshot.packages.find(
      (entry) => entry.directory === directory,
    )!;
    target.manifest.dependencies ??= {};
    target.manifest.dependencies["socket.io-client"] = "^4.8.1";
    replacePackageSource(
      snapshot,
      directory,
      'import { io } from "socket.io-client"; void io;',
    );

    expect(validateWorkspaceSnapshot(snapshot)).toContainEqual(
      expect.stringContaining(
        "external dependency socket.io-client is not allowed by package policy",
      ),
    );
  });

  it("treats mixed type/value imports as runtime imports", async () => {
    const snapshot = clone(await loadWorkspaceSnapshot(process.cwd()));
    replacePackageSource(
      snapshot,
      "chat-protocol",
      'import { type ReactNode, createElement } from "react";\nexport { ReactNode, createElement };',
    );

    expect(validateWorkspaceSnapshot(snapshot)).toContainEqual(
      expect.stringContaining("source runtime import react"),
    );
  });

  it("rejects non-literal dynamic imports because their boundary is unauditable", async () => {
    const snapshot = clone(await loadWorkspaceSnapshot(process.cwd()));
    replacePackageSource(
      snapshot,
      "chat-runtime",
      'const moduleName = "react";\nvoid import(moduleName);',
    );

    expect(validateWorkspaceSnapshot(snapshot)).toContainEqual(
      expect.stringContaining(
        "dynamic import module specifier must be a static string literal",
      ),
    );
  });

  it.each([
    [
      "reverse internal dependency",
      "chat-testing",
      'require("@turingfocus/chat-ui-antd");',
      "source import @turingfocus/chat-ui-antd is not allowed by package policy",
    ],
    [
      "React dependency",
      "chat-protocol",
      'require.resolve("react");',
      "source runtime import react is not allowed by package policy",
    ],
    [
      "Ant Design dependency",
      "chat-react",
      'module.require("antd");',
      "source runtime import antd is not allowed by package policy",
    ],
    [
      "renderer dependency",
      "chat-runtime",
      'require("monaco-editor");',
      "source runtime import monaco-editor is not allowed by package policy",
    ],
    [
      "undeclared ordinary dependency",
      "chat-testing",
      'module.require("unreviewed-package/subpath");',
      "source runtime import unreviewed-package is not allowed by package policy",
    ],
  ])(
    "rejects CommonJS loading of a %s",
    async (_label, directory, content, expectedError) => {
      const snapshot = clone(await loadWorkspaceSnapshot(process.cwd()));
      replacePackageSource(snapshot, directory, content);

      expect(validateWorkspaceSnapshot(snapshot)).toContainEqual(
        expect.stringContaining(expectedError),
      );
    },
  );

  it.each([
    [
      "ambient process variable",
      'declare const process: { env: Record<string, string | undefined> }; export const token = process.env["NPM_TOKEN"];',
      "node:process",
    ],
    [
      "ambient Buffer variable",
      'declare const Buffer: { from(value: string): Uint8Array }; export const bytes = Buffer.from("chat");',
      "node:buffer",
    ],
    [
      "ambient require function",
      'declare function require(name: string): unknown; export const fs = require("node:fs");',
      "node:fs",
    ],
    [
      "ambient module variable",
      'declare const module: { require(name: string): unknown }; export const fs = module.require("node:fs");',
      "node:fs",
    ],
    [
      "declare global process variable",
      'export {}; declare global { const process: { env: Record<string, string | undefined> } } export const token = process.env["NPM_TOKEN"];',
      "node:process",
    ],
  ])(
    "rejects Node.js access hidden behind an %s",
    async (_label, content, builtin) => {
      const snapshot = clone(await loadWorkspaceSnapshot(process.cwd()));
      replacePackageSource(snapshot, "chat-runtime", content);

      expect(validateWorkspaceSnapshot(snapshot)).toContainEqual(
        expect.stringContaining(
          `source runtime import ${builtin} uses a Node.js built-in that is not allowed by package policy`,
        ),
      );
    },
  );

  it.each([
    ["chat-testing", "void process.env.NPM_TOKEN;", "node:process"],
    [
      "chat-runtime",
      'const bytes = Buffer.from("chat"); void bytes;',
      "node:buffer",
    ],
    ["chat-runtime", "void globalThis.process.env.NPM_TOKEN;", "node:process"],
    ["chat-runtime", 'void globalThis.Buffer.from("chat");', "node:buffer"],
    ["chat-testing", "void __dirname;", "node:module"],
    ["chat-testing", "void __filename;", "node:module"],
    ["chat-testing", "setImmediate(() => undefined);", "node:timers"],
    ["chat-testing", "clearImmediate(undefined);", "node:timers"],
    ["chat-testing", "void global.process;", "node:process"],
  ])(
    "rejects Node.js global access from %s: %s",
    async (directory, content, builtin) => {
      const snapshot = clone(await loadWorkspaceSnapshot(process.cwd()));
      replacePackageSource(snapshot, directory, content);

      expect(validateWorkspaceSnapshot(snapshot)).toContainEqual(
        expect.stringContaining(
          `source runtime import ${builtin} uses a Node.js built-in that is not allowed by package policy`,
        ),
      );
    },
  );

  it.each([
    ['const dependency = "react"; require(dependency);', "require"],
    [
      'const dependency = "react"; require.resolve(dependency);',
      "require.resolve",
    ],
    [
      'const dependency = "react"; module.require(dependency);',
      "module.require",
    ],
  ])(
    "rejects a non-literal CommonJS module specifier",
    async (content, loader) => {
      const snapshot = clone(await loadWorkspaceSnapshot(process.cwd()));
      replacePackageSource(snapshot, "chat-runtime", content);

      expect(validateWorkspaceSnapshot(snapshot)).toContainEqual(
        expect.stringContaining(
          `${loader} module specifier must be a static string literal`,
        ),
      );
    },
  );

  it("accepts statically declared CommonJS dependencies", async () => {
    const snapshot = clone(await loadWorkspaceSnapshot(process.cwd()));
    const ui = snapshot.packages.find(
      ({ directory }) => directory === "chat-ui-antd",
    )!;
    ui.manifest.dependencies ??= {};
    ui.manifest.dependencies["monaco-editor"] = "^0.52.0";
    replacePackageSource(
      snapshot,
      "chat-ui-antd",
      [
        'const editorPath = require.resolve("monaco-editor");',
        "export { editorPath };",
      ].join("\n"),
    );

    expect(validateWorkspaceSnapshot(snapshot)).toEqual([]);
  });

  it.each([
    "node:test",
    "node:sqlite",
    "node:test/reporters",
    "fs/promises",
    "node:fs/promises",
    "node:process",
  ])(
    "rejects the Node.js built-in specifier %s from chat-runtime",
    async (specifier) => {
      const snapshot = clone(await loadWorkspaceSnapshot(process.cwd()));
      replacePackageSource(
        snapshot,
        "chat-runtime",
        `import ${JSON.stringify(specifier)};`,
      );

      expect(validateWorkspaceSnapshot(snapshot)).toContainEqual(
        expect.stringContaining(
          `@turingfocus/chat-runtime source runtime import ${specifier} uses a Node.js built-in that is not allowed by package policy`,
        ),
      );
    },
  );

  it.each(["test", "sqlite", "test/reporters"])(
    "does not mistake the bare package specifier %s for a Node.js built-in",
    async (specifier) => {
      const snapshot = clone(await loadWorkspaceSnapshot(process.cwd()));
      replacePackageSource(
        snapshot,
        "chat-runtime",
        `import ${JSON.stringify(specifier)};`,
      );

      expect(validateWorkspaceSnapshot(snapshot)).toContainEqual(
        expect.stringContaining(
          `source runtime import ${specifier.split("/")[0]} is not allowed by package policy`,
        ),
      );
    },
  );

  it("accepts shadowed CommonJS names and ordinary createRequire properties", async () => {
    const snapshot = clone(await loadWorkspaceSnapshot(process.cwd()));
    replacePackageSource(
      snapshot,
      "chat-runtime",
      [
        "const require = (value: string) => value;",
        'require("react");',
        "const module = { require: (value: string) => value };",
        'module.require("antd");',
        "const tools = { createRequire: () => undefined };",
        "tools.createRequire();",
        "const Buffer = { from: (value: string) => value };",
        'Buffer.from("chat");',
        "function useLocalProcess(process: { env: object }) {",
        "  return process.env;",
        "}",
        "void useLocalProcess;",
      ].join("\n"),
    );

    expect(validateWorkspaceSnapshot(snapshot)).toEqual([]);
  });

  it("accepts a shadowed Function binding", async () => {
    const snapshot = clone(await loadWorkspaceSnapshot(process.cwd()));
    replacePackageSource(
      snapshot,
      "chat-runtime",
      'const Function = (source: string) => source;\nFunction("import(\\"react\\")");',
    );

    expect(validateWorkspaceSnapshot(snapshot)).toEqual([]);
  });

  it.each([
    'import { createRequire as makeRequire } from "node:module";\nconst load = makeRequire(import.meta.url);\nload("@turingfocus/chat-ui-antd");',
    'import * as moduleApi from "node:module";\nmoduleApi.createRequire(import.meta.url);',
    'const { createRequire: makeRequire } = require("node:module");\nmakeRequire(import.meta.url);',
    'const makeRequire = require("node:module").createRequire;\nmakeRequire(import.meta.url);',
    'const { createRequire: makeRequire } = await import("node:module");\nmakeRequire(import.meta.url);',
    'export { createRequire as makeRequire } from "node:module";',
    'export * from "node:module";',
  ])("prohibits createRequire acquisition: %s", async (content) => {
    const snapshot = clone(await loadWorkspaceSnapshot(process.cwd()));
    replacePackageSource(snapshot, "chat-testing", content);

    expect(validateWorkspaceSnapshot(snapshot)).toContainEqual(
      expect.stringMatching(/createRequire|node:module/u),
    );
  });

  it.each([
    'const load = require; load("react");',
    'const load = module.require; load("react");',
    'const get = process.getBuiltinModule; get("module").createRequire(import.meta.url)("react");',
    'import { getBuiltinModule as get } from "node:process"; get("module").createRequire(import.meta.url)("react");',
    'import processApi from "node:process"; processApi.getBuiltinModule("module");',
    'import * as processApi from "node:process"; processApi.getBuiltinModule("module");',
    'const processApi = await import("node:process"); processApi.getBuiltinModule("module");',
    'const processApi = require("node:process"); processApi.getBuiltinModule("module");',
    'export { getBuiltinModule as get } from "node:process";',
    'export * from "node:process";',
  ])(
    "prohibits one-hop loading capability acquisition: %s",
    async (content) => {
      const snapshot = clone(await loadWorkspaceSnapshot(process.cwd()));
      replacePackageSource(snapshot, "chat-runtime", content);

      expect(validateWorkspaceSnapshot(snapshot)).toContainEqual(
        expect.stringMatching(
          /loading capability|getBuiltinModule|node:process/u,
        ),
      );
    },
  );

  it.each([
    'const { ["getBuiltinModule"]: get } = process; get("module").createRequire(import.meta.url)("react");',
    'const { ["require"]: load } = module; load("react");',
    'const { ["process"]: { ["get" + "BuiltinModule"]: get } } = globalThis; get("module").createRequire(import.meta.url)("react");',
    'let get; ({ ["get" + "BuiltinModule"]: get } = process); get("module");',
    'let load; ({ ["req" + "uire"]: load } = module); load("react");',
    'let get; ({ ["pro" + "cess"]: { ["getBuiltinModule"]: get } } = globalThis); get("module");',
  ])(
    "prohibits statically computed loading capability acquisition: %s",
    async (content) => {
      const snapshot = clone(await loadWorkspaceSnapshot(process.cwd()));
      replacePackageSource(snapshot, "chat-runtime", content);

      expect(validateWorkspaceSnapshot(snapshot)).toContainEqual(
        expect.stringMatching(/loading capability|getBuiltinModule/u),
      );
    },
  );

  it.each([
    [
      "process rest binding",
      'const { ...processApi } = process; processApi.getBuiltinModule("module").createRequire(import.meta.url)("@turingfocus/chat-ui-antd");',
      "alias to the unshadowed process loading capability",
      'process.getBuiltinModule("module") is prohibited',
    ],
    [
      "process rest assignment",
      'let processApi; ({ ...processApi } = process); processApi.getBuiltinModule("module").createRequire(import.meta.url)("@turingfocus/chat-ui-antd");',
      "alias to the unshadowed process loading capability",
      'process.getBuiltinModule("module") is prohibited',
    ],
    [
      "module rest binding",
      'const { ...moduleApi } = module; moduleApi.require("@turingfocus/chat-ui-antd");',
      "alias to the unshadowed module loading capability",
      "source import @turingfocus/chat-ui-antd is not allowed",
    ],
    [
      "module rest assignment",
      'let moduleApi; ({ ...moduleApi } = module); moduleApi.require("@turingfocus/chat-ui-antd");',
      "alias to the unshadowed module loading capability",
      "source import @turingfocus/chat-ui-antd is not allowed",
    ],
  ])(
    "prohibits capability propagation through a %s",
    async (_label, content, expectedAcquisition, expectedDownstreamError) => {
      const snapshot = clone(await loadWorkspaceSnapshot(process.cwd()));
      replacePackageSource(snapshot, "chat-runtime", content);

      const errors = validateWorkspaceSnapshot(snapshot);
      expect(errors).toContainEqual(
        expect.stringContaining(expectedAcquisition),
      );
      expect(errors).toContainEqual(
        expect.stringContaining(expectedDownstreamError),
      );
    },
  );

  it.each([
    'const capability = Math.random() > 0.5 ? "getBuiltinModule" : "env"; const { [capability]: get } = process; void get;',
    'const capability = Math.random() > 0.5 ? "require" : "filename"; let load; ({ [capability]: load } = module); void load;',
    'const capability = Math.random() > 0.5 ? "getBuiltinModule" : "env"; const { process: { [capability]: get } } = globalThis; void get;',
    'const capability = Math.random() > 0.5 ? "getBuiltinModule" : "env"; let get; ({ process: { [capability]: get } } = globalThis); void get;',
  ])(
    "rejects non-static computed destructuring from confirmed capabilities: %s",
    async (content) => {
      const snapshot = clone(await loadWorkspaceSnapshot(process.cwd()));
      replacePackageSource(snapshot, "chat-runtime", content);

      expect(validateWorkspaceSnapshot(snapshot)).toContainEqual(
        expect.stringContaining(
          "requires a statically analyzable property name",
        ),
      );
    },
  );

  it.each([
    'const member = "getBuiltinModule"; process[member]("module").createRequire(import.meta.url)("@turingfocus/chat-ui-antd");',
    'const loader = "require"; module[loader]("@turingfocus/chat-ui-antd");',
    'const member = "getBuiltinModule"; const get = process[member]; get("module").createRequire(import.meta.url)("@turingfocus/chat-ui-antd");',
    'const loader = "require"; const load = module[loader]; load("@turingfocus/chat-ui-antd");',
  ])(
    "rejects non-static property access on confirmed loading capabilities: %s",
    async (content) => {
      const snapshot = clone(await loadWorkspaceSnapshot(process.cwd()));
      replacePackageSource(snapshot, "chat-runtime", content);

      expect(validateWorkspaceSnapshot(snapshot)).toContainEqual(
        expect.stringContaining(
          "requires a statically analyzable property name",
        ),
      );
    },
  );

  it("accepts non-static property access on ordinary and locally shadowed objects", async () => {
    const snapshot = clone(await loadWorkspaceSnapshot(process.cwd()));
    replacePackageSource(
      snapshot,
      "chat-runtime",
      [
        "const business = { load: (value: string) => value };",
        'const businessMember = Math.random() > 0.5 ? "load" : "missing";',
        'business[businessMember]?.("value");',
        "const process = { getBuiltinModule: (value: string) => value };",
        'const processMember = "getBuiltinModule";',
        'process[processMember]("module");',
        "const module = { require: (value: string) => value };",
        'const moduleMember = "require";',
        'module[moduleMember]("react");',
      ].join("\n"),
    );

    expect(validateWorkspaceSnapshot(snapshot)).toEqual([]);
  });

  it("accepts shadowed loading names", async () => {
    const snapshot = clone(await loadWorkspaceSnapshot(process.cwd()));
    replacePackageSource(
      snapshot,
      "chat-runtime",
      [
        "const require = (value: string) => value;",
        "const module = { require: (value: string) => value };",
        "const process = { getBuiltinModule: (value: string) => value };",
        'require("react");',
        'module.require("react");',
        'process.getBuiltinModule("module");',
      ].join("\n"),
    );

    expect(validateWorkspaceSnapshot(snapshot)).toEqual([]);
  });

  it("accepts aliases derived from locally shadowed global names", async () => {
    const snapshot = clone(await loadWorkspaceSnapshot(process.cwd()));
    replacePackageSource(
      snapshot,
      "chat-runtime",
      [
        "const module = { require: (value: string) => value };",
        "const moduleApi = (module);",
        'moduleApi.require("react");',
        "const process = { getBuiltinModule: (value: string) => value };",
        "const processApi = (process);",
        'processApi.getBuiltinModule("module");',
        "const globalThis = { process };",
        "const { process: globalProcessApi } = (globalThis);",
        'globalProcessApi.getBuiltinModule("module");',
        "let assignedModuleApi;",
        "assignedModuleApi = module;",
        'assignedModuleApi.require("react");',
        "let assignedLoad;",
        "({ require: assignedLoad } = module);",
        'assignedLoad("react");',
        "function useShadowedModule(module: { require(value: string): string }) {",
        "  let nestedModuleApi;",
        "  nestedModuleApi = module;",
        '  nestedModuleApi.require("react");',
        "}",
        "const { ...restProcess } = process;",
        'restProcess.getBuiltinModule("module");',
        "let restModule;",
        "({ ...restModule } = module);",
        'restModule.require("react");',
        "void useShadowedModule;",
      ].join("\n"),
    );

    expect(validateWorkspaceSnapshot(snapshot)).toEqual([]);
  });

  it("accepts rest patterns derived from ordinary objects", async () => {
    const snapshot = clone(await loadWorkspaceSnapshot(process.cwd()));
    replacePackageSource(
      snapshot,
      "chat-runtime",
      [
        "const business = { getBuiltinModule: (value: string) => value };",
        "const { ...businessApi } = business;",
        'businessApi.getBuiltinModule("module");',
        "let assignedBusinessApi;",
        "({ ...assignedBusinessApi } = business);",
        'assignedBusinessApi.getBuiltinModule("module");',
      ].join("\n"),
    );

    expect(validateWorkspaceSnapshot(snapshot)).toEqual([]);
  });

  it.each([
    'import { Function as Fn } from "./safe.js"; void Fn;',
    'import { eval as safeEval, require as safeRequire } from "./safe.js"; void safeEval; void safeRequire;',
    'export { Function as Fn, eval as safeEval, require as safeRequire } from "./safe.js";',
    "const safeFunction = 1; export { safeFunction as Function };",
    "const Function = (source: string) => source; export default Function;",
    "declare const safe: object; const { Function: Fn, eval: safeEval, require: safeRequire } = safe; void Fn; void safeEval; void safeRequire;",
    "type Function = string; interface eval { safe: true } type require = number;",
    "interface Callable extends Function {} class Implementor implements Function {}",
    "interface QualifiedCallable extends globalThis.Function {} class QualifiedImplementor implements globalThis.Function {}",
    "const safe = { Function: 1, eval: 2, require: 3 }; void safe.Function; void safe.eval; void safe.require;",
  ])(
    "accepts dynamic-capability names outside value-reference positions: %s",
    async (content) => {
      const snapshot = clone(await loadWorkspaceSnapshot(process.cwd()));
      replacePackageSource(snapshot, "chat-runtime", content);

      expect(validateWorkspaceSnapshot(snapshot)).toEqual([]);
    },
  );

  it.each([
    "Function: { break Function; }",
    "eval: for (;;) { break eval; }",
    "Function: while (true) { continue Function; }",
  ])(
    "accepts dynamic-code names used only as statement labels: %s",
    async (content) => {
      const snapshot = clone(await loadWorkspaceSnapshot(process.cwd()));
      replacePackageSource(snapshot, "chat-runtime", content);

      expect(validateWorkspaceSnapshot(snapshot)).toEqual([]);
    },
  );

  it.each([
    'const run = eval; run("import(\\"react\\")");',
    'const run = Function; run("return import(\\"react\\")")();',
    "const capabilities = { Function, eval }; void capabilities;",
    'const moduleApi = (module); moduleApi.require("react");',
    'const { require: load } = (module); load("react");',
    'let moduleApi; moduleApi = module; moduleApi.require("react");',
    'let load; ({ require: load } = module); load("react");',
    'let shorthandLoad; ({ require: shorthandLoad = () => undefined } = module); shorthandLoad("react");',
    'let processApi; { processApi = globalThis.process; } processApi.getBuiltinModule("module");',
    'let get; { ({ getBuiltinModule: get } = process); } get("module");',
    'const processApi = (process); processApi.getBuiltinModule("module").createRequire(import.meta.url)("react");',
    'const { getBuiltinModule: get } = (process); get("module").createRequire(import.meta.url)("react");',
    'globalThis.process.getBuiltinModule("module").createRequire(import.meta.url)("react");',
    'const processApi = (globalThis.process); processApi.getBuiltinModule("module").createRequire(import.meta.url)("react");',
    'const { process: processApi } = (globalThis); processApi.getBuiltinModule("module").createRequire(import.meta.url)("react");',
    'const { process: { getBuiltinModule: get } } = globalThis; get("module").createRequire(import.meta.url)("@turingfocus/chat-ui-antd");',
    'const { process: { getBuiltinModule: get } } = global; get("module").createRequire(import.meta.url)("@turingfocus/chat-ui-antd");',
    'let get; ({ process: { getBuiltinModule: get } } = globalThis); get("module").createRequire(import.meta.url)("@turingfocus/chat-ui-antd");',
    'let get; ({ process: { getBuiltinModule: get } = {} } = globalThis); get("module").createRequire(import.meta.url)("@turingfocus/chat-ui-antd");',
    'process.getBuiltinModule("module")["create" + "Require"](import.meta.url)("react");',
    'import { Module } from "node:module"; Module._load("react", null);',
    'import { runInThisContext } from "node:vm"; runInThisContext("import(\\"react\\")");',
    'const vm = require("vm"); vm.runInThisContext("import(\\"react\\")");',
    "class DynamicConstructor extends Function {}",
    "class QualifiedDynamicConstructor extends globalThis.Function {}",
  ])(
    "rejects acquisition of dynamic loading capabilities: %s",
    async (content) => {
      const snapshot = clone(await loadWorkspaceSnapshot(process.cwd()));
      replacePackageSource(snapshot, "chat-runtime", content);

      expect(validateWorkspaceSnapshot(snapshot)).toContainEqual(
        expect.stringMatching(
          /dynamic code evaluation|loading capabilit(?:y|ies)|getBuiltinModule|node:vm|vm is prohibited/u,
        ),
      );
    },
  );

  it.each([
    'const name = "module"; process.getBuiltinModule(name).createRequire(import.meta.url)("react");',
    'globalThis.process.getBuiltinModule(Math.random() > 0.5 ? "module" : "fs").createRequire(import.meta.url)("react");',
    'const processApi = (process); const suffix = "dule"; processApi.getBuiltinModule(`mo${suffix}`).createRequire(import.meta.url)("react");',
    'const { getBuiltinModule: get } = process; const name = "module"; get(name).createRequire(import.meta.url)("react");',
  ])(
    "rejects non-static getBuiltinModule specifiers from confirmed process capabilities: %s",
    async (content) => {
      const snapshot = clone(await loadWorkspaceSnapshot(process.cwd()));
      replacePackageSource(snapshot, "chat-runtime", content);

      expect(validateWorkspaceSnapshot(snapshot)).toContainEqual(
        expect.stringContaining(
          "process.getBuiltinModule requires a statically analyzable specifier",
        ),
      );
    },
  );

  it.each([
    'process.getBuiltinModule("fs");',
    'globalThis.process.getBuiltinModule("node:path");',
    "process.getBuiltinModule(`url`);",
  ])(
    "rejects static Node.js built-ins loaded through getBuiltinModule: %s",
    async (content) => {
      const snapshot = clone(await loadWorkspaceSnapshot(process.cwd()));
      replacePackageSource(snapshot, "chat-runtime", content);

      expect(validateWorkspaceSnapshot(snapshot)).toContainEqual(
        expect.stringContaining(
          "uses a Node.js built-in that is not allowed by package policy",
        ),
      );
    },
  );

  it("limits assignment provenance to direct global roots", async () => {
    const snapshot = clone(await loadWorkspaceSnapshot(process.cwd()));
    replacePackageSource(
      snapshot,
      "chat-runtime",
      [
        "let directModuleApi;",
        "let transitiveModuleApi;",
        "directModuleApi = module;",
        "transitiveModuleApi = directModuleApi;",
        'transitiveModuleApi.require("react");',
      ].join("\n"),
    );

    expect(
      validateWorkspaceSnapshot(snapshot).filter((error) =>
        error.includes("acquiring an alias to the unshadowed module"),
      ),
    ).toHaveLength(1);
  });

  it("accepts nested patterns outside confirmed global capability paths", async () => {
    const snapshot = clone(await loadWorkspaceSnapshot(process.cwd()));
    replacePackageSource(
      snapshot,
      "chat-runtime",
      [
        "const business = { process: { getBuiltinModule: (value: string) => value } };",
        "const { process: { getBuiltinModule: businessGet } } = business;",
        'businessGet("module");',
        "const globalThis = { process: { getBuiltinModule: (value: string) => value } };",
        "const { process: { getBuiltinModule: localGet } } = globalThis;",
        'localGet("module");',
        "let assignedGet;",
        "({ process: { getBuiltinModule: assignedGet } } = globalThis);",
        'assignedGet("module");',
      ].join("\n"),
    );

    expect(validateWorkspaceSnapshot(snapshot)).toEqual([]);
  });

  it("rejects loading capabilities reached through a globalThis alias", async () => {
    const snapshot = clone(await loadWorkspaceSnapshot(process.cwd()));
    replacePackageSource(
      snapshot,
      "chat-runtime",
      [
        "const g = globalThis;",
        "const load = g.process",
        '  .getBuiltinModule("module")',
        "  .createRequire(import.meta.url);",
        'load("@turingfocus/chat-ui-antd");',
      ].join("\n"),
    );

    expect(validateWorkspaceSnapshot(snapshot)).toContainEqual(
      expect.stringContaining(
        "alias to the unshadowed global loading capability",
      ),
    );
  });

  it.each([
    'const get = Reflect.get(globalThis, "process").getBuiltinModule; export const load = () => get("module").createRequire(import.meta.url)("@turingfocus/chat-ui-antd");',
    'const descriptor = Object.getOwnPropertyDescriptor(globalThis, "process"); const get = descriptor?.value.getBuiltinModule; void get;',
    'const get = Reflect.get(process, "getBuiltinModule"); void get;',
    'const load = Reflect.get(module, "require"); void load;',
  ])(
    "rejects reflective acquisition from an unshadowed global capability: %s",
    async (content) => {
      const snapshot = clone(await loadWorkspaceSnapshot(process.cwd()));
      replacePackageSource(snapshot, "chat-runtime", content);

      expect(validateWorkspaceSnapshot(snapshot)).toContainEqual(
        expect.stringContaining("loading capability as a value"),
      );
    },
  );

  it.each([
    'eval("require(\\"react\\")");',
    'Function("return require(\\"react\\")")();',
    'new Function("return require(\\"react\\")")();',
    'globalThis["eval"]("require(\\"react\\")");',
    "export default Function;",
    "export default eval;",
    "export = Function;",
  ])("rejects direct dynamic-code loading escapes: %s", async (content) => {
    const snapshot = clone(await loadWorkspaceSnapshot(process.cwd()));
    replacePackageSource(snapshot, "chat-runtime", content);

    expect(validateWorkspaceSnapshot(snapshot)).toContainEqual(
      expect.stringContaining(
        "dynamic code evaluation is prohibited by workspace policy",
      ),
    );
  });

  it("does not mistake comments and ordinary strings for imports", async () => {
    const snapshot = clone(await loadWorkspaceSnapshot(process.cwd()));
    replacePackageSource(
      snapshot,
      "chat-protocol",
      [
        '// import "next/router";',
        '// require("@turingfocus/chat-ui-antd");',
        "const documentation = 'import \"react\" from /Users/example/TFRobotFront';",
        'const examples = "createRequire eval Function require.resolve module.require";',
        "export { documentation, examples };",
      ].join("\n"),
    );

    expect(validateWorkspaceSnapshot(snapshot)).toEqual([]);
  });

  it("rejects host source imports and local path consumption", async () => {
    const snapshot = clone(await loadWorkspaceSnapshot(process.cwd()));
    const runtime = snapshot.packages.find(
      ({ directory }) => directory === "chat-runtime",
    )!;
    runtime.manifest.dependencies ??= {};
    runtime.manifest.dependencies["@turingfocus/chat-protocol"] =
      "file:/Users/example/TFRobotFront/src/packages/chat-kit";
    snapshot.sourceFiles.push({
      path: "packages/chat-runtime/src/host-leak.ts",
      content: 'import "next/router";',
    });

    const errors = validateWorkspaceSnapshot(snapshot);
    expect(errors).toContainEqual(
      expect.stringContaining("forbidden source/path dependency"),
    );
    expect(errors).toContainEqual(
      expect.stringContaining("forbidden Next.js dependency"),
    );
  });

  it("rejects symbolic links in public package source trees", async () => {
    const fixtureRoot = await mkdtemp(
      path.join(os.tmpdir(), "tf-chat-kit-source-policy-"),
    );
    const sourceDirectory = path.join(
      fixtureRoot,
      "packages",
      "chat-runtime",
      "src",
    );
    const externalSource = path.join(fixtureRoot, "outside-runtime.ts");

    try {
      await mkdir(sourceDirectory, { recursive: true });
      await writeFile(externalSource, "export const leaked = true;\n");
      await symlink(externalSource, path.join(sourceDirectory, "index.ts"));

      await expect(
        collectSourceFiles(path.join(fixtureRoot, "packages"), fixtureRoot),
      ).rejects.toThrow(
        "packages/chat-runtime/src/index.ts: symbolic links are not allowed in public package source trees",
      );
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it.each([
    [
      "runtime relative import",
      'import { protocol } from "../../chat-protocol/src/index.js"; void protocol;',
    ],
    [
      "type-only relative import",
      'import type { Protocol } from "../../chat-protocol/src/index.js"; export type RuntimeProtocol = Protocol;',
    ],
  ])("rejects cross-workspace %s", async (_label, content) => {
    const snapshot = clone(await loadWorkspaceSnapshot(process.cwd()));
    replacePackageSource(snapshot, "chat-runtime", content);

    expect(validateWorkspaceSnapshot(snapshot)).toContainEqual(
      expect.stringContaining("cross-workspace source imports are prohibited"),
    );
  });

  it("rejects package import aliases until imports maps are governed", async () => {
    const snapshot = clone(await loadWorkspaceSnapshot(process.cwd()));
    replacePackageSource(snapshot, "chat-runtime", 'import "#protocol";');

    expect(validateWorkspaceSnapshot(snapshot)).toContainEqual(
      expect.stringContaining("package import aliases are prohibited"),
    );
  });

  it.each([
    ["bare relative path", "../../hosts/TFRobotFront"],
    ["file protocol", "file:../../hosts/TFRobotFront"],
    ["link protocol", "link:../../hosts/TFRobotFront"],
    ["portal protocol", "portal:../../hosts/TFRobotFront"],
    ["POSIX absolute path", "/opt/TFRobotFront"],
    ["home-relative path", "~/TFRobotFront"],
    ["Windows drive path", "C:\\workspace\\TFRobotFront"],
    ["UNC path", "\\\\server\\share\\TFRobotFront"],
    ["external workspace package", "workspace:*"],
    ["Git HTTPS URL", "git+https://example.invalid/TFRobotFront.git"],
    ["Git SCP URL", "git@github.com:org/TFRobotFront.git"],
    ["GitHub shortcut", "github:org/TFRobotFront"],
    ["remote tarball", "https://example.invalid/TFRobotFront.tgz"],
    ["mutable Registry tag", "latest"],
  ])("rejects %s dependencies", async (_label, specifier) => {
    const snapshot = clone(await loadWorkspaceSnapshot(process.cwd()));
    const runtime = snapshot.packages.find(
      ({ directory }) => directory === "chat-runtime",
    )!;
    runtime.manifest.dependencies ??= {};
    runtime.manifest.dependencies["host-source"] = specifier;

    expect(validateWorkspaceSnapshot(snapshot)).toContainEqual(
      expect.stringContaining("forbidden source/path dependency"),
    );
  });

  it("allows Registry dependency specifiers", async () => {
    const snapshot = clone(await loadWorkspaceSnapshot(process.cwd()));
    snapshot.rootManifest.devDependencies ??= {};
    snapshot.rootManifest.devDependencies["registry-package"] = "^1.2.3";

    expect(validateWorkspaceSnapshot(snapshot)).toEqual([]);
  });

  it("allows Registry aliases with immutable ranges", async () => {
    const snapshot = clone(await loadWorkspaceSnapshot(process.cwd()));
    snapshot.rootManifest.devDependencies ??= {};
    snapshot.rootManifest.devDependencies["registry-alias"] =
      "npm:registry-package@^1.2.3";

    expect(validateWorkspaceSnapshot(snapshot)).toEqual([]);
  });

  it("rejects source dependencies in the root manifest", async () => {
    const snapshot = clone(await loadWorkspaceSnapshot(process.cwd()));
    snapshot.rootManifest.devDependencies ??= {};
    snapshot.rootManifest.devDependencies["host-source"] =
      "file:../TFRobotFront";

    expect(validateWorkspaceSnapshot(snapshot)).toContainEqual(
      expect.stringContaining("root: host-source uses forbidden source/path"),
    );
  });

  it("rejects internal workspace dependencies in the root manifest", async () => {
    const snapshot = clone(await loadWorkspaceSnapshot(process.cwd()));
    snapshot.rootManifest.devDependencies ??= {};
    snapshot.rootManifest.devDependencies["@turingfocus/chat-runtime"] =
      "workspace:*";

    expect(validateWorkspaceSnapshot(snapshot)).toContainEqual(
      expect.stringContaining(
        "root: @turingfocus/chat-runtime uses forbidden source/path dependency workspace:*",
      ),
    );
  });

  it("rejects source dependencies injected through pnpm overrides", async () => {
    const snapshot = clone(await loadWorkspaceSnapshot(process.cwd()));
    snapshot.rootManifest.pnpm = {
      overrides: { react: "link:../TFRobotFront/react" },
    };

    expect(validateWorkspaceSnapshot(snapshot)).toContainEqual(
      expect.stringContaining(
        "root: pnpm override react uses forbidden source/path",
      ),
    );
  });

  it.each([
    "changeset publish",
    "pnpm exec changeset publish",
    "pnpm exec @changesets/cli@2.31.0 publish",
    "npm exec changeset publish",
    "npm x @changesets/cli@2.31.0 publish",
    "npm publish",
    "npm pub",
    "pnpm publish --no-git-checks",
    "pnpm -w publish",
    "pnpm --filter @turingfocus/chat-runtime publish",
    "pnpm dlx @changesets/cli publish",
    "npm --workspace @turingfocus/chat-runtime publish",
    "npm --location project publish",
    "npm --location=project publish",
    "npm --location project pub",
    "npm exec --package @changesets/cli changeset publish",
    "npm publish>/dev/null",
    "npm publish</dev/null",
    "2>/dev/null npm publish",
    "< /dev/null npm publish",
    "(npm publish)",
    "pnpm --reporter append-only publish",
    "pnpm --color false publish",
    "pnpm --stream false publish",
    "pnpm --config.strict-peer-dependencies false publish",
    "npm exec --location project -- changeset publish",
    "npm exec --prefix . -- changeset publish",
    "npm x --prefix . -- changeset publish",
    "npx --location project -- changeset publish",
    "env -C . npm publish",
    "yarn publish",
    "yarn npm publish",
    "true\nnpm publish",
    "true\r\nnpm publish",
  ])(
    "rejects a release command before the TFCK-13 workflow is approved: %s",
    async (command) => {
      const snapshot = clone(await loadWorkspaceSnapshot(process.cwd()));
      snapshot.rootManifest.scripts ??= {};
      snapshot.rootManifest.scripts["release"] = command;

      expect(validateWorkspaceSnapshot(snapshot)).toContainEqual(
        expect.stringContaining(
          "must not publish before the TFCK-13 release workflow and npm identity are approved",
        ),
      );
    },
  );

  it.each([
    "echo pub",
    "node -e \"console.log('pub')\"",
    "node scripts/publish-summary.mjs",
    "npm run publication-report",
    "npm view pub",
    "npm --location project view publish",
    "npm --location=project run publication-report",
    "npm --location project exec echo publish",
    "pnpm exec echo publish",
    "pnpm -w exec echo publish",
    "pnpm -w view publish",
    "npm exec echo publish",
    "npm exec --package kleur echo publish",
    "npm exec --location project -- echo publish",
    "npm exec --prefix . -- echo publish",
    "npx --location project -- echo publish",
    "pnpm --reporter append-only view publish",
    "pnpm --color false view publish",
    "pnpm --stream false run publication-report",
    "pnpm --config.strict-peer-dependencies false exec echo publish",
    "(echo publish)",
    "env -C . npm view publish",
    "yarn info publish",
  ])(
    "rejects unapproved script additions even when they do not publish: %s",
    async (command) => {
      const snapshot = clone(await loadWorkspaceSnapshot(process.cwd()));
      snapshot.rootManifest.scripts ??= {};
      snapshot.rootManifest.scripts["report"] = command;

      expect(validateWorkspaceSnapshot(snapshot)).toContainEqual(
        expect.stringContaining(
          "scripts must exactly match the approved publish-disabled baseline",
        ),
      );
    },
  );

  it.each([
    'sh -c "npm publish"',
    'bash -lc "pnpm publish"',
    "corepack npm publish",
  ])(
    "rejects wrapped publish commands through the script allowlist: %s",
    async (command) => {
      const snapshot = clone(await loadWorkspaceSnapshot(process.cwd()));
      snapshot.rootManifest.scripts ??= {};
      snapshot.rootManifest.scripts["release"] = command;

      expect(validateWorkspaceSnapshot(snapshot)).toContainEqual(
        expect.stringContaining(
          "scripts must exactly match the approved publish-disabled baseline",
        ),
      );
    },
  );

  it("rejects package-level publish commands before TFCK-13", async () => {
    const snapshot = clone(await loadWorkspaceSnapshot(process.cwd()));
    const runtime = snapshot.packages.find(
      ({ directory }) => directory === "chat-runtime",
    )!;
    runtime.manifest.scripts = { release: "pnpm publish" };

    expect(validateWorkspaceSnapshot(snapshot)).toContainEqual(
      expect.stringContaining(
        "@turingfocus/chat-runtime: script release must not publish before the TFCK-13 release workflow",
      ),
    );
  });

  it("rejects package-level npm pub commands before TFCK-13", async () => {
    const snapshot = clone(await loadWorkspaceSnapshot(process.cwd()));
    const runtime = snapshot.packages.find(
      ({ directory }) => directory === "chat-runtime",
    )!;
    runtime.manifest.scripts = { release: "npm pub" };

    expect(validateWorkspaceSnapshot(snapshot)).toContainEqual(
      expect.stringContaining(
        "@turingfocus/chat-runtime: script release must not publish before the TFCK-13 release workflow",
      ),
    );
  });

  it.each([
    "pnpm exec changeset publish",
    "pnpm -w publish",
    "npm exec @changesets/cli@2.31.0 publish",
    "npm exec --package @changesets/cli changeset publish",
    "env -C . npm publish",
    "true\nnpm publish",
  ])("rejects package-level wrapped publish commands: %s", async (command) => {
    const snapshot = clone(await loadWorkspaceSnapshot(process.cwd()));
    const runtime = snapshot.packages.find(
      ({ directory }) => directory === "chat-runtime",
    )!;
    runtime.manifest.scripts = { release: command };

    expect(validateWorkspaceSnapshot(snapshot)).toContainEqual(
      expect.stringContaining(
        "@turingfocus/chat-runtime: script release must not publish before the TFCK-13 release workflow",
      ),
    );
  });

  it.each(["monaco-editor", "@xterm/xterm"])(
    "rejects the %s heavy renderer dependency outside chat-ui-antd",
    async (dependency) => {
      const snapshot = clone(await loadWorkspaceSnapshot(process.cwd()));
      const runtime = snapshot.packages.find(
        ({ directory }) => directory === "chat-runtime",
      )!;
      runtime.manifest.dependencies ??= {};
      runtime.manifest.dependencies[dependency] = "^1.0.0";

      expect(validateWorkspaceSnapshot(snapshot)).toContainEqual(
        expect.stringContaining(
          `heavy renderer dependency ${dependency} is only allowed in chat-ui-antd`,
        ),
      );
    },
  );

  it("allows approved heavy renderer dependencies in chat-ui-antd", async () => {
    const snapshot = clone(await loadWorkspaceSnapshot(process.cwd()));
    const ui = snapshot.packages.find(
      ({ directory }) => directory === "chat-ui-antd",
    )!;
    ui.manifest.dependencies ??= {};
    ui.manifest.dependencies["monaco-editor"] = "^0.52.0";
    ui.manifest.dependencies["@xterm/xterm"] = "^5.5.0";

    expect(validateWorkspaceSnapshot(snapshot)).toEqual([]);
  });

  it("rejects peer dependencies duplicated as production dependencies", async () => {
    const snapshot = clone(await loadWorkspaceSnapshot(process.cwd()));
    const reactPackage = snapshot.packages.find(
      ({ directory }) => directory === "chat-react",
    )!;
    const uiPackage = snapshot.packages.find(
      ({ directory }) => directory === "chat-ui-antd",
    )!;
    reactPackage.manifest.dependencies ??= {};
    reactPackage.manifest.dependencies["react"] = "18.3.1";
    uiPackage.manifest.dependencies ??= {};
    uiPackage.manifest.dependencies["antd"] = "5.29.3";

    const errors = validateWorkspaceSnapshot(snapshot);
    expect(errors).toContainEqual(
      expect.stringContaining(
        "@turingfocus/chat-react: external dependency react is not allowed by package policy in dependencies",
      ),
    );
    expect(errors).toContainEqual(
      expect.stringContaining(
        "@turingfocus/chat-ui-antd: external dependency antd is not allowed by package policy in dependencies",
      ),
    );
  });

  it("requires explicit package side-effect metadata", async () => {
    const snapshot = clone(await loadWorkspaceSnapshot(process.cwd()));
    delete snapshot.packages[0]!.manifest.sideEffects;

    expect(validateWorkspaceSnapshot(snapshot)).toContainEqual(
      expect.stringContaining(
        "sideEffects must be false or a non-empty list of explicit file patterns",
      ),
    );
  });

  it("accepts explicit side-effect file patterns", async () => {
    const snapshot = clone(await loadWorkspaceSnapshot(process.cwd()));
    const uiPackage = snapshot.packages.find(
      ({ directory }) => directory === "chat-ui-antd",
    )!;
    uiPackage.manifest.sideEffects = ["dist/*.css"];

    expect(validateWorkspaceSnapshot(snapshot)).toEqual([]);
  });

  it("rejects undeclared external package dependencies", async () => {
    const snapshot = clone(await loadWorkspaceSnapshot(process.cwd()));
    const runtime = snapshot.packages.find(
      ({ directory }) => directory === "chat-runtime",
    )!;
    runtime.manifest.dependencies ??= {};
    runtime.manifest.dependencies["unreviewed-package"] = "^1.0.0";

    expect(validateWorkspaceSnapshot(snapshot)).toContainEqual(
      expect.stringContaining(
        "external dependency unreviewed-package is not allowed by package policy",
      ),
    );
  });
});
