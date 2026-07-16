import { describe, expect, it } from "vitest";

import { assembleWorkspaceReleasePlan } from "../scripts/changeset-release-plan.mjs";
import { PACKAGE_POLICY } from "../scripts/workspace-policy.mjs";

const packageManifests = Object.fromEntries(
  Object.values(PACKAGE_POLICY).map(({ name, internalDependencies }) => [
    name,
    {
      name,
      version: "0.1.0",
      dependencies: Object.fromEntries(
        internalDependencies.map((dependency) => [dependency, "workspace:^"]),
      ),
    },
  ]),
);

describe("Changesets fixed-group release planning", () => {
  it.each([
    ["patch", "0.1.1"],
    ["minor", "0.2.0"],
    ["major", "1.0.0"],
  ] as const)(
    "uses Changesets semantics for a %s release",
    async (type, version) => {
      const plan = await assembleWorkspaceReleasePlan({
        rootDirectory: process.cwd(),
        rootManifest: { name: "tf-chat-kit", version: "0.0.0" },
        packageManifests,
        changesets: [
          {
            id: `${type}-runtime`,
            summary: `${type} runtime release`,
            releases: [{ name: "@tf/chat-runtime", type }],
          },
        ],
      });

      expect(plan.releases).toHaveLength(Object.keys(PACKAGE_POLICY).length);
      expect(plan.releases.map(({ newVersion }) => newVersion)).toEqual(
        Array(Object.keys(PACKAGE_POLICY).length).fill(version),
      );
    },
  );
});
