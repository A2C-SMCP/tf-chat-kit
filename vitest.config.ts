import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

import { PACKAGE_POLICY } from "./scripts/workspace-policy.mjs";

const workspaceRoot = fileURLToPath(new URL(".", import.meta.url));

export const workspaceSourceAliases = Object.fromEntries(
  Object.entries(PACKAGE_POLICY).map(([directory, { name }]) => [
    name,
    path.join(workspaceRoot, "packages", directory, "src", "index.ts"),
  ]),
);

export default defineConfig({
  resolve: {
    alias: workspaceSourceAliases,
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    sequence: { concurrent: false },
  },
});
