# Spec — Consolidate the replicated ADLC phase routers (T13, P1)

**Phase:** P1 working spec for ticket **T13**. Deliverable of the eventual build is a single
canonical router source + a generator + a drift check that keeps all five harness routers in
sync. This spec makes the design decisions the ticket left open and states testable acceptance
criteria.

## Problem

ADLC phase-router content is spread across five harness plugins in three file conventions, and
the harnesses fall into **two content classes** (verified by counting `phase|adlc-gate` pairs in
each file — do not assume all five are identical):

- **Full-map routers** — enumerate the P0–P7 → gate map:
  - `plugins/adlc-claude-code/skills/adlc/SKILL.md` — prose, YAML frontmatter (~20 pairs)
  - `plugins/adlc-opencode/skill/adlc.md` — table + prose, `---` frontmatter (~16 pairs)
  - `plugins/adlc-cursor/rules/adlc.mdc` — Cursor `.mdc` table, frontmatter (~16 pairs)
- **Minimal / delegating routers** — a short skill that delegates to `adlc preflight` / `adlc run`,
  with **no** per-phase P0–P7 map (~3 pairs):
  - `plugins/adlc-codex/skills/adlc/SKILL.md` — prose, YAML frontmatter
  - `plugins/adlc-pi/skills/adlc/SKILL.md` — prose, YAML frontmatter

