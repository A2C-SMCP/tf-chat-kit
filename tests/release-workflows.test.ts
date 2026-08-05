import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";

const releasePrPath = new URL(
  "../.github/workflows/release-pr.yml",
  import.meta.url,
);
const releasePath = new URL(
  "../.github/workflows/release.yml",
  import.meta.url,
);

const parseWorkflow = (source: string) => {
  const document = parseDocument(source);
  expect(document.errors).toEqual([]);
  const value: unknown = document.toJS();
  expect(value).toBeTypeOf("object");
  expect(value).not.toBeNull();
  return value as Record<string, unknown>;
};

const objectField = (value: Record<string, unknown>, field: string) => {
  const candidate = value[field];
  expect(candidate).toBeTypeOf("object");
  expect(candidate).not.toBeNull();
  return candidate as Record<string, unknown>;
};

const arrayField = (value: Record<string, unknown>, field: string) => {
  const candidate = value[field];
  expect(candidate).toBeInstanceOf(Array);
  return candidate as Record<string, unknown>[];
};

const jobSteps = (workflow: Record<string, unknown>, jobName: string) => {
  const jobs = objectField(workflow, "jobs");
  return arrayField(objectField(jobs, jobName), "steps");
};

const namedStep = (steps: Record<string, unknown>[], name: string) => {
  const step = steps.find((candidate) => candidate["name"] === name);
  expect(step, `missing workflow step ${name}`).toBeDefined();
  return step!;
};

