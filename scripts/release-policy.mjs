import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

import {
  isPrereleaseVersion,
  isZeroMajorVersion,
  PACKAGE_POLICY,
} from "./workspace-policy.mjs";

export const RELEASE_REPOSITORY = "A2C-SMCP/tf-chat-kit";
export const RELEASE_REGISTRY = "https://registry.npmjs.org/";
export const RELEASE_ENVIRONMENT = "npm-production";
export const RELEASE_WORKFLOW = "release.yml";
export const RELEASE_CHANNELS = Object.freeze(["next", "latest"]);
export const RELEASE_PACKAGE_NAMES = Object.freeze(
  Object.values(PACKAGE_POLICY).map(({ name }) => name),
);
export const RELEASE_CONSUMER_NAMES = Object.freeze([
  "tfrobotfrontMock",
  "officeMock",
  "tauriMock",
  "tfrobotfrontReal",
  "secondHostReal",
]);
const REQUIRED_COMPATIBILITY_CONSUMERS = Object.freeze([
  "tfrobotfrontMock",
  "officeMock",
  "tauriMock",
]);
/** @type {Readonly<Record<string, string>>} */
const MOCK_CONSUMER_EVIDENCE_PREFIXES = Object.freeze({
  tfrobotfrontMock: "docs/baselines/tfck-11/",
  officeMock: "docs/baselines/tfck-12/",
  tauriMock: "docs/baselines/tfck-12/",
});
const SERVER_BASELINE_EVIDENCE =
  "docs/baselines/tfck-7/tfrobot-gateway-compatibility.md";
const EXTERNAL_EVIDENCE_RULES = Object.freeze({
  productionSocket: Object.freeze({
    path: "release/evidence/production-socket.json",
    kind: "production-socket",
    issue: "TFCK-13",
    subject: "TFRobotServer",
  }),
  tfrobotfrontReal: Object.freeze({
    path: "release/evidence/tfrobotfront-real.json",
    kind: "real-host",
    issue: "TFCK-13",
    subject: "TFRobotFront",
  }),
  secondHostReal: Object.freeze({
    path: "release/evidence/second-host-real.json",
    kind: "real-host",
    issue: "TFCK-13",
    subject: "second-host",
  }),
});

/**
 * @typedef {{
 *   status: "passed" | "missing" | "blocked";
 *   evidence?: string;
 *   blockedBy?: string[];
 * }} ConsumerEvidence
 * @typedef {{
 *   versionKind: "prerelease" | "stable";
 *   reason: string;
 * }} ChannelPolicy
 * @typedef {{
 *   baseline: string;
 *   evidence: string;
 *   productionSocketStatus: "passed" | "missing" | "blocked";
 *   blockedBy?: string[];
 * }} ServerEvidence
 * @typedef {{
 *   schemaVersion: number;
 *   repository: string;
 *   server: ServerEvidence;
 *   consumers: Record<string, ConsumerEvidence>;
 *   channels: Record<string, ChannelPolicy>;
 *   knownLimitations: string[];
 * }} CompatibilityPolicy
 * @typedef {{
 *   name: string;
 *   version: string;
 *   tarball: string;
 *   files: string[];
 * }} PackedPackage
 * @typedef {{
 *   name: string;
 *   version: string;
 *   tarball: string;
 *   size: number;
 *   integrity: string;
 *   files: string[];
 * }} ReleasePackage
 */

/** @param {unknown} value @param {string} label */
const requireNonEmptyString = (value, label) => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
};

/** @param {unknown} value @param {string} label */
const requireStringArray = (value, label) => {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string" || entry.length === 0)
  ) {
    throw new Error(`${label} must be an array of non-empty strings.`);
  }
  return value;
};

/** @param {unknown} value @param {string} label */
const requireObject = (value, label) => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return /** @type {Record<string, unknown>} */ (value);
};

/**
 * @param {Record<string, unknown>} value
 * @param {readonly string[]} required
 * @param {readonly string[]} optional
 * @param {string} label
 */
const requireExactKeys = (value, required, optional, label) => {
  const actual = Object.keys(value).sort();
  const allowed = [...required, ...optional].sort();
  if (
    required.some((key) => !(key in value)) ||
    actual.some((key) => !allowed.includes(key))
  ) {
    throw new Error(
      `${label} must contain required keys ${required.join(", ")} and only optional keys ${optional.join(", ") || "<none>"}.`,
    );
  }
};

