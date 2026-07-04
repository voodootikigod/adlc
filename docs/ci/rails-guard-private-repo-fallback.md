# rails-guard: private-repo / free-plan fallback (issue #47)

`docs/ci/rails-guard.yml` recommends configuring the `rails-guard` job as a
required status check. That advice assumes your GitHub plan lets you
configure a required status check at all. On a private repository on GitHub's
free plan, **both** required-status-check mechanisms return 403 ("Upgrade to
GitHub Pro or make this repository public"):

```
PUT  /repos/{owner}/{repo}/branches/main/protection
POST /repos/{owner}/{repo}/rulesets
```

On that plan tier the `rails-guard` job still runs and reports red/green on
every PR, but it can never be made *blocking* — a maintainer (or an admin
merge button) can merge straight past a failing `rails-guard` run, which
undercuts the "unbypassable backstop" framing used elsewhere in these docs.

If you are integrating this template into a private/free-plan repo, do not
rely on `rails-guard` as a standalone required check. Use the fallback below
instead: fold the rail-freeze step into a job you already have configured as
required (commonly your main `test`/CI job) so a rail violation fails a check
GitHub will already block merges on.

## Fold-into-existing-required-job fallback

Don't ship `rails-guard` as a standalone job. Fold the rail-freeze step into
the job that backs your EXISTING required check instead, e.g. the main `test`
job in `.github/workflows/ci.yml`. Sketch (this is a documentation example,
not a functional job definition — port the bootstrap-acknowledgement /
trust-root / CODEOWNERS self-protection checks from the standalone job in
`rails-guard.yml` if you adopt this pattern; they are safety properties of the
gate, not artifacts of it running as its own job):

```yaml
jobs:
  test:                            # <- your EXISTING required job
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<pinned-sha>
        with:
          fetch-depth: 0            # rails-guard needs full history for the diff
      - uses: actions/setup-node@<pinned-sha>
        with:
          node-version: 20
      - name: Fetch base ref
        env:
          BASE_REF: ${{ github.base_ref }}
        run: git fetch --no-tags origin "$BASE_REF:refs/remotes/origin/$BASE_REF"
      - name: Rail-freeze gate (folded into the required job — issue #47)
        run: |
          npm install -g --ignore-scripts @adlc/cli@1.1.0
          adlc rails-guard --base "origin/${{ github.base_ref }}" --ticket "<active-ticket-id>"
      - name: Run tests                # <- your existing test step, unchanged
        run: npm test
```

A rail violation now fails the SAME job GitHub is already configured to
require, so a rail-freeze regression blocks the merge without needing any
branch-protection or ruleset configuration at all. The trade-off: you lose
independent gate reporting in the PR checks list (one combined job instead of
two), and a status-check audit has to look inside the `test` job's logs rather
than a dedicated `rails-guard` check name. That trade is worth it on a
private/free-plan repo, where the alternative is a `rails-guard` job that
runs, reports red, and changes nothing about whether the PR can merge.

This repo (voodootikigod/adlc) is public, so its own CI does not hit this
constraint — `rails-guard` runs here as the standalone job in
`docs/ci/rails-guard.yml`. This fallback exists for downstream adopters who
deploy this template into a private repo on GitHub's free plan.

## Why this lives in its own file, not in `rails-guard.yml` itself

`docs/ci/rails-guard.yml` is one of this repo's own immutable ADLC trust
roots (see `scripts/rails-guard-ci.mjs`'s `immutableTrustRoots` list) —
editing it trips the very rail-freeze gate it implements. Documentation about
it therefore lives alongside it in this sibling file instead of inside it.
