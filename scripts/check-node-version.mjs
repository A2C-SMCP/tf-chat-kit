import { pathToFileURL } from "node:url";

const supportedNodeMajor = "24";
const supportedNodeRange = ">=24 <25";

export const assertSupportedNodeVersion = (
  version = process.versions.node,
  displayVersion = process.version,
) => {
  const [nodeMajor] = version.split(".");
  if (nodeMajor !== supportedNodeMajor) {
    throw new Error(
      `Node.js ${displayVersion} is unsupported; expected ${supportedNodeRange}. Run "nvm install && nvm use" from the repository root.`,
    );
  }
};

const entryPath = process.argv[1];
if (
  entryPath !== undefined &&
  import.meta.url === pathToFileURL(entryPath).href
) {
  try {
    assertSupportedNodeVersion();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
