# OpenCode Native Flush — making adlc-opencode robust, feature-complete, and native-feeling

Status: PROPOSED (plan for review)
Branch: `opencode-native-flush`
Inputs: full plugin audit, six-integration capability benchmark, and a verified inventory of
OpenCode's extension surface as of `@opencode-ai/plugin` v1.17.13 (July 2026).

## Why now

The integration was designed against an *assumed* OpenCode SDK (ADR 0004 lists the open
questions). The July-2026 surface answers nearly all of them, in our favor:

| Old assumption (in code/docs today) | Verified reality (v1.17.13) |
| --- | --- |
| Throwing in `tool.execute.before` may not block ("capability unproven") | **Throwing blocks the tool call.** Documented, verbatim example in plugins.mdx. |
| `input.args` vs `output.args` ambiguity | Args are on **`output.args`** only; `input` = `{tool, sessionID, callID}`. |
| Keyless bridge needs a "proposed SDK extension" | `client.session.create({parentID})` + `session.prompt` (with `outputFormat` JSON-schema structured output and `noReply`) exists today. |
| Warnings can only go to `console.error` | `client.tui.showToast`, `client.app.log`, plus a full **TUI plugin surface** (toasts, dialogs, persistent UI slots, OS notifications). |
| Commands/agents markdown is the only extension shape | Plugins can register **native model-callable tools** (`tool` hook / `.opencode/tools/`), a **`permission.ask`** programmatic allow/deny hook, `tool.definition` rewriting, `experimental.chat.system.transform`, and more. |
| `.opencode/command/`, `skill/adlc.md` layout | **Plural dirs are canonical** (`commands/ agents/ skills/ tools/ plugins/`); native skills are `skills/<name>/SKILL.md` discovered via a `skill` tool. |

## Where we stand (audit + benchmark synthesis)

adlc-opencode is the **second-most-complete** of the six integrations (after claude-code):
richest explicit phase-command surface (8 commands), 5 prosecutor lenses + verifier,
self-registering idempotent scaffold, 71/71 unit tests, CI backstop wired.

But the audit found the native seam is thin — one hook plus two session events — and four
material defects the docs don't admit:

1. **Dead code shipped as capability.** `lib/keyless-bridge.mjs`, `gate-bins.mjs`, and the
   decision half of `lib/prosecutor.mjs` are imported only by their own tests. "Phase B/E
   ship" describes tested-but-unwired libraries.
2. **The SDK-capability probe is structurally unreachable.** `index.mjs:20` destructures
   `{directory, worktree, project}` and **discards `client`**; `probeEnforcementCapability`
   then checks `.capabilities` on the wrong object. Enforcement today is env-var-only.
3. **`patch`/`multiedit`/`apply_patch` silently bypass the guard.** Only `args.filePath` is
   read; tools without that field return early → the write is allowed with zero signal,
   contradicting the ADR threat model.
4. **The advisory layer may be invisible.** Everything goes to `console.error`; TUI
   visibility was never established. The default fail-closed deny path emits *nothing* if a
   throw were swallowed.

Benchmark gaps vs best sibling (ranked): blocking rails (CC/codex/pi), build-gate
context-rot backstop (CC), shell-mutation gating (codex/pi), flail detection (CC),
`adlc-maintain` + maintenance cron (CC), `prosecutor` meta-agent (CC/agy), TUI statusline
(pi), per-turn ticket-context injection (pi), suppression-marker revert + scope
enforcement (pi).

## The plan

Phases ordered by risk-reduction per unit effort. Each phase is independently shippable
and prosecutable (P5) before the next begins.

### Phase 1 — Fix the hook we already have (correctness, small diffs)

1.1 **Capture `client` and `$` from `PluginInput`** in `index.mjs`; thread `client` into the
    hook closures and session hooks.
1.2 **Pin the payload contract**: read args from `output.args` (keep a tolerant fallback),
    extract `filePath` for edit/write and `command` for bash. Delete the
    `input.args`-first guess and the ADR "pinning pending" caveat.
