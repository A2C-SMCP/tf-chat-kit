import { describe, expect, it } from "vitest";

import {
  EMPTY_TREE_SHA,
  selectGithubComparisonBase,
} from "../scripts/changeset-base.mjs";

const previousMain = "a".repeat(40);
const pullRequestTarget = "b".repeat(40);

describe("changeset comparison base", () => {
  it("leaves local base selection to the caller", () => {
    expect(selectGithubComparisonBase({})).toBeUndefined();
  });

  it("leaves an explicit comparison base to the caller in GitHub Actions", () => {
    expect(
      selectGithubComparisonBase({
        CHANGESET_BASE_REF: "HEAD^",
        GITHUB_ACTIONS: "true",
        GITHUB_EVENT_NAME: "workflow_dispatch",
      }),
    ).toBeUndefined();
  });

  it("uses the pre-push branch head for the complete pushed commit range", () => {
    expect(
      selectGithubComparisonBase({
        GITHUB_ACTIONS: "true",
        GITHUB_EVENT_NAME: "push",
        GITHUB_EVENT_BEFORE: previousMain,
      }),
    ).toEqual({
      ref: previousMain,
      strategy: "direct",
      source: "GITHUB_EVENT_BEFORE",
    });
  });

  it("compares a new branch push with the empty Git tree", () => {
    expect(
      selectGithubComparisonBase({
        GITHUB_ACTIONS: "true",
        GITHUB_EVENT_NAME: "push",
        GITHUB_EVENT_BEFORE: "0".repeat(40),
      }),
    ).toEqual({
      ref: EMPTY_TREE_SHA,
      strategy: "direct",
      source: "GITHUB_EVENT_BEFORE",
    });
  });

  it("uses the PR target through a merge-base comparison", () => {
    expect(
      selectGithubComparisonBase({
        GITHUB_ACTIONS: "true",
        GITHUB_EVENT_NAME: "pull_request",
        GITHUB_BASE_SHA: pullRequestTarget,
      }),
    ).toEqual({
      ref: pullRequestTarget,
      strategy: "merge-base",
      source: "GITHUB_BASE_SHA",
    });
  });

  it("fails closed when the push base is missing", () => {
    expect(() =>
      selectGithubComparisonBase({
        GITHUB_ACTIONS: "true",
        GITHUB_EVENT_NAME: "push",
      }),
    ).toThrow(
      "GITHUB_EVENT_BEFORE must contain a full 40-character commit SHA",
    );
  });

  it("fails closed for unsupported GitHub Actions events", () => {
    expect(() =>
      selectGithubComparisonBase({
        GITHUB_ACTIONS: "true",
        GITHUB_EVENT_NAME: "workflow_dispatch",
      }),
    ).toThrow(
      "Unsupported GITHUB_EVENT_NAME for changeset coverage: workflow_dispatch",
    );
  });
});
