import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  realpath,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AUTH_PACKAGE_NAME,
  registryConsumerPackages,
  releasePackageNames,
} from "../scripts/release-group-policy.mjs";
import {
  buildReleasePackages,
  createReleaseManifest,
  validateCompatibilityPolicy,
} from "../scripts/release-policy.mjs";
import {
  publishRelease,
  validateReleaseManifestForPublish,
} from "../scripts/publish-release.mjs";
import { renderReleaseIncident } from "../scripts/render-release-report.mjs";

async function fixture(group: "all" | "core" | "auth") {
  const rootDirectory = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "tfck-auth-release-")),
  );
  const directory = path.join(rootDirectory, ".artifacts", "packages");
  await mkdir(directory, { recursive: true });
  const packed = [];
  for (const name of releasePackageNames()) {
    const version = name === AUTH_PACKAGE_NAME ? "0.9.0" : "0.8.3";
    const tarball = path.join(
      directory,
      `${name.slice(1).replace("/", "-")}-${version}.tgz`,
    );
    await writeFile(tarball, `${name}@${version}`);
    packed.push({ name, version, tarball, files: ["package.json"] });
  }
  const { packages } = await buildReleasePackages({
    rootDirectory,
    packManifest: { packages: packed },
  });
  const selected = packages.filter(({ name }) =>
    releasePackageNames(group).includes(name),
  );
  const compatibility = validateCompatibilityPolicy(
    JSON.parse(
      await readFile(
        new URL("../release/compatibility.json", import.meta.url),
        "utf8",
      ),
    ),
  );
  const manifest = createReleaseManifest({
    version: group === "auth" ? "0.9.0" : "0.8.3",
    channel: "latest",
    releaseGroup: group,
    consumerPackages: packages.map(({ name, version }) => ({ name, version })),
    commit: "a".repeat(40),
    runUrl: "https://github.com/A2C-SMCP/tf-chat-kit/actions/runs/1",
    createdAt: "2026-10-10T00:00:00.000Z",
    compatibility,
    packages: selected,
  });
  return {
    packed,
    rootDirectory,
    manifest,
    progressFile: path.join(rootDirectory, "progress.json"),
  };
}

