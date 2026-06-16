# ADR: Reconciling the `adlc` command across the two integration efforts

**Status:** Proposed (under adversarial review) · **Date:** 2026-06-16

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

**Option C — unify under one `adlc` command owned by `@adlc/cli`.**

- `@adlc/cli` remains the sole owner of bin `adlc`.
- The dispatcher gains a small set of **reserved built-in verbs** — `run` and
  `accept` — handled *before* tool lookup. They delegate to `@adlc/runner`'s
  logic (imported as a library, or invoked as a resolved bin), preserving the
  exact `adlc run <phase>` / `adlc accept …` grammar.
- Everything else (`adlc <anything-not-a-reserved-verb>`) dispatches to
  `@adlc/<tool>` exactly as today.
- `@adlc/runner` **drops its `adlc` bin** (it becomes a library the dispatcher
  consumes, and/or keeps a non-colliding bin such as `adlc-run` for direct use).
- `@adlc/cli` adds a dependency on `@adlc/runner` (lockstep, like the other 19).

### Dispatch precedence (the contract)

```
adlc <first> [args...]
  if <first> in {--help,-h,help,--version,-v}  → dispatcher built-in
  else if <first> in RESERVED_VERBS {run,accept} → runner logic
  else if <first> is a known tool               → spawn @adlc/<first>
  else                                          → unknown-tool error (exit 1)
```

`RESERVED_VERBS` and the tool registry are validated to be **disjoint** at build
time (a test asserts no tool is named `run`/`accept`), so a reserved verb can
never shadow a real tool and vice-versa.

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
  repin-all behavior.
- **Reserved-verb surface must be guarded**: a future tool named `run`/`accept`
  would be unreachable; the disjointness test prevents that landing silently.
- **Merge ordering**: codex's work is currently uncommitted; it must be committed
  to a stable ref before the unification is implemented against it. This ADR does
  not modify any codex file.

## Open questions for review

1. Is delegating verbs to `@adlc/runner` as a **library import** safer than
   **spawning its bin**, given the dispatcher otherwise spawns tools as children
   (process isolation, exit-code fidelity)?
2. Does reserving `run`/`accept` create ambiguity with any planned tool, or with
   the existing `gate-manifest record`/`verify` sub-verb style?
3. Should `RESERVED_VERBS` be a closed set, or should the runner own a single
   namespace prefix (e.g. `adlc phase …`) to avoid ever colliding with tool names?
