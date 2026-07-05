# Spec — extract shared ensureGitignore/ensureFormatterIgnores logic (issue #97)

## Issue

`ensureGitignore()` and `ensureFormatterIgnores()` (plus their private helpers
`ensureTextIgnoreFile`, `ensureBiomeIgnore`, `ensureEslintRcIgnore`,
`mergeEslintReports`) were independently hand-duplicated, byte-for-byte
except for a parameter-name difference, across `plugins/adlc-cursor/lib/
scaffold.mjs` and `plugins/adlc-opencode/lib/scaffold.mjs`. Every `.gitignore`
last-match-wins edge case found during #92's 5 review rounds had to be fixed
in both copies to keep them in sync — a future one-sided fix would silently
reintroduce drift, with nothing to catch it.

## Fix

Extracted both functions (and their private helpers) into
`packages/core/lib/scaffold-hygiene.mjs`, re-exported from `@adlc/core`'s
index — both plugins already declare `@adlc/core` as a dependency and already
import from it elsewhere (`rails-checker.mjs` in adlc-cursor). Both plugins'
`scaffold.mjs` now import and re-export the shared functions instead of
defining their own copies.

Consolidated the ~17 duplicated behavioral tests (which were also
byte-for-byte identical modulo test-fixture style) into
`packages/core/test/scaffold-hygiene.test.mjs`. Each plugin's own test file
now has a single "delegates to the shared @adlc/core implementation" test
asserting reference equality — a future edit that reintroduces a local copy
in only one plugin fails this test immediately instead of silently drifting.

## Acceptance criteria

1. `ensureGitignore`/`ensureFormatterIgnores` have exactly one implementation,
   in `packages/core/lib/scaffold-hygiene.mjs`.
2. Both `plugins/adlc-cursor` and `plugins/adlc-opencode` import (not
   reimplement) the shared functions.
3. Each plugin has a test asserting its `scaffold.mjs` exports are reference-
   equal to `@adlc/core`'s exports (fails if either plugin reintroduces a
   local copy).
4. No behavioral regression: the full consolidated test suite passes, and
   both `scripts/cursor-install-smoke.mjs` / `scripts/opencode-install-smoke.mjs`
   still pass.

## Verification

```sh
node --test packages/core/test/scaffold-hygiene.test.mjs   # 17/17 pass
node --test plugins/adlc-cursor/test/scaffold.test.mjs       # 5/5 pass
node --test plugins/adlc-opencode/test/scaffold.test.mjs     # 12/12 pass
node scripts/cursor-install-smoke.mjs .                       # PASS
node scripts/opencode-install-smoke.mjs .                     # PASS
npm test                                                      # full repo suite, exit 0
```
