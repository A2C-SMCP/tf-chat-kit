import { TextDecoder } from "node:util";
import ts from "typescript";

import { validateFacadeEntryIsolation } from "./facade-entry-policy.mjs";
import {
  loadWorkspaceSnapshot,
  isZeroMajorVersion,
} from "./workspace-policy.mjs";

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
const credentialFieldName =
  /^(?:_authToken|npmAuthToken|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|admin[_-]?key|_auth|_password|token|api[_-]?key|secret|password|cookie|authorization)$/iu;

/**
 * Source field projections are references, not embedded credential values.
 * Only AST-confirmed references or calls with references/field-name arguments
 * qualify. Comments, strings, config text and credential literals keep checks.
 * @param {string} filePath
 * @param {string} text
 * @returns {{references: Map<number, number>, embedded: Set<string>}}
 */
const sourceReferenceSpans = (filePath, text) => {
  const spans = new Map();
  const embedded = new Set();
  if (!/\.[cm]?[jt]sx?$/u.test(filePath))
    return { references: spans, embedded };
  const source = ts.createSourceFile(
    filePath,
    text,
    ts.ScriptTarget.Latest,
    true,
  );
  /** @param {import("typescript").Expression} node
   * @returns {boolean}
   */
  const memberReference = (node) =>
    ts.isPropertyAccessExpression(node) &&
    (ts.isIdentifier(node.expression) || memberReference(node.expression));
  /** @param {import("typescript").Expression} node */
  const runtimeReference = (node) =>
    memberReference(node) ||
    (ts.isCallExpression(node) &&
      (ts.isIdentifier(node.expression) || memberReference(node.expression)) &&
      node.arguments.every(
        (argument) =>
          ts.isIdentifier(argument) ||
          memberReference(argument) ||
          (ts.isStringLiteral(argument) &&
            /^(?:token|access_token|accessToken|refresh_token|refreshToken|password|secret|authorization|cookie)$/u.test(
              argument.text,
            )),
      ));
  /** @param {import("typescript").Node} node */
  const visit = (node) => {
    const value =
      ts.isPropertyAssignment(node) || ts.isVariableDeclaration(node)
        ? node.initializer
        : ts.isBinaryExpression(node) &&
            node.operatorToken.kind === ts.SyntaxKind.EqualsToken
          ? node.right
          : undefined;
    if (value !== undefined && runtimeReference(value))
      spans.set(value.getStart(source), value.getEnd());
    const field =
      ts.isPropertyAssignment(node) || ts.isVariableDeclaration(node)
        ? node.name
        : ts.isBinaryExpression(node)
          ? node.left
          : undefined;
    const name =
      field !== undefined &&
      (ts.isIdentifier(field) || ts.isStringLiteral(field))
        ? field.text
        : field !== undefined && ts.isPropertyAccessExpression(field)
          ? field.name.text
          : undefined;
    if (
      value !== undefined &&
      name !== undefined &&
      credentialFieldName.test(name) &&
      (ts.isCallExpression(value) || ts.isElementAccessExpression(value))
    ) {
      /** @param {import("typescript").Node} child */
      const inspectLiteral = (child) => {
        if (
          (ts.isStringLiteral(child) ||
            ts.isNoSubstitutionTemplateLiteral(child)) &&
          child.text.length >= 8 &&
          !documentedPlaceholder.test(child.text) &&
          !credentialFieldName.test(child.text)
        )
          embedded.add(name);
        ts.forEachChild(child, inspectLiteral);
      };
      inspectLiteral(value);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { references: spans, embedded };
};

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

/** Load one validated version catalog for both packaging and artifact checks.
 * @param {string} rootDirectory
 * @returns {Promise<ReadonlyMap<string, string>>}
 */
export async function loadWorkspaceVersions(rootDirectory) {
  const { packages } = await loadWorkspaceSnapshot(rootDirectory);
  /** @type {Map<string, string>} */
  const versions = new Map();
  for (const { manifest } of packages) {
    if (
      !manifest.name ||
      !manifest.version ||
      !isZeroMajorVersion(manifest.version)
    ) {
      throw new Error(
        "workspace packages must declare a name and valid 0.x version",
      );
    }
    if (versions.has(manifest.name)) {
      throw new Error(`duplicate workspace package ${manifest.name}`);
    }
    versions.set(manifest.name, manifest.version);
  }
  return versions;
}

/**
 * pnpm rewrites internal workspace ranges in the packed manifest. Build the
 * exact manifest that consumers should receive so unexpected dependencies,
 * scripts, or metadata cannot hide behind a valid source workspace snapshot.
 *
 * @param {Record<string, unknown>} sourceManifest
 * @param {ReadonlyMap<string, string>} workspaceVersions
 * @returns {Record<string, unknown>}
 */
export function expectedPackedManifest(sourceManifest, workspaceVersions) {
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
      if (name.startsWith("@turingfocus/") && specifier === "workspace:^") {
        const dependencyVersion = workspaceVersions.get(name);
        if (!dependencyVersion) {
          throw new Error(`missing version for workspace dependency ${name}`);
        }
        dependencyMap[name] = `^${dependencyVersion}`;
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
 *   workspaceVersions: ReadonlyMap<string, string>;
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
  workspaceVersions,
  declaredFiles,
  extractedFiles,
  expectedFileContents = {},
}) {
  /** @type {string[]} */
  const errors = [];
  const expectedManifest = expectedPackedManifest(
    sourceManifest,
    workspaceVersions,
  );
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
      const { references, embedded } = sourceReferenceSpans(file.path, text);
      for (const field of embedded)
        fileErrors.add(
          `${packageName}: ${file.path} contains a credential-like ${field} assignment`,
        );
      for (const { label, pattern } of forbiddenArtifactText) {
        if (pattern.test(text)) {
          fileErrors.add(
            `${packageName}: ${file.path} contains forbidden ${label}`,
          );
        }
      }
      for (const match of text.matchAll(sensitiveAssignment)) {
        const value = match[3] ?? match[4] ?? "";
        const start = match.index + match[0].lastIndexOf(value);
        if (
          match[2] === undefined &&
          (references.get(start) ?? -1) >= start + value.length
        )
          continue;
        if (!documentedPlaceholder.test(value)) {
          fileErrors.add(
            `${packageName}: ${file.path} contains a credential-like ${match[1] ?? "secret"} assignment`,
          );
        }
      }
    }
    errors.push(...fileErrors);
  }
  if (packageName === "@turingfocus/chat-kit") {
    const facadeFiles = Object.fromEntries(
      extractedFiles
        .filter(({ path: filePath }) =>
          /^dist\/.+\.(?:d\.ts|js)$/u.test(filePath),
        )
        .map((file) => [
          file.path,
          file.content ??
            (file.bytes === undefined ? "" : utf8Decoder.decode(file.bytes)),
        ]),
    );
    errors.push(
      ...validateFacadeEntryIsolation({
        label: "@turingfocus/chat-kit packed artifact",
        files: facadeFiles,
        entries: {
          headless: ["dist/headless.js", "dist/headless.d.ts"],
          react: ["dist/react.js", "dist/react.d.ts"],
        },
      }),
    );
  }
  return errors;
}
