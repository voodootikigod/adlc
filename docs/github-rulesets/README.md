# GitHub Repository Rulesets

Reproducible branch and tag protection for this repository, expressed as GitHub
[ruleset](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets)
JSON so the configuration lives in version control instead of only in the GitHub UI.

## Files

- `main-branch-ruleset.json` — protects the default branch (`main`).
- `release-tag-ruleset.json` — protects `v*` release tags (the publish trigger).
- `apply.sh` — applies both via `gh api` (requires admin auth).

## What the main-branch ruleset enforces

| Rule | Effect |
| --- | --- |
| `pull_request` | No direct pushes — changes land via PR. Stale approvals dismissed on new commits; all review threads must be resolved; squash-only merges. |
| `required_status_checks` (strict) | CI `test (18)`, `test (20)`, `test (22)` must pass and the branch must be up to date before merge. |
| `required_linear_history` | No merge commits — pairs with squash merges. |
| `non_fast_forward` | Blocks force pushes. |
| `deletion` | Blocks branch deletion. |

`required_approving_review_count` is **0** so a solo maintainer is not blocked
(GitHub does not allow self-approval). Raise it to `1` once a second maintainer
exists. Admins (`actor_id: 5`) keep `always` bypass so the maintainer cannot be
locked out; tighten this once the team grows.

## What the release-tag ruleset enforces

`creation` + `deletion` + `non_fast_forward` on `refs/tags/v*`, with admins as the
only bypass actors. This restricts who can create release tags.

This rule is load-bearing: `.github/workflows/publish.yml` triggers **only** on a
`v*` tag push (it deliberately has no `workflow_dispatch`), so the workflow content
that runs is always the admin-controlled tagged commit. Restricting tag creation to
admins therefore restricts who can publish to npm.

The **`npm-publish` protected environment** (below) is the second layer — a required
human approval plus a deployment-ref allowlist on top of the tag gate. The npm
credential must be an **environment-scoped secret** so it is unreadable outside that
environment.

## Applying

Requires the `gh` CLI (admin auth) and `jq`.

```sh
gh auth status            # must have admin on the repo
REPO=voodootikigod/adlc ./apply.sh
```

`apply.sh` does two things:

1. **Provisions and verifies the `npm-publish` protected environment** — the real
   publish gate. It sets required reviewers and a **deployment-ref allowlist**, then
   **fails closed** unless both are actually present after the API call. This matters
   because a workflow that references a missing environment silently creates it
   *unprotected*.

   - **Required reviewers** (`REVIEWER_IDS`, default the authenticated user; 1–6
     numeric IDs, validated locally and re-checked against the API response) — a
     human approval gate on every publish.
   - **Deployment refs** (`ALLOWED_BRANCHES` default `main`, `ALLOWED_TAGS` default
     `v*`) — constrains *which code* can be published. Even an approved manual
     `workflow_dispatch` cannot publish from an arbitrary feature branch.

   ```sh
   REVIEWER_IDS=123,456 ALLOWED_TAGS="v*" ALLOWED_BRANCHES="main" \
     REPO=voodootikigod/adlc ./apply.sh
   ```

2. **Applies the branch and tag rulesets idempotently** — it matches each ruleset
   by name and updates the existing one (`PUT /rulesets/{id}`) instead of creating
   a duplicate, and refuses to act if two active rulesets already share a name. A
   re-run never strands a stale active ruleset.

> Required status checks only become matchable after the CI workflow has run once.
> Merge or run a PR first so the `test (NN)` check contexts exist.

Verify afterward:

```sh
gh api /repos/voodootikigod/adlc/environments/npm-publish | jq .protection_rules
gh api /repos/voodootikigod/adlc/rulesets
```

## Not expressible as rulesets

Set these in the GitHub UI:

- **Settings → Actions → General → Workflow permissions:** default `GITHUB_TOKEN`
  to read-only. (`publish.yml` already requests its own `id-token: write`.)
- **Settings → General → Pull Requests:** allow squash merging only; enable
  automatically delete head branches.