/** @param {unknown} value @param {string} label */
const requireEvidencePath = (value, label) => {
  const evidence = requireNonEmptyString(value, label);
  if (
    !/^(?:docs\/[A-Za-z0-9._/-]+\.md|release\/evidence\/[A-Za-z0-9._-]+\.json)$/u.test(
      evidence,
    ) ||
    evidence.split("/").includes("..")
  ) {
    throw new Error(
      `${label} must be a repository-relative Markdown baseline or JSON release evidence path.`,
    );
  }
  return evidence;
};

/**
 * @param {unknown} value
 * @param {{kind: string; issue: string; subject: string}} rule
 * @param {string} label
 */
export function validateExternalReleaseEvidence(value, rule, label) {
  const evidence = requireObject(value, label);
  requireExactKeys(
    evidence,
    [
      "schemaVersion",
      "kind",
      "issue",
      "subject",
      "repository",
      "revision",
      "environment",
      "runUrl",
      "executedAt",
      "result",
    ],
    [],
    label,
  );
  if (
    evidence["schemaVersion"] !== 1 ||
    evidence["kind"] !== rule.kind ||
    evidence["issue"] !== rule.issue ||
    evidence["subject"] !== rule.subject ||
    evidence["result"] !== "passed"
  ) {
    throw new Error(
      `${label} identity and result must match its release gate.`,
    );
  }
  const repository = requireNonEmptyString(
    evidence["repository"],
    `${label} repository`,
  );
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    throw new Error(
      `${label} repository must be an owner/repository identity.`,
    );
  }
  const revision = requireNonEmptyString(
    evidence["revision"],
    `${label} revision`,
  );
  if (!/^[0-9a-f]{40}$/u.test(revision)) {
    throw new Error(`${label} revision must be a full lowercase Git SHA.`);
  }
  const environment = requireNonEmptyString(
    evidence["environment"],
    `${label} environment`,
  );
  if (environment !== "staging" && environment !== "production") {
    throw new Error(`${label} environment must be staging or production.`);
  }
  const runUrl = requireNonEmptyString(evidence["runUrl"], `${label} runUrl`);
  try {
    if (new URL(runUrl).protocol !== "https:") throw new Error();
  } catch {
    throw new Error(`${label} runUrl must be an HTTPS execution identity.`);
  }
  const executedAt = requireNonEmptyString(
    evidence["executedAt"],
    `${label} executedAt`,
  );
  if (Number.isNaN(Date.parse(executedAt))) {
    throw new Error(`${label} executedAt must be an ISO date-time.`);
  }
  return evidence;
}

/** @param {unknown} value @param {string} label */
const requireEvidenceStatus = (value, label) => {
  if (value !== "passed" && value !== "missing" && value !== "blocked") {
    throw new Error(`${label} must be passed, missing, or blocked.`);
  }
  return value;
};