describe("independent auth protected release", () => {
  it.each(["all", "core", "auth"] as const)(
    "publishes only %s and verifies pinned mixed-version consumers",
    async (group) => {
      const data = await fixture(group);
      const manifest = validateReleaseManifestForPublish(data.manifest);
      expect(manifest.tag).toBe(
        group === "auth" ? "chat-auth-v0.9.0" : "v0.8.3",
      );
      const consumers = registryConsumerPackages(manifest);
      expect(
        consumers.find(({ name }) => name === AUTH_PACKAGE_NAME)?.version,
      ).toBe("0.9.0");
      expect(
        consumers
          .filter(({ name }) => name !== AUTH_PACKAGE_NAME)
          .every(({ version }) => version === "0.8.3"),
      ).toBe(true);
      const registry = new Map<string, Record<string, unknown>>();
      const published: string[] = [];
      await publishRelease({
        ...data,
        manifest,
        authMode: "oidc",
        env: {},
        reconciliationDelaysMs: [0],
        waitImpl: async () => {},
        fetchImpl: (async (input) => {
          const metadata = registry.get(
            decodeURIComponent(new URL(String(input)).pathname.slice(1)),
          );
          return metadata
            ? new Response(JSON.stringify(metadata), { status: 200 })
            : new Response("missing", { status: 404 });
        }) as typeof fetch,
        publishImpl: (_npmCli, args, env) => {
          expect(env).not.toHaveProperty("NODE_AUTH_TOKEN");
          expect(args).toContain("--provenance");
          const releasePackage = manifest.packages.find(
            (entry) => entry.tarball === path.basename(args[1] ?? ""),
          );
          if (!releasePackage) throw new Error("unexpected tarball");
          published.push(`${releasePackage.name}@${releasePackage.version}`);
          registry.set(releasePackage.name, {
            versions: {
              [releasePackage.version]: {
                dist: { integrity: releasePackage.integrity },
              },
            },
            "dist-tags": { latest: releasePackage.version },
          });
        },
      });
      expect(published).toEqual(
        manifest.packages.map(({ name, version }) => `${name}@${version}`),
      );
      expect(published).toHaveLength(
        group === "auth" ? 1 : group === "core" ? 7 : 8,
      );
      const progress = JSON.parse(await readFile(data.progressFile, "utf8"));
      const report = renderReleaseIncident(data.manifest, progress);
      for (const entry of manifest.packages)
        expect(report).toContain(`npm dist-tag rm ${entry.name} latest`);
    },
  );

  it("builds an auth-only CLI manifest against an already published core version and rejects overriding the selected group", async () => {
    const data = await fixture("auth");
    await mkdir(path.join(data.rootDirectory, ".changeset"));
    await mkdir(path.join(data.rootDirectory, "release"));
    await writeFile(
      path.join(data.rootDirectory, ".artifacts", "packages", "manifest.json"),
      JSON.stringify({ packages: data.packed }),
    );
    const policy = JSON.parse(
      await readFile(
        new URL("../release/compatibility.json", import.meta.url),
        "utf8",
      ),
    );
    const evidencePaths = [
      policy.server.evidence,
      ...Object.values(policy.consumers).map(
        (entry) => (entry as { evidence?: string }).evidence,
      ),
    ].filter(Boolean) as string[];
    for (const evidence of evidencePaths) {
      await mkdir(path.dirname(path.join(data.rootDirectory, evidence)), {
        recursive: true,
      });
      await writeFile(
        path.join(data.rootDirectory, evidence),
        await readFile(path.resolve(evidence)),
      );
    }
    await writeFile(
      path.join(data.rootDirectory, "release", "compatibility.json"),
      JSON.stringify(policy),
    );
    const output = path.join(data.rootDirectory, "release-manifest.json");
    const args = [
      fileURLToPath(
        new URL("../scripts/create-release-manifest.mjs", import.meta.url),
      ),
      "--group",
      "auth",
      "--expected-version",
      "0.9.0",
      "--consumer-core-version",
      "0.8.2",
      "--channel",
      "latest",
      "--commit",
      "a".repeat(40),
      "--run-url",
      "https://github.com/A2C-SMCP/tf-chat-kit/actions/runs/1",
      "--output",
      output,
    ];
    execFileSync(process.execPath, args, {
      cwd: data.rootDirectory,
      stdio: "pipe",
    });
    const manifest = validateReleaseManifestForPublish(
      JSON.parse(await readFile(output, "utf8")),
    );
    expect(manifest.packages.map(({ name }) => name)).toEqual([
      AUTH_PACKAGE_NAME,
    ]);
    expect(
      registryConsumerPackages(manifest)
        .filter(({ name }) => name !== AUTH_PACKAGE_NAME)
        .every(({ version }) => version === "0.8.2"),
    ).toBe(true);
    expect(() =>
      execFileSync(
        process.execPath,
        [...args, "--consumer-auth-version", "0.8.2"],
        { cwd: data.rootDirectory, stdio: "pipe" },
      ),
    ).toThrow();
  });

  it("rejects incomplete core, mixed core versions, wrong auth tags and mismatched consumer pins", async () => {
    const { manifest } = await fixture("all");
    const incomplete = structuredClone(manifest);
    incomplete.packages.splice(0, 1);
    expect(() => validateReleaseManifestForPublish(incomplete)).toThrow(
      /complete selected group/,
    );
    const mixedCore = structuredClone(manifest);
    mixedCore.packages[1]!.version = "0.8.4";
    expect(() => validateReleaseManifestForPublish(mixedCore)).toThrow(
      /fixed group/,
    );
    const consumers = structuredClone(manifest);
    consumers.consumerPackages.at(-1)!.version = "0.9.1";
    expect(() => validateReleaseManifestForPublish(consumers)).toThrow(
      /must match/,
    );
    const auth = (await fixture("auth")).manifest;
    auth.tag = "v0.9.0";
    expect(() => validateReleaseManifestForPublish(auth)).toThrow(
      /identity fields/,
    );
  });

  it("rejects stable/prerelease channel mixing across independent groups", async () => {
    const { manifest } = await fixture("all");
    manifest.packages.at(-1)!.version = "0.9.0-next.0";
    expect(() => validateReleaseManifestForPublish(manifest)).toThrow(
      /stable\/prerelease/,
    );
  });
});
