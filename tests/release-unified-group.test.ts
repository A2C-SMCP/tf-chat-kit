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
  ALL_PACKAGE_NAMES,
  registryConsumerPackages,
  releasePackageNames,
  releaseSourceTag,
  validateReleaseGroup,
} from "../scripts/release-group-policy.mjs";
import { parseReleaseManifestArguments } from "../scripts/create-release-manifest.mjs";
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

const UNIFIED_VERSION = "0.13.0";

async function fixture() {
  const rootDirectory = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "tfck-unified-release-")),
  );
  const directory = path.join(rootDirectory, ".artifacts", "packages");
  await mkdir(directory, { recursive: true });
  const packed = [];
  for (const name of releasePackageNames()) {
    const tarball = path.join(
      directory,
      `${name.slice(1).replace("/", "-")}-${UNIFIED_VERSION}.tgz`,
    );
    await writeFile(tarball, `${name}@${UNIFIED_VERSION}`);
    packed.push({
      name,
      version: UNIFIED_VERSION,
      tarball,
      files: ["package.json"],
    });
  }
  const { packages } = await buildReleasePackages({
    rootDirectory,
    packManifest: { packages: packed },
  });
  const compatibility = validateCompatibilityPolicy(
    JSON.parse(
      await readFile(
        new URL("../release/compatibility.json", import.meta.url),
        "utf8",
      ),
    ),
  );
  const manifest = createReleaseManifest({
    version: UNIFIED_VERSION,
    channel: "latest",
    commit: "a".repeat(40),
    runUrl: "https://github.com/A2C-SMCP/tf-chat-kit/actions/runs/1",
    createdAt: "2026-11-10T00:00:00.000Z",
    compatibility,
    packages,
  });
  return {
    packed,
    rootDirectory,
    manifest,
    progressFile: path.join(rootDirectory, "progress.json"),
  };
}

