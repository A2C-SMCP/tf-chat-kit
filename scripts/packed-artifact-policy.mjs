import { TextDecoder } from "node:util";

const dependencySections = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
];

const forbiddenArtifactText = [
  {
    label: "developer home path",
    pattern: /(?:\/Users\/|\/home\/[^/\s]+\/|[A-Za-z]:\\Users\\)/u,
  },
  {
    label: "TFRobotFront host source",
    pattern: /TFRobotFront|src[\\/]components[\\/]chat-player/u,
  },
  { label: "source/path dependency", pattern: /(?:file|link|workspace):/u },
  { label: "private key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/u },
  {
    label: "Bearer credential",
    pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}={0,2}\b/u,
  },
  {
    label: "GitHub credential",
    pattern: /\b(?:gh[opsu]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/u,
  },
  { label: "AWS access key", pattern: /\bAKIA[0-9A-Z]{16}\b/u },
];

const sensitiveAssignment =
  /(?:^|[^A-Za-z0-9_])(_authToken|npmAuthToken|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|admin[_-]?key|_auth|_password|token|api[_-]?key|secret|password|cookie|authorization)\s*[:=]\s*(?:(["'`])([^"'`\s]{8,})\2|([^\s,"'`;\]]{8,}))/gimu;
const documentedPlaceholder =
  /^(?:<[^>]+>|\$\{[^}]+\}|example|placeholder|redacted|changeme|not-a-real-|dummy)/iu;

const utf8Decoder = new TextDecoder("utf-8");
const utf16LittleEndianDecoder = new TextDecoder("utf-16le");
const utf16BigEndianDecoder = new TextDecoder("utf-16be");

/**
 * Decode every representation relevant to text credentials. UTF-8 also keeps
 * contiguous ASCII strings visible inside arbitrary binary files. NUL-bearing
 * files receive both UTF-16 byte orders so text cannot evade the scanner by
 * changing encoding.
 *
 * @param {{ content?: string; bytes?: Uint8Array }} file
 * @returns {string[]}
 */
const artifactTextViews = (file) => {
  const views = [];
  if (file.content !== undefined) views.push(file.content);
  if (file.bytes !== undefined) {
    views.push(utf8Decoder.decode(file.bytes));
    if (file.bytes.includes(0)) {
      views.push(utf16LittleEndianDecoder.decode(file.bytes));
      views.push(utf16BigEndianDecoder.decode(file.bytes));
    }
  }
  return [...new Set(views)];
};

/**
 * JSON object key order has no package-manifest semantics and pnpm may emit a
 * different order across platforms. Canonicalize objects while preserving
 * arrays so the comparison remains exact for every field and value.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
const canonicalJson = (value) => {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalJson(entry)]),
  );
};

/** @param {unknown} value */
const stableJson = (value) => JSON.stringify(canonicalJson(value));

/**
 * pnpm rewrites internal workspace ranges in the packed manifest. Build the
 * exact manifest that consumers should receive so unexpected dependencies,
 * scripts, or metadata cannot hide behind a valid source workspace snapshot.
 *
 * @param {Record<string, unknown>} sourceManifest
 * @returns {Record<string, unknown>}
 */
export function expectedPackedManifest(sourceManifest) {
  const expected = structuredClone(sourceManifest);
  const version = expected["version"];
  if (typeof version !== "string") {
    throw new Error("source package manifest must contain a string version");
  }
  for (const section of dependencySections) {
    const dependencies = expected[section];
    if (!dependencies || typeof dependencies !== "object") continue;
    const dependencyMap = /** @type {Record<string, unknown>} */ (dependencies);
    for (const [name, specifier] of Object.entries(dependencyMap)) {
      if (name.startsWith("@tf/") && specifier === "workspace:^") {
        dependencyMap[name] = `^${version}`;
      }
    }
  }
  return expected;
}

/**
 * @param {{
 *   packageName: string;
 *   sourceManifest: Record<string, unknown>;
 *   packedManifest: Record<string, unknown>;
 *   declaredFiles: readonly string[];
 *   extractedFiles: readonly { path: string; content?: string; bytes?: Uint8Array }[];
 *   expectedFileContents?: Readonly<Record<string, Uint8Array>>;
 * }} input
 * @returns {string[]}
 */
export function validatePackedArtifact({
  packageName,
  sourceManifest,
  packedManifest,
  declaredFiles,
  extractedFiles,
  expectedFileContents = {},
}) {
  /** @type {string[]} */
  const errors = [];
  const expectedManifest = expectedPackedManifest(sourceManifest);
  if (stableJson(packedManifest) !== stableJson(expectedManifest)) {
    errors.push(
      `${packageName}: packed package.json must exactly match the approved source manifest after workspace range resolution`,
    );
  }

  const expectedFiles = [...new Set(declaredFiles)].sort();
  const actualFiles = [
    ...new Set(extractedFiles.map(({ path }) => path)),
  ].sort();
  if (stableJson(actualFiles) !== stableJson(expectedFiles)) {
    errors.push(
      `${packageName}: extracted tarball files must exactly match pnpm pack output; expected ${expectedFiles.join(", ")}; found ${actualFiles.join(", ")}`,
    );
  }

  for (const [filePath, expectedBytes] of Object.entries(
    expectedFileContents,
  )) {
    const extractedFile = extractedFiles.find(({ path }) => path === filePath);
    if (
      extractedFile?.bytes === undefined ||
      !Buffer.from(extractedFile.bytes).equals(Buffer.from(expectedBytes))
    ) {
      errors.push(
        `${packageName}: ${filePath} must exactly match the approved repository file`,
      );
    }
  }

  for (const file of extractedFiles) {
    const textViews = artifactTextViews(file);
    if (textViews.length === 0) {
      errors.push(
        `${packageName}: ${file.path} content is unavailable for security scanning`,
      );
      continue;
    }
    const fileErrors = new Set();
    for (const text of textViews) {
      for (const { label, pattern } of forbiddenArtifactText) {
        if (pattern.test(text)) {
          fileErrors.add(
            `${packageName}: ${file.path} contains forbidden ${label}`,
          );
        }
      }
      for (const match of text.matchAll(sensitiveAssignment)) {
        const value = match[3] ?? match[4] ?? "";
        if (!documentedPlaceholder.test(value)) {
          fileErrors.add(
            `${packageName}: ${file.path} contains a credential-like ${match[1] ?? "secret"} assignment`,
          );
        }
      }
    }
    errors.push(...fileErrors);
  }
  return errors;
}
