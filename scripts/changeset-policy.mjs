import { isZeroMajorVersion, PACKAGE_POLICY } from "./workspace-policy.mjs";

const publicPackageEntries = Object.entries(PACKAGE_POLICY);
const publicPackageDirectories = new Set(
  publicPackageEntries.map(([directory]) => directory),
);
const publicPackageNames = new Set(
  publicPackageEntries.map(([, { name }]) => name),
);
const publicPackageNameByDirectory = new Map(
  publicPackageEntries.map(([directory, { name }]) => [directory, name]),
);

/** @typedef {{ name: string; type: "none" | "patch" | "minor" | "major" }} ChangesetRelease */
/**
 * @typedef {{
 *   id: string;
 *   summary: string;
 *   releases: readonly ChangesetRelease[];
 * }} ParsedChangeset
 */
/**
 * @typedef {{
 *   name: string;
 *   type: "none" | "patch" | "minor" | "major";
 *   oldVersion: string;
 *   newVersion: string;
 *   changesets: readonly string[];
 * }} PlannedRelease
 */
/** @typedef {{ releases: readonly PlannedRelease[] }} ReleasePlan */
/** @typedef {Record<string, Record<string, unknown>>} PackageManifestMap */

/**
 * @param {string} file
 * @returns {boolean}
 */
const isPublicPackageFile = (file) => {
  const [packagesDirectory, packageDirectory] = file.split("/");
  return (
    packagesDirectory === "packages" &&
    packageDirectory !== undefined &&
    publicPackageDirectories.has(packageDirectory)
  );
};

/** @param {readonly string[]} values */
const sortedUnique = (values) => [...new Set(values)].sort();

/**
 * @param {readonly ParsedChangeset[]} changesets
 * @returns {ChangesetRelease[]}
 */
const publicChangesetReleases = (changesets) =>
  changesets.flatMap(({ releases }) =>
    releases.filter(
      ({ name, type }) => type !== "none" && publicPackageNames.has(name),
    ),
  );

/**
 * @param {ReleasePlan} plan
 * @returns {PlannedRelease[]}
 */
const publicPlannedReleases = (plan) =>
  plan.releases.filter(
    ({ name, type }) => type !== "none" && publicPackageNames.has(name),
  );

/**
 * @param {string} label
 * @param {ReleasePlan} plan
 * @param {string[]} errors
 */
const validateFixedGroupReleasePlan = (label, plan, errors) => {
  const releases = publicPlannedReleases(plan);
  const plannedNames = sortedUnique(releases.map(({ name }) => name));
  const expectedNames = sortedUnique([...publicPackageNames]);
  if (JSON.stringify(plannedNames) !== JSON.stringify(expectedNames)) {
    errors.push(
      `${label} release plan must include the complete fixed group; expected ${expectedNames.join(", ")}; found ${plannedNames.join(", ") || "<none>"}`,
    );
  }
  for (const { name, newVersion } of releases) {
    if (!isZeroMajorVersion(newVersion)) {
      errors.push(
        `${label} release plan for ${name} must remain on 0.x; found ${newVersion}`,
      );
    }
  }
};

/**
 * @param {{
 *   changedFiles: readonly string[];
 *   consumedChangesetIds: readonly string[];
 *   expectedConsumedChangesetIds: readonly string[];
 *   consumedReleasePlan: ReleasePlan;
 *   basePackageManifests: PackageManifestMap;
 *   currentPackageManifests: PackageManifestMap;
 *   expectedPackageManifests: PackageManifestMap;
 *   currentChangelogs: Record<string, string>;
 *   expectedChangelogs: Record<string, string>;
 *   expectedReleaseOutputFiles: readonly string[];
 * }} input
 * @returns {string[]}
 */
