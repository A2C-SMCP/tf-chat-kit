import { describe, expect, it } from "vitest";

import {
  expectedPackedManifest,
  validatePackedArtifact,
} from "../scripts/packed-artifact-policy.mjs";

const sourceManifest = {
  name: "@tf/chat-testing",
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
    "@tf/chat-protocol": "workspace:^",
    "@tf/chat-runtime": "workspace:^",
  },
  publishConfig: {
    access: "public",
    registry: "https://registry.npmjs.org/",
  },
};

type MutableArtifactInput = Omit<
  Parameters<typeof validatePackedArtifact>[0],
  "extractedFiles"
> & {
  extractedFiles: Array<{
    path: string;
    content?: string;
    bytes?: Uint8Array;
  }>;
};

const validInput = (): MutableArtifactInput => {
  const packedManifest = expectedPackedManifest(sourceManifest);
  return {
    packageName: "@tf/chat-testing",
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

describe("packed artifact policy", () => {
  it("accepts an exact packed manifest and safe text files", () => {
    expect(validatePackedArtifact(validInput())).toEqual([]);
  });

  it("accepts semantically identical manifest keys in a different order", () => {
    const input = validInput();
    input.packedManifest = Object.fromEntries(
      Object.entries({
        ...input.packedManifest,
        dependencies: {
          "@tf/chat-runtime": "^0.1.0",
          "@tf/chat-protocol": "^0.1.0",
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
