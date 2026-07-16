import assembleReleasePlan from "@changesets/assemble-release-plan";
import { read as readChangesetConfig } from "@changesets/config";
import path from "node:path";

import { PACKAGE_POLICY } from "./workspace-policy.mjs";

/** @typedef {"none" | "patch" | "minor" | "major"} ReleaseType */
/** @typedef {{ name: string; type: ReleaseType }} ChangesetRelease */
/**
 * @typedef {{
 *   id: string;
 *   summary: string;
 *   releases: readonly ChangesetRelease[];
 * }} ReleaseChangeset
 */
/**
 * @typedef {{
 *   name: string;
 *   version: string;
 *   dependencies?: Record<string, string>;
 *   devDependencies?: Record<string, string>;
 *   optionalDependencies?: Record<string, string>;
 *   peerDependencies?: Record<string, string>;
 *   [key: string]: unknown;
 * }} ReleasePackageManifest
 */
/** @typedef {Record<string, ReleasePackageManifest>} ReleasePackageManifestMap */

/**
 * Build a release plan with the same package graph and fixed-group semantics used
 * by the Changesets CLI. Supplying manifests from a Git comparison ref lets the
 * caller validate a consumed changeset against the versions that it consumed.
 *
 * @param {{
 *   rootDirectory: string;
 *   rootManifest: ReleasePackageManifest;
 *   packageManifests: ReleasePackageManifestMap;
 *   changesets: readonly ReleaseChangeset[];
 * }} input
 */
export async function assembleWorkspaceReleasePlan({
  rootDirectory,
  rootManifest,
  packageManifests,
  changesets,
}) {
  const packages = {
    tool: /** @type {const} */ ("pnpm"),
    root: { dir: rootDirectory, packageJson: rootManifest },
    packages: Object.entries(PACKAGE_POLICY).map(([directory, { name }]) => {
      const manifest = packageManifests[name];
      if (!manifest) {
        throw new Error(`Cannot assemble release plan without ${name}.`);
      }
      return {
        dir: path.join(rootDirectory, "packages", directory),
        packageJson: manifest,
      };
    }),
  };
  const config = await readChangesetConfig(rootDirectory, packages);

  return assembleReleasePlan(
    changesets.map(({ id, summary, releases }) => ({
      id,
      summary,
      releases: releases.map(({ name, type }) => ({ name, type })),
    })),
    packages,
    config,
    undefined,
  );
}