const validateConsumedReleaseOutput = ({
  changedFiles,
  consumedChangesetIds,
  expectedConsumedChangesetIds,
  consumedReleasePlan,
  basePackageManifests,
  currentPackageManifests,
  expectedPackageManifests,
  currentChangelogs,
  expectedChangelogs,
  expectedReleaseOutputFiles,
}) => {
  /** @type {string[]} */
  const errors = [];
  validateFixedGroupReleasePlan(
    "consumed changeset",
    consumedReleasePlan,
    errors,
  );

  const actualConsumedChangesetIds = sortedUnique(consumedChangesetIds);
  const expectedConsumedIds = sortedUnique(expectedConsumedChangesetIds);
  if (
    JSON.stringify(actualConsumedChangesetIds) !==
    JSON.stringify(expectedConsumedIds)
  ) {
    errors.push(
      `consumed release must delete every changeset pending at the comparison base, including empty changesets; expected ${expectedConsumedIds.join(", ") || "<none>"}; found ${actualConsumedChangesetIds.join(", ") || "<none>"}`,
    );
  }

  const releases = publicPlannedReleases(consumedReleasePlan);
  for (const { name, oldVersion, newVersion } of releases) {
    const baseManifest = basePackageManifests[name];
    const currentManifest = currentPackageManifests[name];
    const expectedManifest = expectedPackageManifests[name];
    if (!baseManifest || !currentManifest || !expectedManifest) {
      errors.push(
        `consumed changeset release output requires base, expected, and current manifests for ${name}`,
      );
      continue;
    }
    if (baseManifest["version"] !== oldVersion) {
      errors.push(
        `consumed changeset release plan for ${name} expected base ${oldVersion}; found ${String(baseManifest["version"])}`,
      );
    }
    if (expectedManifest["version"] !== newVersion) {
      errors.push(
        `Changesets generated ${String(expectedManifest["version"])} for ${name}, but the consumed release plan expected ${newVersion}`,
      );
    }
    if (JSON.stringify(currentManifest) !== JSON.stringify(expectedManifest)) {
      errors.push(
        `consumed changeset release output for ${name} package.json must exactly match Changesets output`,
      );
    }
    if (currentChangelogs[name] !== expectedChangelogs[name]) {
      errors.push(
        `consumed changeset release output for ${name} CHANGELOG.md must exactly match Changesets output`,
      );
    }
  }

  const actualFiles = sortedUnique(changedFiles);
  const expectedFiles = sortedUnique([
    ...expectedReleaseOutputFiles,
    ...consumedChangesetIds.map((id) => `.changeset/${id}.md`),
  ]);
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    errors.push(
      `consumed changesets must exactly match Changesets fixed-group output files plus consumed changeset deletions and contain no other files; expected ${expectedFiles.join(", ") || "<none>"}; found ${actualFiles.join(", ") || "<none>"}`,
    );
  }

  return errors;
};

/**
 * @param {{
 *   changedFiles: readonly string[];
 *   addedChangesets: readonly ParsedChangeset[];
 *   pendingChangesets?: readonly ParsedChangeset[];
 *   consumedChangesets?: readonly ParsedChangeset[];
 *   expectedConsumedChangesetIds?: readonly string[];
 *   pendingReleasePlan?: ReleasePlan;
 *   consumedReleasePlan?: ReleasePlan;
 *   basePackageManifests?: PackageManifestMap;
 *   currentPackageManifests?: PackageManifestMap;
 *   expectedPackageManifests?: PackageManifestMap;
 *   currentChangelogs?: Record<string, string>;
 *   expectedChangelogs?: Record<string, string>;
 *   expectedReleaseOutputFiles?: readonly string[];
 *   isInitialWorkspaceBootstrap: boolean;
 * }} input
 * @returns {string[]}
 */
