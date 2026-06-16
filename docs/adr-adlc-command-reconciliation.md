# ADR: Reconciling the `adlc` command across the two integration efforts

**Status:** **Accepted — Option D** (separate concern-focused bins), given the
multi-harness roadmap (Claude Code, Codex, Cursor, opencode, …). Supersedes the
earlier Option C (unify) decision, preserved below as decision history. See the
Revision section for the accepted design. · **Date:** 2026-06-16

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

## Implementation notes (cautions from the second review pass)

These are binding on the implementation; each maps to how the dispatcher already
runs tools, so they add no new mechanism:

1. **Resolve `adlc-run` BY PATH, never via `$PATH`.** On a global install only
   `@adlc/cli`'s own `adlc` bin lands on the global PATH; its dependency's
   `adlc-run` does not. The dispatcher must resolve `@adlc/runner`'s declared bin
   the same way it resolves a tool — `createRequire(...).resolve('@adlc/runner/
   package.json')` → read `bin` → `spawn(process.execPath, [binPath, ...argv])`.
   A `spawnSync('adlc-run', …)` PATH lookup would fail under global install.
2. **Inherit stdio** on the spawned child (`stdio: 'inherit'`), so `adlc run` /
   `adlc accept` output and any interactivity reach the user unchanged. A test
   asserts this.
3. **Forward argv verbatim, verb included.** `adlc run p5` spawns the runner with
   `["run","p5"]` — the runner's existing first-positional grammar is unchanged
   (its bin is the old `adlc` bin, only renamed). A test asserts exit-code
   fidelity (0/1/2) and that the verb reaches the runner.

---

## Revision (2026-06-16): multi-harness roadmap → Option D supersedes Option C

### New context

The ADLC integration is not one-off: similar thin plugins are planned for
**Codex, Cursor, opencode, and more**. The primary callers of the command surface
are therefore **N independent, thin harness adapters**, not humans typing.

### The layers

Three genuinely distinct concerns, all harness-agnostic:

- **Tools** — the 19 atomic gate bins (`spec-lint`, `rails-guard`, …).
- **Dispatcher** (`adlc <tool>`) — sugar: one stable prefix over the 19 tools.
- **Runner** (`adlc run <phase>` / `accept`) — higher-level lifecycle-evidence
  assertion. A different job than gate dispatch.

Each harness plugin is a thin adapter wiring that harness's native primitives
(hooks, slash commands) to these commands.

### Decision (ACCEPTED — supersedes Option C)

**Option D — separate, concern-focused bins.** Do NOT overload one command.

- `adlc <tool>` — dispatcher (`@adlc/cli`). Unchanged.
- `adlc-runner <verb> …` — runner (`@adlc/runner`), a **single** bin with
  `run` / `accept` subcommands (`adlc-runner run <phase>`,
  `adlc-runner accept --ticket …`). This is the minimal change to the runner
  package: its bin already parses `run`/`accept` as the first positional, so it is
  only renamed `adlc` → `adlc-runner`; the grammar is otherwise unchanged.
- No reserved verbs on `adlc`, no `cli → runner` dependency, no disjointness test.

### Why the roadmap flips the decision

Overloading one command — whether "unify under `adlc`" (Option C) or "funnel
everything through the runner bin" — is the **same anti-pattern**: it puts two
concerns (gate-dispatch *and* phase-assert) behind one command. Tolerable with
one caller; a tax on **every** caller when callers multiply:

1. **Ambiguity** — `adlc <x>`: tool or verb? Every plugin author must hold that
   model. With separate bins, `adlc <x>` is *always* a tool, `adlc-runner <x>` is
   *always* a runner subcommand. Zero precedence logic.
2. **Coupling** — Option C makes `@adlc/cli` depend on `@adlc/runner`; they must
   move together. Separate bins evolve independently.
3. **Reserved-surface fragility** — Option C's `run`/`accept` can never collide
   with a tool name, forever, enforced by a test on every change. Separate bins
   have no such constraint.
4. **Minimal deps per plugin** — a harness integration that only runs gates pulls
   `@adlc/cli`; one that asserts phases pulls `@adlc/runner`. Neither is forced to
   take both.

Cost: two top-level commands instead of one. Acceptable: the primary callers are
plugins, for which two unambiguous commands beat one overloaded command; and the
docs are one sentence per harness ("gates: `adlc <x>`; phases: `adlc-run <x>`").
This costs the Claude Code side nothing — Phase A–F never calls `run`/`accept`.

### Companion direction: share the harness-agnostic logic, not just the bins

Today the Claude hook (`hooks/adlc-hook.mjs`) and the Codex hook
(`plugins/adlc-codex/hooks/adlc-rails-guard.mjs`) are **separate implementations
of the same rails logic**. With N harnesses that is N drifting copies of
security-critical code. Factor the harness-agnostic decision logic (rails
parsing, the bash-write lexer, the fail-closed contract) into a **shared library**
(`@adlc/core` or a new `@adlc/hook-core`). Each harness plugin then keeps only the
thin native binding: *read this harness's hook payload → call the shared logic →
emit this harness's response format.* One source of truth for the dangerous
logic, N thin bindings.

### Refinements (from the Option D adversarial review)

The Gemini-3.5-Flash review confirmed separate bins over unify and sharpened the
design. All three are folded into the accepted decision:

1. **Runner is ONE bin with subcommands, not two top-level commands.** Use
   `adlc-runner run …` / `adlc-runner accept …`, never separate `adlc-run` +
   `adlc-accept` bins. Fewer top-level commands, and it matches the runner's
   existing first-positional grammar (rename only).

2. **Plugins must declare exactly the bins they use** — separate bins move
   install-correctness onto each adapter, so a plugin calling `adlc-runner` while
   only `@adlc/cli` is installed gets command-not-found. Mitigations:
   - each harness plugin's install docs/manifest names its required packages
     (`@adlc/cli` for gates, `@adlc/runner` for phases);
   - ship an **`@adlc/all`** convenience meta-package (depends on every bin) for
     "install the whole suite" flows, so a plugin can require that one package;
   - a plugin should **detect a missing bin and fail with a clear install
     message**, not an opaque ENOENT.

3. **An enforcing hook's fail-closed guarantee cannot live only in JS.** If the
   hook crashes, the JS fail-closed logic never runs. The review proved this was a
   live bug in the Phase D hook: its global `try/catch … process.exit(0)` swallowed
   *any* exception in `rails` mode → no deny → exit 0 → the harness allowed the
   edit (**fail open on crash**). **Fixed**: the global handler is now mode-aware —
   in `rails` mode a caught exception emits a deny and `exit 2` (Claude Code blocks
   the PreToolUse call), while the advisory modes still swallow and exit 0. The
   same pass found that the bash guard ignored `rm`/`mv` (so `rm .adlc/tickets.json`
   or `rm <rail>` disabled enforcement); **fixed** by treating `rm`/`mv` operands
   (and `cp`/`install` destinations) as mutation targets. For *other* harnesses,
   the principle still holds: configure each so a hook *crash* (non-zero/uncaught
   exit) is treated as deny for the enforcing hook. The shared hook library
   (companion direction) holds the *decision* logic; the *fail-closed-on-crash*
   guarantee is a harness-binding responsibility, documented per harness.
