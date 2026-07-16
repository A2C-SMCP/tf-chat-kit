import { describe, expect, it } from "vitest";

import {
  EMPTY_TREE_SHA,
  selectCnbComparisonBase,
} from "../scripts/changeset-base.mjs";

const previousMain = "a".repeat(40);
const pullRequestTarget = "b".repeat(40);

describe("changeset comparison base", () => {
  it("leaves local base selection to the caller", () => {
    expect(selectCnbComparisonBase({})).toBeUndefined();
  });

  it("uses the pre-push branch head for the complete pushed commit range", () => {
    expect(
      selectCnbComparisonBase({
        CNB: "true",
        CNB_EVENT: "push",
        CNB_BEFORE_SHA: previousMain,
        CNB_NEW_COMMITS_COUNT: "3",
      }),
    ).toEqual({
      ref: previousMain,
      strategy: "direct",
      source: "CNB_BEFORE_SHA",
    });
  });

  it("compares a new branch push with the empty Git tree", () => {
    expect(
      selectCnbComparisonBase({
        CNB: "true",
        CNB_EVENT: "push",
        CNB_BEFORE_SHA: "0".repeat(40),
      }),
    ).toEqual({
      ref: EMPTY_TREE_SHA,
      strategy: "direct",
      source: "CNB_BEFORE_SHA",
    });
  });

  it("uses the PR target through a merge-base comparison", () => {
    expect(
      selectCnbComparisonBase({
        CNB: "true",
        CNB_EVENT: "pull_request",
        CNB_PULL_REQUEST_TARGET_SHA: pullRequestTarget,
      }),
    ).toEqual({
      ref: pullRequestTarget,
      strategy: "merge-base",
      source: "CNB_PULL_REQUEST_TARGET_SHA",
    });
  });

  it("fails closed when the push base is missing", () => {
    expect(() =>
      selectCnbComparisonBase({ CNB: "true", CNB_EVENT: "push" }),
    ).toThrow("CNB_BEFORE_SHA must contain a full 40-character commit SHA");
  });

  it("fails closed for unsupported CNB events", () => {
    expect(() =>
      selectCnbComparisonBase({
        CNB: "true",
        CNB_EVENT: "pull_request.target",
      }),
    ).toThrow(
      "Unsupported CNB_EVENT for changeset coverage: pull_request.target",
    );
  });
});
