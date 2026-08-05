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

export const BOOTSTRAP_FACADE_PACKAGE = "@turingfocus/chat-kit";
export const REGISTRY_RECONCILIATION_DELAYS_MS = Object.freeze([
  0, 1_000, 2_000, 4_000, 8_000, 15_000, 30_000, 30_000, 30_000,
]);

/** @typedef {"oidc" | "bootstrap-token" | "oidc-with-bootstrap-facade"} PublishAuthMode */

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
  if (
    authMode !== "oidc" &&
    authMode !== "bootstrap-token" &&
    authMode !== "oidc-with-bootstrap-facade"
  ) {
    throw new Error(
      "auth mode must be oidc, bootstrap-token, or oidc-with-bootstrap-facade.",
    );
  }
  return {
    manifest,
    progress,
    authMode: /** @type {PublishAuthMode} */ (authMode),
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

/** @param {number} milliseconds */
const wait = (milliseconds) =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

/**
 * @param {NodeJS.ProcessEnv} env
 */
const oidcPublishEnvironment = (env) => {
  const oidcEnvironment = { ...env };
  delete oidcEnvironment["NODE_AUTH_TOKEN"];
  delete oidcEnvironment["NPM_CONFIG_USERCONFIG"];
  delete oidcEnvironment["NPM_BOOTSTRAP_TOKEN"];
  delete oidcEnvironment["NPM_BOOTSTRAP_USERCONFIG"];
  return oidcEnvironment;
};

/**
 * @param {ReleasePackage} releasePackage
 * @param {Record<string, unknown> | undefined} registryPackage
 * @param {PublishAuthMode} authMode
 */
const assertPackageAuthEligibility = (
  releasePackage,
  registryPackage,
  authMode,
) => {
  if (authMode === "bootstrap-token") {
    const historicalVersions = Object.keys(registryVersions(registryPackage));
    if (
      (registryPackage !== undefined && historicalVersions.length === 0) ||
      historicalVersions.some((version) => version !== releasePackage.version)
    ) {
      throw new Error(
        "bootstrap token mode is forbidden after the initial fixed-version batch; configure Trusted Publishing and use OIDC.",
      );
    }
  }
  if (authMode !== "oidc-with-bootstrap-facade") return;
  const targetVersion = registryVersionMetadata(
    registryPackage,
    releasePackage.version,
  );
  if (releasePackage.name === BOOTSTRAP_FACADE_PACKAGE) {
    if (registryPackage !== undefined && targetVersion === undefined) {
      throw new Error(
        `${BOOTSTRAP_FACADE_PACKAGE}: one-time facade bootstrap is allowed only while the package is completely absent; configure Trusted Publishing and use OIDC for later versions.`,
      );
    }
  } else if (registryPackage === undefined) {
    throw new Error(
      `${releasePackage.name}: hybrid facade bootstrap requires every non-facade package to already exist and publish through OIDC.`,
    );
  }
};

/**
 * @param {{
 *   releasePackage: ReleasePackage;
 *   channel: string;
 *   fetchImpl: typeof fetch;
 *   reconciliationDelaysMs: readonly number[];
 *   waitImpl: (milliseconds: number) => Promise<unknown>;
 * }} input
 */
const reconcilePublishedPackage = async ({
  releasePackage,
  channel,
  fetchImpl,
  reconciliationDelaysMs,
  waitImpl,
}) => {
  /** @type {Record<string, unknown> | undefined} */
  let observedPackage;
  /** @type {Record<string, unknown> | undefined} */
  let observedVersion;
  /** @type {string | undefined} */
  let observedTag;
  /** @type {unknown} */
  let lastReadError;
  /** @type {unknown} */
  let terminalError;

  for (const delayMs of reconciliationDelaysMs) {
    if (!Number.isSafeInteger(delayMs) || delayMs < 0) {
      throw new Error(
        "registry reconciliation delays must be non-negative safe integers.",
      );
    }
    if (delayMs > 0) await waitImpl(delayMs);
    /** @type {Record<string, unknown> | undefined} */
    let candidatePackage;
    try {
      candidatePackage = await readRegistryPackage({
        packageName: releasePackage.name,
        fetchImpl,
      });
    } catch (error) {
      lastReadError = error;
      continue;
    }
    /** @type {string | undefined} */
    let candidateTag;
    try {
      candidateTag = registryDistTag(candidatePackage, channel);
    } catch (error) {
      return {
        observedPackage: candidatePackage,
        observedVersion: undefined,
        observedTag: undefined,
        observedTagKnown: false,
        lastReadError: undefined,
        terminalError: error,
      };
    }
    /** @type {Record<string, unknown> | undefined} */
    let candidateVersion;
    try {
      candidateVersion = registryVersionMetadata(
        candidatePackage,
        releasePackage.version,
      );
    } catch (error) {
      return {
        observedPackage: candidatePackage,
        observedVersion: undefined,
        observedTag: candidateTag,
        observedTagKnown: true,
        lastReadError: undefined,
        terminalError: error,
      };
    }
    observedPackage = candidatePackage;
    observedTag = candidateTag;
    observedVersion = candidateVersion;
    lastReadError = undefined;
    if (candidateVersion) {
      try {
        assertRegistryIntegrity(releasePackage, candidateVersion);
      } catch (error) {
        terminalError = error;
        break;
      }
      if (candidateTag === releasePackage.version) break;
    }
  }

  return {
    observedPackage,
    observedVersion,
    observedTag,
    observedTagKnown:
      observedPackage !== undefined || lastReadError === undefined,
    lastReadError,
    terminalError,
  };
};

/**
 * @param {{
 *   rootDirectory: string;
 *   manifest: ReleaseManifest;
 *   authMode: PublishAuthMode;
 *   progressFile: string;
 *   fetchImpl?: typeof fetch;
 *   publishImpl?: (npmCli: string, args: string[], env: NodeJS.ProcessEnv) => void;
 *   env?: NodeJS.ProcessEnv;
 *   reconciliationDelaysMs?: readonly number[];
 *   waitImpl?: (milliseconds: number) => Promise<unknown>;
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
  reconciliationDelaysMs = REGISTRY_RECONCILIATION_DELAYS_MS,
  waitImpl = wait,
}) {
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
  /** @type {Record<string, string | null | undefined>} */
  const beforeTags = {};
  /** @type {Record<string, string | null | undefined>} */
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
  /** @param {unknown} error */
  const recordFailure = async (error) => {
    await writeProgress(error instanceof Error ? error.message : String(error));
  };

  await writeProgress();

  let missingCount = 0;
  try {
    if (
      (authMode === "oidc" || authMode === "oidc-with-bootstrap-facade") &&
      env["NODE_AUTH_TOKEN"]
    ) {
      throw new Error(
        "OIDC publication must not receive a process-wide NODE_AUTH_TOKEN.",
      );
    }
    if (authMode === "bootstrap-token" && !env["NODE_AUTH_TOKEN"]) {
      throw new Error(
        "bootstrap-token publication requires a protected NODE_AUTH_TOKEN.",
      );
    }
    if (
      authMode === "oidc-with-bootstrap-facade" &&
      (!env["NPM_BOOTSTRAP_TOKEN"] || !env["NPM_BOOTSTRAP_USERCONFIG"])
    ) {
      throw new Error(
        "facade bootstrap publication requires a protected token and isolated npm userconfig.",
      );
    }
    if (
      reconciliationDelaysMs.length === 0 ||
      reconciliationDelaysMs.some(
        (delayMs) => !Number.isSafeInteger(delayMs) || delayMs < 0,
      )
    ) {
      throw new Error(
        "registry reconciliation delays must contain non-negative safe integers.",
      );
    }
    for (const releasePackage of manifest.packages) {
      const tarball = path.join(
        rootDirectory,
        ".artifacts",
        "packages",
        releasePackage.tarball,
      );
      if (
        (await calculateFileIntegrity(tarball)) !== releasePackage.integrity
      ) {
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
      beforeTags[releasePackage.name] = previousTag ?? null;
      currentTags[releasePackage.name] = previousTag ?? null;
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
    for (const releasePackage of manifest.packages) {
      assertPackageAuthEligibility(
        releasePackage,
        registryPackages[releasePackage.name],
        authMode,
      );
    }
  } catch (error) {
    await recordFailure(error);
    throw error;
  }
  await writeProgress();
  if (missingCount === 0) {
    return states;
  }

  const oidcEnvironment = oidcPublishEnvironment(env);

  for (const releasePackage of manifest.packages) {
    if (states[releasePackage.name] === "verified-existing") continue;
    const tarball = path.join(
      rootDirectory,
      ".artifacts",
      "packages",
      releasePackage.tarball,
    );
    /** @type {Record<string, unknown> | undefined} */
    let freshRegistryPackage;
    try {
      freshRegistryPackage = await readRegistryPackage({
        packageName: releasePackage.name,
        fetchImpl,
      });
      registryPackages[releasePackage.name] = freshRegistryPackage;
      const freshTag = registryDistTag(freshRegistryPackage, manifest.channel);
      currentTags[releasePackage.name] = freshTag ?? null;
      const freshExisting = registryVersionMetadata(
        freshRegistryPackage,
        releasePackage.version,
      );
      if (freshExisting) {
        assertRegistryIntegrity(releasePackage, freshExisting);
        if (freshTag !== releasePackage.version) {
          throw new Error(
            `${releasePackage.name}@${releasePackage.version}: an existing partial release must retain the ${manifest.channel} dist-tag before it can be resumed.`,
          );
        }
        states[releasePackage.name] = "verified-existing";
        await writeProgress();
        continue;
      }
      assertPackageAuthEligibility(
        releasePackage,
        freshRegistryPackage,
        authMode,
      );
    } catch (error) {
      await recordFailure(error);
      throw error;
    }
    states[releasePackage.name] = "publish-attempted";
    await writeProgress();
    const useFacadeBootstrap =
      authMode === "oidc-with-bootstrap-facade" &&
      releasePackage.name === BOOTSTRAP_FACADE_PACKAGE &&
      freshRegistryPackage === undefined;
    const publishEnvironment = useFacadeBootstrap
      ? {
          ...oidcEnvironment,
          NODE_AUTH_TOKEN: env["NPM_BOOTSTRAP_TOKEN"],
          NPM_CONFIG_USERCONFIG: env["NPM_BOOTSTRAP_USERCONFIG"],
        }
      : authMode === "bootstrap-token"
        ? env
        : oidcEnvironment;
    /** @type {unknown} */
    let publishError;
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
        publishEnvironment,
      );
    } catch (error) {
      publishError = error;
    }

    let reconciliation;
    try {
      reconciliation = await reconcilePublishedPackage({
        releasePackage,
        channel: manifest.channel,
        fetchImpl,
        reconciliationDelaysMs,
        waitImpl,
      });
    } catch (error) {
      await recordFailure(error);
      throw error;
    }
    if (
      reconciliation.lastReadError !== undefined ||
      !reconciliation.observedTagKnown
    ) {
      delete currentTags[releasePackage.name];
    } else if (reconciliation.observedTag === undefined) {
      currentTags[releasePackage.name] = null;
    } else {
      currentTags[releasePackage.name] = reconciliation.observedTag;
    }
    if (reconciliation.terminalError !== undefined) {
      await writeProgress(
        reconciliation.terminalError instanceof Error
          ? reconciliation.terminalError.message
          : reconciliation.terminalError,
      );
      throw reconciliation.terminalError;
    }
    if (
      reconciliation.observedVersion !== undefined &&
      reconciliation.lastReadError !== undefined
    ) {
      await recordFailure(reconciliation.lastReadError);
      throw reconciliation.lastReadError;
    }
    if (!reconciliation.observedVersion) {
      if (publishError !== undefined) {
        await writeProgress(
          publishError instanceof Error ? publishError.message : publishError,
        );
        throw publishError;
      }
      if (reconciliation.lastReadError !== undefined) {
        await writeProgress(
          reconciliation.lastReadError instanceof Error
            ? reconciliation.lastReadError.message
            : reconciliation.lastReadError,
        );
        throw reconciliation.lastReadError;
      }
      const message = `${releasePackage.name}@${releasePackage.version}: registry did not expose the published version; rerun to reconcile without republishing.`;
      await writeProgress(message);
      throw new Error(message);
    }
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