1.3 **Enforce by default.** Throwing blocks — retire `probeEnforcementCapability` and the
    `ADLC_OPENCODE_ENFORCES` opt-in; keep `ADLC_ALLOW_ADVISORY_HOOKS` only as an explicit
    downgrade escape hatch. Update ADR 0004 + docs/integrations/opencode.md (the
    "advisory until proven" posture, Gap 1, and the Status overstatements from audit §3.1).
1.4 **Fail closed on unextractable paths from mutating tools.** If `tool` is mutating
    (patch/multiedit/apply_patch/…) and no path can be extracted, deny with a clear
    message instead of silently allowing. Add arg-shape handling for multi-file payloads
    (`files[]`, patch body paths) as they're pinned against real payloads. Keep the
    existing unknown-tool-name fail-closed posture, and add a test that registers a
    **synthetic unknown write tool** and proves the deny path fires for it.
1.5 **Normalize tool names** (`toLowerCase()`) before allowlist/mutator checks.
1.6 **Deny visibly.** On every deny (and every advisory warning), call
    `client.tui.showToast({variant:'error'|'warning'})` with `console.error` retained as
    fallback; route audit trails through `client.app.log`.
1.7 **Scaffold to canonical plural layout**: `commands/`, `agents/`, and native skill shape
    `.opencode/skills/adlc/SKILL.md` (frontmatter `name` + `description` so the `skill`
    tool discovers it). Migrate idempotently; leave back-compat copies out.
1.8 Hygiene: fix the dangling `/adlc-rail-write` reference in `adlc-decompose.md`; add
    `agent/*.md` to the manual-install fallback in `adlc-init.md`.

Exit: live deny proof (ADR 0004 AC7) now automatable — script an `opencode` server via
`@opencode-ai/sdk`, drive an edit to a frozen rail, assert the block and the toast.
This becomes `scripts/opencode-live-deny.test.mjs` and is wired as a **required CI
gate**, not an optional job — a refactor of the `output.args` read path must not be
able to silently kill the deny throw and still merge. On the private-repo free plan
(where required checks 403), fold it into the existing required job, mirroring the
rails-guard CI fallback. Follow-on: run it against a small **version matrix** of
OpenCode releases (current + latest) to catch upstream hook-contract drift.

### Phase 2 — Enforcement depth (close the benchmark's top gaps)

2.1 **`permission.ask` second lever.** Register the hook; when the permission targets a
    frozen rail, set `output.status='deny'`. Belt-and-braces with the throw, and it covers
    permission-mediated paths the tool hook doesn't see.
2.2 **In-session shell gating.** Port adlc-codex's shell parser (fail-closed on opaque
    commands) into `tool.execute.before` for `bash` via `output.args.command`. Same
    posture as codex: parseable mutating command against a rail → deny; unparseable +
    rail-relevant heuristics → deny with explanation (CI gate remains the backstop).