describe("TFCK-13 release workflows", () => {
  it("keeps version PR creation separate from publication", async () => {
    const workflow = await readFile(releasePrPath, "utf8");
    const parsed = parseWorkflow(workflow);
    expect(parsed).toMatchSnapshot();
    const triggers = objectField(parsed, "on");
    const push = objectField(triggers, "push");
    const permissions = objectField(parsed, "permissions");
    const steps = jobSteps(parsed, "version");
    const revalidateStep = namedStep(
      steps,
      "Revalidate main before versioning",
    );
    const versionStep = namedStep(
      steps,
      "Create or update the fixed-group version pull request",
    );

    expect(push["branches"]).toEqual(["main"]);
    expect(permissions).toEqual({
      contents: "write",
      "pull-requests": "write",
    });
    expect(objectField(revalidateStep, "env")).toEqual({
      GITHUB_EVENT_BEFORE: "${{ github.event.before }}",
    });
    expect(versionStep["uses"]).toBe(
      "changesets/action@a45c4d594aa4e2c509dc14a9f2b3b67ba3780d0d",
    );
    expect(objectField(versionStep, "with")).toMatchObject({
      version: "node scripts/version-release.mjs",
      createGithubReleases: false,
      commitMode: "github-api",
    });
    expect(
      steps.flatMap((step) =>
        typeof step["run"] === "string" ? [step["run"]] : [],
      ),
    ).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/\bnpm\s+publish\b/u)]),
    );
    expect(permissions).not.toHaveProperty("id-token");
  });

  it("requires manual main deployment through the protected environment", async () => {
    const workflow = await readFile(releasePath, "utf8");
    const parsed = parseWorkflow(workflow);
    expect(parsed).toMatchSnapshot();
    const triggers = objectField(parsed, "on");
    const jobs = objectField(parsed, "jobs");
    const publish = objectField(jobs, "publish");
    const environment = objectField(publish, "environment");
    const permissions = objectField(parsed, "permissions");

    expect(triggers).toHaveProperty("workflow_dispatch");
    expect(publish["if"]).toBe("github.ref == 'refs/heads/main'");
    expect(environment).toEqual({
      name: "npm-production",
      deployment: true,
    });
    expect(permissions).toMatchObject({
      contents: "write",
      "id-token": "write",
      issues: "write",
    });
    expect(workflow).toContain("cancel-in-progress: false");
  });

  it("pins actions and npm, isolates bootstrap auth, and verifies before release", async () => {
    const workflow = await readFile(releasePath, "utf8");
    const parsed = parseWorkflow(workflow);
    const steps = jobSteps(parsed, "publish");
    const checkout = namedStep(steps, "Checkout the approved main commit");
    const setupNode = namedStep(steps, "Set up Node.js 24");
    const manifest = namedStep(steps, "Build the immutable release manifest");
    const bootstrapConfig = namedStep(
      steps,
      "Configure the one-time bootstrap npm credential",
    );
    const bootstrapPublish = namedStep(
      steps,
      "Publish with the one-time bootstrap credential",
    );
    const hybridPublish = namedStep(
      steps,
      "Publish existing packages with OIDC and bootstrap the facade",
    );
    const oidcPublish = namedStep(steps, "Publish with npm Trusted Publishing");
    const release = namedStep(
      steps,
      "Create or reconcile the GitHub Release after Registry verification",
    );
    const incident = namedStep(steps, "Render a failed-release incident");
    const stepNames = steps.map((step) => step["name"]);

    expect(checkout["uses"]).toBe(
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
    );
    expect(setupNode["uses"]).toBe(
      "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
    );
    expect(
      namedStep(steps, "Verify the pinned trusted-publishing npm CLI")["run"],
    ).toContain('= "11.18.0"');
    expect(objectField(manifest, "env")).toEqual({
      RELEASE_CHANNEL: "${{ inputs.channel }}",
      EXPECTED_VERSION: "${{ inputs.expected-version }}",
    });
    expect(manifest["run"]).not.toContain("${{ inputs.");
    expect(bootstrapConfig["if"]).toBe(
      "inputs.auth-mode == 'bootstrap-token' || inputs.auth-mode == 'oidc-with-bootstrap-facade'",
    );
    expect(bootstrapPublish["if"]).toBe(
      "inputs.auth-mode == 'bootstrap-token'",
    );
    expect(bootstrapConfig).not.toHaveProperty("env");
    expect(bootstrapConfig["run"]).not.toContain("secrets.");
    expect(objectField(bootstrapPublish, "env")).toMatchObject({
      NODE_AUTH_TOKEN: "${{ secrets.NPM_BOOTSTRAP_TOKEN }}",
      NPM_CONFIG_USERCONFIG: "${{ runner.temp }}/tf-chat-kit-bootstrap.npmrc",
    });
    expect(hybridPublish["if"]).toBe(
      "inputs.auth-mode == 'oidc-with-bootstrap-facade'",
    );
    expect(objectField(hybridPublish, "env")).toEqual({
      NPM_BOOTSTRAP_TOKEN: "${{ secrets.NPM_BOOTSTRAP_TOKEN }}",
      NPM_BOOTSTRAP_USERCONFIG:
        "${{ runner.temp }}/tf-chat-kit-bootstrap.npmrc",
    });
    expect(hybridPublish["run"]).toContain(
      "--auth-mode oidc-with-bootstrap-facade",
    );
    expect(hybridPublish["run"]).not.toContain("NODE_AUTH_TOKEN");
    expect(oidcPublish["if"]).toBe("inputs.auth-mode == 'oidc'");
    expect(oidcPublish).not.toHaveProperty("env");
    expect(oidcPublish["run"]).not.toContain("NODE_AUTH_TOKEN");
    expect(release["run"]).toContain("gh release download");
    expect(release["run"]).toContain("gh release upload");
    expect(release["run"]).toContain("reconcile-release-manifest.mjs");
    expect(release["run"]).toContain('cmp "${asset}"');
    expect(incident["run"]).toContain(
      "unauthenticated Registry consumer verification failed",
    );
    expect(incident["run"]).toContain("GitHub Release reconciliation failed");
    expect(incident["run"]).toContain('--error "${failure_stage}"');
    expect(incident["run"]).not.toContain(
      "workflow failed before publication progress was recorded",
    );

    expect(
      stepNames.indexOf("Build the immutable release manifest"),
    ).toBeLessThan(
      stepNames.indexOf("Create or reconcile the immutable source tag"),
    );
    expect(
      stepNames.indexOf("Create or reconcile the immutable source tag"),
    ).toBeLessThan(stepNames.indexOf("Publish with npm Trusted Publishing"));
    expect(
      stepNames.indexOf("Publish with npm Trusted Publishing"),
    ).toBeLessThan(
      stepNames.indexOf("Verify unauthenticated Registry consumers"),
    );
    expect(
      stepNames.indexOf(
        "Publish existing packages with OIDC and bootstrap the facade",
      ),
    ).toBeLessThan(
      stepNames.indexOf("Verify unauthenticated Registry consumers"),
    );
    expect(
      stepNames.indexOf("Verify unauthenticated Registry consumers"),
    ).toBeLessThan(
      stepNames.indexOf(
        "Create or reconcile the GitHub Release after Registry verification",
      ),
    );
    expect(stepNames).toContain("Create or update the Release Incident");
  });
});
