# ADR: Reconciling the `adlc` command across the two integration efforts

**Status:** Accepted — Option C (hardened) · **Date:** 2026-06-16

## Context

Two parallel efforts each added an `adlc` command, in separate branches:

- **`feat/claude-code-integration`** (this branch) ships `@adlc/cli` with bin
  `adlc`, an **umbrella dispatcher**: `adlc <tool> [args]` routes to the 19 gate
  CLIs (`adlc spec-lint …`, `adlc rails-guard …`). The whole Claude Code
  integration — hooks, slash commands, the discovery skill, the CI scripts —
  calls `adlc <tool>`.
- **`feat/codex-integration-codex`** ships `@adlc/runner` with bin `adlc`, an
  **artifact-asserting phase runner**: `adlc run <phase>` and `adlc accept
  --ticket …` assert that required `.adlc/` phase evidence exists.

Both packages declare bin `adlc`. npm cannot install two packages that claim the
same global bin (and in the monorepo, `node_modules/.bin/adlc` links to whichever
linked last). The two grammars are different but **not overlapping**: the
dispatcher's first token is a *tool name*; the runner's first token is a *verb*
(`run` / `accept`). No existing tool is named `run` or `accept`.

The efforts are otherwise complementary: they target different harnesses (Claude
Code vs Codex), `@adlc/prosecute` uses a distinct bin (`adlc-prosecute`), the
Codex plugin and the Claude Code plugin coexist, and this branch's `release.mjs`
already auto-discovers and lockstep-publishes the new packages.

## Decision

**Option C (hardened) — unify under one `adlc` command owned by `@adlc/cli`,
delegating to `@adlc/runner` by *spawning its bin*.**

- `@adlc/cli` remains the sole owner of bin `adlc`.
- The dispatcher reserves a small set of **built-in verbs** — `run` and `accept`
  — handled *before* tool lookup, preserving the exact `adlc run <phase>` /
  `adlc accept …` grammar (so codex's existing usage is unchanged).
- A reserved verb is served by **spawning `@adlc/runner`'s own standalone bin
  (`adlc-run`) as a child process** — NOT by importing runner as a library. This
  is identical to how the dispatcher already runs tools: full process isolation
  and verbatim exit-code propagation (0/1/2). The runner is never loaded into the
  dispatcher's process.
- `@adlc/runner` **keeps a non-colliding `adlc-run` bin** (it drops only the
  colliding `adlc` bin), so it stays independently installable/usable, and the
  dispatcher has a stable bin to resolve and spawn.
- Everything else (`adlc <anything-not-a-reserved-verb>`) dispatches to
  `@adlc/<tool>` exactly as today.
- `@adlc/cli` adds a dependency on `@adlc/runner` (lockstep, like the other 19),
  so `adlc-run` is always present alongside `adlc`.

### Dispatch precedence (the contract)

```
adlc <first> [args...]
  if <first> in {--help,-h,help,--version,-v}     → dispatcher built-in
  else if <first> in RESERVED_VERBS {run,accept}  → spawn `adlc-run` <first> args...
  else if <first> is a known tool                 → spawn @adlc/<first> args...
  else                                            → unknown-tool error (exit 1)
```

Hardening enforced by tests (so the risks the adversarial review raised cannot
regress silently):

1. **Disjointness test** — asserts `RESERVED_VERBS` and the tool registry never
   intersect (no tool may be named `run`/`accept`). A reserved verb can never
   shadow a real tool, and a new tool with a reserved name fails the test rather
   than becoming unreachable.
2. **Spawn, never import** — the runner is invoked only as a spawned child; a
   test asserts `adlc run …`/`adlc accept …` propagate the child's exit code
   (0/1/2) verbatim, matching tool dispatch.
3. **Reserved verbs are a closed set** — adding a verb is a deliberate registry +
   test change, not an implicit fallthrough.

## Alternatives considered

- **B — `@adlc/runner` keeps `adlc`, rename `@adlc/cli`'s bin.** Rejected: every
  Phase A–F artifact (hooks, slash commands, discovery skill, CI scripts) calls
  `adlc <tool>`; renaming breaks all of them.
- **D — keep both bins under different names** (`adlc` for the dispatcher,
  `adlc-run` for the runner). Lower effort and zero shadowing risk, but ships two
  top-level commands and loses the single-entry-point property the dispatcher was
  created for. Acceptable fallback if unification proves costly.

## Consequences

- **Backward compatible both ways**: `adlc spec-lint …` and `adlc run p5` /
  `adlc accept …` all keep working; no caller changes.
- **Single entry point** preserved — one command for the whole lifecycle.
- **New coupling**: `@adlc/cli` now depends on `@adlc/runner`. Both are already
  lockstep-versioned, so this adds no release complexity beyond the existing
  repin-all behavior. Because the dispatcher *spawns* `adlc-run` rather than
  importing it, the coupling is a runtime resolve, not a hard module link — the
  dispatcher does not break if the runner's internals change.
- **Reserved-verb surface is guarded**: the disjointness test makes a shadowing
  collision a build failure, not a silent unreachable tool.
- **Merge ordering**: codex's work is currently uncommitted; it must be committed
  to a stable ref before the unification is implemented against it. This ADR does
  not modify any codex file.

## Resolved questions (from the Gemini-3.5-Flash adversarial review)

The review of the original (un-hardened) proposal raised coupling, process-
isolation loss, and shadowing. Resolutions, now folded into the Decision above:

1. **Library import vs spawn → spawn.** The dispatcher spawns `adlc-run` as a
   child (process isolation + verbatim exit codes), consistent with how it runs
   every tool. The runner is never imported into the dispatcher process.
2. **Reserving `run`/`accept` vs an `adlc phase …` prefix → keep bare verbs.** A
   prefix would change codex's existing `adlc run <phase>` grammar and break its
   users; bare verbs preserve that grammar, and the disjointness test removes the
   shadowing risk that motivated the prefix. (`gate-manifest`'s `record`/`verify`
   are sub-verbs of a *tool*, not top-level `adlc` verbs, so there is no clash.)
3. **Closed set.** `RESERVED_VERBS = {run, accept}` is closed; expanding it is a
   deliberate registry + test change.

If the coupling or reserved surface ever proves costly, **Option D** (separate
`adlc` + `adlc-run` bins) remains the documented fallback — it trades the single
entry point for zero coupling and zero shadowing.
