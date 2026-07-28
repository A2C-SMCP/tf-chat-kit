import { readFile, readdir } from "node:fs/promises";
import { isBuiltin } from "node:module";
import path from "node:path";

import npa from "npm-package-arg";
import ts from "typescript";

/** @typedef {Record<string, string>} DependencyMap */
/**
 * @typedef {"dependencies" | "devDependencies" | "optionalDependencies" | "peerDependencies"} DependencySection
 */
/**
 * @typedef {{
 *   name?: string;
 *   version?: string;
 *   private?: boolean;
 *   license?: string;
 *   packageManager?: string;
 *   scripts?: Record<string, string>;
 *   files?: string[];
 *   sideEffects?: boolean | string[];
 *   exports?: Record<string, { types?: string; import?: string }>;
 *   publishConfig?: { access?: string; registry?: string };
 *   repository?: { type?: string; url?: string; directory?: string };
 *   homepage?: string;
 *   bugs?: { url?: string };
 *   dependencies?: DependencyMap;
 *   devDependencies?: DependencyMap;
 *   optionalDependencies?: DependencyMap;
 *   peerDependencies?: DependencyMap;
 *   pnpm?: { overrides?: DependencyMap };
 * }} PackageManifest
 */
/**
 * @typedef {{
 *   name: string;
 *   internalDependencies: readonly string[];
 *   allowedNodeBuiltins: readonly string[];
 *   peerDependencies: DependencyMap;
 *   allowedExternalDependencies: Partial<Record<DependencySection, readonly (string | RegExp)[]>>;
 * }} PackageRule
 */
/** @typedef {{ directory: string; manifest: PackageManifest }} WorkspacePackage */
/** @typedef {{ path: string; content: string }} SourceFile */
/**
 * @typedef {{
 *   rootManifest: PackageManifest;
 *   changesetConfig: Record<string, unknown>;
 *   packages: WorkspacePackage[];
 *   sourceFiles: SourceFile[];
 * }} WorkspaceSnapshot
 */
const heavyRendererDependencyPatterns = [
  /^monaco-editor$/u,
  /^@monaco-editor\//u,
  /^xterm$/u,
  /^@xterm\//u,
];

const PUBLIC_REGISTRY = "https://registry.npmjs.org/";
const REPOSITORY_URL = "git+https://github.com/A2C-SMCP/tf-chat-kit.git";
const HOMEPAGE_URL = "https://github.com/A2C-SMCP/tf-chat-kit#readme";
const BUGS_URL = "https://github.com/A2C-SMCP/tf-chat-kit/issues";

/** @type {Readonly<Record<string, PackageRule>>} */
export const PACKAGE_POLICY = Object.freeze({
  "chat-protocol": {
    name: "@turingfocus/chat-protocol",
    internalDependencies: [],
    allowedNodeBuiltins: [],
    peerDependencies: {},
    allowedExternalDependencies: {
      dependencies: ["zod"],
    },
  },
  "chat-runtime": {
    name: "@turingfocus/chat-runtime",
    internalDependencies: ["@turingfocus/chat-protocol"],
    allowedNodeBuiltins: [],
    peerDependencies: {},
    allowedExternalDependencies: {},
  },
  "chat-gateway-tfrobot": {
    name: "@turingfocus/chat-gateway-tfrobot",
    internalDependencies: ["@turingfocus/chat-protocol"],
    allowedNodeBuiltins: [],
    peerDependencies: {},
    allowedExternalDependencies: {
      dependencies: ["socket.io-client", "zod"],
    },
  },
  "chat-react": {
    name: "@turingfocus/chat-react",
    internalDependencies: ["@turingfocus/chat-runtime"],
    allowedNodeBuiltins: [],
    peerDependencies: { react: ">=18.2.0 <19.0.0" },
    allowedExternalDependencies: {
      peerDependencies: ["react"],
    },
  },
  "chat-ui-antd": {
    name: "@turingfocus/chat-ui-antd",
    internalDependencies: ["@turingfocus/chat-react"],
    allowedNodeBuiltins: [],
    peerDependencies: {
      antd: ">=5.23.4 <6.0.0",
      react: ">=18.2.0 <19.0.0",
    },
    allowedExternalDependencies: {
      dependencies: heavyRendererDependencyPatterns,
      peerDependencies: ["antd", "react"],
    },
  },
  "chat-testing": {
    name: "@turingfocus/chat-testing",
    internalDependencies: ["@turingfocus/chat-protocol"],
    allowedNodeBuiltins: [],
    peerDependencies: {},
    allowedExternalDependencies: {},
  },
});

const CHANGESET_CONFIG_POLICY = Object.freeze({
  $schema: "https://unpkg.com/@changesets/config@3.1.4/schema.json",
  changelog: "@changesets/cli/changelog",
  commit: false,
  fixed: [Object.values(PACKAGE_POLICY).map(({ name }) => name)],
  linked: [],
  access: "public",
  baseBranch: "main",
  updateInternalDependencies: "patch",
  bumpVersionsWithWorkspaceProtocolOnly: true,
  ignore: [],
});

const ROOT_SCRIPT_POLICY = Object.freeze({
  build: "tsc -b --pretty false",
  check:
    "pnpm run check:workspace && pnpm run check:changesets && pnpm run check:boundaries && pnpm run lint && pnpm run format:check && pnpm run typecheck && pnpm run test && pnpm run pack:check",
  "check:boundaries":
    "depcruise packages --config dependency-cruiser.config.mjs",
  "check:changesets": "node scripts/check-changesets.mjs",
  "check:workspace": "node scripts/check-workspace.mjs",
  clean: "node scripts/clean-workspace.mjs",
  format:
    'prettier --write "package.json" "pnpm-workspace.yaml" "tsconfig*.json" "eslint.config.mjs" "dependency-cruiser.config.mjs" "vitest.config.ts" "packages/**/*.{json,ts,tsx}" "scripts/**/*.mjs" "tests/**/*.ts" "fixtures/**/*.json" ".changeset/**/*.{json,md}" "README.md" "docs/project-charter.md" "docs/engineering-baseline.md" "docs/epics/001-chat-kit-v1-and-tfrobotfront-migration.md" "docs/adr/{README,007-versioning-and-release,008-github-and-public-npm-release}.md" "docs/baselines/**/*.md" ".github/workflows/*.yml"',
  "format:check":
    'prettier --check "package.json" "pnpm-workspace.yaml" "tsconfig*.json" "eslint.config.mjs" "dependency-cruiser.config.mjs" "vitest.config.ts" "packages/**/*.{json,ts,tsx}" "scripts/**/*.mjs" "tests/**/*.ts" "fixtures/**/*.json" ".changeset/**/*.{json,md}" "README.md" "docs/project-charter.md" "docs/engineering-baseline.md" "docs/epics/001-chat-kit-v1-and-tfrobotfront-migration.md" "docs/adr/{README,007-versioning-and-release,008-github-and-public-npm-release}.md" "docs/baselines/**/*.md" ".github/workflows/*.yml"',
  lint: "eslint . --max-warnings=0",
  "pack:check": "node scripts/verify-packed-artifacts.mjs",
  "pack:workspace": "node scripts/pack-workspace.mjs",
  test: "vitest run",
  typecheck:
    "tsc -b --pretty false && tsc -p tsconfig.tests.json --pretty false",
  changeset: "changeset",
  "changeset:status": "changeset status",
  "version-packages": "changeset version",
});

/** @type {readonly DependencySection[]} */
const dependencySections = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];

/** @type {readonly DependencySection[]} */
const runtimeDependencySections = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
];

const zeroMajorSemver =
  /^0\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
/** @param {string} version */
export const isZeroMajorVersion = (version) => zeroMajorSemver.test(version);

/**
 * @param {PackageManifest} manifest
 * @param {DependencySection} section
 * @returns {DependencyMap}
 */
const getDependencies = (manifest, section) => manifest[section] ?? {};

/** @param {Iterable<string>} values */
const sorted = (values) =>
  [...values].sort((left, right) => left.localeCompare(right));

/**
 * @param {DependencyMap} actual
 * @param {DependencyMap} expected
 */
const sameEntries = (actual, expected) =>
  JSON.stringify(Object.fromEntries(Object.entries(actual).sort())) ===
  JSON.stringify(Object.fromEntries(Object.entries(expected).sort()));

/** @param {Record<string, unknown>} value */
const stableObjectJson = (value) =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(value).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
  );

/**
 * @param {string} dependency
 * @param {string} specifier
 * @param {boolean} allowInternalWorkspaceDependencies
 * @returns {boolean}
 */
const usesForbiddenSourceDependency = (
  dependency,
  specifier,
  allowInternalWorkspaceDependencies,
) => {
  if (specifier.startsWith("workspace:")) {
    return !(
      allowInternalWorkspaceDependencies &&
      dependency.startsWith("@turingfocus/")
    );
  }

  try {
    const parsed = npa.resolve(dependency, specifier);
    if (parsed.type === "alias") {
      return !(
        parsed.subSpec.registry &&
        (parsed.subSpec.type === "version" || parsed.subSpec.type === "range")
      );
    }
    return !(
      parsed.registry &&
      (parsed.type === "version" || parsed.type === "range")
    );
  } catch {
    return true;
  }
};

/**
 * @param {string} dependency
 * @param {readonly (string | RegExp)[]} rules
 * @returns {boolean}
 */
const matchesDependencyRule = (dependency, rules) =>
  rules.some((rule) =>
    typeof rule === "string" ? dependency === rule : rule.test(dependency),
  );

