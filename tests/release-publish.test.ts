import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  publishRelease,
  validateReleaseManifestForPublish,
} from "../scripts/publish-release.mjs";
import {
  calculateFileIntegrity,
  RELEASE_PACKAGE_NAMES,
} from "../scripts/release-policy.mjs";

type ReleasePackage = {
  name: string;
  version: string;
  tarball: string;
  size: number;
  integrity: string;
  files: string[];
};

const releaseVersion = "0.2.0-next.0";

const createFixture = async () => {
  const rootDirectory = await mkdtemp(
    path.join(os.tmpdir(), "tf-chat-kit-release-publish-"),
  );
  const artifactDirectory = path.join(rootDirectory, ".artifacts", "packages");
  await mkdir(artifactDirectory, { recursive: true });
  const packages: ReleasePackage[] = [];
  for (const name of RELEASE_PACKAGE_NAMES) {
    const tarball = `${name.slice(1).replace("/", "-")}-${releaseVersion}.tgz`;
    const absoluteTarball = path.join(artifactDirectory, tarball);
    const bytes = `approved tarball for ${name}`;
    await writeFile(absoluteTarball, bytes);
    packages.push({
      name,
      version: releaseVersion,
      tarball,
      size: Buffer.byteLength(bytes),
      integrity: await calculateFileIntegrity(absoluteTarball),
      files: ["package.json"],
    });
  }
  return {
    rootDirectory,
    progressFile: path.join(rootDirectory, ".artifacts", "progress.json"),
    manifest: {
      version: releaseVersion,
      channel: "next",
      tag: `v${releaseVersion}`,
      commit: "b".repeat(40),
      packages,
    },
  };
};

