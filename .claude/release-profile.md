---
project: "@adlc suite (lockstep monorepo)"
registry: npm
package: "@adlc/core"
versionSource: packages/core/package.json
bumpCommand: node scripts/release.mjs {{version}}
changelogCommand: node scripts/changelog.mjs {{version}}
preconditions:
  - npm test
landing: pr
publishTrigger: tag
publishEnvironment: npm-publish
publishWorkflow: .github/workflows/publish.yml
tokenException: |
  Applies to: any @adlc/* package being published for the FIRST time in this release.
  Reason: npm trusted publishing is configured against an existing package, so it cannot
  create one that does not exist yet — a new package's first publish needs a real token.
  This suite is still growing, so the token stays until the package set settles.
  Known gap: the single gated `publish` job holds this token for every package, not only
  the new ones. Narrowing it needs a separate gated bootstrap job in publish.yml.
verify:
  - |
    # EVERY non-private publish target must exist at {{version}} AND have latest pointing at
    # it. Asserting dist-tags for only @adlc/core and @adlc/cli was not enough: a phase CLI
    # published under some other tag still satisfies an existence check while `npm install`
    # resolves the previous release for that package. Fail closed on both.
    fail=0
    for f in $(find packages plugins -maxdepth 2 -name package.json -not -path '*/node_modules/*'); do
      name=$(node -p "require('$PWD/$f').name || ''" 2>/dev/null)
      priv=$(node -p "require('$PWD/$f').private === true" 2>/dev/null)
      [ "$priv" = "true" ] && continue
      [ -z "$name" ] && continue
      if ! npm view "$name@{{version}}" version >/dev/null 2>&1; then
        echo "MISSING: $name@{{version}}"; fail=1; continue
      fi
      latest=$(npm view "$name" dist-tags.latest 2>/dev/null)
      if [ "$latest" = "{{version}}" ]; then
        echo "ok: $name@{{version}} (latest)"
      else
        echo "STALE TAG: $name latest=$latest expected {{version}}"; fail=1
      fi
    done
    exit $fail
---

**The bump lands via PR, never directly.** `main` carries an active ruleset requiring pull
requests and 3 status checks. This profile said `landing: direct` until 1.5.1, which contradicted
that rule — and because the maintainer has admin bypass, the contradiction was invisible: the
1.5.0 bump pushed straight to `main`, silently skipping both the PR requirement and the status
checks, and nothing complained. The version-bump commit is the worst possible one to skip checks
on, because it is the exact tree that gets tagged and published irreversibly. Branch, PR, let the
checks run, and let a human merge.

**There is a human gate.** `publish.yml` binds the publish job to the protected `npm-publish`
environment with required reviewers. Pushing the tag starts the run *waiting*, not running — the
maintainer must approve the deployment. Hand over the run URL and STOP (R1). The retired release
command never mentioned the gate and told the operator the workflow publishes automatically.

All packages are lockstep, so any package's version is authoritative; `packages/core` is the
convention.

**Do not hand-edit `package.json` or `package-lock.json`.** `scripts/release.mjs` sets the
version across `@adlc/core`, the phase CLIs, the `@adlc/cli` umbrella, every versioned
`plugins/*` package (e.g. `@adlc/pi`), and the root; repins every `"@adlc/*"` dependency
preserving each one's `^`/`~`/exact range style; and regenerates `package-lock.json`. Run it
**without** `--publish`.

The script runs two gates of its own. A non-zero exit means the release is incomplete — fix it,
do not commit a partial bump:

- **Drift gate** — every versioned `package.json`, the root, and `package-lock.json` must read
  the new version. Exists because v1.1.0 shipped with `package-lock.json` stranded at 1.0.2 and
  `plugins/adlc-pi` missed entirely. This repo is why R4 exists.
- **Publish-metadata gate** — every non-private publish target must carry a `repository.url`.
  Exists because v1.4.0 stranded a partial publish: `@adlc/tickets` had no `repository` field,
  so npm's provenance check 422'd after 27 of 34 packages had already shipped.

The script is idempotent — re-running it is a safe way to confirm no drift before committing.

Stage everything the bump touched (every `package.json` in packages *and* plugins, plus
`package-lock.json`) **and `CHANGELOG.md`**. `git status --porcelain` should show
`package-lock.json` and `CHANGELOG.md` among the changes.

**Do not trust a package count.** The retired release command claimed "21 packages" while its
own incident note described 34 targets; the two never agreed. The `verify` block enumerates the
non-private targets from the filesystem instead — that is the authority, and it is what proves
the partial-publish failure mode did not recur. Checking only `@adlc/core` and `@adlc/cli`
cannot detect a missing phase CLI: the umbrella resolving does not prove its dependencies were
published at that version.

Publish order is `@adlc/core` first, then the phase CLIs, then the `@adlc/cli` umbrella last
(it depends on every other CLI), each with `--provenance --access public`.

**Pushing the tag publishes every public package immediately and is irreversible.**

**Conformant, with one declared exception.** `npm-publish` has a required reviewer, the publish
job is bound to it, `id-token: write` is requested, and there is no repo- or org-scoped token.

**The `NPM_TOKEN` environment secret is deliberate and stays.** npm trusted publishing cannot
create a package that does not exist yet — a brand-new package's *first* publish needs a token.
This suite is still growing, so removing it would break the next package addition. The profile
declares this via `tokenException`, which is what allows the checker to pass; without the
declaration it refuses (fail-closed by default).

The exception is narrow and the approval property still holds: the token is **environment**-scoped,
so it is unreachable until a human approves the deployment. That is the whole reason environment
scope is the only tolerable place for it. A repo- or org-scoped copy would be reachable by every
job in the repo and is refused unconditionally — no exception field can permit it.

**Exit condition:** once the package set stops changing and every `@adlc/*` package has a trusted
publisher configured on npmjs.com, delete the secret and drop `tokenException`. The checker will
then flag the stale declaration. Do not delete it before every package is configured — this repo
publishes 30+ packages in one run, so a partial trusted-publisher setup fails partway through,
which is exactly the shape of the v1.4.0 incident.

**Token scope — the retired command got this dangerously wrong**, and it is worth recording why.
It said "the `NPM_TOKEN` repo secret must be set." `docs/RELEASING.md` requires the opposite:
during bootstrap `NPM_TOKEN` must be an **environment secret on `npm-publish`** — *not* a
repository or organization Actions secret — because an environment secret is unreadable from any
job that does not run under the protected gate. The docs further say that if a repo- or org-level
`NPM_TOKEN` already exists, **delete it**. Following the retired command would hand a live npm
automation token for the entire `@adlc` scope to every job in the repo, including ones that never
pass a reviewer.

The repo-scope rule still holds absolutely; only the environment-scoped bootstrap token is
permitted, and only while packages are still being added.
