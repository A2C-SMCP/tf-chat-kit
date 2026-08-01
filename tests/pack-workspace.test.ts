import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { PACKAGE_POLICY } from "../scripts/workspace-policy.mjs";

type PackManifest = {
  packages: Array<{
    name: string;
    version: string;
    tarball: string;
    files: string[];
  }>;
};

describe("workspace packaging", () => {
  it("builds complete tarballs from a clean workspace", async () => {
    const rootDirectory = process.cwd();
    execFileSync("pnpm", ["run", "clean"], {
      cwd: rootDirectory,
      stdio: "pipe",
    });
    execFileSync("pnpm", ["run", "pack:workspace"], {
      cwd: rootDirectory,
      stdio: "pipe",
    });

    const manifest = JSON.parse(
      await readFile(
        path.join(rootDirectory, ".artifacts", "packages", "manifest.json"),
        "utf8",
      ),
    ) as PackManifest;

    expect(manifest.packages).toHaveLength(Object.keys(PACKAGE_POLICY).length);
    for (const packedPackage of manifest.packages) {
      expect(packedPackage.files).toEqual(
        expect.arrayContaining([
          "LICENSE",
          "package.json",
          "dist/index.js",
          "dist/index.d.ts",
        ]),
      );
    }
  }, 60_000);
});
