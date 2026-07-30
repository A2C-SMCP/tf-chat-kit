import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  assertRegistryIntegrity,
  calculateFileIntegrity,
  registryDistTag,
  registryVersionMetadata,
  registryVersions,
  readRegistryPackage,
  RELEASE_CHANNELS,
  RELEASE_PACKAGE_NAMES,
  RELEASE_REGISTRY,
} from "./release-policy.mjs";
import {
  isPrereleaseVersion,
  isZeroMajorVersion,
} from "./workspace-policy.mjs";

/**
 * @typedef {{
 *   name: string;
 *   version: string;
 *   tarball: string;
 *   size: number;
 *   integrity: string;
 *   files: string[];
 * }} ReleasePackage
 * @typedef {{
 *   version: string;
 *   channel: string;
 *   tag: string;
 *   commit: string;
 *   packages: ReleasePackage[];
 * }} ReleaseManifest
 */

/** @param {unknown} value @returns {ReleaseManifest} */
export function validateReleaseManifestForPublish(value) {
  if (typeof value !== "object" || value === null) {
    throw new Error("release manifest must be an object.");
  }
  const manifest = /** @type {Record<string, unknown>} */ (value);
  if (
    typeof manifest["version"] !== "string" ||
    !isZeroMajorVersion(manifest["version"]) ||
    typeof manifest["channel"] !== "string" ||
    !RELEASE_CHANNELS.includes(manifest["channel"]) ||
    manifest["tag"] !== `v${manifest["version"]}` ||
    typeof manifest["commit"] !== "string" ||
    !/^[0-9a-f]{40}$/u.test(manifest["commit"]) ||
    !Array.isArray(manifest["packages"])
  ) {
    throw new Error("release manifest identity fields are invalid.");
  }
  if (
    (manifest["channel"] === "next" &&
      !isPrereleaseVersion(manifest["version"])) ||
    (manifest["channel"] === "latest" &&
      isPrereleaseVersion(manifest["version"]))
  ) {
    throw new Error(
      "release manifest channel and stable/prerelease version semantics do not match.",
    );
  }
  const packages = /** @type {ReleasePackage[]} */ (manifest["packages"]);
  if (
    JSON.stringify(packages.map(({ name }) => name)) !==
      JSON.stringify(RELEASE_PACKAGE_NAMES) ||
    packages.some(
      ({ version, tarball, integrity, size }) =>
        version !== manifest["version"] ||
        path.basename(tarball) !== tarball ||
        !/^[a-z0-9][a-z0-9._-]*\.tgz$/u.test(tarball) ||
        !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(integrity) ||
        !Number.isSafeInteger(size) ||
        size <= 0,
    )
  ) {
    throw new Error(
      "release manifest must contain the complete fixed package group with safe immutable artifacts at one version.",
    );
  }
  return /** @type {ReleaseManifest} */ (value);
}

/** @param {string[]} args */
export function parsePublishArguments(args) {
  /** @type {Record<string, string>} */
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error("publish arguments must be --flag value pairs.");
    }
    values[flag.slice(2)] = value;
  }
  const manifest = values["manifest"];
  const progress = values["progress"];
  const authMode = values["auth-mode"];
  if (!manifest || !progress || !authMode) {
    throw new Error(
      "--manifest, --progress, and --auth-mode arguments are required.",
    );
  }
  if (authMode !== "oidc" && authMode !== "bootstrap-token") {
    throw new Error("auth mode must be oidc or bootstrap-token.");
  }
  return {
    manifest,
    progress,
    authMode: /** @type {"oidc" | "bootstrap-token"} */ (authMode),
  };
}

