import { describe, expect, it } from "vitest";

import {
  expectedPackedManifest,
  validatePackedArtifact,
} from "../scripts/packed-artifact-policy.mjs";

const sourceManifest = {
  name: "@tf/chat-runtime",
  version: "0.1.0",
  license: "UNLICENSED",
  type: "module",
  sideEffects: false,
  files: ["dist"],
  dependencies: { "@tf/chat-protocol": "workspace:^" },
  publishConfig: { access: "restricted" },
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
    packageName: "@tf/chat-runtime",
    sourceManifest,
    packedManifest,
    declaredFiles: ["package.json", "dist/index.js", "dist/index.d.ts"],
    extractedFiles: [
      { path: "package.json", content: JSON.stringify(packedManifest) },
      { path: "dist/index.js", content: "export {};\n" },
      { path: "dist/index.d.ts", content: "export {};\n" },
    ],
  };
};

describe("packed artifact policy", () => {
  it("accepts an exact packed manifest and safe text files", () => {
    expect(validatePackedArtifact(validInput())).toEqual([]);
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
      "//npm.cnb.cool/:_authToken=super-secret-token-value",
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
    input.extractedFiles[1] = { path: "dist/index.js", content };

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

  it("accepts a documented environment placeholder in npm auth configuration", () => {
    const input = validInput();
    input.extractedFiles[1] = {
      path: "dist/index.js",
      content: "//npm.cnb.cool/:_authToken=${CNB_TOKEN}",
    };

    expect(validatePackedArtifact(input)).toEqual([]);
  });

  it("rejects credentials embedded in UTF-16LE artifact text", () => {
    const input = validInput();
    input.extractedFiles[1] = {
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
    input.extractedFiles[1] = {
      path: "dist/index.js",
      bytes: Buffer.concat([
        Buffer.from([0]),
        Buffer.from("password=real-production-password"),
      ]),
    };

    expect(validatePackedArtifact(input)).not.toEqual([]);
  });
});