/** @param {unknown} value @returns {CompatibilityPolicy} */
export function validateCompatibilityPolicy(value) {
  if (typeof value !== "object" || value === null) {
    throw new Error("release compatibility policy must be an object.");
  }
  const policy = /** @type {Record<string, unknown>} */ (value);
  if (policy["schemaVersion"] !== 1) {
    throw new Error("release compatibility schemaVersion must be 1.");
  }
  if (policy["repository"] !== RELEASE_REPOSITORY) {
    throw new Error(
      `release compatibility repository must be ${RELEASE_REPOSITORY}.`,
    );
  }
  const server = requireObject(
    policy["server"],
    "release compatibility server",
  );
  requireExactKeys(
    server,
    ["baseline", "evidence", "productionSocketStatus"],
    ["blockedBy"],
    "release compatibility server",
  );
  requireNonEmptyString(
    server["baseline"],
    "release compatibility server baseline",
  );
  const serverEvidence = requireEvidencePath(
    server["evidence"],
    "release compatibility server evidence",
  );
  const serverStatus = requireEvidenceStatus(
    server["productionSocketStatus"],
    "release compatibility server productionSocketStatus",
  );
  const expectedServerEvidence =
    serverStatus === "passed"
      ? EXTERNAL_EVIDENCE_RULES.productionSocket.path
      : SERVER_BASELINE_EVIDENCE;
  if (serverEvidence !== expectedServerEvidence) {
    throw new Error(
      `release compatibility server evidence must be ${expectedServerEvidence}.`,
    );
  }
  if (serverStatus !== "passed") {
    const blockers = requireStringArray(
      server["blockedBy"],
      "release compatibility server blockedBy",
    );
    if (blockers.length === 0) {
      throw new Error(
        "release compatibility server blockedBy must identify unresolved work.",
      );
    }
  } else if (server["blockedBy"] !== undefined) {
    throw new Error(
      "release compatibility passed server must not retain blockedBy.",
    );
  }

  const consumers = requireObject(
    policy["consumers"],
    "release compatibility consumers",
  );
  if (
    JSON.stringify(Object.keys(consumers).sort()) !==
    JSON.stringify([...RELEASE_CONSUMER_NAMES].sort())
  ) {
    throw new Error(
      `release compatibility consumers must exactly contain ${RELEASE_CONSUMER_NAMES.join(", ")}.`,
    );
  }
  for (const name of RELEASE_CONSUMER_NAMES) {
    const consumer = requireObject(
      consumers[name],
      `release compatibility consumer ${name}`,
    );
    requireExactKeys(
      consumer,
      ["status"],
      ["evidence", "blockedBy"],
      `release compatibility consumer ${name}`,
    );
    const status = requireEvidenceStatus(
      consumer["status"],
      `release compatibility consumer ${name} status`,
    );
    if (status === "passed") {
      const evidence = requireEvidencePath(
        consumer["evidence"],
        `release compatibility consumer ${name} evidence`,
      );
      const mockPrefix = MOCK_CONSUMER_EVIDENCE_PREFIXES[name];
      const externalRule =
        name === "tfrobotfrontReal"
          ? EXTERNAL_EVIDENCE_RULES.tfrobotfrontReal
          : name === "secondHostReal"
            ? EXTERNAL_EVIDENCE_RULES.secondHostReal
            : undefined;
      if (
        (mockPrefix !== undefined && !evidence.startsWith(mockPrefix)) ||
        (externalRule !== undefined && evidence !== externalRule.path) ||
        (mockPrefix === undefined && externalRule === undefined)
      ) {
        throw new Error(
          `release compatibility consumer ${name} evidence must use its dedicated approved evidence path.`,
        );
      }
      if (consumer["blockedBy"] !== undefined) {
        throw new Error(
          `release compatibility passed consumer ${name} must not retain blockedBy.`,
        );
      }
    } else {
      const blockers = requireStringArray(
        consumer["blockedBy"],
        `release compatibility consumer ${name} blockedBy`,
      );
      if (blockers.length === 0) {
        throw new Error(
          `release compatibility consumer ${name} blockedBy must identify unresolved work.`,
        );
      }
      if (consumer["evidence"] !== undefined) {
        throw new Error(
          `release compatibility unresolved consumer ${name} must not claim evidence.`,
        );
      }
    }
  }

  const channels = requireObject(
    policy["channels"],
    "release compatibility channels",
  );
  if (
    JSON.stringify(Object.keys(channels).sort()) !==
    JSON.stringify([...RELEASE_CHANNELS].sort())
  ) {
    throw new Error(
      `release compatibility channels must exactly contain ${RELEASE_CHANNELS.join(", ")}.`,
    );
  }
  for (const channel of RELEASE_CHANNELS) {
    const candidate = requireObject(
      channels[channel],
      `release compatibility channel ${channel}`,
    );
    requireExactKeys(
      candidate,
      ["versionKind", "reason"],
      [],
      `release compatibility channel ${channel}`,
    );
    const expectedVersionKind = channel === "next" ? "prerelease" : "stable";
    if (candidate["versionKind"] !== expectedVersionKind) {
      throw new Error(
        `release compatibility channel ${channel} versionKind must be ${expectedVersionKind}.`,
      );
    }
    requireNonEmptyString(
      candidate["reason"],
      `release compatibility channel ${channel} reason`,
    );
  }
  requireStringArray(
    policy["knownLimitations"],
    "release compatibility knownLimitations",
  );
  return /** @type {CompatibilityPolicy} */ (value);
}

/** @param {CompatibilityPolicy} policy @param {string} channel */
export function getReleaseChannelDecision(policy, channel) {
  if (!RELEASE_CHANNELS.includes(channel)) {
    throw new Error(
      `release channel must be one of ${RELEASE_CHANNELS.join(", ")}; found ${channel}.`,
    );
  }
  const blockers = REQUIRED_COMPATIBILITY_CONSUMERS.flatMap((name) => {
    const evidence = policy.consumers[name];
    return evidence?.status === "passed"
      ? []
      : (evidence?.blockedBy ?? [`${name} evidence`]);
  });
  const channelPolicy = policy.channels[channel];
  return {
    allowed: blockers.length === 0,
    blockedBy: [...new Set(blockers)].sort(),
    reason: channelPolicy?.reason ?? "no approved policy",
    versionKind: channelPolicy?.versionKind,
  };
}