export function validateChangesetCoverage({
  changedFiles,
  addedChangesets,
  pendingChangesets = [],
  consumedChangesets = [],
  expectedConsumedChangesetIds = [],
  pendingReleasePlan = { releases: [] },
  consumedReleasePlan = { releases: [] },
  basePackageManifests = {},
  currentPackageManifests = {},
  expectedPackageManifests = {},
  currentChangelogs = {},
  expectedChangelogs = {},
  expectedReleaseOutputFiles = [],
  isInitialWorkspaceBootstrap,
}) {
  /** @type {string[]} */
  const errors = [];
  const addedPublicReleases = publicChangesetReleases(addedChangesets);
  const pendingPublicReleases = publicChangesetReleases(pendingChangesets);
  const consumedPublicReleases = publicChangesetReleases(consumedChangesets);
  const hasPublicRelease = addedPublicReleases.length > 0;
  const hasConsumedPublicRelease = consumedPublicReleases.length > 0;

  if (pendingPublicReleases.length > 0) {
    validateFixedGroupReleasePlan(
      "pending changeset",
      pendingReleasePlan,
      errors,
    );
  }

  const changedPublicPackageFiles = changedFiles.filter(isPublicPackageFile);
  const changedPackages = sortedUnique(
    changedPublicPackageFiles
      .map((file) => file.split("/")[1])
      .filter((directory) => directory !== undefined),
  );
  const changedPackageNames = changedPackages.map(
    (directory) => publicPackageNameByDirectory.get(directory) ?? directory,
  );
  const isCompleteBootstrap =
    isInitialWorkspaceBootstrap &&
    changedPackages.length === publicPackageDirectories.size;
  const addedEmptyChangesets = addedChangesets.filter(
    ({ releases }) => releases.length === 0,
  );
  if (addedEmptyChangesets.length > 0) {
    const hasUndocumentedEmptyChangeset = addedEmptyChangesets.some(
      ({ summary }) => summary.trim().length === 0,
    );
    if (!isCompleteBootstrap || hasUndocumentedEmptyChangeset) {
      errors.push(
        "empty changesets are only allowed with a summary for the complete initial workspace bootstrap",
      );
    }
  }

  if (hasConsumedPublicRelease) {
    errors.push(
      ...validateConsumedReleaseOutput({
        changedFiles,
        consumedChangesetIds: consumedChangesets.map(({ id }) => id),
        expectedConsumedChangesetIds,
        consumedReleasePlan,
        basePackageManifests,
        currentPackageManifests,
        expectedPackageManifests,
        currentChangelogs,
        expectedChangelogs,
        expectedReleaseOutputFiles,
      }),
    );
  } else if (!isInitialWorkspaceBootstrap) {
    const manuallyChangedVersions = [...publicPackageNames].filter(
      (name) =>
        basePackageManifests[name]?.["version"] !== undefined &&
        currentPackageManifests[name]?.["version"] !==
          basePackageManifests[name]?.["version"],
    );
    if (manuallyChangedVersions.length > 0) {
      errors.push(
        `workspace package versions changed without consuming a release changeset: ${manuallyChangedVersions.join(", ")}`,
      );
    }
  }

  if (changedPackages.length === 0) return errors;
  if (hasConsumedPublicRelease) return errors;

  const hasDocumentedEmptyChangeset = addedChangesets.some(
    ({ releases, summary }) =>
      releases.length === 0 && summary.trim().length > 0,
  );
  if (isCompleteBootstrap && hasDocumentedEmptyChangeset) return errors;

  if (hasPublicRelease) {
    const releasedPackageNames = new Set(
      addedPublicReleases.map(({ name }) => name),
    );
    const uncoveredPackageNames = changedPackageNames.filter(
      (name) => !releasedPackageNames.has(name),
    );
    if (uncoveredPackageNames.length > 0) {
      errors.push(
        `new changeset releases must cover every changed public package; missing ${uncoveredPackageNames.join(", ")}; changed packages: ${changedPackageNames.join(", ")}`,
      );
    }
    return errors;
  }

  if (addedChangesets.length > 0) {
    if (addedEmptyChangesets.length > 0) return errors;
    errors.push(
      `public package changes require a release changeset; empty changesets are only allowed for the complete initial workspace bootstrap; changed packages: ${changedPackages.join(", ")}`,
    );
    return errors;
  }

  if (consumedChangesets.length > 0) {
    errors.push(
      `consumed changesets only cover fixed-group version output; public package source changes require a new changeset; changed packages: ${changedPackages.join(", ")}`,
    );
    return errors;
  }

  errors.push(
    `public package changes require a new changeset; changed packages: ${changedPackages.join(", ")}`,
  );
  return errors;
}
