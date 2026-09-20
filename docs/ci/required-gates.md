# Required Gates and Gate Liveness

This document describes the declaration of merge-blocking status checks in `docs/ci/required-gates.json` and the `scripts/gate-liveness.mjs` meta-gate.

## Single Source of Truth

`docs/ci/required-gates.json` records every GitHub Actions workflow in `.github/workflows/` that runs on `pull_request` or `pull_request_target`, and classifies every job as either:
- **blocking: true** — with its required status-check `contexts` as reported by GitHub Actions (`integration_id` 15368).
- **blocking: false** — with a one-line `why` explaining why the check is advisory or covered elsewhere.

`scripts/test/gate-liveness.test.mjs` enforces bijectivity in both directions: every PR workflow and job in `.github/workflows/` must be classified, and every classified job must exist in the YAML.

The `scripts/gate-liveness.mjs` tool is strictly read-only: it queries the GitHub ruleset API and never writes to GitHub.

## Adding or Retiring a Gate

1. Update `docs/ci/required-gates.json` with the new or modified job classification.
2. For any change to merge-blocking contexts, update `docs/github-rulesets/main-branch-ruleset.json` in the same change so the committed ruleset remains in sync.
3. If changing workflow triggers or jobs, update the corresponding workflow file under `.github/workflows/`.
4. Run `node --test scripts/test/gate-liveness.test.mjs` to confirm bijectivity and agreement.
5. After merge, a repository admin updates the live GitHub ruleset as described below.

## Admin Procedure: Updating the Live Ruleset

The live branch protection ruleset for `main` (ruleset `17662766`) must be updated by a repository admin using `gh api`.

### 1. Fetch current ruleset
```sh
gh api repos/voodootikigod/adlc/rulesets/17662766 > /tmp/ruleset-before.json
```

### 2. Generate updated payload
Use `node scripts/gate-liveness.mjs --contexts` to get the declared contexts and format each with `integration_id` 15368:
```sh
jq --argjson ctx "$(node scripts/gate-liveness.mjs --contexts)" '
  {
    name,
    target,
    enforcement,
    conditions,
    bypass_actors,
    rules: (.rules | map(
      if .type == "required_status_checks" then
        .parameters.required_status_checks = ($ctx | map({ context: ., integration_id: 15368 }))
      else
        .
      end
    ))
  }
' /tmp/ruleset-before.json > /tmp/ruleset-after.json
```

### 3. Apply the updated ruleset
```sh
gh api -X PUT repos/voodootikigod/adlc/rulesets/17662766 --input /tmp/ruleset-after.json
```

### 4. Verify
```sh
node scripts/gate-liveness.mjs
# Expected: exit 0
```
Note: `docs/github-rulesets/apply.sh` now applies the same six contexts from `main-branch-ruleset.json`.

## Consequences for Admins

Once `rails-guard` is a required status check:

1. **Immutable Trust Root Changes**: In a single-collaborator repository where separation-of-duties review cannot occur, a pull request modifying an immutable trust root (`.github/workflows/ci.yml`, `CODEOWNERS`, `scripts/rails-guard-ci.mjs`, `scripts/preflight.mjs`, `package.json`) remains red on `rails-guard` by design. An admin must merge such PRs using the admin bypass.
2. **Direct Push Manifest Updates**: Direct pushes to `main` (e.g. `adlc ticket complete` adding a manifest segment) make existing open PRs show `rails-guard` red until their branches are rebased or merged with `main`.
3. **Fork Pull Requests**: A pull request from a fork that touches a trust root requires the `trust-root-change` label applied before the contributor's last push (the workflow evaluates labels from the event payload), followed by an approving review from the repository owner and a re-run of the check.
