import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { PACKAGE_POLICY } from "./workspace-policy.mjs";

const rootDirectory = process.cwd();
const outputDirectory = path.join(rootDirectory, ".artifacts", "packages");

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

for (const directory of Object.keys(PACKAGE_POLICY)) {
  const packageDirectory = path.join(rootDirectory, "packages", directory);
  execFileSync(
    "pnpm",
    ["--dir", packageDirectory, "pack", "--pack-destination", outputDirectory],
    { stdio: "inherit" },
  );
}

const tarballs = (await readdir(outputDirectory))
  .filter((file) => file.endsWith(".tgz"))
  .sort();
const packages = [];
for (const directory of Object.keys(PACKAGE_POLICY)) {
  const packageManifest = JSON.parse(
    await readFile(
      path.join(rootDirectory, "packages", directory, "package.json"),
      "utf8",
    ),
  );
  const expectedPrefix = packageManifest.name
    .replace(/^@/u, "")
    .replace("/", "-");
  const tarball = tarballs.find((file) =>
    file.startsWith(`${expectedPrefix}-`),
  );
  if (!tarball)
    throw new Error(`No tarball produced for ${packageManifest.name}`);
  packages.push({
    name: packageManifest.name,
    version: packageManifest.version,
    tarball: path.join(outputDirectory, tarball),
  });
}

await writeFile(
  path.join(outputDirectory, "manifest.json"),
  `${JSON.stringify({ packages }, null, 2)}\n`,
  "utf8",
);

console.log(
  `Packed ${packages.length} workspace packages into ${outputDirectory}.`,
);
