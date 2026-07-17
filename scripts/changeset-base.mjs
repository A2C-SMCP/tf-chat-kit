export const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

const zeroSha = /^0{40}$/u;
const commitSha = /^[0-9a-f]{40}$/u;

/**
 * @typedef {{
 *   ref: string;
 *   strategy: "direct" | "merge-base";
 *   source: string;
 * }} ComparisonBase
 */

/**
 * @param {string | undefined} value
 * @param {string} variable
 * @returns {string}
 */
const requireCommitSha = (value, variable) => {
  if (!value || !commitSha.test(value)) {
    throw new Error(`${variable} must contain a full 40-character commit SHA.`);
  }
  return value;
};

/**
 * Select the authoritative comparison base exposed by GitHub Actions. Returning
 * undefined means the caller is running outside GitHub Actions and may use its
 * local Git fallback.
 *
 * @param {NodeJS.ProcessEnv} environment
 * @returns {ComparisonBase | undefined}
 */
export function selectGithubComparisonBase(environment) {
  if (environment["GITHUB_ACTIONS"] !== "true") return undefined;

  const event = environment["GITHUB_EVENT_NAME"];
  if (event === "push") {
    const beforeSha = requireCommitSha(
      environment["GITHUB_EVENT_BEFORE"],
      "GITHUB_EVENT_BEFORE",
    );
    return {
      ref: zeroSha.test(beforeSha) ? EMPTY_TREE_SHA : beforeSha,
      strategy: "direct",
      source: "GITHUB_EVENT_BEFORE",
    };
  }

  if (event === "pull_request" || event === "pull_request_target") {
    return {
      ref: requireCommitSha(environment["GITHUB_BASE_SHA"], "GITHUB_BASE_SHA"),
      strategy: "merge-base",
      source: "GITHUB_BASE_SHA",
    };
  }

  throw new Error(
    `Unsupported GITHUB_EVENT_NAME for changeset coverage: ${event ?? "<missing>"}.`,
  );
}