/**
 * @param {PackageRule} policy
 * @param {string} dependency
 * @returns {DependencySection[]}
 */
const allowedDependencySections = (policy, dependency) =>
  dependencySections.filter((section) =>
    matchesDependencyRule(
      dependency,
      policy.allowedExternalDependencies[section] ?? [],
    ),
  );

/** @param {string} specifier */
const packageNameFromSpecifier = (specifier) => {
  const parts = specifier.split("/");
  return specifier.startsWith("@")
    ? parts.slice(0, 2).join("/")
    : (parts[0] ?? specifier);
};

/** @param {import("typescript").ImportDeclaration} declaration */
const importDeclarationIsTypeOnly = (declaration) => {
  const clause = declaration.importClause;
  if (!clause) return false;
  if (clause.isTypeOnly) return true;
  return (
    clause.name === undefined &&
    clause.namedBindings !== undefined &&
    ts.isNamedImports(clause.namedBindings) &&
    clause.namedBindings.elements.length > 0 &&
    clause.namedBindings.elements.every((element) => element.isTypeOnly)
  );
};

/** @param {import("typescript").ExportDeclaration} declaration */
const exportDeclarationIsTypeOnly = (declaration) =>
  declaration.isTypeOnly ||
  (declaration.exportClause !== undefined &&
    ts.isNamedExports(declaration.exportClause) &&
    declaration.exportClause.elements.length > 0 &&
    declaration.exportClause.elements.every((element) => element.isTypeOnly));

/**
 * @typedef {{ specifier?: string | undefined; kind?: "runtime" | "type"; loader?: string; error?: string }} SourceImport
 */

/**
 * @param {import("typescript").Expression | undefined} expression
 * @returns {string | undefined}
 */
