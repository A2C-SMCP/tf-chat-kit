import { rm } from "node:fs/promises";
import path from "node:path";

import { PACKAGE_POLICY } from "./workspace-policy.mjs";

const rootDirectory = process.cwd();
const generatedPaths = [
  path.join(rootDirectory, ".artifacts"),
  path.join(rootDirectory, "coverage"),
  path.join(rootDirectory, "playwright-report"),
  path.join(rootDirectory, "playground", "dist"),
  path.join(rootDirectory, "test-results"),
  ...Object.keys(PACKAGE_POLICY).map((directory) =>
    path.join(rootDirectory, "packages", directory, "dist"),
  ),
];

await Promise.all(
  generatedPaths.map((generatedPath) =>
    rm(generatedPath, { recursive: true, force: true }),
  ),
);
console.log("Removed generated build, test, and package artifacts.");
