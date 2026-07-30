import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertReleaseChannelAllowed,
  buildReleasePackages,
  createReleaseManifest,
  loadCompatibilityPolicy,
  RELEASE_PACKAGE_NAMES,
  validateCompatibilityPolicy,
} from "../scripts/release-policy.mjs";
import { assertReleaseQueueConsumed } from "../scripts/create-release-manifest.mjs";
import { planReleaseVersionCommands } from "../scripts/version-release.mjs";

const loadPolicyValue = async () =>
  JSON.parse(
    await readFile(
      new URL("../release/compatibility.json", import.meta.url),
      "utf8",
    ),
  );

const loadPolicy = async () =>
  validateCompatibilityPolicy(await loadPolicyValue());

const externalEvidence = (kind: string, issue: string, subject: string) => ({
  schemaVersion: 1,
  kind,
  issue,
  subject,
  repository: `A2C-SMCP/${subject}`,
  revision: "c".repeat(40),
  environment: "staging",
  runUrl: "https://github.com/A2C-SMCP/host/actions/runs/123",
  executedAt: "2026-07-30T00:00:00.000Z",
  result: "passed",
});

const loadReadyPolicy = async (result = "passed") => {
  const rootDirectory = await mkdtemp(
    path.join(os.tmpdir(), "tf-chat-kit-ready-policy-"),
  );
  const policy = await loadPolicyValue();
  policy.server.productionSocketStatus = "passed";
  policy.server.evidence = "release/evidence/production-socket.json";
  delete policy.server.blockedBy;
  policy.consumers.tfrobotfrontReal = {
    status: "passed",
    evidence: "release/evidence/tfrobotfront-real.json",
  };
  policy.consumers.secondHostReal = {
    status: "passed",
    evidence: "release/evidence/second-host-real.json",
  };
  const evidence = {
    "release/evidence/production-socket.json": {
      ...externalEvidence("production-socket", "TFCK-13", "TFRobotServer"),
      result,
    },
    "release/evidence/tfrobotfront-real.json": externalEvidence(
      "real-host",
      "TFCK-13",
      "TFRobotFront",
    ),
    "release/evidence/second-host-real.json": externalEvidence(
      "real-host",
      "TFCK-13",
      "second-host",
    ),
  };
  await mkdir(path.join(rootDirectory, "release"), { recursive: true });
  await writeFile(
    path.join(rootDirectory, "release", "compatibility.json"),
    `${JSON.stringify(policy)}\n`,
  );
  for (const pathValue of [
    policy.server.evidence,
    ...(Object.values(policy.consumers) as { evidence?: string }[]).flatMap(
      (entry) => (entry.evidence ? [entry.evidence] : []),
    ),
  ]) {
    const absolute = path.join(rootDirectory, pathValue);
    await mkdir(path.dirname(absolute), { recursive: true });
    const content =
      evidence[pathValue as keyof typeof evidence] ?? "# Mock baseline\n";
    await writeFile(
      absolute,
      typeof content === "string"
        ? content
        : `${JSON.stringify(content, null, 2)}\n`,
    );
  }
  return loadCompatibilityPolicy(rootDirectory);
};

const createPackedGroup = async (
  rootDirectory: string,
  version = "0.2.0-next.0",
) => {
  const artifactDirectory = path.join(rootDirectory, ".artifacts", "packages");
  await mkdir(artifactDirectory, { recursive: true });
  const packages = [];
  for (const name of RELEASE_PACKAGE_NAMES) {
    const tarball = path.join(
      artifactDirectory,
      `${name.slice(1).replace("/", "-")}-${version}.tgz`,
    );
    await writeFile(tarball, `approved tarball for ${name}@${version}`);
    packages.push({
      name,
      version,
      tarball,
      files: ["package.json", "dist/index.js"],
    });
  }
  return { packages };
};