const staticStringValue = (expression) => {
  if (expression === undefined) return undefined;
  if (ts.isStringLiteralLike(expression)) return expression.text;
  if (ts.isParenthesizedExpression(expression))
    return staticStringValue(expression.expression);
  if (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = staticStringValue(expression.left);
    const right = staticStringValue(expression.right);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  return undefined;
};

/** @param {import("typescript").PropertyName | undefined} name */
const staticPropertyName = (name) => {
  if (name === undefined) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
  if (ts.isComputedPropertyName(name))
    return staticStringValue(name.expression);
  return undefined;
};

/** @param {import("typescript").PropertyAccessExpression | import("typescript").ElementAccessExpression} expression */
const accessedPropertyName = (expression) =>
  ts.isPropertyAccessExpression(expression)
    ? expression.name.text
    : staticStringValue(expression.argumentExpression);

/** @param {string} specifier */
const normalizedBuiltinSpecifier = (specifier) =>
  specifier.replace(/^node:/u, "");

/** @param {string} specifier */
const isNodeBuiltinSpecifier = (specifier) => isBuiltin(specifier);

/** @param {string} specifier @param {string} name */
const isBuiltinCapability = (specifier, name) =>
  normalizedBuiltinSpecifier(specifier) === name;

/**
 * The checker resolves identifiers to their lexical declarations, including
 * hoisted and nested bindings. Only declarations that produce a JavaScript
 * value may shadow a Node/CommonJS or JavaScript global; ambient and type-only
 * declarations disappear during emit and therefore cannot establish a runtime
 * boundary.
 *
 * @param {import("typescript").TypeChecker} checker
 * @param {import("typescript").SourceFile} parsed
 * @param {import("typescript").Identifier} identifier
 */
const isLocallyDeclared = (checker, parsed, identifier) =>
  (ts.isShorthandPropertyAssignment(identifier.parent)
    ? checker.getShorthandAssignmentValueSymbol(identifier.parent)
    : checker.getSymbolAtLocation(identifier)
  )?.declarations?.some(
    (declaration) =>
      declaration.getSourceFile() === parsed &&
      declarationCreatesRuntimeBinding(declaration),
  ) === true;

/** @param {import("typescript").Node} node */
const hasDeclareModifier = (node) =>
  ts.canHaveModifiers(node) &&
  ts
    .getModifiers(node)
    ?.some(({ kind }) => kind === ts.SyntaxKind.DeclareKeyword) === true;

/** @param {import("typescript").Declaration} declaration */
const declarationIsAmbient = (declaration) => {
  if (declaration.getSourceFile().isDeclarationFile) return true;
  let current = /** @type {import("typescript").Node | undefined} */ (
    declaration
  );
  while (current !== undefined && !ts.isSourceFile(current)) {
    if (hasDeclareModifier(current)) return true;
    current = current.parent;
  }
  return false;
};

/** @param {import("typescript").Declaration} declaration */
const declarationCreatesRuntimeBinding = (declaration) => {
  if (declarationIsAmbient(declaration)) return false;
  if (
    ts.isInterfaceDeclaration(declaration) ||
    ts.isTypeAliasDeclaration(declaration) ||
    ts.isTypeParameterDeclaration(declaration) ||
    ts.isPropertySignature(declaration) ||
    ts.isMethodSignature(declaration)
  ) {
    return false;
  }
  if (ts.isImportClause(declaration)) return !declaration.isTypeOnly;
  if (ts.isImportSpecifier(declaration)) {
    const importClause = declaration.parent.parent;
    return !declaration.isTypeOnly && !importClause.isTypeOnly;
  }
  if (ts.isNamespaceImport(declaration)) {
    return !declaration.parent.isTypeOnly;
  }
  if (ts.isImportEqualsDeclaration(declaration)) {
    return !declaration.isTypeOnly;
  }
  if (ts.isFunctionDeclaration(declaration)) {
    return declaration.body !== undefined;
  }
  return true;
};

/**
 * @param {import("typescript").Identifier} identifier
 * @param {import("typescript").TypeChecker} checker
 * @param {import("typescript").SourceFile} parsed
 */
const isUnshadowedGlobal = (identifier, checker, parsed) =>
  !isLocallyDeclared(checker, parsed, identifier);

const nodeGlobalBuiltinByName = new Map([
  ["Buffer", "node:buffer"],
  ["__dirname", "node:module"],
  ["__filename", "node:module"],
  ["clearImmediate", "node:timers"],
  ["process", "node:process"],
  ["setImmediate", "node:timers"],
]);

/** @param {import("typescript").Expression} expression */
const unwrapParentheses = (expression) => {
  let current = expression;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
};

/**
 * @typedef {{
 *   moduleObjects: Set<import("typescript").Symbol>;
 *   processObjects: Set<import("typescript").Symbol>;
 *   moduleRequireFunctions: Set<import("typescript").Symbol>;
 *   getBuiltinModuleFunctions: Set<import("typescript").Symbol>;
 *   acquisitions: string[];
 * }} CapabilityProvenance
 */

/**
 * @param {import("typescript").Identifier} identifier
 * @param {import("typescript").TypeChecker} checker
 */
const identifierSymbol = (identifier, checker) =>
  checker.getSymbolAtLocation(identifier);

/**
 * @param {import("typescript").Identifier} identifier
 * @param {Set<import("typescript").Symbol>} symbols
 * @param {import("typescript").TypeChecker} checker
 */
const identifierSymbolIsIn = (identifier, symbols, checker) => {
  const symbol = identifierSymbol(identifier, checker);
  return symbol !== undefined && symbols.has(symbol);
};

/**
 * Only direct, unshadowed roots participate in provenance. Aliases are
 * deliberately collected in a separate pass and are never used as roots for
 * another alias, keeping propagation to one auditable hop.
 *
 * @param {import("typescript").Expression} expression
 * @param {import("typescript").TypeChecker} checker
 * @param {import("typescript").SourceFile} parsed
 * @returns {"global" | "module" | "process" | undefined}
 */
const directGlobalCapability = (expression, checker, parsed) => {
  const unwrapped = unwrapParentheses(expression);
  if (ts.isIdentifier(unwrapped)) {
    if (
      (unwrapped.text === "global" || unwrapped.text === "globalThis") &&
      isUnshadowedGlobal(unwrapped, checker, parsed)
    )
      return "global";
    if (
      (unwrapped.text === "module" || unwrapped.text === "process") &&
      isUnshadowedGlobal(unwrapped, checker, parsed)
    )
      return unwrapped.text;
    return undefined;
  }

  if (
    (ts.isPropertyAccessExpression(unwrapped) ||
      ts.isElementAccessExpression(unwrapped)) &&
    accessedPropertyName(unwrapped) === "process" &&
    directGlobalCapability(unwrapped.expression, checker, parsed) === "global"
  ) {
    return "process";
  }
  return undefined;
};

/**
 * @param {import("typescript").SourceFile} parsed
 * @param {import("typescript").TypeChecker} checker
 * @returns {CapabilityProvenance}
 */
const collectCapabilityProvenance = (parsed, checker) => {
  /** @type {CapabilityProvenance} */
  const provenance = {
    moduleObjects: new Set(),
    processObjects: new Set(),
    moduleRequireFunctions: new Set(),
    getBuiltinModuleFunctions: new Set(),
    acquisitions: [],
  };

  /**
   * @param {import("typescript").Identifier} name
   * @param {Set<import("typescript").Symbol>} target
   * @param {string} acquisition
   */
  const recordBinding = (name, target, acquisition) => {
    const symbol = identifierSymbol(name, checker);
    if (symbol === undefined) return;
    target.add(symbol);
    provenance.acquisitions.push(acquisition);
  };

  /**
   * Assignment defaults are represented as `target = fallback` inside the
   * destructuring target. Strip defaults and parentheses before deciding
   * whether the target is an identifier or another object pattern.
   *
   * @param {import("typescript").Expression} expression
   * @returns {import("typescript").Expression}
   */
  const assignmentTarget = (expression) => {
    const target = unwrapParentheses(expression);
    if (
      ts.isBinaryExpression(target) &&
      target.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      return assignmentTarget(target.left);
    }
    return target;
  };

  /**
   * @param {import("typescript").Identifier} name
   * @param {"global" | "module" | "process" | undefined} source
   */
  const recordSimpleAlias = (name, source) => {
    if (source === "global") {
      provenance.acquisitions.push(
        "acquiring an alias to the unshadowed global loading capability is prohibited by workspace policy",
      );
    } else if (source === "module") {
      recordBinding(
        name,
        provenance.moduleObjects,
        "acquiring an alias to the unshadowed module loading capability is prohibited by workspace policy",
      );
    } else if (source === "process") {
      recordBinding(
        name,
        provenance.processObjects,
        "acquiring an alias to the unshadowed process loading capability is prohibited by workspace policy",
      );
    }
  };

  /**
   * @param {import("typescript").Identifier} name
   * @param {string | undefined} property
   * @param {"global" | "module" | "process" | undefined} source
   */
  const recordDestructuredAlias = (name, property, source) => {
    if (source === "global" && property === "process") {
      recordBinding(
        name,
        provenance.processObjects,
        "acquiring an alias to globalThis.process loading capability is prohibited by workspace policy",
      );
    } else if (source === "module" && property === "require") {
      recordBinding(
        name,
        provenance.moduleRequireFunctions,
        "acquiring the unshadowed module.require loading capability is prohibited by workspace policy",
      );
    } else if (source === "process" && property === "getBuiltinModule") {
      recordBinding(
        name,
        provenance.getBuiltinModuleFunctions,
        "acquiring the unshadowed process.getBuiltinModule loading capability is prohibited by workspace policy",
      );
    }
  };

  /**
   * Nested patterns stay within the same direct-root acquisition. Only object
   * properties that are themselves confirmed capability objects may carry
   * provenance into the next pattern level.
   *
   * @param {string | undefined} property
   * @param {"global" | "module" | "process" | undefined} source
   * @returns {"global" | "module" | "process" | undefined}
   */
  const nestedDestructuringSource = (property, source) =>
    source === "global" && property === "process" ? "process" : undefined;

  /**
   * @param {import("typescript").PropertyName | undefined} propertyName
   * @param {"global" | "module" | "process" | undefined} source
   * @returns {string | undefined}
   */
  const destructuredProperty = (propertyName, source) => {
    const property = staticPropertyName(propertyName);
    if (
      source !== undefined &&
      propertyName !== undefined &&
      ts.isComputedPropertyName(propertyName) &&
      property === undefined
    ) {
      provenance.acquisitions.push(
        `destructuring a computed property from the unshadowed ${source} capability requires a statically analyzable property name`,
      );
    }
    return property;
  };

  /**
   * Declaration binding patterns and assignment patterns have different AST
   * shapes. Recursion follows only statically known capability-object properties
   * inside the same pattern; aliases are not reused as roots, so propagation
   * remains limited to one auditable acquisition path.
   *
   * @param {import("typescript").ObjectBindingPattern | import("typescript").ObjectLiteralExpression} pattern
   * @param {"global" | "module" | "process" | undefined} source
   */
  const recordObjectPattern = (pattern, source) => {
    if (ts.isObjectBindingPattern(pattern)) {
      for (const element of pattern.elements) {
        if (element.dotDotDotToken !== undefined) {
          if (ts.isIdentifier(element.name)) {
            recordSimpleAlias(element.name, source);
          }
          continue;
        }
        const propertyName =
          element.propertyName ??
          (ts.isIdentifier(element.name) ? element.name : undefined);
        const property = destructuredProperty(propertyName, source);
        if (ts.isIdentifier(element.name)) {
          recordDestructuredAlias(element.name, property, source);
        } else if (ts.isObjectBindingPattern(element.name)) {
          recordObjectPattern(
            element.name,
            nestedDestructuringSource(property, source),
          );
        }
      }
      return;
    }

    for (const propertyAssignment of pattern.properties) {
      if (ts.isSpreadAssignment(propertyAssignment)) {
        const target = assignmentTarget(propertyAssignment.expression);
        if (ts.isIdentifier(target)) {
          recordSimpleAlias(target, source);
        }
      } else if (ts.isShorthandPropertyAssignment(propertyAssignment)) {
        recordDestructuredAlias(
          propertyAssignment.name,
          propertyAssignment.name.text,
          source,
        );
      } else if (ts.isPropertyAssignment(propertyAssignment)) {
        const property = destructuredProperty(propertyAssignment.name, source);
        const target = assignmentTarget(propertyAssignment.initializer);
        if (ts.isIdentifier(target)) {
          recordDestructuredAlias(target, property, source);
        } else if (ts.isObjectLiteralExpression(target)) {
          recordObjectPattern(
            target,
            nestedDestructuringSource(property, source),
          );
        }
      }
    }
  };

  /** @param {import("typescript").Node} node */
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
      const source = directGlobalCapability(node.initializer, checker, parsed);
      if (ts.isIdentifier(node.name)) {
        recordSimpleAlias(node.name, source);
      } else if (ts.isObjectBindingPattern(node.name)) {
        recordObjectPattern(node.name, source);
      }
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      const source = directGlobalCapability(node.right, checker, parsed);
      const target = unwrapParentheses(node.left);
      if (ts.isIdentifier(target)) {
        recordSimpleAlias(target, source);
      } else if (ts.isObjectLiteralExpression(target)) {
        recordObjectPattern(target, source);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return provenance;
};

/**
 * @param {import("typescript").Expression} expression
 * @param {"module" | "process"} capability
 * @param {CapabilityProvenance} provenance
 * @param {import("typescript").TypeChecker} checker
 * @param {import("typescript").SourceFile} parsed
 */
const expressionHasCapability = (
  expression,
  capability,
  provenance,
  checker,
  parsed,
) => {
  const unwrapped = unwrapParentheses(expression);
  if (directGlobalCapability(unwrapped, checker, parsed) === capability)
    return true;
  if (!ts.isIdentifier(unwrapped)) return false;
  const symbol = identifierSymbol(unwrapped, checker);
  return (
    symbol !== undefined &&
    (capability === "module"
      ? provenance.moduleObjects.has(symbol)
      : provenance.processObjects.has(symbol))
  );
};

/**
 * Once an expression is known to be the native module or process object, an
 * element access with a runtime-selected property can expose any loading
 * capability on that object. Keep this decision independent of how the result
 * is consumed (called immediately, assigned, or passed elsewhere), so every
 * access path has the same fail-closed boundary.
 *
 * @param {import("typescript").Node} node
 * @param {CapabilityProvenance} provenance
 * @param {import("typescript").TypeChecker} checker
 * @param {import("typescript").SourceFile} parsed
 * @returns {"module" | "process" | undefined}
 */
const nonStaticPropertyCapability = (node, provenance, checker, parsed) => {
  if (
    !ts.isElementAccessExpression(node) ||
    accessedPropertyName(node) !== undefined
  )
    return undefined;

  if (
    expressionHasCapability(
      node.expression,
      "module",
      provenance,
      checker,
      parsed,
    )
  )
    return "module";
  if (
    expressionHasCapability(
      node.expression,
      "process",
      provenance,
      checker,
      parsed,
    )
  )
    return "process";
  return undefined;
};

/**
 * @param {import("typescript").Expression} expression
 * @param {import("typescript").TypeChecker} checker
 * @param {import("typescript").SourceFile} parsed
 * @param {CapabilityProvenance} provenance
 * @returns {"require" | "require.resolve" | "module.require" | undefined}
 */
const commonJsLoader = (expression, checker, parsed, provenance) => {
  const unwrapped = unwrapParentheses(expression);
  if (
    ts.isIdentifier(unwrapped) &&
    unwrapped.text === "require" &&
    isUnshadowedGlobal(unwrapped, checker, parsed)
  )
    return "require";
  if (
    ts.isIdentifier(unwrapped) &&
    identifierSymbolIsIn(unwrapped, provenance.moduleRequireFunctions, checker)
  )
    return "module.require";

  if (
    !ts.isPropertyAccessExpression(unwrapped) &&
    !ts.isElementAccessExpression(unwrapped)
  )
    return undefined;

  const owner = unwrapped.expression;
  const property = accessedPropertyName(unwrapped);
  if (
    ts.isIdentifier(owner) &&
    owner.text === "require" &&
    isUnshadowedGlobal(owner, checker, parsed) &&
    property === "resolve"
  )
    return "require.resolve";
  if (
    expressionHasCapability(owner, "module", provenance, checker, parsed) &&
    property === "require"
  )
    return "module.require";

  return undefined;
};

const dangerousModuleExports = new Set([
  "Module",
  "_load",
  "createRequire",
  "default",
]);
const dangerousProcessExports = new Set(["default", "getBuiltinModule"]);

/** @param {import("typescript").ImportDeclaration} declaration */
const importDeclarationHasRuntimeBindings = (declaration) => {
  const clause = declaration.importClause;
  if (clause === undefined || clause.isTypeOnly) return false;
  if (clause.name !== undefined) return true;
  const bindings = clause.namedBindings;
  return (
    bindings !== undefined &&
    (ts.isNamespaceImport(bindings) ||
      bindings.elements.some((element) => !element.isTypeOnly))
  );
};

/** @param {import("typescript").ExportDeclaration} declaration */
const exportDeclarationHasRuntimeBindings = (declaration) => {
  if (declaration.isTypeOnly) return false;
  if (declaration.exportClause === undefined) return true;
  if (!ts.isNamedExports(declaration.exportClause)) return true;
  return declaration.exportClause.elements.some(
    (element) => !element.isTypeOnly,
  );
};

/** @param {import("typescript").Identifier} identifier */
const identifierIsPropertyName = (identifier) => {
  const parent = identifier.parent;
  return (
    (ts.isPropertyAccessExpression(parent) && parent.name === identifier) ||
    ((ts.isPropertyAssignment(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isMethodSignature(parent)) &&
      parent.name === identifier)
  );
};

/** @param {import("typescript").ExpressionWithTypeArguments} expression */
const expressionWithTypeArgumentsIsRuntimeValue = (expression) => {
  const heritage = expression.parent;
  if (!ts.isHeritageClause(heritage)) return true;
  const declaration = heritage.parent;
  return (
    heritage.token === ts.SyntaxKind.ExtendsKeyword &&
    (ts.isClassDeclaration(declaration) || ts.isClassExpression(declaration))
  );
};

/** @param {import("typescript").Expression} expression */
const expressionIsWithinTypeOnlyHeritage = (expression) => {
  let current = expression;
  while (ts.isExpression(current.parent)) current = current.parent;
  if (ts.isExpressionWithTypeArguments(current)) {
    return !expressionWithTypeArgumentsIsRuntimeValue(current);
  }
  return (
    ts.isExpressionWithTypeArguments(current.parent) &&
    current.parent.expression === current &&
    !expressionWithTypeArgumentsIsRuntimeValue(current.parent)
  );
};

/**
 * TypeScript's expression-context predicate is a positive syntactic test. The
 * shorthand-property case is the one value read represented as a declaration
 * name, so it is included explicitly. Ordinary property names remain metadata
 * rather than reads (`object.Function` reads `object`, not a global Function).
 *
 * @param {import("typescript").Identifier} identifier
 */
const identifierIsValueReference = (identifier) => {
  if (identifierIsPropertyName(identifier)) return false;
  if (expressionIsWithinTypeOnlyHeritage(identifier)) return false;
  const parent = identifier.parent;

  if (ts.isShorthandPropertyAssignment(parent)) {
    return (
      parent.name === identifier ||
      parent.objectAssignmentInitializer === identifier
    );
  }
  if (
    ts.isVariableDeclaration(parent) ||
    ts.isParameter(parent) ||
    ts.isPropertyDeclaration(parent) ||
    ts.isEnumMember(parent) ||
    ts.isPropertyAssignment(parent) ||
    ts.isBindingElement(parent)
  ) {
    return parent.initializer === identifier;
  }
  if (
    ts.isExpressionStatement(parent) ||
    ts.isIfStatement(parent) ||
    ts.isDoStatement(parent) ||
    ts.isWhileStatement(parent) ||
    ts.isReturnStatement(parent) ||
    ts.isWithStatement(parent) ||
    ts.isSwitchStatement(parent) ||
    ts.isCaseClause(parent) ||
    ts.isThrowStatement(parent) ||
    ts.isExportAssignment(parent)
  ) {
    return parent.expression === identifier;
  }
  if (ts.isForStatement(parent)) {
    return (
      parent.initializer === identifier ||
      parent.condition === identifier ||
      parent.incrementor === identifier
    );
  }
  if (ts.isForInStatement(parent) || ts.isForOfStatement(parent)) {
    return (
      parent.initializer === identifier || parent.expression === identifier
    );
  }
  if (
    ts.isTypeAssertionExpression(parent) ||
    ts.isAsExpression(parent) ||
    ts.isSatisfiesExpression(parent) ||
    ts.isTemplateSpan(parent) ||
    ts.isComputedPropertyName(parent) ||
    ts.isDecorator(parent) ||
    ts.isJsxExpression(parent) ||
    ts.isJsxSpreadAttribute(parent) ||
    ts.isSpreadAssignment(parent)
  ) {
    return parent.expression === identifier;
  }
  if (
    ts.isJsxOpeningElement(parent) ||
    ts.isJsxSelfClosingElement(parent) ||
    ts.isJsxClosingElement(parent)
  ) {
    return parent.tagName === identifier;
  }

  return ts.isExpression(parent);
};

/** @param {import("typescript").Expression} expression */
const expressionIsDirectCallTarget = (expression) =>
  ts.isCallExpression(expression.parent) &&
  expression.parent.expression === expression;

/**
 * @param {import("typescript").Expression} expression
 * @param {readonly string[]} names
 * @param {import("typescript").TypeChecker} checker
 * @param {import("typescript").SourceFile} parsed
 */
const isUnshadowedGlobalObject = (expression, names, checker, parsed) =>
  ts.isIdentifier(expression) &&
  names.includes(expression.text) &&
  isUnshadowedGlobal(expression, checker, parsed);

/**
 * Parse actual module syntax instead of scanning comments and arbitrary string
 * literals. A mixed import/export is runtime because at least one binding is
 * preserved in emitted JavaScript.
 *
 * @param {SourceFile} sourceFile
 * @returns {SourceImport[]}
 */
const collectSourceImports = (sourceFile) => {
  const compilerOptions = {
    module: ts.ModuleKind.ESNext,
    moduleDetection: ts.ModuleDetectionKind.Force,
    noLib: true,
    noResolve: true,
    target: ts.ScriptTarget.Latest,
    types: [],
  };
  const compilerHost = ts.createCompilerHost(compilerOptions);
  const defaultGetSourceFile = compilerHost.getSourceFile.bind(compilerHost);
  compilerHost.getSourceFile = (fileName, languageVersion, ...rest) =>
    fileName === sourceFile.path
      ? ts.createSourceFile(fileName, sourceFile.content, languageVersion, true)
      : defaultGetSourceFile(fileName, languageVersion, ...rest);
  const program = ts.createProgram(
    [sourceFile.path],
    compilerOptions,
    compilerHost,
  );
  const parsed = program.getSourceFile(sourceFile.path);
  if (parsed === undefined) {
    return [{ error: "source file could not be parsed for policy validation" }];
  }
  const checker = program.getTypeChecker();
  const provenance = collectCapabilityProvenance(parsed, checker);
  /** @type {SourceImport[]} */
  const imports = [];

  /** @param {string} error */
  const recordViolation = (error) => imports.push({ error });

  for (const acquisition of provenance.acquisitions) {
    recordViolation(acquisition);
  }

  /** @param {import("typescript").Node} node */
  const visit = (node) => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      const specifier = node.moduleSpecifier.text;
      const isTypeOnly = importDeclarationIsTypeOnly(node);
      if (isBuiltinCapability(specifier, "module") && !isTypeOnly) {
        const bindings = node.importClause?.namedBindings;
        if (
          node.importClause?.name !== undefined ||
          (bindings !== undefined && ts.isNamespaceImport(bindings))
        ) {
          recordViolation(
            "default and namespace imports from node:module are prohibited because they expose createRequire",
          );
        } else if (
          bindings !== undefined &&
          ts.isNamedImports(bindings) &&
          bindings.elements.some(
            (element) =>
              !element.isTypeOnly &&
              dangerousModuleExports.has(
                staticPropertyName(element.propertyName ?? element.name) ?? "",
              ),
          )
        ) {
          recordViolation(
            "loading capabilities from node:module are prohibited by workspace policy",
          );
        }
      } else if (isBuiltinCapability(specifier, "process") && !isTypeOnly) {
        const bindings = node.importClause?.namedBindings;
        if (
          node.importClause?.name !== undefined ||
          (bindings !== undefined && ts.isNamespaceImport(bindings))
        ) {
          recordViolation(
            "default and namespace imports from node:process are prohibited because they expose getBuiltinModule",
          );
        } else if (
          bindings !== undefined &&
          ts.isNamedImports(bindings) &&
          bindings.elements.some(
            (element) =>
              !element.isTypeOnly &&
              dangerousProcessExports.has(
                staticPropertyName(element.propertyName ?? element.name) ?? "",
              ),
          )
        ) {
          recordViolation(
            "getBuiltinModule imports from node:process are prohibited by workspace policy",
          );
        }
      } else if (
        isBuiltinCapability(specifier, "vm") &&
        importDeclarationHasRuntimeBindings(node)
      ) {
        recordViolation(
          "runtime bindings from node:vm are prohibited because they expose dynamic code evaluation",
        );
      }
      imports.push({
        specifier,
        kind: isTypeOnly ? "type" : "runtime",
      });
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      const specifier = node.moduleSpecifier.text;
      const isTypeOnly = exportDeclarationIsTypeOnly(node);
      if (
        isBuiltinCapability(specifier, "module") &&
        !isTypeOnly &&
        (node.exportClause === undefined ||
          !ts.isNamedExports(node.exportClause) ||
          node.exportClause.elements.some(
            (element) =>
              !element.isTypeOnly &&
              dangerousModuleExports.has(
                staticPropertyName(element.propertyName ?? element.name) ?? "",
              ),
          ))
      ) {
        recordViolation(
          "re-exporting node:module loading capabilities is prohibited by workspace policy",
        );
      } else if (
        isBuiltinCapability(specifier, "process") &&
        !isTypeOnly &&
        (node.exportClause === undefined ||
          !ts.isNamedExports(node.exportClause) ||
          node.exportClause.elements.some(
            (element) =>
              !element.isTypeOnly &&
              dangerousProcessExports.has(
                staticPropertyName(element.propertyName ?? element.name) ?? "",
              ),
          ))
      ) {
        recordViolation(
          "re-exporting node:process getBuiltinModule capabilities is prohibited by workspace policy",
        );
      } else if (
        isBuiltinCapability(specifier, "vm") &&
        exportDeclarationHasRuntimeBindings(node)
      ) {
        recordViolation(
          "re-exporting node:vm runtime capabilities is prohibited by workspace policy",
        );
      }
      imports.push({
        specifier,
        kind: isTypeOnly ? "type" : "runtime",
      });
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression !== undefined &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      const specifier = node.moduleReference.expression.text;
      if (
        !node.isTypeOnly &&
        (isBuiltinCapability(specifier, "module") ||
          isBuiltinCapability(specifier, "process") ||
          isBuiltinCapability(specifier, "vm"))
      ) {
        recordViolation(
          `namespace imports from ${specifier} are prohibited because they expose loading or dynamic-code capabilities`,
        );
      }
      imports.push({
        specifier,
        kind: node.isTypeOnly ? "type" : "runtime",
      });
    } else if (ts.isImportTypeNode(node)) {
      const argument = node.argument;
      if (
        ts.isLiteralTypeNode(argument) &&
        ts.isStringLiteralLike(argument.literal)
      ) {
        imports.push({ specifier: argument.literal.text, kind: "type" });
      }
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      const [argument] = node.arguments;
      const specifier =
        argument !== undefined && ts.isStringLiteralLike(argument)
          ? argument.text
          : undefined;
      if (
        specifier !== undefined &&
        (isBuiltinCapability(specifier, "module") ||
          isBuiltinCapability(specifier, "process") ||
          isBuiltinCapability(specifier, "vm"))
      ) {
        recordViolation(
          `dynamic imports of ${specifier} are prohibited because they expose loading or dynamic-code capabilities`,
        );
      }
      imports.push({
        specifier,
        kind: "runtime",
        loader: "dynamic import",
      });
    } else if (ts.isCallExpression(node)) {
      const loader = commonJsLoader(
        node.expression,
        checker,
        parsed,
        provenance,
      );
      if (loader !== undefined) {
        const [argument] = node.arguments;
        const specifier =
          argument !== undefined && ts.isStringLiteralLike(argument)
            ? argument.text
            : undefined;
        if (
          specifier !== undefined &&
          loader !== "require.resolve" &&
          (isBuiltinCapability(specifier, "module") ||
            isBuiltinCapability(specifier, "process") ||
            isBuiltinCapability(specifier, "vm"))
        ) {
          recordViolation(
            `${loader} of ${specifier} is prohibited because it exposes loading or dynamic-code capabilities`,
          );
        }
        imports.push({ specifier, kind: "runtime", loader });
      }

      const callTarget = unwrapParentheses(node.expression);
      const callsGetBuiltinModule =
        ((ts.isPropertyAccessExpression(callTarget) ||
          ts.isElementAccessExpression(callTarget)) &&
          accessedPropertyName(callTarget) === "getBuiltinModule" &&
          expressionHasCapability(
            callTarget.expression,
            "process",
            provenance,
            checker,
            parsed,
          )) ||
        (ts.isIdentifier(callTarget) &&
          identifierSymbolIsIn(
            callTarget,
            provenance.getBuiltinModuleFunctions,
            checker,
          ));
      if (callsGetBuiltinModule) {
        const specifier = staticStringValue(node.arguments[0]);
        if (specifier === undefined) {
          recordViolation(
            "process.getBuiltinModule requires a statically analyzable specifier so loading and dynamic-code capabilities cannot be selected at runtime",
          );
        } else {
          imports.push({
            specifier,
            kind: "runtime",
            loader: "process.getBuiltinModule",
          });
          if (
            isBuiltinCapability(specifier, "module") ||
            isBuiltinCapability(specifier, "vm")
          ) {
            recordViolation(
              `process.getBuiltinModule(${JSON.stringify(specifier)}) is prohibited because it exposes loading or dynamic-code capabilities`,
            );
          }
        }
      }
    }

    if (
      ts.isIdentifier(node) &&
      identifierIsValueReference(node) &&
      isUnshadowedGlobal(node, checker, parsed)
    ) {
      const builtin = nodeGlobalBuiltinByName.get(node.text);
      if (builtin !== undefined) {
        imports.push({
          specifier: builtin,
          kind: "runtime",
          loader: `Node.js ${node.text} global`,
        });
      }
    } else if (
      (ts.isPropertyAccessExpression(node) ||
        ts.isElementAccessExpression(node)) &&
      directGlobalCapability(node.expression, checker, parsed) === "global" &&
      !expressionIsWithinTypeOnlyHeritage(node)
    ) {
      const property = accessedPropertyName(node);
      const builtin =
        property === undefined
          ? undefined
          : nodeGlobalBuiltinByName.get(property);
      if (builtin !== undefined) {
        imports.push({
          specifier: builtin,
          kind: "runtime",
          loader: `Node.js ${property} global`,
        });
      }
    }

    if (
      ts.isIdentifier(node) &&
      ["global", "globalThis", "module", "process"].includes(node.text) &&
      identifierIsValueReference(node) &&
      isUnshadowedGlobal(node, checker, parsed) &&
      !(
        (ts.isPropertyAccessExpression(node.parent) ||
          ts.isElementAccessExpression(node.parent)) &&
        node.parent.expression === node
      )
    ) {
      recordViolation(
        `passing or acquiring the unshadowed ${node.text} loading capability as a value is prohibited by workspace policy`,
      );
    }

    if (
      ts.isIdentifier(node) &&
      node.text === "require" &&
      identifierIsValueReference(node) &&
      isUnshadowedGlobal(node, checker, parsed) &&
      !expressionIsDirectCallTarget(node) &&
      !(
        (ts.isPropertyAccessExpression(node.parent) ||
          ts.isElementAccessExpression(node.parent)) &&
        node.parent.expression === node &&
        accessedPropertyName(node.parent) === "resolve" &&
        expressionIsDirectCallTarget(node.parent)
      )
    ) {
      recordViolation(
        "acquiring the unshadowed require loading capability is prohibited by workspace policy",
      );
    } else if (
      (ts.isPropertyAccessExpression(node) ||
        ts.isElementAccessExpression(node)) &&
      accessedPropertyName(node) === "require" &&
      expressionHasCapability(
        node.expression,
        "module",
        provenance,
        checker,
        parsed,
      ) &&
      !expressionIsDirectCallTarget(node)
    ) {
      recordViolation(
        "acquiring the unshadowed module.require loading capability is prohibited by workspace policy",
      );
    } else if (
      (ts.isPropertyAccessExpression(node) ||
        ts.isElementAccessExpression(node)) &&
      accessedPropertyName(node) === "getBuiltinModule" &&
      expressionHasCapability(
        node.expression,
        "process",
        provenance,
        checker,
        parsed,
      ) &&
      !expressionIsDirectCallTarget(node)
    ) {
      recordViolation(
        "acquiring the unshadowed process.getBuiltinModule loading capability is prohibited by workspace policy",
      );
    }

    const nonStaticOwner = nonStaticPropertyCapability(
      node,
      provenance,
      checker,
      parsed,
    );
    if (nonStaticOwner !== undefined) {
      recordViolation(
        `accessing a computed property on the confirmed ${nonStaticOwner} loading capability requires a statically analyzable property name`,
      );
    }

    if (
      ts.isIdentifier(node) &&
      (node.text === "eval" || node.text === "Function") &&
      identifierIsValueReference(node) &&
      isUnshadowedGlobal(node, checker, parsed)
    ) {
      recordViolation(
        `${node.text} dynamic code evaluation is prohibited by workspace policy; acquiring the capability is also forbidden`,
      );
    } else if (
      (ts.isPropertyAccessExpression(node) ||
        ts.isElementAccessExpression(node)) &&
      (accessedPropertyName(node) === "eval" ||
        accessedPropertyName(node) === "Function") &&
      isUnshadowedGlobalObject(
        node.expression,
        ["global", "globalThis"],
        checker,
        parsed,
      ) &&
      !expressionIsWithinTypeOnlyHeritage(node)
    ) {
      recordViolation(
        `${accessedPropertyName(node)} dynamic code evaluation is prohibited by workspace policy; acquiring the capability is also forbidden`,
      );
    }
    ts.forEachChild(node, visit);
  };

  visit(parsed);
  return imports;
};

/** @param {string} specifier */
const forbiddenHostImport = (specifier) => {
  if (/\/Users\/|TFRobotFront/u.test(specifier)) return "host/developer source";
  const dependency = packageNameFromSpecifier(specifier);
  if (dependency === "next") return "Next.js";
  if (dependency.startsWith("@tauri-apps/")) return "Tauri API";
  if (dependency === "@microsoft/office-js") return "Office API";
  return undefined;
};

/**
 * @param {string} sourceFilePath
 * @param {string} packageDirectory
 * @param {string} specifier
 * @returns {string | undefined}
 */
const validateLocalModuleSpecifier = (
  sourceFilePath,
  packageDirectory,
  specifier,
) => {
  if (specifier.startsWith("#")) {
    return "package import aliases are prohibited until their imports maps and package boundaries are explicitly governed";
  }
  if (specifier.startsWith("/")) {
    return "absolute source imports are prohibited by workspace policy";
  }
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
    return undefined;
  }

  const packageRoot = `packages/${packageDirectory}`;
  const resolvedPath = path.posix
    .resolve("/", path.posix.dirname(sourceFilePath), specifier)
    .slice(1);
  if (
    resolvedPath !== packageRoot &&
    !resolvedPath.startsWith(`${packageRoot}/`)
  ) {
    return `relative source import ${specifier} escapes ${packageRoot}; cross-workspace source imports are prohibited`;
  }
  return "";
};

