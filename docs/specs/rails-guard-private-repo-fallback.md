# Spec — rails-guard private-repo/free-plan fallback (issue #47)

## Issue

The `rails-guard` docs/templates call the commit-time CI diff gate the "unbypassable
backstop" and instruct adopters to "make it a required check" in branch protection.
On a **private repo on GitHub's free plan**, both required-status-check mechanisms
(`PUT .../branches/main/protection`, `POST .../rulesets`) return 403 ("Upgrade to
GitHub Pro or make this repository public"). The gate still runs and reports
red/green on every PR, but nothing stops a merge past a failing run — undercutting
the "unbypassable" framing for a common repo configuration.

## Fix

Documented the 403 constraint and the worked fallback (fold the rail-freeze step
into an already-required job, e.g. the main `test` job, instead of shipping it as
a standalone, non-requireable check) in a new standalone doc,
`docs/ci/rails-guard-private-repo-fallback.md` — **not** inside
`docs/ci/rails-guard.yml` itself, because that file is one of this repo's own
immutable ADLC trust roots (`scripts/rails-guard-ci.mjs`'s `immutableTrustRoots`
list) and editing it trips the very rail-freeze gate it implements (confirmed:
an earlier draft of this fix edited it directly and failed this repo's own
`rails-guard` CI check). Added a matching caveat + pointer to the new doc
everywhere the docs tell an adopter to "make it a required check":
`docs/README.md`, `docs/integrations/claude-code.md`, `docs/integrations/opencode.md`,
`docs/integrations/antigravity.md`, and `docs/integrations/cursor.md`. This repo
(`voodootikigod/adlc`) is itself public, so its own CI is unaffected and continues
to run `rails-guard` as a standalone required job — the fallback is documentation
for downstream adopters, not a change to this repo's `.github/workflows/ci.yml`.

## Acceptance criteria

1. `docs/ci/rails-guard-private-repo-fallback.md` names the 403 constraint (both
   the branch-protection and rulesets endpoints) and sketches the
   fold-into-existing-job fallback. `docs/ci/rails-guard.yml` itself is untouched.
2. Every integration doc that recommends "make it a required check"
   (claude-code, opencode, antigravity, cursor) also surfaces the private-repo
   caveat and points at the fallback doc.
3. `docs/README.md`'s CI-templates index flags the caveat and links the fallback doc.
4. No regression in the existing `rails-guard` CI-template test suite, and this
   repo's own `rails-guard` CI check stays green (the fix touches zero trust-root
   files).

## Verification

```sh
node --test scripts/test/rails-guard-private-repo-fallback.test.mjs
node --test scripts/test/*.test.mjs
node --test packages/rails-guard/test/*.test.mjs
node --test apps/docs/test/*.test.mjs
```

All four pass as of this change (7/7, 165/165, 58/58, 12/12 respectively).
