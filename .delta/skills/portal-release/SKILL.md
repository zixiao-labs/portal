---
name: portal-release
description: Release zixiao-labs/portal via Delta's Merge button. Require a fresh Reviewer subagent verdict and passing pull-request CI before merging to main, then verify the production deployment.
metadata:
  delta-action: land
---

# Release the portal

Use this workflow only for `github.com/zixiao-labs/portal`, targeting `main`. A user selecting **Merge Changes** for the scoped change, or explicitly asking to land that change, authorizes this workflow. Merely invoking the skill, asking for a review, or approving a review does not authorize a merge. Loading or installing the skill never starts a release.

## 1. Pin the candidate

- Verify that `origin` fetches from and pushes to `zixiao-labs/portal` on GitHub (HTTPS or SSH), that `gh` can access that repository, and that `main` is its default branch. Never publish to the Delta `local` backlink.
- Fetch `origin/main`. Record its full SHA as `base`. Inspect all commits and changes relative to it, including staged and untracked files. If there is nothing to land, report a no-op; if the scope is ambiguous or includes unrelated edits, secrets, or unexpected generated output, stop. Do not stage everything blindly.
- Before publishing anything, verify active `main` branch protection with `gh api repos/zixiao-labs/portal/branches/main/protection`: `required_status_checks.strict` and `enforce_admins.enabled` must be `true`, `verify` must be a required check, and `allow_force_pushes.enabled` and `allow_deletions.enabled` must be `false`. An inaccessible, missing, or loose policy is a blocker: a final client-side read alone cannot prevent a base race. Do not change the GitHub settings on behalf of the user.
- Prepare a release snapshot `head` whose only parent is `base`, on a dedicated feature branch such as `delta/release-<short-sha>`. Use only approved paths and ensure the checkout matches the candidate tree. If there are multiple approved local commits atop `base`, take their final tree into a new single-parent release commit on that dedicated branch; do not reset or rewrite the source branch. If the source needs a base update or has conflicts, stop and ask for an updated candidate.

## 2. Require an independent subagent review

- Call `spawn_subthread` with the built-in `reviewer` profile. In the prompt explicitly state that the user requires subagent review and give the reviewer the full `base`, `head`, `head` tree SHA, intended scope, and repository name. Ask for a read-only review of the complete `base..head` change, including deployment risks, regressions, and validation gaps. Tell it not to publish, approve on GitHub, merge, or deploy.
- Require the reviewer to confirm it examined the exact diff and return `APPROVE` or `REQUEST_CHANGES`, both full SHAs, and evidence or findings. If the isolated checkout cannot resolve the candidate commit, the reviewer may verify that the isolated file snapshot produces the same Git tree (using a temporary index) and review that tree against `base`. If it cannot verify the exact base and candidate tree, it must not approve.
- Wait for the subagent's final response. A pass requires a completed, explicit `APPROVE` for these exact SHAs with no unresolved blocking findings. Do **not** substitute your own review, a human approval, a previous Review thread, or passing CI. If delegation is unavailable, spawning fails, the verdict is missing, or changes are requested, block the merge and explain what to do next. Any change to either SHA invalidates the verdict and CI evidence; start a fresh review on the replacement pair.

## 3. Verify the PR, then merge

- Re-read the remote `main` and confirm it is still `base`; also confirm that the local checkout has not changed. Push only the reviewed SHA to the dedicated feature branch, without force. Use `gh` to create or reuse a non-draft same-repository PR targeting `main` with exactly `head` on that branch. Note the Delta Reviewer thread link and reviewed SHAs in the PR or Merge subthread. This is not a GitHub approval.
- Wait for the latest `Verify portal` run from `.github/workflows/verify.yml` for this PR's branch and `head` (`pull_request`, not a `main` run). Discover with `gh run list --repo zixiao-labs/portal --workflow verify.yml --event pull_request --branch <feature-branch> --commit <head>` and confirm the run's commit, event, and the `verify` job's `success` with `gh run view`.
- In that successful job's **Record the tested PR revision** step log (`gh run view <run-id> --repo zixiao-labs/portal --job <verify-job-id> --log`), require the checkout's `portal-ci-parents` to be exactly `base head`, in that order, and `portal-ci-tree` to equal the reviewed candidate tree. Fetch `refs/pull/<PR>/merge` and verify its parents and tree also match before merging. Missing, pending, skipped, cancelled, or failed evidence is not green. A candidate that weakens this check cannot pass by merely reporting success. Wait for any other required GitHub checks and approvals; report links if blocked or waiting.
- Immediately before merging, re-check the PR is open, not draft, not queued or set to auto-merge, and still points from the expected same-repository branch and `head` to `main`. Re-check that remote `main` is still `base` and strict branch protection is active. If any of these changed, do not merge; an updated candidate requires fresh review and CI.
- Squash merge through GitHub's synchronous pull-request merge endpoint: `gh api --method PUT repos/zixiao-labs/portal/pulls/<PR>/merge -f merge_method=squash -f sha=<head>`. It atomically checks the head and does not enqueue or enable auto-merge; strict branch protection guards against base advances at merge time. Never directly push to `main`, force-push, bypass rules, or replace required GitHub approvals. Check for `merged: true`, verify the PR is `MERGED`, and fetch `origin/main` to confirm the resulting commit is on it. Its parent and tree must match `base` and the reviewed tree; if either differs, report the discrepancy and do not claim the exact candidate was released or revert automatically.

## 4. Verify production separately

- Existing GitHub Actions deploys on the `main` push if production deployment is enabled. Do not SSH to deploy manually, modify Secrets or Variables, or trigger a duplicate run. Find the `Verify portal` **push** run for `main` and the actual squash commit. A successful workflow alone is insufficient: check that **Deploy production portal** and its **Deploy over SSH** and **Verify public HTTPS** steps all succeeded (not skipped).
- Distinguish **merged** from **deployed**. Only confirm production after that exact run's deploy checks pass. If production is disabled, superseded, pending, or failed, name that state and link the run; do not infer deployment from an already healthy site or silently revert.
- Use the built-in `report-landed` skill for the final Delta Merge result. Use `landed` only after verifying the remote merge; include the production result in the body when it is not confirmed. Before a merge, report pending reviews or checks in ordinary prose; use `failed` for a definitive blocker with no permitted recovery.
