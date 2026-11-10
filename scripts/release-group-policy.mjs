import {
  PACKAGE_POLICY,
  isPrereleaseVersion,
  isZeroMajorVersion,
} from "./workspace-policy.mjs";

export const ALL_PACKAGE_NAMES = Object.freeze(
  Object.values(PACKAGE_POLICY).map(({ name }) => name),
);

/** @typedef {{ name: string; version: string }} PackageVersion */

/**
 * All public packages form one fixed version and release group. The former
 * independent core/auth release groups were retired when auth joined the fixed
 * group; historical `chat-auth-v*` tags remain immutable but are no longer
 * produced.
 *
 * @param {unknown} group
 * @returns {"all"}
 */
export function releaseGroup(group = "all") {
  if (group !== "all")
    throw new Error(
      "independent core/auth release groups are retired; releases must include the complete unified package group.",
    );
  return "all";
}

/**
 * @param {...unknown} retiredArguments
 * @returns {readonly string[]}
 */
export function releasePackageNames(...retiredArguments) {
  if (retiredArguments.length > 0) {
    throw new Error(
      "releasePackageNames does not accept a release group; all public packages form the unified group.",
    );
  }
  return ALL_PACKAGE_NAMES;
}

/** @param {string} version */
export function releaseSourceTag(version) {
  return `v${version}`;
}

/**
 * The unified group is all-or-nothing: every public package must be present in
 * the approved order, every version must be a valid 0.x SemVer, and all eight
 * packages must share exactly one version.
 *
 * @param {readonly PackageVersion[]} packages
 * @param {string} [requestedVersion]
 * @param {string} [channel]
 */
export function validateReleaseGroup(packages, requestedVersion, channel) {
  if (
    JSON.stringify(packages.map(({ name }) => name)) !==
    JSON.stringify(ALL_PACKAGE_NAMES)
  )
    throw new Error(
      "release packages must contain the complete unified group in approved order.",
    );
  if (packages.some(({ version }) => !isZeroMajorVersion(version)))
    throw new Error("release packages must have valid 0.x versions.");
  if (new Set(packages.map(({ version }) => version)).size > 1)
    throw new Error("the unified package group must share one version.");
  const version = packages[0]?.version;
  if (
    !version ||
    (requestedVersion !== undefined && version !== requestedVersion)
  )
    throw new Error(
      "release group version does not match the requested version.",
    );
  if (channel !== undefined && channel !== "next" && channel !== "latest")
    throw new Error("release channel must be next or latest.");
  if (
    channel !== undefined &&
    packages.some(
      (entry) => isPrereleaseVersion(entry.version) !== (channel === "next"),
    )
  )
    throw new Error(
      "all selected packages must match the stable/prerelease release channel.",
    );
  return version;
}

/**
 * Registry consumers need exact versions for every published package.
 * Consumer overrides cannot introduce an independent or partial version set.
 *
 * @param {{ packages: readonly PackageVersion[]; releaseGroup?: unknown; consumerPackages?: readonly PackageVersion[] }} manifest
 */
export function registryConsumerPackages(manifest) {
  releaseGroup(manifest.releaseGroup);
  validateReleaseGroup(manifest.packages);
  const consumers = manifest.consumerPackages ?? manifest.packages;
  validateReleaseGroup(consumers);
  for (const entry of manifest.packages) {
    if (
      consumers.find(({ name }) => name === entry.name)?.version !==
      entry.version
    )
      throw new Error(
        "consumer package versions must match every published package.",
      );
  }
  return consumers.map(({ name, version }) => ({ name, version }));
}
