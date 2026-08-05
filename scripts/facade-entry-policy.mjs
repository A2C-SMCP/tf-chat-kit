import path from "node:path";

import ts from "typescript";

const ENTRY_POLICIES = Object.freeze({
  headless: Object.freeze([
    "@turingfocus/chat-react",
    "@turingfocus/chat-ui-antd",
    "antd",
    "react",
    "react-dom",
  ]),
  react: Object.freeze(["@turingfocus/chat-ui-antd", "antd", "react-dom"]),
});
/** @type {Map<string, string[]>} */
const moduleSpecifierCache = new Map();
const FACADE_PACKAGE_NAME = "@turingfocus/chat-kit";
/** @type {Readonly<Record<string, string>>} */
const FACADE_SELF_ENTRIES = Object.freeze({
  "@turingfocus/chat-kit": "index",
  "@turingfocus/chat-kit/antd": "antd",
  "@turingfocus/chat-kit/headless": "headless",
  "@turingfocus/chat-kit/react": "react",
});

/** @param {string} specifier */
const packageNameFromSpecifier = (specifier) => {
  if (!specifier.startsWith("@")) return specifier.split("/")[0] ?? specifier;
  return specifier.split("/").slice(0, 2).join("/");
};

/**
 * Collect only syntax that can add a module edge. Comments and ordinary string
 * literals are deliberately ignored.
 *
 * @param {string} filePath
 * @param {string} content
 * @returns {string[]}
 */
const moduleSpecifiers = (filePath, content) => {
  const cacheKey = `${filePath}\0${content}`;
  const cached = moduleSpecifierCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const source = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true,
  );
  /** @type {string[]} */
  const specifiers = [
    ...source.referencedFiles.map(({ fileName }) => fileName),
    ...source.typeReferenceDirectives.map(({ fileName }) => fileName),
  ];
  /** @param {import("typescript").Node} node */
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (ts.isImportTypeNode(node)) {
      const argument = node.argument;
      if (
        ts.isLiteralTypeNode(argument) &&
        ts.isStringLiteralLike(argument.literal)
      ) {
        specifiers.push(argument.literal.text);
      }
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression !== undefined &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      specifiers.push(node.moduleReference.expression.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      const [argument] = node.arguments;
      if (argument !== undefined && ts.isStringLiteralLike(argument)) {
        specifiers.push(argument.text);
      }
    } else if (ts.isCallExpression(node)) {
      const [argument] = node.arguments;
      const target = node.expression;
      const isRequire =
        (ts.isIdentifier(target) && target.text === "require") ||
        ((ts.isPropertyAccessExpression(target) ||
          ts.isElementAccessExpression(target)) &&
          ts.isIdentifier(target.expression) &&
          target.expression.text === "module" &&
          (ts.isPropertyAccessExpression(target)
            ? target.name.text === "require"
            : target.argumentExpression !== undefined &&
              ts.isStringLiteralLike(target.argumentExpression) &&
              target.argumentExpression.text === "require"));
      if (
        isRequire &&
        argument !== undefined &&
        ts.isStringLiteralLike(argument)
      ) {
        specifiers.push(argument.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  moduleSpecifierCache.set(cacheKey, specifiers);
  return specifiers;
};

/**
 * Resolve the `.js` specifiers emitted by NodeNext source against either the
 * TypeScript source graph or a packed JavaScript/declaration graph.
 *
 * @param {string} importer
 * @param {string} specifier
 * @param {ReadonlyMap<string, string>} files
 * @returns {string[]}
 */
const resolveLocalModules = (importer, specifier, files) => {
  const resolved = path.posix.normalize(
    path.posix.join(path.posix.dirname(importer), specifier),
  );
  const base = resolved.replace(/\.(?:[cm]?js|[cm]?ts|tsx)$/u, "");
  const candidates = importer.endsWith(".d.ts")
    ? [resolved.endsWith(".d.ts") ? resolved : `${base}.d.ts`]
    : importer.startsWith("src/")
      ? [
          `${base}.ts`,
          `${base}.tsx`,
          `${base}.mts`,
          `${base}.cts`,
          `${base}.d.ts`,
          resolved,
        ]
      : [resolved];
  return [...new Set(candidates)].filter((candidate) => files.has(candidate));
};

/**
 * Resolve this package's public self-references back into the same source or
 * packed graph. Without this step a lower entry could jump to `/antd` while
 * looking like an external package edge.
 *
 * @param {string} importer
 * @param {string} specifier
 * @param {ReadonlyMap<string, string>} files
 * @returns {string[]}
 */
const resolveFacadeSelfReference = (importer, specifier, files) => {
  const entry = FACADE_SELF_ENTRIES[specifier];
  if (entry === undefined) return [];
  const directory = importer.startsWith("src/") ? "src" : "dist";
  const extension = importer.endsWith(".d.ts")
    ? ".d.ts"
    : directory === "src"
      ? ".ts"
      : ".js";
  const resolved = `${directory}/${entry}${extension}`;
  return files.has(resolved) ? [resolved] : [];
};

/**
 * Validate the complete local module graph reachable from the layered facade
 * entries. This runs once against workspace source and again against extracted
 * tarball JavaScript/declarations.
 *
 * @param {{
 *   label: string;
 *   files: Readonly<Record<string, string>>;
 *   entries: Readonly<Record<keyof typeof ENTRY_POLICIES, readonly string[]>>;
 * }} input
 * @returns {string[]}
 */
export function validateFacadeEntryIsolation({ label, files, entries }) {
  const fileMap = new Map(
    Object.entries(files).map(([filePath, content]) => [
      filePath.replaceAll("\\", "/"),
      content,
    ]),
  );
  /** @type {string[]} */
  const errors = [];

  for (const [entryName, forbiddenPackages] of Object.entries(ENTRY_POLICIES)) {
    const roots =
      entries[/** @type {keyof typeof ENTRY_POLICIES} */ (entryName)];
    const visited = new Set();
    const pending = [...roots];
    for (const root of roots) {
      if (!fileMap.has(root)) {
        errors.push(`${label}: ${entryName} entry graph is missing ${root}`);
      }
    }

    while (pending.length > 0) {
      const current = pending.pop();
      if (current === undefined || visited.has(current)) continue;
      visited.add(current);
      const content = fileMap.get(current);
      if (content === undefined) continue;

      for (const specifier of moduleSpecifiers(current, content)) {
        if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
          if (
            specifier === FACADE_PACKAGE_NAME ||
            specifier.startsWith(`${FACADE_PACKAGE_NAME}/`)
          ) {
            const resolved = resolveFacadeSelfReference(
              current,
              specifier,
              fileMap,
            );
            if (resolved.length === 0) {
              errors.push(
                `${label}: ${entryName} entry cannot resolve facade self-reference ${specifier} from ${current}`,
              );
            } else {
              pending.push(...resolved);
            }
            continue;
          }
          const dependency = packageNameFromSpecifier(specifier);
          if (forbiddenPackages.includes(dependency)) {
            errors.push(
              `${label}: ${entryName} entry reaches forbidden ${dependency} through ${current}`,
            );
          }
          continue;
        }

        const resolved = resolveLocalModules(current, specifier, fileMap);
        if (resolved.length === 0) {
          errors.push(
            `${label}: ${entryName} entry cannot resolve ${specifier} from ${current}`,
          );
          continue;
        }
        pending.push(...resolved);
      }
    }
  }

  return [...new Set(errors)];
}