/**
 * @param {SourceFile} sourceFile
 * @param {WorkspacePackage} entry
 * @param {PackageRule} policy
 * @param {string[]} errors
 */
const validateSourceImports = (sourceFile, entry, policy, errors) => {
  const label = entry.manifest.name ?? entry.directory;
  for (const sourceImport of collectSourceImports(sourceFile)) {
    if (sourceImport.error !== undefined) {
      errors.push(`${sourceFile.path}: ${sourceImport.error}`);
      continue;
    }
    if (sourceImport.specifier === undefined) {
      errors.push(
        `${sourceFile.path}: ${sourceImport.loader ?? "module loader"} module specifier must be a static string literal`,
      );
      continue;
    }

    const { specifier, kind } = sourceImport;
    const forbiddenDescription = forbiddenHostImport(specifier);
    if (forbiddenDescription) {
      errors.push(
        `${sourceFile.path}: contains forbidden ${forbiddenDescription} dependency`,
      );
      continue;
    }
    if (isNodeBuiltinSpecifier(specifier)) {
      const builtin = normalizedBuiltinSpecifier(specifier);
      if (!policy.allowedNodeBuiltins.includes(builtin)) {
        errors.push(
          `${sourceFile.path}: ${label} source ${kind} import ${specifier} uses a Node.js built-in that is not allowed by package policy`,
        );
      }
      continue;
    }
    const localImportError = validateLocalModuleSpecifier(
      sourceFile.path.replaceAll("\\", "/"),
      entry.directory,
      specifier,
    );
    if (localImportError !== undefined) {
      if (localImportError !== "") {
        errors.push(`${sourceFile.path}: ${localImportError}`);
      }
      continue;
    }

    const dependency = packageNameFromSpecifier(specifier);
    if (dependency.startsWith("@turingfocus/")) {
      if (dependency === policy.name) continue;
      if (!policy.internalDependencies.includes(dependency)) {
        errors.push(
          `${sourceFile.path}: ${label} source import ${dependency} is not allowed by package policy`,
        );
      } else if (!entry.manifest.dependencies?.[dependency]) {
        errors.push(
          `${sourceFile.path}: ${label} source import ${dependency} must be declared in dependencies`,
        );
      }
      continue;
    }

    const policySections = allowedDependencySections(policy, dependency);
    const compatibleSections =
      kind === "runtime"
        ? policySections.filter((section) =>
            runtimeDependencySections.includes(section),
          )
        : policySections;
    if (compatibleSections.length === 0) {
      errors.push(
        `${sourceFile.path}: ${label} source ${kind} import ${dependency} is not allowed by package policy`,
      );
      continue;
    }
    if (
      !compatibleSections.some(
        (section) => entry.manifest[section]?.[dependency] !== undefined,
      )
    ) {
      errors.push(
        `${sourceFile.path}: ${label} source ${kind} import ${dependency} must be declared in ${compatibleSections.join(" or ")}`,
      );
    }
  }
};

