import { describe, expect, it } from "vitest";

import {
  renderReleaseIncident,
  renderReleaseNotes,
} from "../scripts/render-release-report.mjs";
import { assertReleaseManifestReconciles } from "../scripts/reconcile-release-manifest.mjs";

const manifest = {
  version: "0.2.0-next.0",
  channel: "next",
  tag: "v0.2.0-next.0",
  commit: "c".repeat(40),
  runUrl: "https://github.com/A2C-SMCP/tf-chat-kit/actions/runs/1",
  createdAt: "2026-07-30T00:00:00.000Z",
  packages: [
    {
      name: "@turingfocus/chat-protocol",
      version: "0.2.0-next.0",
      integrity: "sha512-approved",
    },
  ],
  compatibility: {
    consumers: {
      tfrobotfrontMock: {
        status: "passed",
        evidence: "docs/mock.md",
      },
      tfrobotfrontReal: { status: "missing" },
    },
    knownLimitations: ["Mock evidence is not a production rollout."],
  },
};

describe("release audit reports", () => {
  it("reconciles rerun audit fields but rejects immutable identity changes", () => {
    const rerunManifest = structuredClone(manifest);
    rerunManifest.runUrl =
      "https://github.com/A2C-SMCP/tf-chat-kit/actions/runs/2";
    rerunManifest.createdAt = "2026-07-30T01:00:00.000Z";
    expect(() =>
      assertReleaseManifestReconciles(rerunManifest, manifest),
    ).not.toThrow();

    const conflictingManifest = structuredClone(manifest);
    conflictingManifest.packages[0]!.integrity = "sha512-conflict";
    expect(() =>
      assertReleaseManifestReconciles(conflictingManifest, manifest),
    ).toThrow(/immutable current release identity/u);
  });

  it("links package integrity, consumer evidence, and rollback policy", () => {
    const report = renderReleaseNotes(manifest);

    expect(report).toContain("@turingfocus/chat-protocol@0.2.0-next.0");
    expect(report).toContain("sha512-approved");
    expect(report).toContain("tfrobotfrontReal: **missing**");
    expect(report).toContain("Never overwrite the version or move the tag");
  });

  it("does not remove an earlier tag when publication was only attempted", () => {
    const report = renderReleaseIncident(manifest, {
      runUrl: manifest.runUrl,
      error: "simulated failure",
      states: {
        "@turingfocus/chat-protocol": "publish-attempted",
      },
      beforeTags: {
        "@turingfocus/chat-protocol": "0.1.0-next.0",
      },
      currentTags: {
        "@turingfocus/chat-protocol": "0.1.0-next.0",
      },
    });

    expect(report).not.toContain("npm dist-tag rm");
    expect(report).not.toContain("npm dist-tag add");
    expect(report).toContain("do not change existing tags");
    expect(report).toContain("If no dist-tag has been removed");
    expect(report).toContain("After any dist-tag removal, fix forward");
  });

  it("restores the recorded previous tag when the failed release moved it", () => {
    const report = renderReleaseIncident(manifest, {
      states: {
        "@turingfocus/chat-protocol": "published",
      },
      beforeTags: {
        "@turingfocus/chat-protocol": "0.1.0-next.0",
      },
      currentTags: {
        "@turingfocus/chat-protocol": "0.2.0-next.0",
      },
    });

    expect(report).toContain(
      "npm dist-tag add @turingfocus/chat-protocol@0.1.0-next.0 next",
    );
    expect(report).not.toContain("npm dist-tag rm");
  });

  it("removes only a newly created tag with no previous mapping", () => {
    const report = renderReleaseIncident(manifest, {
      states: {
        "@turingfocus/chat-protocol": "published",
      },
      beforeTags: {},
      currentTags: {
        "@turingfocus/chat-protocol": "0.2.0-next.0",
      },
    });

    expect(report).toContain("npm dist-tag rm @turingfocus/chat-protocol next");
  });
});
