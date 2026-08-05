import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  BOOTSTRAP_FACADE_PACKAGE,
  publishRelease,
  validateReleaseManifestForPublish,
} from "../scripts/publish-release.mjs";
import {
  calculateFileIntegrity,
  RELEASE_PACKAGE_NAMES,
} from "../scripts/release-policy.mjs";
import { renderReleaseIncident } from "../scripts/render-release-report.mjs";

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

const readProgress = async (progressFile: string) =>
  JSON.parse(await readFile(progressFile, "utf8")) as {
    states: Record<string, string>;
    beforeTags: Record<string, string | null>;
    currentTags: Record<string, string | null>;
    error?: string;
  };

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
    ).rejects.toThrow(/process-wide NODE_AUTH_TOKEN/u);
    expect((await readProgress(fixture.progressFile)).error).toMatch(
      /process-wide NODE_AUTH_TOKEN/u,
    );
    await expect(
      publishRelease({
        ...fixture,
        manifest,
        authMode: "bootstrap-token",
        env: {},
      }),
    ).rejects.toThrow(/requires a protected NODE_AUTH_TOKEN/u);
    expect((await readProgress(fixture.progressFile)).error).toMatch(
      /requires a protected NODE_AUTH_TOKEN/u,
    );
    await expect(
      publishRelease({
        ...fixture,
        manifest,
        authMode: "oidc-with-bootstrap-facade",
        env: {},
      }),
    ).rejects.toThrow(
      /requires a protected token and isolated npm userconfig/u,
    );
    expect((await readProgress(fixture.progressFile)).error).toMatch(
      /requires a protected token and isolated npm userconfig/u,
    );
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
    expect(fetchCalls).toHaveLength(RELEASE_PACKAGE_NAMES.length * 3 - 2);
  });

  it("skips a package that appears between batch preflight and its fresh write check", async () => {
    const fixture = await createFixture();
    const manifest = validateReleaseManifestForPublish(fixture.manifest);
    const registry = new Map<string, Record<string, unknown>>();
    const appearedPackage = manifest.packages[1]!;
    const published: string[] = [];

    const states = await publishRelease({
      ...fixture,
      manifest,
      authMode: "oidc",
      env: {},
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
        if (releasePackage === manifest.packages[0]) {
          registry.set(appearedPackage.name, {
            versions: {
              [releaseVersion]: {
                dist: { integrity: appearedPackage.integrity },
              },
            },
            "dist-tags": { next: releaseVersion },
          });
        }
      },
    });

    expect(published).not.toContain(appearedPackage.name);
    expect(states[appearedPackage.name]).toBe("verified-existing");
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

  it("uses OIDC for existing packages and exposes the bootstrap token only to an absent facade", async () => {
    const fixture = await createFixture();
    const manifest = validateReleaseManifestForPublish(fixture.manifest);
    const registry = new Map<string, Record<string, unknown>>();
    for (const releasePackage of manifest.packages) {
      if (releasePackage.name === BOOTSTRAP_FACADE_PACKAGE) continue;
      registry.set(releasePackage.name, {
        versions: {
          "0.1.0-next.0": {
            dist: { integrity: "sha512-previous" },
          },
        },
        "dist-tags": { next: "0.1.0-next.0" },
      });
    }
    const publishEnvironments = new Map<string, NodeJS.ProcessEnv>();

    const states = await publishRelease({
      ...fixture,
      manifest,
      authMode: "oidc-with-bootstrap-facade",
      env: {
        NPM_BOOTSTRAP_TOKEN: "facade-only-token",
        NPM_BOOTSTRAP_USERCONFIG: "/tmp/facade-bootstrap.npmrc",
        ACTIONS_ID_TOKEN_REQUEST_URL: "https://example.test/oidc",
      },
      fetchImpl: registryFetch(registry, []),
      publishImpl: (_npmCli, args, publishEnv) => {
        const tarball = path.basename(args[1] ?? "");
        const releasePackage = manifest.packages.find(
          (entry) => entry.tarball === tarball,
        );
        if (!releasePackage) throw new Error("unexpected tarball");
        publishEnvironments.set(releasePackage.name, publishEnv);
        registry.set(releasePackage.name, {
          versions: {
            ...((registry.get(releasePackage.name)?.["versions"] as
              Record<string, unknown> | undefined) ?? {}),
            [releaseVersion]: {
              dist: { integrity: releasePackage.integrity },
            },
          },
          "dist-tags": { next: releaseVersion },
        });
      },
    });

    expect(Object.values(states)).toEqual(
      Array(RELEASE_PACKAGE_NAMES.length).fill("published"),
    );
    for (const releasePackage of manifest.packages) {
      const publishEnv = publishEnvironments.get(releasePackage.name);
      expect(publishEnv).toBeDefined();
      expect(publishEnv).not.toHaveProperty("NPM_BOOTSTRAP_TOKEN");
      expect(publishEnv).not.toHaveProperty("NPM_BOOTSTRAP_USERCONFIG");
      expect(publishEnv?.["ACTIONS_ID_TOKEN_REQUEST_URL"]).toBe(
        "https://example.test/oidc",
      );
      if (releasePackage.name === BOOTSTRAP_FACADE_PACKAGE) {
        expect(publishEnv?.["NODE_AUTH_TOKEN"]).toBe("facade-only-token");
        expect(publishEnv?.["NPM_CONFIG_USERCONFIG"]).toBe(
          "/tmp/facade-bootstrap.npmrc",
        );
      } else {
        expect(publishEnv).not.toHaveProperty("NODE_AUTH_TOKEN");
        expect(publishEnv).not.toHaveProperty("NPM_CONFIG_USERCONFIG");
      }
    }
  });

  it("fails closed when the facade appears before its fresh bootstrap check", async () => {
    const fixture = await createFixture();
    const manifest = validateReleaseManifestForPublish(fixture.manifest);
    const registry = new Map<string, Record<string, unknown>>();
    for (const releasePackage of manifest.packages) {
      if (releasePackage.name === BOOTSTRAP_FACADE_PACKAGE) continue;
      registry.set(releasePackage.name, {
        versions: {
          "0.1.0-next.0": {
            dist: { integrity: "sha512-previous" },
          },
        },
        "dist-tags": { next: "0.1.0-next.0" },
      });
    }
    const publishEnvironments = new Map<string, NodeJS.ProcessEnv>();

    await expect(
      publishRelease({
        ...fixture,
        manifest,
        authMode: "oidc-with-bootstrap-facade",
        env: {
          NPM_BOOTSTRAP_TOKEN: "facade-only-token",
          NPM_BOOTSTRAP_USERCONFIG: "/tmp/facade-bootstrap.npmrc",
        },
        fetchImpl: registryFetch(registry, []),
        publishImpl: (_npmCli, args, publishEnv) => {
          const tarball = path.basename(args[1] ?? "");
          const releasePackage = manifest.packages.find(
            (entry) => entry.tarball === tarball,
          );
          if (!releasePackage) throw new Error("unexpected tarball");
          publishEnvironments.set(releasePackage.name, publishEnv);
          registry.set(releasePackage.name, {
            versions: {
              ...((registry.get(releasePackage.name)?.["versions"] as
                Record<string, unknown> | undefined) ?? {}),
              [releaseVersion]: {
                dist: { integrity: releasePackage.integrity },
              },
            },
            "dist-tags": { next: releaseVersion },
          });
          if (publishEnvironments.size === 1) {
            registry.set(BOOTSTRAP_FACADE_PACKAGE, {
              versions: {
                "0.1.0-next.0": {
                  dist: { integrity: "sha512-concurrent-facade" },
                },
              },
              "dist-tags": { next: "0.1.0-next.0" },
            });
          }
        },
      }),
    ).rejects.toThrow(/allowed only while the package is completely absent/u);

    expect(publishEnvironments.has(BOOTSTRAP_FACADE_PACKAGE)).toBe(false);
    for (const publishEnv of publishEnvironments.values()) {
      expect(publishEnv).not.toHaveProperty("NODE_AUTH_TOKEN");
      expect(publishEnv).not.toHaveProperty("NPM_CONFIG_USERCONFIG");
    }
    expect((await readProgress(fixture.progressFile)).error).toMatch(
      /allowed only while the package is completely absent/u,
    );
  });

  it("fails before publishing when hybrid bootstrap would create a non-facade package", async () => {
    const fixture = await createFixture();
    const manifest = validateReleaseManifestForPublish(fixture.manifest);
    const publishImpl = vi.fn();

    await expect(
      publishRelease({
        ...fixture,
        manifest,
        authMode: "oidc-with-bootstrap-facade",
        env: {
          NPM_BOOTSTRAP_TOKEN: "facade-only-token",
          NPM_BOOTSTRAP_USERCONFIG: "/tmp/facade-bootstrap.npmrc",
        },
        fetchImpl: registryFetch(new Map(), []),
        publishImpl,
      }),
    ).rejects.toThrow(/non-facade package to already exist/u);
    expect(publishImpl).not.toHaveBeenCalled();
  });

  it("rejects facade bootstrap after that package has any historical version", async () => {
    const fixture = await createFixture();
    const manifest = validateReleaseManifestForPublish(fixture.manifest);
    const registry = new Map<string, Record<string, unknown>>();
    for (const releasePackage of manifest.packages) {
      registry.set(releasePackage.name, {
        versions: {
          "0.1.0-next.0": {
            dist: { integrity: "sha512-previous" },
          },
        },
        "dist-tags": { next: "0.1.0-next.0" },
      });
    }
    const publishImpl = vi.fn();

    await expect(
      publishRelease({
        ...fixture,
        manifest,
        authMode: "oidc-with-bootstrap-facade",
        env: {
          NPM_BOOTSTRAP_TOKEN: "facade-only-token",
          NPM_BOOTSTRAP_USERCONFIG: "/tmp/facade-bootstrap.npmrc",
        },
        fetchImpl: registryFetch(registry, []),
        publishImpl,
      }),
    ).rejects.toThrow(/allowed only while the package is completely absent/u);
    expect(publishImpl).not.toHaveBeenCalled();
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

  it("bounds failed publication reconciliation and records the original error", async () => {
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
        reconciliationDelaysMs: [0, 1, 2],
        waitImpl: vi.fn().mockResolvedValue(undefined),
      }),
    ).rejects.toThrow("simulated npm failure");

    expect(fetchCalls).toHaveLength(RELEASE_PACKAGE_NAMES.length + 4);
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

  it("waits for a successfully published version and dist-tag to become visible", async () => {
    const fixture = await createFixture();
    const manifest = validateReleaseManifestForPublish(fixture.manifest);
    const registry = new Map<string, Record<string, unknown>>();
    const firstPackage = manifest.packages[0]!;
    let firstPackagePublished = false;
    let firstPackageReconciliationReads = 0;
    const waitImpl = vi.fn().mockResolvedValue(undefined);
    const baseFetch = registryFetch(registry, []);
    const fetchImpl = (async (input, init) => {
      const name = decodeURIComponent(new URL(String(input)).pathname.slice(1));
      if (name === firstPackage.name && firstPackagePublished) {
        firstPackageReconciliationReads += 1;
        if (firstPackageReconciliationReads === 3) {
          registry.set(firstPackage.name, {
            versions: {
              [releaseVersion]: {
                dist: { integrity: firstPackage.integrity },
              },
            },
            "dist-tags": { next: releaseVersion },
          });
        }
      }
      return baseFetch(input, init);
    }) as typeof fetch;

    const states = await publishRelease({
      ...fixture,
      manifest,
      authMode: "oidc",
      env: {},
      fetchImpl,
      publishImpl: (_npmCli, args) => {
        const tarball = path.basename(args[1] ?? "");
        const releasePackage = manifest.packages.find(
          (entry) => entry.tarball === tarball,
        );
        if (!releasePackage) throw new Error("unexpected tarball");
        if (releasePackage.name === firstPackage.name) {
          firstPackagePublished = true;
          return;
        }
        registry.set(releasePackage.name, {
          versions: {
            [releaseVersion]: {
              dist: { integrity: releasePackage.integrity },
            },
          },
          "dist-tags": { next: releaseVersion },
        });
      },
      reconciliationDelaysMs: [0, 1, 2, 4],
      waitImpl,
    });

    expect(states[firstPackage.name]).toBe("published");
    expect(firstPackageReconciliationReads).toBe(3);
    expect(waitImpl).toHaveBeenNthCalledWith(1, 1);
    expect(waitImpl).toHaveBeenNthCalledWith(2, 2);
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
              dist: { integrity: manifest.packages[0]!.integrity },
            },
          },
          "dist-tags": { next: releaseVersion },
        },
      ],
      [
        manifest.packages[1]!.name,
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
    const progress = await readProgress(fixture.progressFile);
    expect(progress.states[manifest.packages[0]!.name]).toBe(
      "verified-existing",
    );
    expect(progress.currentTags[manifest.packages[1]!.name]).toBe(
      releaseVersion,
    );
    expect(progress.error).toMatch(/does not match the approved tarball/u);
  });

  it("records tarball and Registry preflight failures before publication", async () => {
    const changedTarballFixture = await createFixture();
    const changedManifest = validateReleaseManifestForPublish(
      changedTarballFixture.manifest,
    );
    await writeFile(
      path.join(
        changedTarballFixture.rootDirectory,
        ".artifacts",
        "packages",
        changedManifest.packages[0]!.tarball,
      ),
      "changed after approval",
    );

    await expect(
      publishRelease({
        ...changedTarballFixture,
        manifest: changedManifest,
        authMode: "oidc",
        env: {},
        publishImpl: vi.fn(),
      }),
    ).rejects.toThrow(/tarball changed after release manifest creation/u);
    expect(
      (await readProgress(changedTarballFixture.progressFile)).error,
    ).toMatch(/tarball changed after release manifest creation/u);

    const registryFixture = await createFixture();
    const registryManifest = validateReleaseManifestForPublish(
      registryFixture.manifest,
    );
    await expect(
      publishRelease({
        ...registryFixture,
        manifest: registryManifest,
        authMode: "oidc",
        env: {},
        fetchImpl: (async () =>
          new Response("unavailable", { status: 503 })) as typeof fetch,
        publishImpl: vi.fn(),
      }),
    ).rejects.toThrow(/registry read failed with HTTP 503/u);
    const registryProgress = await readProgress(registryFixture.progressFile);
    expect(registryProgress.error).toMatch(
      /registry read failed with HTTP 503/u,
    );
    expect(Object.values(registryProgress.states)).toEqual(
      Array(RELEASE_PACKAGE_NAMES.length).fill("pending"),
    );
  });

  it("records the observed tag and integrity conflict after a publish attempt", async () => {
    const fixture = await createFixture();
    const manifest = validateReleaseManifestForPublish(fixture.manifest);
    const registry = new Map<string, Record<string, unknown>>();
    const releasePackage = manifest.packages[0]!;
    const publishImpl = vi.fn(() => {
      registry.set(releasePackage.name, {
        versions: {
          [releaseVersion]: {
            dist: { integrity: "sha512-conflicting-publication" },
          },
        },
        "dist-tags": { next: releaseVersion },
      });
    });

    await expect(
      publishRelease({
        ...fixture,
        manifest,
        authMode: "oidc",
        env: {},
        fetchImpl: registryFetch(registry, []),
        publishImpl,
      }),
    ).rejects.toThrow(/integrity does not match the approved tarball/u);

    expect(publishImpl).toHaveBeenCalledTimes(1);
    const progress = JSON.parse(
      await readFile(fixture.progressFile, "utf8"),
    ) as {
      states: Record<string, string>;
      beforeTags: Record<string, string>;
      currentTags: Record<string, string>;
      error: string;
    };
    expect(progress.states[releasePackage.name]).toBe("publish-attempted");
    expect(progress.beforeTags[releasePackage.name]).toBeNull();
    expect(progress.currentTags[releasePackage.name]).toBe(releaseVersion);
    expect(progress.error).toMatch(/integrity does not match/u);

    const incident = renderReleaseIncident(manifest, progress);
    expect(incident).toContain(progress.error);
    expect(incident).toContain(`npm dist-tag rm ${releasePackage.name} next`);
    expect(incident).not.toContain("do not change existing tags");
  });

  it("never combines a previous version with a later malformed Registry snapshot", async () => {
    const fixture = await createFixture();
    const manifest = validateReleaseManifestForPublish(fixture.manifest);
    const releasePackage = manifest.packages[0]!;
    let publishStarted = false;
    let reconciliationRead = 0;
    const fetchImpl = (async (input) => {
      const name = decodeURIComponent(new URL(String(input)).pathname.slice(1));
      if (name !== releasePackage.name || !publishStarted) {
        return new Response("missing", { status: 404 });
      }
      reconciliationRead += 1;
      const metadata =
        reconciliationRead === 1
          ? {
              versions: {
                [releaseVersion]: {
                  dist: { integrity: releasePackage.integrity },
                },
              },
              "dist-tags": { next: "0.1.0-next.0" },
            }
          : {
              versions: { [releaseVersion]: "malformed-version-metadata" },
              "dist-tags": { next: releaseVersion },
            };
      return new Response(JSON.stringify(metadata), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const publishImpl = vi.fn(() => {
      publishStarted = true;
    });

    await expect(
      publishRelease({
        ...fixture,
        manifest,
        authMode: "oidc",
        env: {},
        fetchImpl,
        publishImpl,
        reconciliationDelaysMs: [0, 1],
        waitImpl: vi.fn().mockResolvedValue(undefined),
      }),
    ).rejects.toThrow(/registry version .* must be an object/u);

    expect(publishImpl).toHaveBeenCalledTimes(1);
    const progress = JSON.parse(
      await readFile(fixture.progressFile, "utf8"),
    ) as {
      states: Record<string, string>;
      beforeTags: Record<string, string>;
      currentTags: Record<string, string>;
      error: string;
    };
    expect(progress.states[releasePackage.name]).toBe("publish-attempted");
    expect(progress.currentTags[releasePackage.name]).toBe(releaseVersion);
    expect(progress.error).toMatch(/registry version .* must be an object/u);

    const incident = renderReleaseIncident(manifest, progress);
    expect(incident).toContain(progress.error);
    expect(incident).toContain(`npm dist-tag rm ${releasePackage.name} next`);
    expect(incident).not.toContain("do not change existing tags");
  });

  it("records a malformed dist-tag snapshot as unknown instead of absent", async () => {
    const fixture = await createFixture();
    const manifest = validateReleaseManifestForPublish(fixture.manifest);
    const releasePackage = manifest.packages[0]!;
    let publishStarted = false;
    const fetchImpl = (async (input) => {
      const name = decodeURIComponent(new URL(String(input)).pathname.slice(1));
      if (name !== releasePackage.name || !publishStarted) {
        return new Response("missing", { status: 404 });
      }
      return new Response(
        JSON.stringify({
          versions: {
            [releaseVersion]: {
              dist: { integrity: releasePackage.integrity },
            },
          },
          "dist-tags": "malformed-dist-tags",
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as typeof fetch;

    await expect(
      publishRelease({
        ...fixture,
        manifest,
        authMode: "oidc",
        env: {},
        fetchImpl,
        publishImpl: () => {
          publishStarted = true;
        },
      }),
    ).rejects.toThrow(/registry dist-tags must be an object/u);

    const progress = await readProgress(fixture.progressFile);
    expect(progress.states[releasePackage.name]).toBe("publish-attempted");
    expect(progress.currentTags).not.toHaveProperty(releasePackage.name);
    expect(progress.error).toMatch(/registry dist-tags must be an object/u);
    const incident = renderReleaseIncident(manifest, progress);
    expect(incident).toContain("current=`<unknown>`");
    expect(incident).not.toContain("npm dist-tag rm");
  });

  it("records the final Registry read error after an earlier incomplete observation", async () => {
    const fixture = await createFixture();
    const manifest = validateReleaseManifestForPublish(fixture.manifest);
    const releasePackage = manifest.packages[0]!;
    let publishStarted = false;
    let reconciliationRead = 0;
    const fetchImpl = (async (input) => {
      const name = decodeURIComponent(new URL(String(input)).pathname.slice(1));
      if (name !== releasePackage.name || !publishStarted) {
        return new Response("missing", { status: 404 });
      }
      reconciliationRead += 1;
      if (reconciliationRead > 1) {
        throw new Error("simulated final Registry read failure");
      }
      return new Response(
        JSON.stringify({
          versions: {
            [releaseVersion]: {
              dist: { integrity: releasePackage.integrity },
            },
          },
          "dist-tags": { next: "0.1.0-next.0" },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as typeof fetch;

    await expect(
      publishRelease({
        ...fixture,
        manifest,
        authMode: "oidc",
        env: {},
        fetchImpl,
        publishImpl: () => {
          publishStarted = true;
        },
        reconciliationDelaysMs: [0, 1],
        waitImpl: vi.fn().mockResolvedValue(undefined),
      }),
    ).rejects.toThrow("simulated final Registry read failure");

    const progress = await readProgress(fixture.progressFile);
    expect(progress.states[releasePackage.name]).toBe("publish-attempted");
    expect(progress.currentTags).not.toHaveProperty(releasePackage.name);
    expect(progress.error).toBe("simulated final Registry read failure");
    const incident = renderReleaseIncident(manifest, progress);
    expect(incident).toContain("current=`<unknown>`");
    expect(incident).toContain(progress.error);
    expect(incident).not.toContain("npm dist-tag rm");
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