/**
 * @param {PackageManifest} manifest
 * @returns {{ section: DependencySection; dependency: string; specifier: unknown }[]}
 */
const dependencyEntries = (manifest) =>
  dependencySections.flatMap((section) =>
    Object.entries(getDependencies(manifest, section)).map(
      ([dependency, specifier]) => ({ section, dependency, specifier }),
    ),
  );

/**
 * @param {string} label
 * @param {PackageManifest} manifest
 * @param {string[]} errors
 * @param {boolean} [allowInternalWorkspaceDependencies]
 */
const validateDependencySources = (
  label,
  manifest,
  errors,
  allowInternalWorkspaceDependencies = false,
) => {
  for (const { dependency, specifier } of dependencyEntries(manifest)) {
    if (typeof specifier !== "string") {
      errors.push(
        `${label}: ${dependency} dependency specifier must be a string`,
      );
      continue;
    }
    if (
      usesForbiddenSourceDependency(
        dependency,
        specifier,
        allowInternalWorkspaceDependencies,
      )
    ) {
      errors.push(
        `${label}: ${dependency} uses forbidden source/path dependency ${specifier}`,
      );
    }
  }
};

/**
 * @param {PackageManifest} manifest
 * @param {string[]} errors
 */
const validateRootOverrides = (manifest, errors) => {
  for (const [selector, specifier] of Object.entries(
    manifest.pnpm?.overrides ?? {},
  )) {
    if (typeof specifier !== "string") {
      errors.push(`root: pnpm override ${selector} must be a string`);
      continue;
    }
    if (usesForbiddenSourceDependency("override-target", specifier, false)) {
      errors.push(
        `root: pnpm override ${selector} uses forbidden source/path dependency ${specifier}`,
      );
    }
  }
};

