# Spec note — CI adversarial-review template (issue #60)

**Phase:** P1-lite record for a documented CI template deliverable (no ticket rails).

## Issue

[voodootikigod/adlc#60](https://github.com/voodootikigod/adlc/issues/60): `.github/workflows/ci.yml`
has no `adversarial-review` job, and `docs/ci/adlc-maintenance.yml` deliberately excludes
LLM-backed gates by design. Adversarial review was reachable only if a human remembered to run
`npx adversarial-review` before merging — CI, the layer that "can't be forgotten under pressure,"
didn't know the gate existed.

## Acceptance criteria

1. `docs/ci/adversarial-review.yml` exists as a documented, **not force-installed** template
   (same pattern as `docs/ci/adlc-maintenance.yml`) — not wired into `.github/workflows/` by
   this change.
2. Path-filters PRs to the ADR-0007 risk tiers: auth/trust boundary, security controls/deny
   paths (rail guards, validators, sandboxes), secrets handling, data-loss/destructive/
   irreversible ops, schema/migration changes, CI/CD/supply-chain config.
3. On a matching PR: runs `npx adversarial-review --base origin/$BASE --providers auto
   --fail-on high`, posts the report as a PR comment, and records the verdict via
   `adlc gate-manifest record adversarial-review`.
4. On a non-matching PR: runs a cheap single-model pass (no `--providers`) instead of the full
   quorum, informational only (never blocks, no gate-manifest record) — cost control per
   ADR-0007.
5. Uses **plain (non-loop)** review mode throughout, never `--loop`, with a comment explaining
   why. Historically ([voodootikigod/adversarial-review#9](https://github.com/voodootikigod/adversarial-review/issues/9),
   filed against v2.5.1) `--loop` silently dropped `--providers`, which would have defeated the
   multi-provider quorum without any visible error; that bug is fixed as of the 2.6.0 pin this
   template uses. The durable reason plain mode is required here is unrelated to #9: `--loop`
   only supports `--scope working-tree` and hard-errors on `--base <ref>`/`--scope branch`
   (confirmed against 2.6.0's `src/loop.js`), which is incompatible with this gate's read-only
   `--base origin/$BASE_REF` diff review of a PR.
6. `docs/toolkit.md` and `docs/README.md` reference the new template, mirroring how
   `docs/ci/adlc-maintenance.yml` is referenced elsewhere in the repo.

## A pre-existing bug found and fixed en route

`docs/toolkit.md` documented `gate-manifest record adversarial-review --evidence 'k=v; k=v'` as
"the exact evidence-string convention" (also quoted verbatim in issue #60's proposed direction).
The real `gate-manifest` CLI (`packages/gate-manifest/bin/gate-manifest.mjs`) has no `--evidence`
flag — only `--ticket`, `--data '{json}'`, `--files`, `--dir`, `--json` — and node's strict-mode
`parseArgs` throws an uncaught `ERR_PARSE_ARGS_UNKNOWN_OPTION` on any unknown flag (confirmed by
running it directly). Since the CI template's whole job is to actually invoke this command, using
the documented-but-fictional `--evidence` flag would have crashed every risk-gated PR. Fixed the
convention in `docs/toolkit.md` to the real `--data '{json}'` form (same semantic fields:
providers, iterations, verdict, exitReason, surviving, accepted) and used the corrected form in
the shipped template.

## Files changed

- `docs/ci/adversarial-review.yml` (new) — the template.
- `docs/toolkit.md` — corrected the `gate-manifest record` evidence convention (`--data`, not
  `--evidence`) and added a short section referencing the new template.
- `docs/README.md` — added the template to the "CI templates" list.
- `scripts/test/adversarial-review-template.test.mjs` (new) — structural assertions on the
  template plus a functional check that runs the real `gate-manifest` binary against the exact
  `--data` payload shape the template emits.

## Verification

```sh
node --test scripts/test/adversarial-review-template.test.mjs   # this feature's tests (17 pass)
npm test                                                         # full repo suite, no regressions
python3 -c "import yaml; yaml.safe_load(open('docs/ci/adversarial-review.yml'))"  # YAML sanity
```
