import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

export const PACKAGE_POLICY = Object.freeze({
  "chat-protocol": {
    name: "@tf/chat-protocol",
    internalDependencies: [],
    peerDependencies: {},
  },
  "chat-runtime": {
    name: "@tf/chat-runtime",
    internalDependencies: ["@tf/chat-protocol"],
    peerDependencies: {},
  },
  "chat-gateway-tfrobot": {
    name: "@tf/chat-gateway-tfrobot",
    internalDependencies: ["@tf/chat-protocol"],
    peerDependencies: {},
  },
  "chat-react": {
    name: "@tf/chat-react",
    internalDependencies: ["@tf/chat-runtime"],
    peerDependencies: { react: ">=18.2.0 <19.0.0" },
  },
  "chat-ui-antd": {
    name: "@tf/chat-ui-antd",
    internalDependencies: ["@tf/chat-react"],
    peerDependencies: {
      antd: ">=5.23.4 <6.0.0",
      react: ">=18.2.0 <19.0.0",
    },
  },
  "chat-testing": {
    name: "@tf/chat-testing",
    internalDependencies: ["@tf/chat-protocol", "@tf/chat-runtime"],
    peerDependencies: {},
  },
});

const dependencySections = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];

const forbiddenSourcePatterns = [
  ["absolute developer path", /\/Users\//u],
  ["TFRobotFront source", /TFRobotFront/u],
  ["Next.js", /(?:from\s+|import\s*)["']next(?:\/|["'])/u],
  ["Tauri API", /@tauri-apps\//u],
  ["Office API", /@microsoft\/office-js/u],
];

const zeroMajorSemver =
  /^0\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

const getDependencies = (manifest, section) => manifest[section] ?? {};

const sorted = (values) =>
  [...values].sort((left, right) => left.localeCompare(right));

const sameEntries = (actual, expected) =>
  JSON.stringify(Object.fromEntries(Object.entries(actual).sort())) ===
  JSON.stringify(Object.fromEntries(Object.entries(expected).sort()));

export function validateWorkspaceSnapshot(snapshot) {
  const errors = [];
  const expectedDirectories = Object.keys(PACKAGE_POLICY);
  const actualDirectories = snapshot.packages.map(({ directory }) => directory);

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
    !zeroMajorSemver.test(packageVersions[0])
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
    if (manifest.license !== "UNLICENSED")
      errors.push(`${label}: license must be UNLICENSED`);
    if (manifest.publishConfig?.access !== "restricted") {
      errors.push(`${label}: publishConfig.access must be restricted`);
    }
    if (manifest.publishConfig?.registry) {
      errors.push(
        `${label}: registry must not be guessed before the CNB artifact repository exists`,
      );
    }
    if (!manifest.files?.includes("dist"))
      errors.push(`${label}: package files must include dist`);
    if (manifest.exports?.["."]?.types !== "./dist/index.d.ts") {
      errors.push(`${label}: exports must expose generated declarations`);
    }
    if (manifest.exports?.["."]?.import !== "./dist/index.js") {
      errors.push(`${label}: exports must expose the ESM build`);
    }

    const actualInternalDependencies = {};
    for (const section of dependencySections) {
      for (const [dependency, specifier] of Object.entries(
        getDependencies(manifest, section),
      )) {
        if (
          /^(?:file|link):/u.test(specifier) ||
          specifier.includes("/Users/")
        ) {
          errors.push(
            `${label}: ${dependency} uses forbidden source/path dependency ${specifier}`,
          );
        }
        if (!dependency.startsWith("@tf/")) continue;
        if (section !== "dependencies") {
          errors.push(
            `${label}: internal package ${dependency} must be a production dependency`,
          );
        }
        actualInternalDependencies[dependency] = specifier;
      }
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
        dependencies.react
      ) {
        errors.push(
          `${label}: React is only allowed in chat-react and chat-ui-antd`,
        );
      }
      if (entry.directory !== "chat-ui-antd" && dependencies.antd) {
        errors.push(`${label}: Ant Design is only allowed in chat-ui-antd`);
      }
      if (dependencies.next)
        errors.push(`${label}: Next.js is a forbidden host dependency`);
    }
  }

  for (const sourceFile of snapshot.sourceFiles) {
    for (const [description, pattern] of forbiddenSourcePatterns) {
      if (pattern.test(sourceFile.content)) {
        errors.push(
          `${sourceFile.path}: contains forbidden ${description} dependency`,
        );
      }
    }
  }

  return errors;
}

async function collectSourceFiles(directory, rootDirectory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "dist")
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
      manifest: JSON.parse(
        await readFile(
          path.join(packagesDirectory, directory, "package.json"),
          "utf8",
        ),
      ),
    })),
  );

  return {
    rootManifest: JSON.parse(
      await readFile(path.join(rootDirectory, "package.json"), "utf8"),
    ),
    packages,
    sourceFiles: await collectSourceFiles(packagesDirectory, rootDirectory),
  };
}

export async function assertWorkspace(rootDirectory) {
  const errors = validateWorkspaceSnapshot(
    await loadWorkspaceSnapshot(rootDirectory),
  );
  if (errors.length > 0)
    throw new Error(errors.map((error) => `- ${error}`).join("\n"));
}