/**
 * Split shell scripts into simple command token lists while respecting quoted
 * text. This is intentionally a command recognizer, not a shell evaluator: it
 * only needs to identify an executable and its literal subcommands without
 * matching comments or arbitrary text passed to another program.
 *
 * @param {string} command
 * @returns {string[][]}
 */
const shellCommandSegments = (command) => {
  /** @type {string[][]} */
  const segments = [];
  /** @type {string[]} */
  let tokens = [];
  let token = "";
  /** @type {'"' | "'" | undefined} */
  let quote;
  let escaped = false;
  let redirectionTargetStarted = false;
  let readingRedirection = false;

  const finishToken = () => {
    if (token.length > 0) tokens.push(token);
    token = "";
  };
  const finishSegment = () => {
    finishToken();
    if (tokens.length > 0) segments.push(tokens);
    tokens = [];
  };

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index] ?? "";
    if (escaped) {
      if (!readingRedirection) token += character;
      else redirectionTargetStarted = true;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      else if (!readingRedirection) token += character;
      else redirectionTargetStarted = true;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      if (readingRedirection) redirectionTargetStarted = true;
      continue;
    }
    if (readingRedirection) {
      if (character === "<" || character === ">") continue;
      if (/\s/u.test(character)) {
        if (redirectionTargetStarted) {
          readingRedirection = false;
          redirectionTargetStarted = false;
        }
        continue;
      }
      if (
        character === ";" ||
        character === "|" ||
        character === "(" ||
        character === ")" ||
        (character === "&" && redirectionTargetStarted)
      ) {
        readingRedirection = false;
        redirectionTargetStarted = false;
        finishSegment();
        continue;
      }
      redirectionTargetStarted = true;
      continue;
    }
    if (character === "\n" || character === "\r") {
      finishSegment();
      continue;
    }
    if (/\s/u.test(character)) {
      finishToken();
      continue;
    }
    if (character === "&" && (command[index + 1] ?? "") === ">") {
      finishToken();
      readingRedirection = true;
      index += 1;
      continue;
    }
    if (character === "<" || character === ">") {
      if (/^\d+$/u.test(token)) token = "";
      else finishToken();
      readingRedirection = true;
      continue;
    }
    if (
      character === ";" ||
      character === "|" ||
      character === "&" ||
      character === "(" ||
      character === ")"
    ) {
      finishSegment();
      continue;
    }
    token += character;
  }
  finishSegment();
  return segments;
};

/** @param {string} token */
const executableName = (token) =>
  path
    .basename(token)
    .replace(/\.(?:cmd|exe)$/iu, "")
    .toLowerCase();

const pnpmOptionsWithValues = new Set([
  "--config",
  "--dir",
  "--filter",
  "--globalconfig",
  "--loglevel",
  "--prefix",
  "--reporter",
  "--registry",
  "--userconfig",
  "-C",
  "-c",
]);

const pnpmOptionPrefixesWithValues = ["--config."];

const npmExecOptionsWithValues = new Set([
  "--call",
  "--package",
  "--workspace",
  "-c",
  "-p",
  "-w",
]);

const envOptionsWithValues = new Set([
  "--chdir",
  "--split-string",
  "--unset",
  "-C",
  "-S",
  "-u",
]);

const noOptionsWithValues = new Set();

// npm and pnpm accept configuration as global flags, including values separated
// by whitespace. Enumerating every value-taking key is therefore not a safe way
// to find the command. Command names are the stable semantic boundary: ignore
// config values until the first recognized command, and keep publish/pub
// fail-closed while release infrastructure is unapproved.
const npmCommandNames = new Set([
  "access",
  "adduser",
  "audit",
  "bugs",
  "cache",
  "ci",
  "completion",
  "config",
  "dedupe",
  "deprecate",
  "diff",
  "dist-tag",
  "docs",
  "doctor",
  "edit",
  "exec",
  "explain",
  "explore",
  "find-dupes",
  "fund",
  "get",
  "help",
  "help-search",
  "init",
  "install",
  "install-ci-test",
  "install-test",
  "link",
  "ll",
  "login",
  "logout",
  "ls",
  "org",
  "outdated",
  "owner",
  "pack",
  "ping",
  "pkg",
  "prefix",
  "profile",
  "prune",
  "pub",
  "publish",
  "query",
  "rebuild",
  "repo",
  "restart",
  "root",
  "run",
  "run-script",
  "sbom",
  "search",
  "set",
  "shrinkwrap",
  "star",
  "stars",
  "start",
  "stop",
  "team",
  "test",
  "token",
  "uninstall",
  "unpublish",
  "unstar",
  "update",
  "version",
  "view",
  "whoami",
  "x",
]);