describe("release compatibility and manifest policy", () => {
  it("requires the Changesets version PR to consume the release queue", () => {
    expect(() =>
      assertReleaseQueueConsumed([{ id: "pending-runtime" }], undefined),
    ).toThrow(/merged Changesets version commit/u);
    expect(() => assertReleaseQueueConsumed([], undefined)).not.toThrow();
    expect(() =>
      assertReleaseQueueConsumed([{ id: "prerelease-runtime" }], {
        mode: "pre",
        changesets: ["prerelease-runtime"],
      }),
    ).not.toThrow();
  });

  it("gates both release channels on repository-owned compatibility mocks", async () => {
    const policy = await loadPolicy();

    expect(assertReleaseChannelAllowed(policy, "next").allowed).toBe(true);
    expect(assertReleaseChannelAllowed(policy, "latest").allowed).toBe(true);

    const incompatible = structuredClone(policy);
    incompatible.consumers["tauriMock"] = {
      status: "blocked",
      blockedBy: ["Tauri-style packed consumer regression"],
    };
    expect(() => assertReleaseChannelAllowed(incompatible, "next")).toThrow(
      /Tauri-style packed consumer regression/u,
    );
    expect(() => assertReleaseChannelAllowed(incompatible, "latest")).toThrow(
      /Tauri-style packed consumer regression/u,
    );
  });

  it("records optional external E2E with dedicated evidence without making it a release dependency", async () => {
    const policy = await loadPolicy();
    const tampered = structuredClone(policy) as unknown as {
      channels: { latest: Record<string, unknown> };
    };
    tampered.channels.latest["allowed"] = true;
    expect(() => validateCompatibilityPolicy(tampered)).toThrow(
      /only optional keys <none>/u,
    );

    const mockClaim = structuredClone(policy);
    mockClaim.server.productionSocketStatus = "passed";
    mockClaim.server.evidence =
      "docs/baselines/tfck-7/tfrobot-gateway-compatibility.md";
    delete mockClaim.server.blockedBy;
    mockClaim.consumers["tfrobotfrontReal"] = {
      status: "passed",
      evidence: "docs/baselines/tfck-11/host-consumer-validation.md",
    };
    mockClaim.consumers["secondHostReal"] = {
      status: "passed",
      evidence: "docs/baselines/tfck-12/non-tfrobotfront-consumer-matrix.md",
    };
    expect(() => validateCompatibilityPolicy(mockClaim)).toThrow(
      /production-socket\.json|dedicated approved evidence path/u,
    );

    expect(assertReleaseChannelAllowed(policy, "latest").allowed).toBe(true);
    expect(
      assertReleaseChannelAllowed(await loadReadyPolicy(), "latest").allowed,
    ).toBe(true);
    await expect(loadReadyPolicy("failed")).rejects.toThrow(
      /identity and result/u,
    );
  });

  it("plans stable Changesets output from repository-owned compatibility evidence", async () => {
    const policy = await loadPolicy();
    expect(planReleaseVersionCommands(policy, undefined)).toEqual([
      ["version"],
    ]);
    expect(
      planReleaseVersionCommands(policy, { mode: "pre", tag: "next" }),
    ).toEqual([["version"]]);

    expect(
      planReleaseVersionCommands(await loadReadyPolicy(), {
        mode: "pre",
        tag: "next",
      }),
    ).toEqual([["version"]]);

    const incompatible = structuredClone(policy);
    incompatible.consumers["officeMock"] = {
      status: "blocked",
      blockedBy: ["Office-style packed consumer regression"],
    };
    expect(() => planReleaseVersionCommands(incompatible, undefined)).toThrow(
      /Office-style packed consumer regression/u,
    );
  });

  it("turns the fixed packed group into path-independent immutable entries", async () => {
    const rootDirectory = await mkdtemp(
      path.join(os.tmpdir(), "tf-chat-kit-release-policy-"),
    );
    const result = await buildReleasePackages({
      rootDirectory,
      packManifest: await createPackedGroup(rootDirectory),
    });

    expect(result.version).toBe("0.2.0-next.0");
    expect(result.packages.map(({ name }) => name)).toEqual(
      RELEASE_PACKAGE_NAMES,
    );
    expect(result.packages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tarball: "turingfocus-chat-protocol-0.2.0-next.0.tgz",
          integrity: expect.stringMatching(/^sha512-/u),
        }),
      ]),
    );
    expect(
      result.packages.every(({ tarball }) => !path.isAbsolute(tarball)),
    ).toBe(true);
  });

  it("rejects artifacts outside the approved pack directory", async () => {
    const rootDirectory = await mkdtemp(
      path.join(os.tmpdir(), "tf-chat-kit-release-policy-"),
    );
    const packManifest = await createPackedGroup(rootDirectory);
    const outside = path.join(rootDirectory, "outside.tgz");
    await writeFile(outside, "outside");
    packManifest.packages[0]!.tarball = outside;

    await expect(
      buildReleasePackages({ rootDirectory, packManifest }),
    ).rejects.toThrow(/must be inside/u);
  });

  it("rejects a symlinked tarball that resolves outside the artifact directory", async () => {
    const rootDirectory = await mkdtemp(
      path.join(os.tmpdir(), "tf-chat-kit-release-policy-"),
    );
    const packManifest = await createPackedGroup(rootDirectory);
    const outside = path.join(rootDirectory, "outside.tgz");
    await writeFile(outside, "outside");
    const linkedTarball = packManifest.packages[0]!.tarball;
    await writeFile(linkedTarball, "");
    const linkedReplacement = `${linkedTarball}.link`;
    await symlink(outside, linkedReplacement);
    packManifest.packages[0]!.tarball = linkedReplacement;

    await expect(
      buildReleasePackages({ rootDirectory, packManifest }),
    ).rejects.toThrow(/regular file/u);
  });

  it("binds the allowed channel, source SHA, workflow, and package group", async () => {
    const rootDirectory = await mkdtemp(
      path.join(os.tmpdir(), "tf-chat-kit-release-policy-"),
    );
    const { version, packages } = await buildReleasePackages({
      rootDirectory,
      packManifest: await createPackedGroup(rootDirectory),
    });
    const manifest = createReleaseManifest({
      version,
      channel: "next",
      commit: "a".repeat(40),
      runUrl: "https://github.com/A2C-SMCP/tf-chat-kit/actions/runs/1",
      createdAt: "2026-07-29T00:00:00.000Z",
      compatibility: await loadPolicy(),
      packages,
    });

    expect(manifest).toMatchObject({
      version: "0.2.0-next.0",
      channel: "next",
      tag: "v0.2.0-next.0",
      commit: "a".repeat(40),
      workflow: "release.yml",
      environment: "npm-production",
    });
  });

  it("rejects stable versions on next and prereleases on latest", async () => {
    const rootDirectory = await mkdtemp(
      path.join(os.tmpdir(), "tf-chat-kit-release-policy-"),
    );
    const { packages } = await buildReleasePackages({
      rootDirectory,
      packManifest: await createPackedGroup(rootDirectory),
    });
    const policy = await loadPolicy();
    const readyPolicy = await loadReadyPolicy();

    expect(() =>
      createReleaseManifest({
        version: "0.2.0",
        channel: "next",
        commit: "a".repeat(40),
        runUrl: "https://github.com/A2C-SMCP/tf-chat-kit/actions/runs/1",
        createdAt: "2026-07-29T00:00:00.000Z",
        compatibility: policy,
        packages,
      }),
    ).toThrow(/explicit SemVer prerelease/u);

    expect(() =>
      createReleaseManifest({
        version: "0.2.0-next.0",
        channel: "latest",
        commit: "a".repeat(40),
        runUrl: "https://github.com/A2C-SMCP/tf-chat-kit/actions/runs/1",
        createdAt: "2026-07-29T00:00:00.000Z",
        compatibility: readyPolicy,
        packages,
      }),
    ).toThrow(/stable SemVer version/u);
  });
});
