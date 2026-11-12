import { describe, expect, it } from "vitest";

import { assembleWorkspaceReleasePlan } from "../scripts/changeset-release-plan.mjs";
import {
  FIXED_PACKAGE_NAMES,
  PACKAGE_POLICY,
} from "../scripts/workspace-policy.mjs";

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

const preMigrationPackageManifests = Object.fromEntries(
  Object.values(PACKAGE_POLICY).map(({ name, internalDependencies }) => [
    name,
    {
      name,
      version: name === "@turingfocus/chat-auth" ? "0.12.1" : "0.11.0",
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
            releases: [{ name: "@turingfocus/chat-runtime", type }],
          },
        ],
      });

      expect(plan.releases).toHaveLength(FIXED_PACKAGE_NAMES.length);
      expect(plan.releases.map(({ newVersion }) => newVersion)).toEqual(
        Array(FIXED_PACKAGE_NAMES.length).fill(version),
      );
    },
  );

  it("bumps the complete unified group to 0.13.0 from the pre-migration versions", async () => {
    const plan = await assembleWorkspaceReleasePlan({
      rootDirectory: process.cwd(),
      rootManifest: { name: "tf-chat-kit", version: "0.0.0" },
      packageManifests: preMigrationPackageManifests,
      changesets: [
        {
          id: "manager-robot-session-scopes",
          summary: "Allow explicit Robot session scopes through Manager.",
          releases: [
            { name: "@turingfocus/chat-auth", type: "minor" },
            { name: "@turingfocus/chat-kit", type: "patch" },
          ],
        },
      ],
    });

    expect(plan.releases.map(({ name }) => name).sort()).toEqual(
      [...FIXED_PACKAGE_NAMES].sort(),
    );
    expect(plan.releases.map(({ newVersion }) => newVersion)).toEqual(
      Array(FIXED_PACKAGE_NAMES.length).fill("0.13.0"),
    );
    expect(
      plan.releases.find(({ name }) => name === "@turingfocus/chat-auth")
        ?.oldVersion,
    ).toBe("0.12.1");
  });

  it("uses the highest fixed-group version even when only a core package changes", async () => {
    const plan = await assembleWorkspaceReleasePlan({
      rootDirectory: process.cwd(),
      rootManifest: { name: "tf-chat-kit", version: "0.0.0" },
      packageManifests: preMigrationPackageManifests,
      changesets: [
        {
          id: "shared-namespace-connection",
          summary:
            "Share one WebSocket between chat and RemoteTool namespaces.",
          releases: [
            { name: "@turingfocus/chat-gateway-tfrobot", type: "minor" },
            { name: "@turingfocus/chat-kit", type: "minor" },
          ],
        },
      ],
    });

    expect(plan.releases.map(({ newVersion }) => newVersion)).toEqual(
      Array(FIXED_PACKAGE_NAMES.length).fill("0.13.0"),
    );
  });
});
