import {
  FIXED_PACKAGE_NAMES,
  PACKAGE_POLICY,
  isPrereleaseVersion,
  isZeroMajorVersion,
} from "./workspace-policy.mjs";

export const AUTH_PACKAGE_NAME = "@turingfocus/chat-auth";
export const ALL_PACKAGE_NAMES = Object.freeze(
  Object.values(PACKAGE_POLICY).map(({ name }) => name),
);

/** @typedef {"all" | "core" | "auth"} ReleaseGroup */
/** @typedef {{ name: string; version: string }} PackageVersion */

/** @param {unknown} group @returns {ReleaseGroup} */
export function releaseGroup(group = "all") {
  if (group !== "all" && group !== "core" && group !== "auth")
    throw new Error("release group must be all, core, or auth.");
  return group;
}

/** @param {unknown} group */
export function releasePackageNames(group = "all") {
  switch (releaseGroup(group)) {
    case "core":
      return FIXED_PACKAGE_NAMES;
    case "auth":
      return [AUTH_PACKAGE_NAME];
    case "all":
      return ALL_PACKAGE_NAMES;
  }
}

/** @param {unknown} group @param {string} version */
export function releaseSourceTag(group, version) {
  return releaseGroup(group) === "auth"
    ? `chat-auth-v${version}`
    : `v${version}`;
}

/**
 * Only the original seven packages form a fixed version group. Auth stays
 * independent; arbitrary subsets and mismatched core versions remain invalid.
 * @param {readonly PackageVersion[]} packages
 * @param {unknown} group
 * @param {string} [requestedVersion]
 * @param {string} [channel]
 */
export function validateReleaseGroup(
  packages,
  group = "all",
  requestedVersion,
  channel,
) {
  const selectedGroup = releaseGroup(group);
  if (
    JSON.stringify(packages.map(({ name }) => name)) !==
    JSON.stringify(releasePackageNames(selectedGroup))
  )
    throw new Error(
      "release packages must contain the complete selected group in approved order.",
    );
  if (packages.some(({ version }) => !isZeroMajorVersion(version)))
    throw new Error("release packages must have valid 0.x versions.");
  const core = packages.filter(({ name }) =>
    FIXED_PACKAGE_NAMES.includes(name),
  );
  if (new Set(core.map(({ version }) => version)).size > 1)
    throw new Error("the original fixed group must share one version.");
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
 * Registry consumers need exact versions for both enabled and disabled auth
 * hosts, even when this batch publishes just one group.
 * @param {{ packages: readonly PackageVersion[]; releaseGroup?: unknown; consumerPackages?: readonly PackageVersion[] }} manifest
 */
export function registryConsumerPackages(manifest) {
  const group = releaseGroup(manifest.releaseGroup);
  validateReleaseGroup(manifest.packages, group);
  const consumers =
    manifest.consumerPackages ??
    (group === "all" ? manifest.packages : undefined);
  if (!consumers)
    throw new Error(
      "independent releases require exact consumer package versions.",
    );
  validateReleaseGroup(consumers, "all");
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