/** @param {CompatibilityPolicy} policy @param {string} channel */
export function assertReleaseChannelAllowed(policy, channel) {
  const decision = getReleaseChannelDecision(policy, channel);
  if (!decision.allowed) {
    throw new Error(
      `${channel} release is blocked: ${decision.reason} Blocked by ${decision.blockedBy.join(", ")}.`,
    );
  }
  return decision;
}

/** @param {string} rootDirectory */
export async function loadCompatibilityPolicy(rootDirectory) {
  const value = JSON.parse(
    await readFile(
      path.join(rootDirectory, "release", "compatibility.json"),
      "utf8",
    ),
  );
  const policy = validateCompatibilityPolicy(value);
  const evidencePaths = [
    policy.server.evidence,
    ...Object.values(policy.consumers).flatMap(({ evidence }) =>
      evidence ? [evidence] : [],
    ),
  ];
  const realRoot = await realpath(rootDirectory);
  for (const evidence of evidencePaths) {
    const absoluteEvidence = path.resolve(rootDirectory, evidence);
    const evidenceStat = await lstat(absoluteEvidence);
    if (!evidenceStat.isFile() || evidenceStat.isSymbolicLink()) {
      throw new Error(
        `${evidence}: compatibility evidence must be a regular file.`,
      );
    }
    const actualEvidence = await realpath(absoluteEvidence);
    if (!actualEvidence.startsWith(`${realRoot}${path.sep}`)) {
      throw new Error(
        `${evidence}: compatibility evidence escaped the repository.`,
      );
    }
    const externalRule = Object.values(EXTERNAL_EVIDENCE_RULES).find(
      ({ path: expectedPath }) => evidence === expectedPath,
    );
    if (externalRule) {
      validateExternalReleaseEvidence(
        JSON.parse(await readFile(actualEvidence, "utf8")),
        externalRule,
        evidence,
      );
    }
  }
  return policy;
}

/** @param {string} file */
export async function calculateFileIntegrity(file) {
  const bytes = await readFile(file);
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

/**
 * @param {{
 *   rootDirectory: string;
 *   packManifest: { packages?: unknown };
 * }} input
 * @returns {Promise<{ version: string; packages: ReleasePackage[] }>}
 */
export async function buildReleasePackages({ rootDirectory, packManifest }) {
  if (!Array.isArray(packManifest.packages)) {
    throw new Error("pack manifest must contain a packages array.");
  }
  /** @type {ReleasePackage[]} */
  const packages = [];
  for (const rawPackage of packManifest.packages) {
    if (typeof rawPackage !== "object" || rawPackage === null) {
      throw new Error("pack manifest package entries must be objects.");
    }
    const packedPackage = /** @type {Record<string, unknown>} */ (rawPackage);
    const name = requireNonEmptyString(
      packedPackage["name"],
      "packed package name",
    );
    const version = requireNonEmptyString(
      packedPackage["version"],
      `${name} version`,
    );
    const tarball = requireNonEmptyString(
      packedPackage["tarball"],
      `${name} tarball`,
    );
    const files = requireStringArray(packedPackage["files"], `${name} files`);
    const absoluteTarball = path.resolve(tarball);
    const approvedDirectory = path.join(
      rootDirectory,
      ".artifacts",
      "packages",
    );
    if (path.dirname(absoluteTarball) !== approvedDirectory) {
      throw new Error(
        `${name} tarball must be inside ${approvedDirectory}; found ${absoluteTarball}.`,
      );
    }
    const fileStat = await lstat(absoluteTarball);
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
      throw new Error(`${name} tarball must be a regular file.`);
    }
    const [realTarball, realApprovedDirectory] = await Promise.all([
      realpath(absoluteTarball),
      realpath(approvedDirectory),
    ]);
    if (path.dirname(realTarball) !== realApprovedDirectory) {
      throw new Error(
        `${name} tarball must resolve inside ${realApprovedDirectory}; found ${realTarball}.`,
      );
    }
    packages.push({
      name,
      version,
      tarball: path.basename(absoluteTarball),
      size: fileStat.size,
      integrity: await calculateFileIntegrity(absoluteTarball),
      files: [...files].sort(),
    });
  }

  const actualNames = packages.map(({ name }) => name);
  if (JSON.stringify(actualNames) !== JSON.stringify(RELEASE_PACKAGE_NAMES)) {
    throw new Error(
      `release packages must be ordered as ${RELEASE_PACKAGE_NAMES.join(", ")}; found ${actualNames.join(", ")}.`,
    );
  }
  const versions = [...new Set(packages.map(({ version }) => version))];
  if (versions.length !== 1 || !isZeroMajorVersion(versions[0] ?? "")) {
    throw new Error(
      `release packages must share one valid 0.x version; found ${versions.join(", ")}.`,
    );
  }
  return { version: /** @type {string} */ (versions[0]), packages };
}

