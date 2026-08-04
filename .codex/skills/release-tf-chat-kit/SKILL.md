---
name: release-tf-chat-kit
description: Safely publish a stable tf-chat-kit release by performing the Release Owner's manual GitHub steps. Use when the user invokes $release-tf-chat-kit, asks to release or publish tf-chat-kit, supplies a target version, or wants the next patch version released. Handles version planning, the Changesets version PR, CI and merge, immutable tag creation, protected npm OIDC workflow execution, Registry and GitHub Release verification, incident reconciliation, and develop synchronization.
---

# Release tf-chat-kit

Publish the six-package fixed group without requiring a writable `GITHUB_TOKEN` or a Release GitHub App. Act through the authenticated Release Owner for GitHub mutations; keep npm publication inside the protected `release.yml` OIDC workflow.

## Release contract

- Accept an optional stable `0.x.y` version, with or without a leading `v`.
- When no version is supplied, increment the current unified package version by one patch.
- Treat an explicit release invocation as authorization to create the release branch and PR, merge after required checks pass, create the immutable tag, and dispatch the protected workflow. Do not request repeated confirmation for those expected actions.
- Pause when GitHub requires approval for the `npm-production` environment. Ask the user to review and approve that deployment; do not bypass the protected environment.
- Require Changesets to generate exactly the planned version. Never edit generated versions or changelogs to defeat the release plan.
- Publish stable releases only through the `latest` channel and npm Trusted Publishing (`auth-mode=oidc`).
- Never force-push `main`, move or delete a `v*` tag, overwrite an npm version, expose credentials, or hide a failed command with `|| true`.

## 1. Resolve the version

Run from the repository root:

```bash
node .codex/skills/release-tf-chat-kit/scripts/plan-release.mjs
```

Pass the user's version when supplied:

```bash
node .codex/skills/release-tf-chat-kit/scripts/plan-release.mjs --version 0.2.1
```

Report the current version, target version, source (`explicit` or `next-patch`), and tag before mutating GitHub. Reject prereleases, `1.x`, non-increasing versions, and divergent workspace package versions.

## 2. Preflight

1. Announce that this skill is starting a production release.
2. Verify `gh auth status`, the `origin` URL, and Release Owner access.
3. Fetch `origin` and use the latest `origin/main`; do not release an unmerged local commit.
4. Preserve all user work. If the current worktree is dirty, create a dedicated temporary Git worktree from `origin/main`; never reset or discard changes.
5. Activate the Node version from `.nvmrc`, activate the pinned pnpm version, and install with the frozen lockfile.
6. Verify there are pending Changesets. Stop if there is nothing to version.
7. Run the repository compatibility and governance checks before versioning. Stop on any failure.

## 3. Create the version PR manually

1. Create or reuse `release/v<target>` from the exact current `origin/main` commit. If the remote branch or an open PR already exists, inspect and resume it; never overwrite it.
2. Run `node scripts/version-release.mjs` in the release worktree.
3. Verify the generated fixed-group version:

   ```bash
   node .codex/skills/release-tf-chat-kit/scripts/plan-release.mjs --verify <target>
   ```

4. If Changesets generated another version, stop and report the pending release plan. Do not rewrite Changesets merely to force the requested number.
5. Review the diff. A version PR may contain only Changesets-generated package manifests, changelogs, dependency updates, prerelease state, and consumed Changeset deletions.
6. Run `pnpm check` on the versioned tree.
7. Commit as `chore: version tf-chat-kit packages`, push the release branch, and create a PR targeting `main` with the same title.
8. Wait for every required check. If a check fails, diagnose it; do not merge a red PR.
9. Merge using the repository's permitted merge method and record the resulting full `main` commit SHA.
10. Fetch `origin/main` and verify all fixed-group manifests equal the target version at that exact commit.

## 4. Create the immutable source tag

Use a lightweight tag reference so `release.yml` can compare the ref object directly with the approved `main` commit.

1. Query `refs/tags/v<target>` first.
2. If absent, create it at the exact merged `main` SHA using the GitHub Git References API authenticated as the Release Owner.
3. If present at the same SHA, reconcile and continue.
4. If present at any other object or commit, stop. Never move, replace, or delete it.
5. Confirm the remote ref resolves to the merged `main` SHA before publication.

## 5. Dispatch the protected npm release

Dispatch `.github/workflows/release.yml` on `main` with:

```text
expected-version=<target>
channel=latest
auth-mode=oidc
```

Identify the new run by its run ID and exact `headSha`; do not attach to an older run. When the `npm-production` environment requests approval, pause and give the user the run URL. Continue monitoring after approval.

## 6. Reconcile safely

The workflow is idempotent. If it stops because npm has not exposed a newly published package:

1. Inspect the failed step and release incident.
2. Query the public npm Registry without credentials.
3. Confirm every visible target version has the expected dist-tag and immutable integrity.
4. Rerun the same workflow only when the failure is a verified propagation/reconciliation condition.
5. Never republish an existing version, alter its tarball, or move the source tag.

For any other failure, stop and report the direct trigger, already-published packages, current dist-tags, tag SHA, workflow URL, and safe next action. Do not claim success from a green workflow alone.

## 7. Verify and close out

Independently verify all of the following:

- Every package in the Changesets fixed group exposes `<target>` publicly.
- The `latest` dist-tag of every package equals `<target>`.
- Remote `v<target>` resolves to the merged `main` commit.
- The GitHub Release exists, is neither draft nor prerelease, and targets `main`.
- The protected workflow completed successfully for the same commit.
- Any Release Incident for this tag has a resolution comment and is closed only after all checks pass.

Fast-forward `develop` to released `main` only when it is a true fast-forward. Otherwise create a synchronization PR; never force-push it. Remove temporary worktrees after confirming they contain no uncommitted work.

Finish with a concise report containing the version, `main` SHA, version PR, workflow run, GitHub Release, six-package Registry status, incident status, and `develop` synchronization status.