describe("unified protected release", () => {
  it("pins the complete unified package order", () => {
    expect(ALL_PACKAGE_NAMES).toEqual([
      "@turingfocus/chat-protocol",
      "@turingfocus/chat-runtime",
      "@turingfocus/chat-gateway-tfrobot",
      "@turingfocus/chat-react",
      "@turingfocus/chat-ui-antd",
      "@turingfocus/chat-kit",
      "@turingfocus/chat-testing",
      "@turingfocus/chat-auth",
    ]);
  });

  it("fails closed on retired, unknown, and duplicate manifest arguments", () => {
    expect(() => parseReleaseManifestArguments(["--group", "auth"])).toThrow(
      /retired/,
    );
    expect(() => parseReleaseManifestArguments(["--unknown", "value"])).toThrow(
      /unknown release manifest argument/,
    );
    expect(() =>
      parseReleaseManifestArguments([
        "--channel",
        "latest",
        "--channel",
        "next",
      ]),
    ).toThrow(/duplicate release manifest argument/);
  });

  it("publishes the complete eight-package group and verifies pinned consumers", async () => {
    const data = await fixture();
    const manifest = validateReleaseManifestForPublish(data.manifest);
    expect(manifest.tag).toBe("v0.13.0");
    expect(manifest.releaseGroup).toBe("all");
    expect(releaseSourceTag(UNIFIED_VERSION)).toBe("v0.13.0");
    expect(registryConsumerPackages(manifest)).toEqual(
      ALL_PACKAGE_NAMES.map((name) => ({ name, version: UNIFIED_VERSION })),
    );
    expect(manifest.packages).toHaveLength(ALL_PACKAGE_NAMES.length);

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
    expect(published).toHaveLength(ALL_PACKAGE_NAMES.length);
    const progress = JSON.parse(await readFile(data.progressFile, "utf8"));
    const report = renderReleaseIncident(data.manifest, progress);
    for (const entry of manifest.packages)
      expect(report).toContain(`npm dist-tag rm ${entry.name} latest`);
  });

  it("builds a unified CLI manifest and rejects retired group/consumer overrides", async () => {
    const data = await fixture();
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
    const baseArgs = [
      fileURLToPath(
        new URL("../scripts/create-release-manifest.mjs", import.meta.url),
      ),
      "--expected-version",
      UNIFIED_VERSION,
      "--channel",
      "latest",
      "--commit",
      "a".repeat(40),
      "--run-url",
      "https://github.com/A2C-SMCP/tf-chat-kit/actions/runs/1",
      "--output",
      output,
    ];
    execFileSync(process.execPath, baseArgs, {
      cwd: data.rootDirectory,
      stdio: "pipe",
    });
    const manifest = validateReleaseManifestForPublish(
      JSON.parse(await readFile(output, "utf8")),
    );
    expect(manifest.packages.map(({ name }) => name)).toEqual(
      ALL_PACKAGE_NAMES,
    );
    expect(manifest.tag).toBe("v0.13.0");
    expect(manifest.releaseGroup).toBe("all");
    expect(
      registryConsumerPackages(manifest).every(
        ({ version }) => version === UNIFIED_VERSION,
      ),
    ).toBe(true);

    const cliFailure = (args: string[]) => {
      try {
        execFileSync(process.execPath, args, {
          cwd: data.rootDirectory,
          stdio: "pipe",
        });
      } catch (error) {
        const stderr = (error as { stderr?: Buffer | string }).stderr;
        return String(stderr ?? "");
      }
      throw new Error("expected the release manifest CLI to fail");
    };

    for (const [flags, pattern] of [
      [["--group", "auth"], /retired/],
      [["--expected-auth-version", "0.12.1"], /retired/],
      [["--consumer-core-version", "0.11.0"], /retired/],
      [["--consumer-auth-version", "0.12.1"], /retired/],
      [["--unknown", "value"], /unknown release manifest argument/],
    ] as const) {
      expect(cliFailure([...baseArgs, ...flags])).toMatch(pattern);
    }
  });

  it("rejects incomplete, mixed-version, and legacy auth manifests", async () => {
    const { manifest } = await fixture();
    const incomplete = structuredClone(manifest);
    incomplete.packages.splice(0, 1);
    expect(() => validateReleaseManifestForPublish(incomplete)).toThrow(
      /complete unified group/,
    );
    const mixed = structuredClone(manifest);
    mixed.packages[1]!.version = "0.13.1";
    expect(() => validateReleaseManifestForPublish(mixed)).toThrow(
      /unified package group must share one version/,
    );
    const consumers = structuredClone(manifest);
    for (const entry of consumers.consumerPackages) entry.version = "0.13.1";
    expect(() => validateReleaseManifestForPublish(consumers)).toThrow(
      /must match every published package/,
    );
    const legacyAuthTag = structuredClone(manifest);
    legacyAuthTag.tag = "chat-auth-v0.13.0";
    expect(() => validateReleaseManifestForPublish(legacyAuthTag)).toThrow(
      /identity fields/,
    );
    const legacyGroup: Record<string, unknown> = structuredClone(manifest);
    legacyGroup["releaseGroup"] = "auth";
    expect(() => validateReleaseManifestForPublish(legacyGroup)).toThrow(
      /retired/,
    );
    expect(() => validateReleaseGroup(manifest.packages.slice(0, -1))).toThrow(
      /complete unified group/,
    );
  });

  it("rejects stable/prerelease channel mixing across the unified group", async () => {
    const { manifest } = await fixture();
    manifest.version = "0.13.0-next.0";
    manifest.tag = "v0.13.0-next.0";
    manifest.channel = "latest";
    for (const entry of manifest.packages) entry.version = "0.13.0-next.0";
    expect(() => validateReleaseManifestForPublish(manifest)).toThrow(
      /channel and stable\/prerelease version semantics/,
    );
  });
});