/**
 * @param {{
 *   version: string;
 *   channel: string;
 *   commit: string;
 *   runUrl: string;
 *   createdAt: string;
 *   compatibility: CompatibilityPolicy;
 *   packages: ReleasePackage[];
 * }} input
 */
export function createReleaseManifest({
  version,
  channel,
  commit,
  runUrl,
  createdAt,
  compatibility,
  packages,
}) {
  assertReleaseChannelAllowed(compatibility, channel);
  if (!isZeroMajorVersion(version)) {
    throw new Error(`release version must remain on 0.x; found ${version}.`);
  }
  if (channel === "next" && !isPrereleaseVersion(version)) {
    throw new Error(
      `next releases require an explicit SemVer prerelease; found ${version}.`,
    );
  }
  if (channel === "latest" && isPrereleaseVersion(version)) {
    throw new Error(
      `latest releases require a stable SemVer version; found ${version}.`,
    );
  }
  if (
    JSON.stringify(packages.map(({ name }) => name)) !==
      JSON.stringify(RELEASE_PACKAGE_NAMES) ||
    packages.some((releasePackage) => releasePackage.version !== version)
  ) {
    throw new Error(
      "release manifest packages must contain the complete fixed group at the requested version.",
    );
  }
  if (!/^[0-9a-f]{40}$/u.test(commit)) {
    throw new Error("release commit must be a full lowercase Git SHA.");
  }
  requireNonEmptyString(runUrl, "release workflow run URL");
  if (Number.isNaN(Date.parse(createdAt))) {
    throw new Error("release createdAt must be an ISO date-time.");
  }
  return {
    schemaVersion: 1,
    repository: RELEASE_REPOSITORY,
    version,
    channel,
    tag: `v${version}`,
    commit,
    workflow: RELEASE_WORKFLOW,
    environment: RELEASE_ENVIRONMENT,
    runUrl,
    createdAt,
    compatibility,
    packages,
  };
}

/** @param {string} packageName */
export function registryPackageUrl(packageName) {
  return new URL(encodeURIComponent(packageName), RELEASE_REGISTRY).toString();
}

/**
 * @param {{
 *   packageName: string;
 *   fetchImpl?: typeof fetch;
 * }} input
 */
export async function readRegistryPackage({ packageName, fetchImpl = fetch }) {
  const response = await fetchImpl(registryPackageUrl(packageName), {
    headers: { accept: "application/json" },
  });
  if (response.status === 404) return undefined;
  if (!response.ok) {
    throw new Error(
      `${packageName}: registry read failed with HTTP ${response.status}.`,
    );
  }
  const metadata = await response.json();
  if (typeof metadata !== "object" || metadata === null) {
    throw new Error(`${packageName}: registry metadata is invalid.`);
  }
  return /** @type {Record<string, unknown>} */ (metadata);
}

/** @param {Record<string, unknown> | undefined} metadata */
export function registryVersions(metadata) {
  const versions = metadata?.["versions"];
  if (versions === undefined) return {};
  return requireObject(versions, "registry versions");
}

/**
 * @param {Record<string, unknown> | undefined} metadata
 * @param {string} version
 */
export function registryVersionMetadata(metadata, version) {
  const candidate = registryVersions(metadata)[version];
  if (candidate === undefined) return undefined;
  return requireObject(candidate, `registry version ${version}`);
}

/**
 * @param {Record<string, unknown> | undefined} metadata
 * @param {string} channel
 */
export function registryDistTag(metadata, channel) {
  const distTags = metadata?.["dist-tags"];
  if (distTags === undefined) return undefined;
  const value = requireObject(distTags, "registry dist-tags")[channel];
  if (value === undefined) return undefined;
  return requireNonEmptyString(value, `registry dist-tag ${channel}`);
}

/**
 * @param {ReleasePackage} releasePackage
 * @param {Record<string, unknown>} metadata
 */
export function assertRegistryIntegrity(releasePackage, metadata) {
  const dist =
    typeof metadata["dist"] === "object" && metadata["dist"] !== null
      ? /** @type {Record<string, unknown>} */ (metadata["dist"])
      : undefined;
  if (dist?.["integrity"] !== releasePackage.integrity) {
    throw new Error(
      `${releasePackage.name}@${releasePackage.version}: registry integrity does not match the approved tarball.`,
    );
  }
}
