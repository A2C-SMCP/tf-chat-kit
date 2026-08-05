import { describe, expect, it } from "vitest";

import {
  expectedPackedManifest,
  validatePackedArtifact,
} from "../scripts/packed-artifact-policy.mjs";

const sourceManifest = {
  name: "@turingfocus/chat-testing",
  version: "0.1.0",
  license: "MIT",
  repository: {
    type: "git",
    url: "git+https://github.com/A2C-SMCP/tf-chat-kit.git",
    directory: "packages/chat-testing",
  },
  homepage: "https://github.com/A2C-SMCP/tf-chat-kit#readme",
  bugs: { url: "https://github.com/A2C-SMCP/tf-chat-kit/issues" },
  type: "module",
  sideEffects: false,
  files: ["dist"],
  dependencies: {
    "@turingfocus/chat-protocol": "workspace:^",
    "@turingfocus/chat-runtime": "workspace:^",
  },
  publishConfig: {
    access: "public",
    registry: "https://registry.npmjs.org/",
  },
};

type MutableArtifactInput = Omit<
  Parameters<typeof validatePackedArtifact>[0],
  "declaredFiles" | "extractedFiles"
> & {
  declaredFiles: string[];
  extractedFiles: Array<{
    path: string;
    content?: string;
    bytes?: Uint8Array;
  }>;
};

const validInput = (): MutableArtifactInput => {
  const packedManifest = expectedPackedManifest(sourceManifest);
  return {
    packageName: "@turingfocus/chat-testing",
    sourceManifest,
    packedManifest,
    declaredFiles: [
      "LICENSE",
      "package.json",
      "dist/index.js",
      "dist/index.d.ts",
    ],
    extractedFiles: [
      { path: "LICENSE", bytes: Buffer.from("approved license\n") },
      { path: "package.json", content: JSON.stringify(packedManifest) },
      { path: "dist/index.js", content: "export {};\n" },
      { path: "dist/index.d.ts", content: "export {};\n" },
    ],
    expectedFileContents: {
      LICENSE: Buffer.from("approved license\n"),
    },
  };
};

const facadeArtifactInput = (): MutableArtifactInput => {
  const input = validInput();
  input.packageName = "@turingfocus/chat-kit";
  const facadeFiles = [
    {
      path: "dist/headless.js",
      content: 'export * from "./tfrobot-client.js";\n',
    },
    {
      path: "dist/headless.d.ts",
      content: 'export * from "./tfrobot-client.js";\n',
    },
    { path: "dist/tfrobot-client.js", content: "export {};\n" },
    { path: "dist/tfrobot-client.d.ts", content: "export {};\n" },
    {
      path: "dist/react.js",
      content:
        'export * from "./headless.js";\nexport * from "./tfrobot-react.js";\nexport * from "@turingfocus/chat-react";\n',
    },
    {
      path: "dist/react.d.ts",
      content:
        'export * from "./headless.js";\nexport * from "./tfrobot-react.js";\nexport * from "@turingfocus/chat-react";\n',
    },
    { path: "dist/tfrobot-react.js", content: "export {};\n" },
    { path: "dist/tfrobot-react.d.ts", content: "export {};\n" },
  ];
  input.declaredFiles.push(...facadeFiles.map(({ path }) => path));
  input.extractedFiles.push(...facadeFiles);
  return input;
};