Two kinds of content are shared and therefore drift-prone: (a) the **P0–P7 phase→gate map**, shared
across the three full-map routers; (b) the **adversarial-review discoverability block** (from PR
#55), shared across **all five**. An edit to either can update some harnesses and miss others —
which happened in PR #55, where the adversarial-review block was initially omitted from opencode and
cursor and flagged by two independent reviewers as a drift hazard.

## Design decisions (made concrete here)

- **Canonical source:** one **ES module** `scripts/router/router-model.mjs` that `export`s the
  router model object — **no YAML/JSON parser, zero new dependency** (the generator `import`s it
  directly). Chosen over a YAML file specifically to remove supply-chain surface and the
  block-scalar truncation risk that a parser introduces on gate text containing `:`/backticks/`|`.
  It holds a `shared` block with **independently-addressable sections** — `phase_map` (the ordered
  P0–P7 → gate map + per-phase gate text) and `adversarial_note` (the PR #55 discoverability block) —
  and a `harnesses` map keyed by harness id. Each harness entry carries `path`, `format`
  (`prose` | `table`), `frontmatter` (verbatim string emitted at file top), an **`includes`** list
  naming which shared sections that harness renders, and optional `harness_specific` sections (prose
  unique to that harness). This models the two content classes: full-map harnesses
  (claude-code, opencode, cursor) `include: [phase_map, adversarial_note]`; minimal harnesses
  (codex, pi) `include: [adversarial_note]` only, keeping their short delegating body as
  `harness_specific` — the generator must **not** push `phase_map` onto codex/pi (AC5 guards this:
  their baseline has ~3 pairs, so an injected full map trips ROUTING DRIFT).
- **Generator:** `scripts/router/gen-routers.mjs` **imports the canonical ES module
  `router-model.mjs` directly** (no YAML/JSON parsing) and renders each of the five target files
  via a per-`format` template (prose renderer for the three SKILL.md; table renderer for opencode
  `adlc.md` and cursor `.mdc`), writing frontmatter + shared content + that harness's specific
  sections.
- **Drift check:** `scripts/router/gen-routers.mjs --check` regenerates each target in memory and
  compares to the committed file; it exits non-zero listing any drifted paths, and exits 0 when all
  five match. A CI workflow runs it as a required check.
- **Consolidation equivalence check (deliverable, not an inline shell one-liner):**
  `scripts/router/check-consolidation.mjs <BASE>` verifies the consolidation preserved each harness's
  routing and frontmatter versus the pre-consolidation baseline. It (1) **asserts `<BASE>` is a
  non-empty, resolvable commit and exits non-zero with an error if not** — never a silent pass on an
  empty/unresolved ref; (2) for each of the five routers, parses the phase→gate structure
  **structurally per format** (markdown table columns for `.mdc`/opencode; heading-scoped blocks for
  prose) rather than a whole-line regex, so multi-reference lines and same-line swaps cannot produce
  false negatives; (3) compares that structure and the frontmatter block between `git show BASE:<f>`
  and the working file; exits non-zero listing any `ROUTING DRIFT`/`FRONTMATTER DRIFT`. Being a real
  module, it is itself unit-testable and prosecutable (a golden test that a synthetic swap and a
  frontmatter mutation are both caught).
- **Content baseline:** the current committed form of the five router files (post-PR-#55) is the
  source of truth for extracting `shared` vs `harness_specific` content — diff the five files to
  separate common from harness-unique.
- **Baseline ref (`$BASE`) for AC5/AC8.** `$BASE` is **computed at check time** as
  `git merge-base origin/main HEAD` (falling back to local `main` when no remote is present) — the
  branch point, i.e. the pre-consolidation router state. `origin/main` is used because a CI checkout
  typically has no local `main` branch, only the remote-tracking ref. No committed baseline file (a
  `.adlc/*`-stored sha would be gitignored; `.gitignore` only negates `tickets.json`). AC5/AC8
  compare generated output against `$BASE`, never `HEAD` — on a branch that has already committed the
  refactor, `HEAD` holds the refactored files, so a `HEAD` baseline compares refactored-vs-refactored
  and cannot detect a regression (a hollow check). Because T13 is rebased onto post-PR-#55 `main`
  (see Dependency), that merge-base is the post-PR-#55, pre-consolidation state AC4/AC5/AC8 expect.
  If AC5/AC8 are wired into a CI job, that job must `checkout` with `fetch-depth: 0` so the merge-base
  commit is present.
- **Dependency on PR #55.** T13 consolidates the very routers PR #55 edited, and **AC4** requires the
  PR #55 discoverability content (`adversarial-review` at P1/P3/P5, `exit 0 = SHIP`) to be present in
  all five. So T13 must be **built on top of PR #55** (rebased onto post-PR-#55 `main`); the computed
  `$BASE` (`git merge-base origin/main HEAD`) is that post-PR-#55, pre-consolidation router state. Building T13 before PR #55 merges would
  make AC4 fail and `$BASE` wrong.

## Non-goals

- No change to the phase→gate routing itself (pure refactor of how the routers are produced).
- No new harness. No change to `.adlc/` gates or the CLI dispatcher.
- Not adding a sixth harness router; if a harness is added later it becomes a new `harnesses` entry.

## Acceptance criteria

Each has a concrete verification method (this spec must pass `spec-lint`).

- **AC1** — *Verify:* `node -e "import('./scripts/router/router-model.mjs').then(m=>{const o=m.default||m.routerModel;if(!o.shared||!o.harnesses)process.exit(1)})"` exits 0 — the canonical ES module exports a model with `shared` and `harnesses`.
- **AC2** — *Verify:* `node scripts/router/gen-routers.mjs && git diff --exit-code plugins/adlc-claude-code/skills/adlc/SKILL.md plugins/adlc-codex/skills/adlc/SKILL.md plugins/adlc-pi/skills/adlc/SKILL.md plugins/adlc-opencode/skill/adlc.md plugins/adlc-cursor/rules/adlc.mdc` exits 0 — generated output equals the committed five routers on a clean checkout.
- **AC3** — *Verify:* `printf '\\n<!-- drift -->\\n' >> plugins/adlc-cursor/rules/adlc.mdc; node scripts/router/gen-routers.mjs --check; test $? -ne 0; git checkout plugins/adlc-cursor/rules/adlc.mdc; node scripts/router/gen-routers.mjs --check` — the check exits non-zero on a hand-edited router and exits 0 after regeneration.
- **AC4** — *Verify:* `for f in plugins/adlc-claude-code/skills/adlc/SKILL.md plugins/adlc-codex/skills/adlc/SKILL.md plugins/adlc-pi/skills/adlc/SKILL.md plugins/adlc-opencode/skill/adlc.md plugins/adlc-cursor/rules/adlc.mdc; do grep -q 'adversarial-review' "$f" && grep -q 'exit 0 = SHIP' "$f" || echo "FAIL $f"; done` prints nothing — the PR #55 discoverability content survives in all five generated routers.
- **AC5** — *Verify (routing preserved per harness; structured parse, not whole-line regex; baseline `$BASE`, NOT `HEAD`):* `node scripts/router/check-consolidation.mjs "$(git merge-base origin/main HEAD 2>/dev/null || git merge-base main HEAD)"` exits 0 with no `ROUTING DRIFT` — each harness's phase→gate structure is identical between the pre-consolidation baseline and the generated output, so no routing was added, dropped, or swapped (the check parses table columns / heading-scoped prose blocks structurally, so a same-line swap cannot false-negative).
- **AC6** — *Verify:* `adlc spec-lint docs/specs/router-consolidation.md` exits 0 (this spec has zero wishes).
- **AC7** — *Verify:* `test -f .github/workflows/router-drift.yml && grep -nE 'gen-routers.mjs --check' .github/workflows/router-drift.yml` confirms the drift check is wired as a CI workflow.
- **AC8** — *Verify (frontmatter fidelity — a mishandled frontmatter silently breaks plugin loading while grep stays green; all five routers carry `---` frontmatter, opencode included):* `node scripts/router/check-consolidation.mjs "$(git merge-base origin/main HEAD 2>/dev/null || git merge-base main HEAD)" --frontmatter` exits 0 with no `FRONTMATTER DRIFT` — each router's leading `---` frontmatter block is byte-identical to its pre-consolidation baseline.
- **AC9** — *Verify (no silent pass on an unresolved baseline — an empty `<BASE>` must NOT degrade to `git show :<f>` comparing a file to the index):* `node scripts/router/check-consolidation.mjs "" ; test $? -ne 0` — the check exits non-zero (with a clear "baseline unresolved" error) when handed an empty/invalid `<BASE>`, rather than silently passing.

Suppressions are denied.

## Build sequencing (premortem-driven)

To keep the consolidation reviewable and avoid hiding a routing regression inside reformat churn
(premortem finding #1), the build lands in **two commits**: (1) a **content-preserving reformat**
of the five committed routers to exactly match generator output — reviewed as whitespace/format
only, with AC5 + AC8 green; then (2) introduce `router-model.mjs` + the generator + the drift CI.
The drift check must be a **required** status check, not advisory (premortem finding #3).

## Risks (seed for premortem)

- **Byte-exact reproduction.** AC2 requires the generator to reproduce the committed files
  byte-for-byte; the initial build must reformat the committed files to match generator output in
  the same change so `git diff --exit-code` is clean.
- **Losing harness-specific prose.** If the shared/specific split is wrong, a harness loses unique
  content (e.g. cursor's rails-guard note). Mitigated by AC5's per-harness routing-content diff and
  a human read of each generated file against its pre-consolidation form.
- **Frontmatter fidelity.** Each router's frontmatter (name/description/globs) must be emitted
  verbatim per harness, or the plugin fails to load. The `frontmatter` field is verbatim, not
  templated.
- **Adding a dependency (RESOLVED).** Using an ES-module canonical source (`router-model.mjs`,
  `import`ed directly) means **no YAML/JSON parser and no new dependency** — this risk is designed
  out, per the design decision above.
- **Correctness vs. reproducibility (premortem #6).** `git diff --exit-code` (AC2) only proves the
  generator reproduces what is committed, not that the committed output is correct. AC5 (routing-set
  equality vs. HEAD) and AC8 (frontmatter equality vs. HEAD) are the correctness anchors; the build
  must also prosecute the generator with a golden test, not a hollow "it ran" assertion.
- **Single source → single point of failure (premortem #3).** One bad edit to `router-model.mjs`
  now breaks all five harnesses at once. Mitigated by the required drift check + AC5/AC8 running in
  CI on every change to the model or generator.