/**
 * @param {string} npmCli
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 */
const runNpmPublish = (npmCli, args, env) => {
  const result = spawnSync(process.execPath, [npmCli, ...args], {
    cwd: process.cwd(),
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    throw new Error(`npm publish exited with status ${String(result.status)}.`);
  }
};

/**
 * @param {{
 *   rootDirectory: string;
 *   manifest: ReleaseManifest;
 *   authMode: "oidc" | "bootstrap-token";
 *   progressFile: string;
 *   fetchImpl?: typeof fetch;
 *   publishImpl?: (npmCli: string, args: string[], env: NodeJS.ProcessEnv) => void;
 *   env?: NodeJS.ProcessEnv;
 * }} input
 */
export async function publishRelease({
  rootDirectory,
  manifest,
  authMode,
  progressFile,
  fetchImpl = fetch,
  publishImpl = runNpmPublish,
  env = process.env,
}) {
  if (authMode === "oidc" && env["NODE_AUTH_TOKEN"]) {
    throw new Error("OIDC publication must not receive NODE_AUTH_TOKEN.");
  }
  if (authMode === "bootstrap-token" && !env["NODE_AUTH_TOKEN"]) {
    throw new Error(
      "bootstrap-token publication requires a protected NODE_AUTH_TOKEN.",
    );
  }
  const npmCli = path.join(
    rootDirectory,
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js",
  );
  /** @type {Record<string, "pending" | "publish-attempted" | "published" | "verified-existing">} */
  const states = Object.fromEntries(
    manifest.packages.map(({ name }) => [name, "pending"]),
  );
  /** @type {Record<string, string | undefined>} */
  const beforeTags = {};
  /** @type {Record<string, string | undefined>} */
  const currentTags = {};
  /** @type {Record<string, Record<string, unknown> | undefined>} */
  const registryPackages = {};
  /** @param {unknown} [error] */
  const writeProgress = async (error) => {
    await writeFile(
      progressFile,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          version: manifest.version,
          channel: manifest.channel,
          tag: manifest.tag,
          commit: manifest.commit,
          runUrl:
            env["GITHUB_SERVER_URL"] &&
            env["GITHUB_REPOSITORY"] &&
            env["GITHUB_RUN_ID"]
              ? `${env["GITHUB_SERVER_URL"]}/${env["GITHUB_REPOSITORY"]}/actions/runs/${env["GITHUB_RUN_ID"]}`
              : undefined,
          states,
          beforeTags,
          currentTags,
          error,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  };

  let missingCount = 0;
  for (const releasePackage of manifest.packages) {
    const tarball = path.join(
      rootDirectory,
      ".artifacts",
      "packages",
      releasePackage.tarball,
    );
    if ((await calculateFileIntegrity(tarball)) !== releasePackage.integrity) {
      throw new Error(
        `${releasePackage.name}: tarball changed after release manifest creation.`,
      );
    }
    const registryPackage = await readRegistryPackage({
      packageName: releasePackage.name,
      fetchImpl,
    });
    registryPackages[releasePackage.name] = registryPackage;
    const previousTag = registryDistTag(registryPackage, manifest.channel);
    beforeTags[releasePackage.name] = previousTag;
    currentTags[releasePackage.name] = previousTag;
    const existing = registryVersionMetadata(
      registryPackage,
      releasePackage.version,
    );
    if (existing) {
      assertRegistryIntegrity(releasePackage, existing);
      if (previousTag !== releasePackage.version) {
        throw new Error(
          `${releasePackage.name}@${releasePackage.version}: an existing partial release must retain the ${manifest.channel} dist-tag before it can be resumed.`,
        );
      }
      states[releasePackage.name] = "verified-existing";
    } else {
      missingCount += 1;
    }
  }
  if (authMode === "bootstrap-token") {
    for (const releasePackage of manifest.packages) {
      const historicalVersions = Object.keys(
        registryVersions(registryPackages[releasePackage.name]),
      );
      if (
        (registryPackages[releasePackage.name] !== undefined &&
          historicalVersions.length === 0) ||
        historicalVersions.some((version) => version !== releasePackage.version)
      ) {
        throw new Error(
          "bootstrap token mode is forbidden after the initial fixed-version batch; configure Trusted Publishing and use OIDC.",
        );
      }
    }
  }
  if (missingCount === 0) {
    await writeProgress();
    return states;
  }
  await writeProgress();

  for (const releasePackage of manifest.packages) {
    if (states[releasePackage.name] === "verified-existing") continue;
    const tarball = path.join(
      rootDirectory,
      ".artifacts",
      "packages",
      releasePackage.tarball,
    );
    states[releasePackage.name] = "publish-attempted";
    await writeProgress();
    /** @type {Record<string, unknown> | undefined} */
    let observedPackage;
    try {
      publishImpl(
        npmCli,
        [
          "publish",
          tarball,
          "--tag",
          manifest.channel,
          "--access",
          "public",
          "--registry",
          RELEASE_REGISTRY,
          "--provenance",
          "--json",
        ],
        env,
      );
    } catch (error) {
      observedPackage = await readRegistryPackage({
        packageName: releasePackage.name,
        fetchImpl,
      });
      currentTags[releasePackage.name] = registryDistTag(
        observedPackage,
        manifest.channel,
      );
      const reconciled = registryVersionMetadata(
        observedPackage,
        releasePackage.version,
      );
      if (!reconciled) {
        await writeProgress(error instanceof Error ? error.message : error);
        throw error;
      }
      assertRegistryIntegrity(releasePackage, reconciled);
    }

    observedPackage ??= await readRegistryPackage({
      packageName: releasePackage.name,
      fetchImpl,
    });
    currentTags[releasePackage.name] = registryDistTag(
      observedPackage,
      manifest.channel,
    );
    const published = registryVersionMetadata(
      observedPackage,
      releasePackage.version,
    );
    if (!published) {
      const message = `${releasePackage.name}@${releasePackage.version}: registry did not expose the published version; rerun to reconcile without republishing.`;
      await writeProgress(message);
      throw new Error(message);
    }
    assertRegistryIntegrity(releasePackage, published);
    if (currentTags[releasePackage.name] !== releasePackage.version) {
      const message = `${releasePackage.name}@${releasePackage.version}: registry ${manifest.channel} dist-tag does not point to the published version.`;
      await writeProgress(message);
      throw new Error(message);
    }
    states[releasePackage.name] = "published";
    await writeProgress();
  }
  return states;
}

/** @param {string[]} args */
export async function runPublishRelease(args) {
  const options = parsePublishArguments(args);
  const rootDirectory = process.cwd();
  const manifest = validateReleaseManifestForPublish(
    JSON.parse(await readFile(path.resolve(options.manifest), "utf8")),
  );
  return publishRelease({
    rootDirectory,
    manifest,
    authMode: options.authMode,
    progressFile: path.resolve(options.progress),
  });
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  pathToFileURL(path.resolve(invokedPath)).href === import.meta.url
) {
  try {
    await runPublishRelease(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