const pnpmCommandNames = new Set([
  "add",
  "approve-builds",
  "audit",
  "bin",
  "config",
  "create",
  "deploy",
  "dedupe",
  "dlx",
  "env",
  "exec",
  "fetch",
  "help",
  "import",
  "init",
  "install",
  "licenses",
  "link",
  "list",
  "ll",
  "ls",
  "outdated",
  "pack",
  "patch",
  "patch-commit",
  "prune",
  "publish",
  "rebuild",
  "remove",
  "root",
  "run",
  "server",
  "setup",
  "start",
  "store",
  "test",
  "unlink",
  "unpublish",
  "update",
  "view",
  "why",
]);

/**
 * @param {readonly string[]} args
 * @param {number} [start]
 * @param {ReadonlySet<string>} [optionsWithValues]
 * @param {boolean} [skipAssignments]
 * @returns {{ command: string; index: number } | undefined}
 */
const literalSubcommand = (
  args,
  start = 0,
  optionsWithValues = noOptionsWithValues,
  skipAssignments = false,
) => {
  for (let index = start; index < args.length; index += 1) {
    const argument = args[index] ?? "";
    if (argument === "--") continue;
    if (skipAssignments && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(argument)) continue;
    if (argument.startsWith("-")) {
      if (!argument.includes("=") && optionsWithValues.has(argument)) {
        index += 1;
      }
      continue;
    }
    return { command: argument, index };
  }
  return undefined;
};

/**
 * npm configuration flags are accepted before both npm commands and commands
 * wrapped by npm exec/npx. Unknown configuration keys may take a whitespace-
 * separated value, so use the same consumer at both levels instead of keeping
 * two incomplete option enumerations.
 *
 * @param {readonly string[]} args
 * @param {number} start
 * @param {(command: string) => boolean} isProtectedCommand
 * @param {ReadonlySet<string>} [optionsWithValues]
 * @param {readonly string[]} [optionPrefixesWithValues]
 */
const literalConfiguredCommand = (
  args,
  start,
  isProtectedCommand,
  optionsWithValues = noOptionsWithValues,
  optionPrefixesWithValues = [],
) => {
  for (let index = start; index < args.length; index += 1) {
    const argument = args[index] ?? "";
    if (argument === "--") continue;
    if (argument.startsWith("-")) {
      if (argument.includes("=")) continue;
      const possibleValue = (args[index + 1] ?? "").toLowerCase();
      if (
        !optionsWithValues.has(argument) &&
        !optionPrefixesWithValues.some((prefix) =>
          argument.startsWith(prefix),
        ) &&
        isProtectedCommand(possibleValue)
      ) {
        return { command: possibleValue, index: index + 1 };
      }
      index += 1;
      continue;
    }

    const command = argument.toLowerCase();
    if (isProtectedCommand(command)) return { command, index };
  }
  return undefined;
};

/** @param {readonly string[]} args */
const literalNpmCommand = (args) =>
  literalConfiguredCommand(args, 0, (command) => npmCommandNames.has(command));

/** @param {readonly string[]} args */
const literalPnpmCommand = (args) =>
  literalConfiguredCommand(
    args,
    0,
    (command) => pnpmCommandNames.has(command),
    pnpmOptionsWithValues,
    pnpmOptionPrefixesWithValues,
  );

/** @param {string | undefined} command */
const isChangesetsCliCommand = (command) =>
  command !== undefined &&
  /^(?:changesets?|@changesets\/cli)(?:@[^/]+)?$/u.test(command);

/**
 * @param {readonly string[]} args
 * @param {{ index: number } | undefined} wrapperCommand
 * @param {ReadonlySet<string>} [wrapperOptionsWithValues]
 */
const wrappedChangesetsPublishes = (
  args,
  wrapperCommand,
  wrapperOptionsWithValues = noOptionsWithValues,
) => {
  const packageCommand =
    wrapperCommand === undefined
      ? undefined
      : literalSubcommand(
          args,
          wrapperCommand.index + 1,
          wrapperOptionsWithValues,
        );
  const publishCommand =
    packageCommand === undefined
      ? undefined
      : literalSubcommand(args, packageCommand.index + 1);
  return (
    isChangesetsCliCommand(packageCommand?.command) &&
    publishCommand?.command === "publish"
  );
};

/**
 * @param {readonly string[]} args
 * @param {{ index: number } | undefined} wrapperCommand
 */
const npmWrappedChangesetsPublishes = (args, wrapperCommand) => {
  const packageCommand =
    wrapperCommand === undefined
      ? undefined
      : literalConfiguredCommand(
          args,
          wrapperCommand.index + 1,
          isChangesetsCliCommand,
          npmExecOptionsWithValues,
        );
  const publishCommand =
    packageCommand === undefined
      ? undefined
      : literalSubcommand(args, packageCommand.index + 1);
  return (
    isChangesetsCliCommand(packageCommand?.command) &&
    publishCommand?.command === "publish"
  );
};

/** @param {readonly string[]} tokens */
const commandPublishesPackage = (tokens) => {
  let executableIndex = tokens.findIndex(
    (token) => !/^[A-Za-z_][A-Za-z0-9_]*=/u.test(token),
  );
  if (executableIndex < 0) return false;

  let executable = executableName(tokens[executableIndex] ?? "");
  for (let wrapperDepth = 0; wrapperDepth < 4; wrapperDepth += 1) {
    if (executable !== "command" && executable !== "env") break;
    const wrappedCommand = literalSubcommand(
      tokens,
      executableIndex + 1,
      executable === "env" ? envOptionsWithValues : noOptionsWithValues,
      executable === "env",
    );
    if (wrappedCommand === undefined) return false;
    executableIndex = wrappedCommand.index;
    executable = executableName(wrappedCommand.command);
  }

  const args = tokens.slice(executableIndex + 1);
  if (executable === "npm") {
    const subcommand = literalNpmCommand(args);
    if (subcommand?.command === "publish" || subcommand?.command === "pub")
      return true;
    return (
      (subcommand?.command === "exec" || subcommand?.command === "x") &&
      npmWrappedChangesetsPublishes(args, subcommand)
    );
  }
  if (executable === "pnpm") {
    const subcommand = literalPnpmCommand(args);
    if (subcommand?.command === "publish") return true;
    return (
      (subcommand?.command === "dlx" || subcommand?.command === "exec") &&
      wrappedChangesetsPublishes(args, subcommand)
    );
  }
  if (executable === "changeset" || executable === "changesets") {
    const subcommand = literalSubcommand(args);
    return subcommand?.command === "publish";
  }
  if (executable === "yarn") {
    const subcommand = literalSubcommand(args);
    if (subcommand?.command === "publish") return true;
    if (subcommand?.command !== "npm") return false;
    const npmCommand = literalSubcommand(args, subcommand.index + 1);
    return npmCommand?.command === "publish" || npmCommand?.command === "pub";
  }
  if (executable === "npx") {
    return npmWrappedChangesetsPublishes(args, { index: -1 });
  }
  return false;
};

/** @param {string} command */
const containsPublishCommand = (command) =>
  shellCommandSegments(command).some(commandPublishesPackage);

/**
 * @param {string} label
 * @param {PackageManifest} manifest
 * @param {string[]} errors
 */
const validatePublishScripts = (label, manifest, errors) => {
  for (const [name, command] of Object.entries(manifest.scripts ?? {})) {
    if (containsPublishCommand(command)) {
      errors.push(
        `${label}: script ${name} must not publish before the TFCK-13 release workflow and npm identity are approved`,
      );
    }
  }
};

/**
 * Formal publication is deliberately unavailable in this Story. Treat the
 * complete script map as configuration, not as shell source to interpret: any
 * new or changed command requires an explicit policy review. This fail-closed
 * boundary also covers shell, corepack, task-runner, and package-manager
 * wrappers that a finite command parser cannot safely enumerate.
 *
 * @param {string} label
 * @param {PackageManifest} manifest
 * @param {Record<string, string>} expected
 * @param {string[]} errors
 */
const validateApprovedScripts = (label, manifest, expected, errors) => {
  if (!sameEntries(manifest.scripts ?? {}, expected)) {
    errors.push(
      `${label}: scripts must exactly match the approved publish-disabled baseline`,
    );
  }
};

/**
 * @param {string} label
 * @param {PackageManifest} manifest
 * @param {string | undefined} directory
 * @param {string[]} errors
 */
const validateRepositoryMetadata = (label, manifest, directory, errors) => {
  if (manifest.repository?.type !== "git")
    errors.push(`${label}: repository.type must be git`);
  if (manifest.repository?.url !== REPOSITORY_URL)
    errors.push(`${label}: repository.url must be ${REPOSITORY_URL}`);
  if (directory === undefined) {
    if (manifest.repository?.directory !== undefined)
      errors.push(`${label}: root repository must not declare a directory`);
  } else if (manifest.repository?.directory !== directory) {
    errors.push(`${label}: repository.directory must be ${directory}`);
  }
  if (manifest.homepage !== HOMEPAGE_URL)
    errors.push(`${label}: homepage must be ${HOMEPAGE_URL}`);
  if (manifest.bugs?.url !== BUGS_URL)
    errors.push(`${label}: bugs.url must be ${BUGS_URL}`);
};

