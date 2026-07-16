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
 * Select the authoritative comparison base exposed by CNB. Returning undefined
 * means the caller is running outside CNB and may use its local Git fallback.
 *
 * @param {NodeJS.ProcessEnv} environment
 * @returns {ComparisonBase | undefined}
 */
export function selectCnbComparisonBase(environment) {
  if (environment["CNB"] !== "true") return undefined;

  const event = environment["CNB_EVENT"];
  if (event === "push" || event === "commit.add") {
    const beforeSha = requireCommitSha(
      environment["CNB_BEFORE_SHA"],
      "CNB_BEFORE_SHA",
    );
    return {
      ref: zeroSha.test(beforeSha) ? EMPTY_TREE_SHA : beforeSha,
      strategy: "direct",
      source: "CNB_BEFORE_SHA",
    };
  }

  if (event === "pull_request") {
    return {
      ref: requireCommitSha(
        environment["CNB_PULL_REQUEST_TARGET_SHA"],
        "CNB_PULL_REQUEST_TARGET_SHA",
      ),
      strategy: "merge-base",
      source: "CNB_PULL_REQUEST_TARGET_SHA",
    };
  }

  throw new Error(
    `Unsupported CNB_EVENT for changeset coverage: ${event ?? "<missing>"}.`,
  );
}