describe("packed artifact policy", () => {
  it("accepts an exact packed manifest and safe text files", () => {
    expect(validatePackedArtifact(validInput())).toEqual([]);
  });

  it("accepts isolated Headless and React graphs in the packed facade", () => {
    expect(validatePackedArtifact(facadeArtifactInput())).toEqual([]);
  });

  it("keeps packed declaration traversal separate from JavaScript implementation edges", () => {
    const input = facadeArtifactInput();
    const declaration = input.extractedFiles.find(
      ({ path }) => path === "dist/headless.d.ts",
    );
    if (!declaration) {
      throw new Error("Missing packed Headless declaration fixture");
    }
    declaration.content += 'export * from "./declaration-bridge.js";\n';
    const bridgeFiles = [
      { path: "dist/declaration-bridge.d.ts", content: "export {};\n" },
      {
        path: "dist/declaration-bridge.js",
        content: 'export * from "react";\n',
      },
    ];
    input.declaredFiles.push(...bridgeFiles.map(({ path }) => path));
    input.extractedFiles.push(...bridgeFiles);

    expect(validatePackedArtifact(input)).toEqual([]);
  });

  it("does not treat an arbitrary object's require method as a module edge", () => {
    const input = facadeArtifactInput();
    const headless = input.extractedFiles.find(
      ({ path }) => path === "dist/headless.js",
    );
    if (!headless) throw new Error("Missing packed Headless fixture");
    headless.content +=
      'const registry = { require: () => undefined };\nregistry.require("react");\n';

    expect(validatePackedArtifact(input)).toEqual([]);
  });

  it.each([
    ["dist/headless.js", "headless", "@turingfocus/chat-ui-antd"],
    ["dist/react.d.ts", "react", "antd"],
  ])(
    "rejects forbidden entry dependencies in packed %s",
    (filePath, entry, dependency) => {
      const input = facadeArtifactInput();
      const file = input.extractedFiles.find(({ path }) => path === filePath);
      if (!file) throw new Error(`Missing packed fixture ${filePath}`);
      file.content += `export * from ${JSON.stringify(dependency)};\n`;

      expect(validatePackedArtifact(input)).toContainEqual(
        expect.stringContaining(
          `${entry} entry reaches forbidden ${dependency}`,
        ),
      );
    },
  );

  it("rejects an import-equals type dependency in the packed Headless declarations", () => {
    const input = facadeArtifactInput();
    const file = input.extractedFiles.find(
      ({ path }) => path === "dist/headless.d.ts",
    );
    if (!file) throw new Error("Missing packed Headless declaration fixture");
    file.content +=
      'import type React = require("react");\nexport type FacadeLeak = React.ReactNode;\n';

    expect(validatePackedArtifact(input)).toContainEqual(
      expect.stringContaining("headless entry reaches forbidden react"),
    );
  });

  it("rejects an upward self-reference in the packed Headless entry", () => {
    const input = facadeArtifactInput();
    const headless = input.extractedFiles.find(
      ({ path }) => path === "dist/headless.js",
    );
    if (!headless) throw new Error("Missing packed Headless fixture");
    headless.content += 'export * from "@turingfocus/chat-kit/antd";\n';
    const antdFiles = [
      {
        path: "dist/antd.js",
        content: 'export * from "@turingfocus/chat-ui-antd";\n',
      },
      { path: "dist/antd.d.ts", content: "export {};\n" },
    ];
    input.declaredFiles.push(...antdFiles.map(({ path }) => path));
    input.extractedFiles.push(...antdFiles);

    expect(validatePackedArtifact(input)).toContainEqual(
      expect.stringContaining(
        "headless entry reaches forbidden @turingfocus/chat-ui-antd through dist/antd.js",
      ),
    );
  });

  it("accepts semantically identical manifest keys in a different order", () => {
    const input = validInput();
    input.packedManifest = Object.fromEntries(
      Object.entries({
        ...input.packedManifest,
        dependencies: {
          "@turingfocus/chat-runtime": "^0.1.0",
          "@turingfocus/chat-protocol": "^0.1.0",
        },
      }).reverse(),
    );

    expect(validatePackedArtifact(input)).toEqual([]);
  });

  it("rejects unexpected packed dependencies", () => {
    const input = validInput();
    input.packedManifest = {
      ...input.packedManifest,
      dependencies: {
        ...(input.packedManifest["dependencies"] as Record<string, string>),
        unexpected: "^1.0.0",
      },
    };

    expect(validatePackedArtifact(input)).toContainEqual(
      expect.stringContaining("packed package.json must exactly match"),
    );
  });

  it.each([
    ["developer path", 'export const path = "/Users/alice/TFRobotFront";'],
    ["host source", 'export const host = "TFRobotFront";'],
    ["source dependency", 'export const dependency = "file:../host";'],
    ["private key", "-----BEGIN PRIVATE KEY-----"],
    ["Bearer token", `Bearer ${"a".repeat(24)}`],
    ["credential assignment", 'const token = "real-secret-value";'],
    ["template credential assignment", "const token = `real-secret-value`;"],
    [
      "npm auth token assignment",
      "//registry.npmjs.org/:_authToken=super-secret-token-value",
    ],
    ["unquoted credential assignment", "password=real-secret-value"],
    [
      "camelCase access token assignment",
      'const accessToken = "real-production-token-value";',
    ],
    [
      "camelCase refresh token assignment",
      'const refreshToken = "real-production-token-value";',
    ],
    [
      "camelCase client secret assignment",
      'const clientSecret = "real-production-secret-value";',
    ],
  ])("rejects %s in packed text", (_label, content) => {
    const input = validInput();
    input.extractedFiles[2] = { path: "dist/index.js", content };

    expect(validatePackedArtifact(input)).not.toEqual([]);
  });

  it("rejects files hidden from pnpm pack output", () => {
    const input = validInput();
    input.extractedFiles.push({
      path: "dist/hidden.js",
      content: "export {};\n",
    });

    expect(validatePackedArtifact(input)).toContainEqual(
      expect.stringContaining("extracted tarball files must exactly match"),
    );
  });

  it("rejects a packed license that differs from the repository license", () => {
    const input = validInput();
    input.extractedFiles[0] = {
      path: "LICENSE",
      bytes: Buffer.from("different license\n"),
    };

    expect(validatePackedArtifact(input)).toContainEqual(
      expect.stringContaining(
        "LICENSE must exactly match the approved repository file",
      ),
    );
  });

  it("accepts a documented environment placeholder in npm auth configuration", () => {
    const input = validInput();
    input.extractedFiles[2] = {
      path: "dist/index.js",
      content: "//registry.npmjs.org/:_authToken=${NPM_TOKEN}",
    };

    expect(validatePackedArtifact(input)).toEqual([]);
  });

  it("rejects credentials embedded in UTF-16LE artifact text", () => {
    const input = validInput();
    input.extractedFiles[2] = {
      path: "dist/index.js",
      bytes: Buffer.from(
        'const accessToken = "real-production-token-value";',
        "utf16le",
      ),
    };

    expect(validatePackedArtifact(input)).not.toEqual([]);
  });

  it("rejects ASCII credentials in an artifact containing NUL bytes", () => {
    const input = validInput();
    input.extractedFiles[2] = {
      path: "dist/index.js",
      bytes: Buffer.concat([
        Buffer.from([0]),
        Buffer.from("password=real-production-password"),
      ]),
    };

    expect(validatePackedArtifact(input)).not.toEqual([]);
  });
});
