import { assertWorkspace } from "./workspace-policy.mjs";

try {
  await assertWorkspace(process.cwd());
  console.log(
    "Workspace package, version, peer, and host-boundary policy passed.",
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
