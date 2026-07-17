import { describe, expect, it } from "vitest";

import { validateChangesetCoverage } from "../scripts/changeset-policy.mjs";
import { PACKAGE_POLICY } from "../scripts/workspace-policy.mjs";

const allPublicPackageFiles = Object.keys(PACKAGE_POLICY).flatMap((directory) =>
  ["package.json", "CHANGELOG.md"].map(
    (file) => `packages/${directory}/${file}`,
  ),
);
const allPublicPackageManifestFiles = Object.keys(PACKAGE_POLICY).map(
  (directory) => `packages/${directory}/package.json`,
);
const allPublicPackageNames = Object.values(PACKAGE_POLICY).map(
  ({ name }) => name,
);
const runtimeSource = "packages/chat-runtime/src/index.ts";

const releaseChangeset = {
  id: "calm-runtimes-change",
  summary: "Change runtime behavior.",
  releases: [{ name: "@tf/chat-runtime", type: "minor" }],
} as const;

const documentedEmptyChangeset = {
  id: "quiet-chats-bootstrap",
  summary: "Record the initial unpublished workspace bootstrap.",
  releases: [],
};

type ReleaseType = "patch" | "minor" | "major";

const packageManifests = (version: string) =>
  Object.fromEntries(
    allPublicPackageNames.map((name) => [
      name,
      { name, version, sideEffects: false },
    ]),
  );

const generatedChangelogs = Object.fromEntries(
  allPublicPackageNames.map((name) => [
    name,
    name === "@tf/chat-runtime"
      ? `# ${name}\n\n## 0.2.0\n\n### Minor Changes\n\n- ${releaseChangeset.summary}\n`
      : `# ${name}\n\n## 0.2.0\n`,
  ]),
);

const fixedReleasePlan = (
  type: ReleaseType,
  newVersion: string,
  changesetId: string,
) => ({
  releases: allPublicPackageNames.map((name) => ({
    name,
    type,
    oldVersion: "0.1.0",
    newVersion,
    changesets: name === "@tf/chat-runtime" ? [changesetId] : [],
  })),
});

const validConsumedRelease = {
  changedFiles: [
    ...allPublicPackageFiles,
    ".changeset/calm-runtimes-change.md",
  ],
  addedChangesets: [],
  consumedChangesets: [releaseChangeset],
  expectedConsumedChangesetIds: [releaseChangeset.id],
  consumedReleasePlan: fixedReleasePlan("minor", "0.2.0", releaseChangeset.id),
  basePackageManifests: packageManifests("0.1.0"),
  currentPackageManifests: packageManifests("0.2.0"),
  expectedPackageManifests: packageManifests("0.2.0"),
  currentChangelogs: generatedChangelogs,
  expectedChangelogs: generatedChangelogs,
  expectedReleaseOutputFiles: allPublicPackageFiles,
  isInitialWorkspaceBootstrap: false,
} as const;