2.3 **Build-gate context-rot backstop** (port CC issue #48): a second enforcing check in
    `tool.execute.before` that denies structured edits on high-risk tickets when the
    session's context-fitness degrades. Signals available natively: `session.compacted`
    events, `experimental.compaction.autocontinue`, message counts via `client.state`.
2.4 **Suppression-marker + scope enforcement (pi parity):** `tool.execute.after` +
    `file.edited` event watcher that flags/reverts unapproved `@ts-ignore` /
    `eslint-disable` / `.skip(` introductions and edits outside the active ticket's
    `scope`, using `$` (Bun shell) for the git revert. Advisory first, opt-in enforcing.

2.5 **Tool-name-independent rail backstop.** The pre-write guards in 1.x/2.1/2.2 key off
    tool names and arg shapes — but OpenCode lets *any other plugin* register new
    model-callable write tools (e.g. a third-party `write_file`) that our lists have
    never seen. Close the class, not the instance: (a) subscribe to the `file.edited`
    event and, when the edited path resolves to a frozen rail, revert via git and toast
    loudly — enforcement that holds regardless of which tool performed the write; (b)
    register `permission.ask` at global scope so any permission whose target resolves
    to a frozen rail is denied no matter which tool raised it. Test with a synthetic
    third-party write tool registered alongside the plugin (shares the 1.4 fixture).

### Phase 3 — Native feel & visibility

3.1 **Per-turn ticket-context injection** via `experimental.chat.system.transform`:
    append active ticket id, scope, and frozen rails to the system prompt each turn
    (pi's F1/F3 context-rot defense).
3.2 **`tool.definition` annotation**: rewrite the `edit`/`write` tool descriptions to name
    the currently frozen rails, so the model is warned *before* attempting a violation.
3.3 **Flail/churn detection** (port CC's PostToolUse advisory) via `tool.execute.after`
    over a bounded window; surface via toast.
3.4 **TUI plugin module** (separate `tui` export — a module is server XOR tui, so ship
    `plugins/adlc-opencode/tui.mjs` registered alongside): persistent slot
    (`session_prompt_right` or `sidebar_footer`) showing active ticket + enforcement
    state; `DialogConfirm` for `/adlc-approve-spec` so the G1 human gate is a real modal;
    `api.attention.notify` on gate failures.

### Phase 4 — Wire the dead code (keyless bridge + deterministic P5)

4.1 **Keyless bridge goes live.** `makeAsk` gets a real implementation:
    `client.session.create({parentID: current})` → `session.prompt` with
    `outputFormat` (JSON-schema structured verdicts) → thread answers per the existing
    tested protocol. Delete the "proposed SDK extension" caveat.
4.2 **Native `adlc_gate` custom tool** (plugin `tool` hook): the model calls
    `adlc_gate({gate, args})` instead of being prose-instructed to shell out; execute()
    runs the CLI (or keyless bridge for LLM-backed gates) and returns structured
    `{title, output, metadata}`. `gate-bins.mjs` becomes the tool's dispatch table
    (dead code → live).
4.3 **Deterministic P5 runner**: native `adlc_prosecute` tool whose execute() drives
    fan-out → dedupe → verify → loop-until-dry *in first-party code* using the already-
    tested `lib/prosecutor.mjs` helpers, spawning lens/verifier child sessions via the
    SDK with structured output. `/adlc-prosecute` command becomes a thin invoker. This
    closes the "model-driven orchestration" gap CC itself still has — opencode would
    leapfrog to the most deterministic P5 of all six.

### Phase 5 — Parity ports & distribution

5.1 `/adlc-maintain` command + `docs/ci/adlc-maintenance.yml` weekly cron (CC parity).
5.2 `prosecutor` meta-agent (7th agent: hollow-test / behavior-diff / review-calibration
    deterministic gates), port from CC/agy.
5.3 **Publish `@adlc/opencode-package` to npm** so install is
    `"plugin": ["@adlc/opencode-package"]` in opencode.json; scaffolder registers the npm
    name instead of a source path. Fold into the lockstep `/release` flow.
5.4 Docs truth pass: rewrite Status/Gaps in `docs/integrations/opencode.md` to match
    reality (no phase claimed shipped without a runtime caller), refresh ADR 0004
    (answered questions → decisions), update the smoke script for the new surface.

## Risks / open questions

- **v1 vs v2 plugin API**: a v2 API exists in-source but undocumented; build on v1.17.x,
  isolate hook wiring so a v2 migration is one adapter file.
- **Arg shapes for patch/multiedit**: fail-closed default lands first (Phase 1.4);
  precise multi-file extraction is pinned against captured real payloads.
- **`session.prompt` cost**: keyless-bridge child sessions bill the user's configured
  model; keep per-gate calls bounded and surface which model answered.
- **TUI plugin is a second module**: server XOR tui — scaffolder must register both and
  the smoke test must cover both.

## Ticket slicing (P2 sketch)

Phase 1 → 1 ticket (hook correctness + scaffold layout + docs truth), rails: CI gate
config, `.adlc/*` trust roots. Phase 2 → 3 tickets (permission.ask+shell gating;
build-gate; suppression/scope + tool-name-independent backstop, which share the
watcher plumbing). Phase 3 → 2 tickets (server-side context/visibility;
TUI module). Phase 4 → 2 tickets (keyless bridge + adlc_gate tool; deterministic P5).
Phase 5 → 2 tickets (maintain+meta-agent; npm publish + docs). Each gated by
`/adlc-prosecute` before merge per house rules.
