# Spec — Antigravity fail-open visibility (issue #62)

## What this addresses

Issue #62 has two parts:

- **(a) Router omits adversarial-review.** Already resolved on `main` by the T13/T14
  router-consolidation work (commits `6d3d6cc`, `d5cb96e`, `0175d7d`). Verified here:
  `plugins/adlc-antigravity/skills/adlc/SKILL.md` references `adversarial-review` at
  P1 (line 27), P3 (line 29), and P5 (line 32) of the phase table. No changes needed;
  this spec does not redo that work.
- **(b) Fail-open hook risk isn't surfaced prominently enough.** The in-session
  `PreToolUse` hook (`plugins/adlc-antigravity/hooks/adlc-rails-guard.cjs`) fails
  **open** on a non-zero exit — documented in SKILL.md, but `docs/integrations/antigravity.md`'s
  **Install** section (the first thing an operator reads) said nothing about it, and
  the plugin has no README linking `scripts/rails-guard-ci.mjs` as the actual
  required-check control.

## Acceptance criteria

1. `docs/integrations/antigravity.md`'s `## Install` section contains a fail-open /
   CI-is-the-backstop callout, and that callout appears **before** the first install
   command (i.e., near the top of the section, not buried after the steps).
2. `plugins/adlc-antigravity` has no README (consistent with every other plugin in
   `plugins/`), so the closest equivalent doc — `commands/adlc-init.md`, the plugin's
   own bootstrap instructions — names `scripts/rails-guard-ci.mjs` explicitly and
   frames it as a required check in branch protection.
3. No regression in the existing antigravity plugin test suite or install smoke test.

## Verification commands

```sh
node --test plugins/adlc-antigravity/test/docs-visibility.test.mjs   # new tests for (b), RED before fix
node --test plugins/adlc-antigravity/test/*.test.mjs                 # full plugin suite, no regressions
node scripts/antigravity-install-smoke.mjs .                          # existing install smoke, no regressions
npm test                                                              # full repo suite
```

All four passed after the fix (`node --test plugins/adlc-antigravity/test/*.test.mjs`:
52/52 pass including the 3 new tests; `npm test`: full suite green).