const registryFetch = (
  registry: Map<string, Record<string, unknown>>,
  calls: string[],
): typeof fetch =>
  (async (input) => {
    const url = new URL(String(input));
    calls.push(url.toString());
    const name = decodeURIComponent(url.pathname.slice(1));
    const metadata = registry.get(name);
    return metadata
      ? new Response(JSON.stringify(metadata), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      : new Response("missing", { status: 404 });
  }) as typeof fetch;

describe("protected npm publication", () => {
  it("rejects unsafe manifests before resolving tarballs", async () => {
    const fixture = await createFixture();
    const unsafe = structuredClone(fixture.manifest);
    unsafe.packages[0]!.tarball = "../../outside.tgz";

    expect(() => validateReleaseManifestForPublish(unsafe)).toThrow(
      /safe immutable artifacts/u,
    );
  });

  it("keeps OIDC tokenless and requires the protected bootstrap credential", async () => {
    const fixture = await createFixture();
    const manifest = validateReleaseManifestForPublish(fixture.manifest);

    await expect(
      publishRelease({
        ...fixture,
        manifest,
        authMode: "oidc",
        env: { NODE_AUTH_TOKEN: "forbidden" },
      }),
    ).rejects.toThrow(/must not receive NODE_AUTH_TOKEN/u);
    await expect(
      publishRelease({
        ...fixture,
        manifest,
        authMode: "bootstrap-token",
        env: {},
      }),
    ).rejects.toThrow(/requires a protected NODE_AUTH_TOKEN/u);
  });

  it("resumes an integrity-matching partial batch without republishing it", async () => {
    const fixture = await createFixture();
    const manifest = validateReleaseManifestForPublish(fixture.manifest);
    const registry = new Map<string, Record<string, unknown>>();
    registry.set(manifest.packages[0]!.name, {
      versions: {
        [releaseVersion]: {
          dist: { integrity: manifest.packages[0]!.integrity },
        },
      },
      "dist-tags": { next: releaseVersion },
    });
    const fetchCalls: string[] = [];
    const published: string[] = [];

    const states = await publishRelease({
      ...fixture,
      manifest,
      authMode: "oidc",
      env: {},
      fetchImpl: registryFetch(registry, fetchCalls),
      publishImpl: (_npmCli, args) => {
        const tarball = path.basename(args[1] ?? "");
        const releasePackage = manifest.packages.find(
          (entry) => entry.tarball === tarball,
        );
        if (!releasePackage) throw new Error("unexpected tarball");
        published.push(releasePackage.name);
        registry.set(releasePackage.name, {
          versions: {
            [releaseVersion]: {
              dist: { integrity: releasePackage.integrity },
            },
          },
          "dist-tags": { next: releaseVersion },
        });
      },
    });

    expect(states[manifest.packages[0]!.name]).toBe("verified-existing");
    expect(published).toEqual(
      manifest.packages.slice(1).map(({ name }) => name),
    );
    expect(fetchCalls).toHaveLength(RELEASE_PACKAGE_NAMES.length * 2 - 1);
  });

  it("reconciles a complete matching batch so downstream verification can resume", async () => {
    const fixture = await createFixture();
    const manifest = validateReleaseManifestForPublish(fixture.manifest);
    const registry = new Map<string, Record<string, unknown>>();
    for (const releasePackage of manifest.packages) {
      registry.set(releasePackage.name, {
        versions: {
          [releaseVersion]: {
            dist: { integrity: releasePackage.integrity },
          },
        },
        "dist-tags": { next: releaseVersion },
      });
    }
    const publishImpl = vi.fn();
    const fetchCalls: string[] = [];

    const states = await publishRelease({
      ...fixture,
      manifest,
      authMode: "oidc",
      env: {},
      fetchImpl: registryFetch(registry, fetchCalls),
      publishImpl,
    });

    expect(Object.values(states)).toEqual(
      Array(RELEASE_PACKAGE_NAMES.length).fill("verified-existing"),
    );
    expect(fetchCalls).toHaveLength(RELEASE_PACKAGE_NAMES.length);
    expect(publishImpl).not.toHaveBeenCalled();
  });

  it("allows the protected bootstrap credential only for the initial batch", async () => {
    const fixture = await createFixture();
    const manifest = validateReleaseManifestForPublish(fixture.manifest);
    const registry = new Map<string, Record<string, unknown>>();
    const published: string[] = [];

    const states = await publishRelease({
      ...fixture,
      manifest,
      authMode: "bootstrap-token",
      env: { NODE_AUTH_TOKEN: "protected-test-token" },
      fetchImpl: registryFetch(registry, []),
      publishImpl: (_npmCli, args) => {
        const tarball = path.basename(args[1] ?? "");
        const releasePackage = manifest.packages.find(
          (entry) => entry.tarball === tarball,
        );
        if (!releasePackage) throw new Error("unexpected tarball");
        published.push(releasePackage.name);
        registry.set(releasePackage.name, {
          versions: {
            [releaseVersion]: {
              dist: { integrity: releasePackage.integrity },
            },
          },
          "dist-tags": { next: releaseVersion },
        });
      },
    });

    expect(published).toEqual(manifest.packages.map(({ name }) => name));
    expect(Object.values(states)).toEqual(
      Array(RELEASE_PACKAGE_NAMES.length).fill("published"),
    );
  });

  it("refuses to resume an existing version after its release tag moved", async () => {
    const fixture = await createFixture();
    const manifest = validateReleaseManifestForPublish(fixture.manifest);
    const releasePackage = manifest.packages[0]!;
    const registry = new Map<string, Record<string, unknown>>([
      [
        releasePackage.name,
        {
          versions: {
            [releaseVersion]: {
              dist: { integrity: releasePackage.integrity },
            },
          },
          "dist-tags": { next: "0.1.0-next.0" },
        },
      ],
    ]);

    await expect(
      publishRelease({
        ...fixture,
        manifest,
        authMode: "oidc",
        env: {},
        fetchImpl: registryFetch(registry, []),
        publishImpl: vi.fn(),
      }),
    ).rejects.toThrow(/must retain the next dist-tag/u);
  });

  it("does one failure reconciliation, records ambiguity, and never polls", async () => {
    const fixture = await createFixture();
    const manifest = validateReleaseManifestForPublish(fixture.manifest);
    const fetchCalls: string[] = [];

    await expect(
      publishRelease({
        ...fixture,
        manifest,
        authMode: "oidc",
        env: {},
        fetchImpl: registryFetch(new Map(), fetchCalls),
        publishImpl: () => {
          throw new Error("simulated npm failure");
        },
      }),
    ).rejects.toThrow("simulated npm failure");

    expect(fetchCalls).toHaveLength(RELEASE_PACKAGE_NAMES.length + 1);
    const progress = JSON.parse(
      await readFile(fixture.progressFile, "utf8"),
    ) as {
      states: Record<string, string>;
      error: string;
    };
    expect(progress.states[manifest.packages[0]!.name]).toBe(
      "publish-attempted",
    );
    expect(progress.error).toBe("simulated npm failure");
  });

  it("fails closed when an existing version has different integrity", async () => {
    const fixture = await createFixture();
    const manifest = validateReleaseManifestForPublish(fixture.manifest);
    const registry = new Map<string, Record<string, unknown>>([
      [
        manifest.packages[0]!.name,
        {
          versions: {
            [releaseVersion]: {
              dist: { integrity: "sha512-conflict" },
            },
          },
          "dist-tags": { next: releaseVersion },
        },
      ],
    ]);
    const publishImpl = vi.fn();

    await expect(
      publishRelease({
        ...fixture,
        manifest,
        authMode: "oidc",
        env: {},
        fetchImpl: registryFetch(registry, []),
        publishImpl,
      }),
    ).rejects.toThrow(/does not match the approved tarball/u);
    expect(publishImpl).not.toHaveBeenCalled();
  });

  it("forbids bootstrap on a later partially published OIDC batch", async () => {
    const fixture = await createFixture();
    const manifest = validateReleaseManifestForPublish(fixture.manifest);
    const publishImpl = vi.fn();
    const registry = new Map<string, Record<string, unknown>>();
    for (const [index, releasePackage] of manifest.packages.entries()) {
      registry.set(releasePackage.name, {
        versions: {
          "0.1.0": { dist: { integrity: "sha512-previous" } },
          ...(index === 0
            ? {
                [releaseVersion]: {
                  dist: { integrity: releasePackage.integrity },
                },
              }
            : {}),
        },
        "dist-tags": {
          next: index === 0 ? releaseVersion : "0.1.0",
        },
      });
    }

    await expect(
      publishRelease({
        ...fixture,
        manifest,
        authMode: "bootstrap-token",
        env: { NODE_AUTH_TOKEN: "protected-test-token" },
        fetchImpl: registryFetch(registry, []),
        publishImpl,
      }),
    ).rejects.toThrow(/forbidden after the initial fixed-version batch/u);
    expect(publishImpl).not.toHaveBeenCalled();
  });
});