describe("changeset governance", () => {
  it("allows changes outside public packages without a changeset", () => {
    expect(
      validateChangesetCoverage({
        changedFiles: ["README.md", "scripts/check-changesets.mjs"],
        addedChangesets: [],
        isInitialWorkspaceBootstrap: false,
      }),
    ).toEqual([]);
  });

  it("accepts a release changeset with a valid fixed-group plan", () => {
    expect(
      validateChangesetCoverage({
        changedFiles: [runtimeSource],
        addedChangesets: [releaseChangeset],
        pendingChangesets: [releaseChangeset],
        pendingReleasePlan: fixedReleasePlan(
          "minor",
          "0.2.0",
          releaseChangeset.id,
        ),
        isInitialWorkspaceBootstrap: false,
      }),
    ).toEqual([]);
  });

  it("rejects a changeset release for a different public package", () => {
    expect(
      validateChangesetCoverage({
        changedFiles: ["packages/chat-ui-antd/src/index.ts"],
        addedChangesets: [releaseChangeset],
        pendingChangesets: [releaseChangeset],
        pendingReleasePlan: fixedReleasePlan(
          "minor",
          "0.2.0",
          releaseChangeset.id,
        ),
        isInitialWorkspaceBootstrap: false,
      }),
    ).toContain(
      "new changeset releases must cover every changed public package; missing @tf/chat-ui-antd; changed packages: @tf/chat-ui-antd",
    );
  });

  it("rejects partial changeset coverage for multiple changed packages", () => {
    expect(
      validateChangesetCoverage({
        changedFiles: [
          "packages/chat-runtime/src/index.ts",
          "packages/chat-ui-antd/src/index.ts",
        ],
        addedChangesets: [releaseChangeset],
        pendingChangesets: [releaseChangeset],
        pendingReleasePlan: fixedReleasePlan(
          "minor",
          "0.2.0",
          releaseChangeset.id,
        ),
        isInitialWorkspaceBootstrap: false,
      }),
    ).toContain(
      "new changeset releases must cover every changed public package; missing @tf/chat-ui-antd; changed packages: @tf/chat-runtime, @tf/chat-ui-antd",
    );
  });

  it("accepts complete changeset coverage for multiple changed packages", () => {
    const completeChangeset = {
      ...releaseChangeset,
      releases: [
        ...releaseChangeset.releases,
        { name: "@tf/chat-ui-antd", type: "minor" as const },
      ],
    };

    expect(
      validateChangesetCoverage({
        changedFiles: [
          "packages/chat-runtime/src/index.ts",
          "packages/chat-ui-antd/src/index.ts",
        ],
        addedChangesets: [completeChangeset],
        pendingChangesets: [completeChangeset],
        pendingReleasePlan: fixedReleasePlan(
          "minor",
          "0.2.0",
          completeChangeset.id,
        ),
        isInitialWorkspaceBootstrap: false,
      }),
    ).toEqual([]);
  });

  it("rejects a release plan that leaves the 0.x line", () => {
    expect(
      validateChangesetCoverage({
        changedFiles: [runtimeSource],
        addedChangesets: [
          {
            id: "major-runtime",
            summary: "Break the runtime contract.",
            releases: [{ name: "@tf/chat-runtime", type: "major" }],
          },
        ],
        pendingChangesets: [
          {
            id: "major-runtime",
            summary: "Break the runtime contract.",
            releases: [{ name: "@tf/chat-runtime", type: "major" }],
          },
        ],
        pendingReleasePlan: fixedReleasePlan("major", "1.0.0", "major-runtime"),
        isInitialWorkspaceBootstrap: false,
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining("must remain on 0.x; found 1.0.0"),
      ]),
    );
  });

  it("rejects a major edit to an existing pending changeset", () => {
    const existingMajorChangeset = {
      id: "already-committed",
      summary: "Change the existing pending release to major.",
      releases: [{ name: "@tf/chat-runtime", type: "major" }],
    } as const;

    expect(
      validateChangesetCoverage({
        changedFiles: [".changeset/already-committed.md"],
        addedChangesets: [],
        pendingChangesets: [existingMajorChangeset],
        pendingReleasePlan: fixedReleasePlan(
          "major",
          "1.0.0",
          existingMajorChangeset.id,
        ),
        isInitialWorkspaceBootstrap: false,
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining("must remain on 0.x; found 1.0.0"),
      ]),
    );
  });

  it("accepts a documented empty changeset for the complete initial bootstrap", () => {
    expect(
      validateChangesetCoverage({
        changedFiles: allPublicPackageFiles,
        addedChangesets: [documentedEmptyChangeset],
        isInitialWorkspaceBootstrap: true,
      }),
    ).toEqual([]);
  });

  it("accepts exact fixed-group output backed by a consumed changeset", () => {
    expect(validateChangesetCoverage(validConsumedRelease)).toEqual([]);
  });

  it("rejects a release that leaves any base changeset pending", () => {
    expect(
      validateChangesetCoverage({
        ...validConsumedRelease,
        expectedConsumedChangesetIds: [
          releaseChangeset.id,
          documentedEmptyChangeset.id,
        ],
      }),
    ).toContain(
      "consumed release must delete every changeset pending at the comparison base, including empty changesets; expected calm-runtimes-change, quiet-chats-bootstrap; found calm-runtimes-change",
    );
  });

  it.each([
    "scripts/workspace-policy.mjs",
    ".github/workflows/ci.yml",
    "package.json",
    "pnpm-lock.yaml",
  ])("rejects unrelated %s mixed into consumed release output", (file) => {
    expect(
      validateChangesetCoverage({
        ...validConsumedRelease,
        changedFiles: [...validConsumedRelease.changedFiles, file],
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining("and contain no other files"),
      ]),
    );
  });

  it("rejects source changes mixed into consumed changeset output", () => {
    expect(
      validateChangesetCoverage({
        ...validConsumedRelease,
        changedFiles: [...validConsumedRelease.changedFiles, runtimeSource],
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "must exactly match Changesets fixed-group output files",
        ),
      ]),
    );
  });

  it("rejects partial fixed-group version output", () => {
    expect(
      validateChangesetCoverage({
        ...validConsumedRelease,
        changedFiles: [
          "packages/chat-runtime/package.json",
          "packages/chat-runtime/CHANGELOG.md",
          ".changeset/calm-runtimes-change.md",
        ],
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "must exactly match Changesets fixed-group output files",
        ),
      ]),
    );
  });

  it("rejects manually chosen versions for a consumed changeset", () => {
    expect(
      validateChangesetCoverage({
        ...validConsumedRelease,
        currentPackageManifests: packageManifests("0.9.0"),
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "package.json must exactly match Changesets output",
        ),
      ]),
    );
  });

  it("rejects consumed changesets without generated changelog content", () => {
    expect(
      validateChangesetCoverage({
        ...validConsumedRelease,
        currentChangelogs: {
          ...generatedChangelogs,
          "@tf/chat-runtime": "",
        },
      }),
    ).toContain(
      "consumed changeset release output for @tf/chat-runtime CHANGELOG.md must exactly match Changesets output",
    );
  });

  it("rejects a missing changelog for any planned fixed-group release", () => {
    expect(
      validateChangesetCoverage({
        ...validConsumedRelease,
        changedFiles: validConsumedRelease.changedFiles.filter(
          (file) => file !== "packages/chat-testing/CHANGELOG.md",
        ),
        currentChangelogs: {
          ...generatedChangelogs,
          "@tf/chat-testing": "",
        },
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "@tf/chat-testing CHANGELOG.md must exactly match Changesets output",
        ),
        expect.stringContaining(
          "must exactly match Changesets fixed-group output files",
        ),
      ]),
    );
  });

  it("does not accept a changeset summary found only in changelog history", () => {
    expect(
      validateChangesetCoverage({
        ...validConsumedRelease,
        currentChangelogs: {
          ...generatedChangelogs,
          "@tf/chat-runtime": `# @tf/chat-runtime\n\n## 0.2.0\n\n### Minor Changes\n\n- Different change.\n\n## 0.1.0\n\n- ${releaseChangeset.summary}\n`,
        },
      }),
    ).toContain(
      "consumed changeset release output for @tf/chat-runtime CHANGELOG.md must exactly match Changesets output",
    );
  });

  it("rejects manual content mixed into generated changelog output", () => {
    expect(
      validateChangesetCoverage({
        ...validConsumedRelease,
        currentChangelogs: {
          ...generatedChangelogs,
          "@tf/chat-runtime": `${generatedChangelogs["@tf/chat-runtime"]}Manual note.\n`,
        },
      }),
    ).toContain(
      "consumed changeset release output for @tf/chat-runtime CHANGELOG.md must exactly match Changesets output",
    );
  });

  it("rejects manual version changes without a consumed changeset", () => {
    expect(
      validateChangesetCoverage({
        changedFiles: allPublicPackageFiles,
        addedChangesets: [],
        basePackageManifests: packageManifests("0.1.0"),
        currentPackageManifests: packageManifests("0.2.0"),
        isInitialWorkspaceBootstrap: false,
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "workspace package versions changed without consuming a release changeset",
        ),
      ]),
    );
  });

  it("rejects an empty changeset after the initial bootstrap", () => {
    expect(
      validateChangesetCoverage({
        changedFiles: [runtimeSource],
        addedChangesets: [documentedEmptyChangeset],
        isInitialWorkspaceBootstrap: false,
      }),
    ).toEqual([
      "empty changesets are only allowed with a summary for the complete initial workspace bootstrap",
    ]);
  });

  it("rejects a documented empty changeset without public package changes", () => {
    expect(
      validateChangesetCoverage({
        changedFiles: ["docs/engineering-baseline.md"],
        addedChangesets: [documentedEmptyChangeset],
        pendingChangesets: [documentedEmptyChangeset],
        isInitialWorkspaceBootstrap: false,
      }),
    ).toEqual([
      "empty changesets are only allowed with a summary for the complete initial workspace bootstrap",
    ]);
  });

  it("does not treat a none release as SemVer coverage", () => {
    expect(
      validateChangesetCoverage({
        changedFiles: [runtimeSource],
        addedChangesets: [
          {
            id: "no-runtime-release",
            summary: "Do not release runtime.",
            releases: [{ name: "@tf/chat-runtime", type: "none" }],
          },
        ],
        isInitialWorkspaceBootstrap: false,
      }),
    ).toEqual([
      "public package changes require a release changeset; empty changesets are only allowed for the complete initial workspace bootstrap; changed packages: chat-runtime",
    ]);
  });

  it("rejects an empty changeset for an incomplete initial bootstrap", () => {
    expect(
      validateChangesetCoverage({
        changedFiles: allPublicPackageManifestFiles.slice(0, -1),
        addedChangesets: [documentedEmptyChangeset],
        isInitialWorkspaceBootstrap: true,
      }),
    ).toEqual([
      "empty changesets are only allowed with a summary for the complete initial workspace bootstrap",
    ]);
  });

  it("rejects an undocumented empty changeset for the initial bootstrap", () => {
    expect(
      validateChangesetCoverage({
        changedFiles: allPublicPackageFiles,
        addedChangesets: [{ ...documentedEmptyChangeset, summary: "   " }],
        isInitialWorkspaceBootstrap: true,
      }),
    ).toEqual([
      "empty changesets are only allowed with a summary for the complete initial workspace bootstrap",
    ]);
  });

  it("rejects public package changes without a new changeset", () => {
    expect(
      validateChangesetCoverage({
        changedFiles: [
          "packages/chat-protocol/src/index.ts",
          "packages/chat-runtime/src/index.ts",
        ],
        addedChangesets: [],
        isInitialWorkspaceBootstrap: false,
      }),
    ).toEqual([
      "public package changes require a new changeset; changed packages: chat-protocol, chat-runtime",
    ]);
  });

  it("does not accept edits to an existing changeset as new coverage", () => {
    expect(
      validateChangesetCoverage({
        changedFiles: [
          "packages/chat-ui-antd/src/index.ts",
          ".changeset/already-committed.md",
        ],
        addedChangesets: [],
        isInitialWorkspaceBootstrap: false,
      }),
    ).toEqual([
      "public package changes require a new changeset; changed packages: chat-ui-antd",
    ]);
  });
});