/**
 * @param {WorkspaceSnapshot} snapshot
 * @returns {string[]}
 */
export function validateWorkspaceSnapshot(snapshot) {
  const errors = [];
  const expectedDirectories = Object.keys(PACKAGE_POLICY);
  const actualDirectories = snapshot.packages.map(({ directory }) => directory);

  if (
    stableObjectJson(snapshot.changesetConfig ?? {}) !==
    stableObjectJson(CHANGESET_CONFIG_POLICY)
  ) {
    errors.push(
      "changeset configuration must exactly match the approved fixed-group policy",
    );
  }

  if (
    JSON.stringify(sorted(actualDirectories)) !==
    JSON.stringify(sorted(expectedDirectories))
  ) {
    errors.push(
      `workspace packages must be exactly ${sorted(expectedDirectories).join(", ")}; found ${sorted(actualDirectories).join(", ")}`,
    );
  }

  if (snapshot.rootManifest.packageManager !== "pnpm@10.34.5") {
    errors.push("root packageManager must be pinned to pnpm@10.34.5");
  }
  if (snapshot.rootManifest.license !== "MIT")
    errors.push("root license must be MIT");
  validateRepositoryMetadata("root", snapshot.rootManifest, undefined, errors);
  validateApprovedScripts(
    "root",
    snapshot.rootManifest,
    ROOT_SCRIPT_POLICY,
    errors,
  );
  validatePublishScripts("root", snapshot.rootManifest, errors);
  validateDependencySources("root", snapshot.rootManifest, errors);
  validateRootOverrides(snapshot.rootManifest, errors);

  const packageVersions = [
    ...new Set(snapshot.packages.map(({ manifest }) => manifest.version)),
  ];
  const displayedVersions = packageVersions.map((version) =>
    typeof version === "string" ? version : "<missing>",
  );
  if (packageVersions.length !== 1) {
    errors.push(
      `workspace package versions must match; found ${sorted(displayedVersions).join(", ")}`,
    );
  } else if (
    typeof packageVersions[0] !== "string" ||
    !isZeroMajorVersion(packageVersions[0])
  ) {
    errors.push(
      `workspace package version must be valid 0.x SemVer; found ${displayedVersions[0]}`,
    );
  }

  for (const entry of snapshot.packages) {
    const policy = PACKAGE_POLICY[entry.directory];
    if (!policy) continue;

    const { manifest } = entry;
    const label = manifest.name ?? entry.directory;

    if (manifest.name !== policy.name)
      errors.push(`${label}: package name must be ${policy.name}`);
    if (manifest.private === true)
      errors.push(`${label}: publishable workspace packages cannot be private`);
    if (manifest.license !== "MIT")
      errors.push(`${label}: license must be MIT`);
    if (manifest.publishConfig?.access !== "public")
      errors.push(`${label}: publishConfig.access must be public`);
    if (manifest.publishConfig?.registry !== PUBLIC_REGISTRY)
      errors.push(
        `${label}: publishConfig.registry must be ${PUBLIC_REGISTRY}`,
      );
    validateRepositoryMetadata(
      label,
      manifest,
      `packages/${entry.directory}`,
      errors,
    );
    if (!manifest.files?.includes("dist"))
      errors.push(`${label}: package files must include dist`);
    if (
      manifest.sideEffects !== false &&
      !(
        Array.isArray(manifest.sideEffects) &&
        manifest.sideEffects.length > 0 &&
        manifest.sideEffects.every(
          (sideEffect) =>
            typeof sideEffect === "string" && sideEffect.trim().length > 0,
        )
      )
    ) {
      errors.push(
        `${label}: sideEffects must be false or a non-empty list of explicit file patterns`,
      );
    }
    if (manifest.exports?.["."]?.types !== "./dist/index.d.ts") {
      errors.push(`${label}: exports must expose generated declarations`);
    }
    if (manifest.exports?.["."]?.import !== "./dist/index.js") {
      errors.push(`${label}: exports must expose the ESM build`);
    }

    validateApprovedScripts(label, manifest, {}, errors);
    validatePublishScripts(label, manifest, errors);
    validateDependencySources(label, manifest, errors, true);

    /** @type {DependencyMap} */
    const actualInternalDependencies = {};
    for (const { section, dependency, specifier } of dependencyEntries(
      manifest,
    )) {
      if (typeof specifier !== "string") continue;
      if (!dependency.startsWith("@turingfocus/")) {
        if (
          matchesDependencyRule(dependency, heavyRendererDependencyPatterns) &&
          entry.directory !== "chat-ui-antd"
        ) {
          errors.push(
            `${label}: heavy renderer dependency ${dependency} is only allowed in chat-ui-antd`,
          );
        } else if (
          !matchesDependencyRule(
            dependency,
            policy.allowedExternalDependencies[section] ?? [],
          )
        ) {
          errors.push(
            `${label}: external dependency ${dependency} is not allowed by package policy in ${section}`,
          );
        }
        continue;
      }
      if (section !== "dependencies") {
        errors.push(
          `${label}: internal package ${dependency} must be a production dependency`,
        );
      }
      actualInternalDependencies[dependency] = specifier;
    }

    const expectedInternalDependencies = Object.fromEntries(
      policy.internalDependencies.map((dependency) => [
        dependency,
        "workspace:^",
      ]),
    );
    if (
      !sameEntries(actualInternalDependencies, expectedInternalDependencies)
    ) {
      errors.push(
        `${label}: internal dependencies must be ${JSON.stringify(expectedInternalDependencies)}; found ${JSON.stringify(actualInternalDependencies)}`,
      );
    }

    const actualPeers = getDependencies(manifest, "peerDependencies");
    if (!sameEntries(actualPeers, policy.peerDependencies)) {
      errors.push(
        `${label}: peer dependency baseline must be ${JSON.stringify(policy.peerDependencies)}; found ${JSON.stringify(actualPeers)}`,
      );
    }

    for (const section of dependencySections) {
      const dependencies = getDependencies(manifest, section);
      if (
        entry.directory !== "chat-react" &&
        entry.directory !== "chat-ui-antd" &&
        dependencies["react"]
      ) {
        errors.push(
          `${label}: React is only allowed in chat-react and chat-ui-antd`,
        );
      }
      if (entry.directory !== "chat-ui-antd" && dependencies["antd"]) {
        errors.push(`${label}: Ant Design is only allowed in chat-ui-antd`);
      }
      if (dependencies["next"])
        errors.push(`${label}: Next.js is a forbidden host dependency`);
    }
  }

  for (const sourceFile of snapshot.sourceFiles) {
    const pathParts = sourceFile.path.split(/[\\/]/u);
    const packagesIndex = pathParts.indexOf("packages");
    const directory =
      packagesIndex >= 0 ? pathParts[packagesIndex + 1] : undefined;
    if (!directory) continue;
    const entry = snapshot.packages.find(
      (workspacePackage) => workspacePackage.directory === directory,
    );
    const policy = PACKAGE_POLICY[directory];
    if (entry && policy)
      validateSourceImports(sourceFile, entry, policy, errors);
  }

  return errors;
}

/**
 * @param {string} directory
 * @param {string} rootDirectory
 * @returns {Promise<SourceFile[]>}
 */
export async function collectSourceFiles(directory, rootDirectory) {
  const entries = await readdir(directory, { withFileTypes: true });
  /** @type {SourceFile[]} */
  const files = [];
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    const relativePath = path
      .relative(rootDirectory, absolutePath)
      .split(path.sep)
      .join("/");
    if (entry.isSymbolicLink()) {
      throw new Error(
        `${relativePath}: symbolic links are not allowed in public package source trees`,
      );
    }
    if (entry.isDirectory()) {
      if (entry.name !== "dist" && entry.name !== "node_modules")
        files.push(...(await collectSourceFiles(absolutePath, rootDirectory)));
      continue;
    }
    if (!/\.(?:[cm]?[jt]sx?)$/u.test(entry.name)) continue;
    files.push({
      path: path.relative(rootDirectory, absolutePath),
      content: await readFile(absolutePath, "utf8"),
    });
  }
  return files;
}

/**
 * @param {string} rootDirectory
 * @returns {Promise<WorkspaceSnapshot>}
 */
export async function loadWorkspaceSnapshot(rootDirectory) {
  const packagesDirectory = path.join(rootDirectory, "packages");
  const directories = (
    await readdir(packagesDirectory, { withFileTypes: true })
  )
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  const packages = await Promise.all(
    directories.map(async (directory) => ({
      directory,
      manifest: /** @type {PackageManifest} */ (
        JSON.parse(
          await readFile(
            path.join(packagesDirectory, directory, "package.json"),
            "utf8",
          ),
        )
      ),
    })),
  );

  return {
    rootManifest: /** @type {PackageManifest} */ (
      JSON.parse(
        await readFile(path.join(rootDirectory, "package.json"), "utf8"),
      )
    ),
    changesetConfig: /** @type {Record<string, unknown>} */ (
      JSON.parse(
        await readFile(
          path.join(rootDirectory, ".changeset", "config.json"),
          "utf8",
        ),
      )
    ),
    packages,
    sourceFiles: await collectSourceFiles(packagesDirectory, rootDirectory),
  };
}

/** @param {string} rootDirectory */
export async function assertWorkspace(rootDirectory) {
  const errors = validateWorkspaceSnapshot(
    await loadWorkspaceSnapshot(rootDirectory),
  );
  if (errors.length > 0)
    throw new Error(errors.map((error) => `- ${error}`).join("\n"));
}
