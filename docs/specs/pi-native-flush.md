# Pi Native Flush — making adlc-pi robust, feature-complete, and native-feeling

Status: PROPOSED (plan for review)
Branch: `pi-integration`
Inputs: full plugin audit (live behavioral probes included), the six-integration capability
benchmark, and a verified inventory of pi's extension surface as of
`@earendil-works/pi-coding-agent` v0.80.3 (July 2026, types in
`dist/core/extensions/types.d.ts`, docs in `docs/extensions.md` / `docs/packages.md`).

## Why now

adlc-pi shipped as a prototype (PR #16) against an *assumed* pi API and has not been
revisited since 1.1.0. The verified 0.80.3 surface contradicts several assumptions baked
into the code and `docs/integrations/pi.md` — one of them catastrophically:

| Assumption (in code/docs today) | Verified reality (v0.80.3) |
| --- | --- |
| `before_agent_start` returning `{systemPrompt}` *appends* doctrine | It **replaces** the turn's system prompt (chained across extensions). The documented pattern is `event.systemPrompt + "…"`. **Our extension currently wipes pi's entire built-in system prompt whenever a ticket is active** (and replaces it with just an error banner on load errors). |
| Install = "package.json dependencies" or `pi --extension <abs path>` | First-class package manager: `pi install npm:<pkg>` (user) / `pi install -l` (project, auto-installs for the team on trusted startup), `settings.json` `packages`, `pi` manifest field, `"pi-package"` keyword → pi.dev gallery. |
| P5 subagents via `invoke_subagent` "or the Pi SDK" (design doc §4) | No subagent API. The native pattern is `registerTool` + child `pi` subprocesses (official `examples/extensions/subagent/`), or the SDK's `createAgentSession` / `--mode rpc` (JSONL; 0.80.3 adds `get_entries`/`get_tree`). All real, none used. |
| Shell/rail primitives must be hand-rolled | `tool_call` is a per-tool discriminated union (`isToolCallEventType`), fires for **custom third-party tools too**, `event.input` is mutable, `{block:true}` blocks. And `@adlc/core` already ships the hardened shell classifier the siblings use. |
| Checked-in compiled `index.js` is needed | pi loads extensions as TypeScript via jiti — no compile step. The dual-source artifact is pure drift liability (CI's typecheck is `\|\| true`; tests exercise the `.js`, not the `.ts`). |
| P7 on a pi `/schedule` feature | No such feature; CI cron remains the scheduling substrate. |

New surface nobody in the six-integration family uses yet: `ctx.getContextUsage()`
(native context-fitness signal), `session_before_compact` (custom compaction),
`appendEntry`/`setLabel` (evidence persisted into the session file + `/tree` bookmarks),
`ctx.ui.select/confirm` dialogs, `setWidget`/`setFooter`, `registerMessageRenderer`,
session `fork()`/`navigateTree()`.

## Where we stand (audit)

Strengths worth keeping: adlc-pi is the *source* of three parity features the siblings
later ported (per-turn ticket doctrine, suppression-marker revert, scope enforcement);
it fails closed on config errors; the ticket pill gives constant visibility; 15 unit
tests pass in root CI.

But the audit found eight defects and a stalled completion state:

1. **System-prompt destruction (critical).** See table above. Enforcement-on means
   pi loses its own operating instructions.
2. **Shell gate: wrong on both sides.** Live probes confirm: `npm install <pkg>`,
   `git checkout -b feat/x`, and even read-only `sed -n '1,10p' <out-of-scope file>` are
   **blocked** under any scoped ticket (the `\binstall\b`/`\bcheckout\b`/`\bsed\b`
   regexes + a token-with-dot path heuristic), while opaque mutations (`curl … | sh`)
   pass **fail-open**. The codex/opencode enforcement ladder (parse → deny mutating
   rail-touching commands; fail closed on opaque mutation; never block reads) exists in
   `@adlc/core` and is unused here.
3. **ADR-0004 violation: declared deps never imported.** `package.json` depends on
   `@adlc/core` + `@adlc/rails-guard`, but `index.ts` re-implements `globMatch`, ticket
   loading, scope, and the shell scanner by hand. The #97/#102 dedup covered
   cursor/opencode and skipped pi. No symlink-aware rail resolution (opencode's
   `resolveRailPath` closes a real bypass; pi is lexical-only).
4. **`tool_result` blast radius (data loss).** Every mutating tool result runs
   `git add -N .` (pollutes the user's index), diffs against `HEAD` (attributing
   pre-session/user edits to the agent), and reverts violations with whole-file
   `git checkout HEAD --` — destroying legitimate uncommitted user work in that file.
5. **Suppression scan flags inert text.** Naive `includes(marker)` over added lines hits
   markers inside docs/strings/fences — exactly the text-scanning-gate class P7 already
   distilled (and cursor/opencode already fixed via `@adlc/core` fence logic).
6. **Ticket state is session_start-frozen.** Activating/switching a ticket mid-session
   (env or `current-ticket.json`) is invisible until `/ticket` is run manually.
7. **Build/test plumbing.** Checked-in compiled `index.js` with no build script; CI
   typecheck is `\|\| true` (toothless); tests import the compiled artifact.
8. **Docs truth.** README calls this the "Raspberry Pi harness"; `docs/integrations/pi.md`
   presents unshipped design as implementation ("We have constructed…").

**Started-but-never-finished design intent** (`docs/integrations/pi.md`, honestly flagged
in the docs site as "design intent, not shipped"): P5 subagent prosecution loop,
TICKET-DONE interception (the doctrine *demands* the protocol; nothing listens for it),
P6 `session_shutdown` capture + `/integrate`, P1 interactive `ui.select/confirm` flows,
P2 model routing, scheduled P7.

Benchmark gaps vs best sibling: command suite (0 commands vs 8–9 in CC/opencode/cursor),
prosecutor lenses/meta-agent, build-gate context-rot backstop, flail detection,
`adlc-maintain`, deterministic P5, npm distribution + scaffolder.

## The plan

Phases ordered by risk-reduction per unit effort; each independently shippable and
prosecutable (P5) before the next begins.

### Phase 1 — Fix the gates we already have (correctness)

1.1 **System prompt: append, don't replace.** Return
    `{systemPrompt: event.systemPrompt + DOCTRINE_BLOCK}` in both the normal and the
    load-error paths. Regression test asserting the built-in prompt survives.
1.2 **Delegate primitives to `@adlc/core`** (ADR-0004): `globMatch`, `loadTickets`/
    `validateTicket`, `inScope`, the `classifyShellCommand` family, fence/operative-line
    logic. Delete the hand-rolled copies. Restructure to sibling architecture: thin
    `index.ts` event wiring + `lib/*.mjs` logic (a `rails-checker.mjs` adapter mirroring
    opencode's), tests target the libs directly. **Delete the checked-in `index.js`**;
    root CI typecheck loses `\|\| true` (add the pi package as a devDependency for types).
1.3 **Shell gate ladder (codex parity):** parseable mutating command touching a rail or
    out-of-scope path → deny; opaque mutation → deny with explanation (fail closed);
    reads and non-path tokens (`left-pad@1.3.0`, `feat/x`) never collected as paths.
1.4 **Symlink-aware rail resolution:** lift opencode's `resolveRailPath` into
    `@adlc/core`; use it in both integrations.
1.5 **Shrink `tool_result` blast radius:** snapshot target-file content at `tool_call`
    time for structured writes and restore *that snapshot* on violation (never
    `checkout HEAD`); scope the diff to the paths the tool actually touched (repo-wide
    diff only after `bash`); replace `git add -N .` with `git status --porcelain`
    untracked detection; never touch files the tool didn't write.
1.6 **Suppression scan goes operative-only** via core fence/comment derivation, scanning
    only lines the gated tool added. Keep the `allow-suppression:` protocol.
1.7 **Live ticket lifecycle:** re-resolve the active ticket on `turn_start` (cheap mtime
    check on `current-ticket.json`), preserving fail-closed posture.
1.8 **Pin the tool-arg contract** with `isToolCallEventType` narrowing, and prove it with
    a **live deny test**: script `pi --mode rpc` (raw-stream JSONL, strict LF — do not
    use Node `readline`), drive an edit against a frozen rail, assert the block. Wire as
    a required CI gate (mirrors `opencode-live-deny`).
1.9 Docs truth pass v1: README "Raspberry Pi" fix; mark design-vs-shipped in
    `docs/integrations/pi.md`.

Exit: live deny proof in CI; all Phase-1 probes (the `npm install`/`git checkout -b`/
read-only `sed` false positives, `curl|sh` fail-open, prompt-wipe) turned into tests.

### Phase 2 — Enforcement depth

> Banked from the Phase-1 P5 prosecution (low severity): `diffAddedLines`'
> multiset semantics don't re-flag a *pre-existing identical* marker line that
> is relocated (e.g. moved from a fenced block into operative code) — the
> occurrence count is unchanged. A position-aware diff in the suppression scan
> closes it; fold into 2.4/2.5.

2.1 **Build-gate context-rot backstop** using native `ctx.getContextUsage()` + core
    risk-tier classification: deny structured edits on high-risk tickets once context
    fitness degrades (CC issue #48 port — with a cleaner signal than any sibling has).
2.2 **Flail advisory:** bounded window over `tool_execution_end` (repeated failures,
    edit churn, oversized outputs) → steer message via `sendMessage(deliverAs:"steer")`.
2.3 **`user_bash` advisory:** `!` commands are human-typed and bypass tool gates by
    design; when one mutates a rail, warn and record to the manifest — don't block the
    human.
2.4 **Evidence rail:** `appendEntry()` every gate event into the session file, mirror to
    `.adlc/manifest.jsonl`, and `setLabel()` violations so `/tree` shows enforcement
    history as navigable bookmarks.
2.5 **Custom-tool coverage:** `tool_call` fires for third-party tools — extend the gate
    to `CustomToolCallEvent` (path-like args checked; unknown mutating tools fail
    closed). The snapshot/diff reactive gate stays the tool-agnostic backstop.

### Phase 3 — Native feel & command parity

3.1 **`/adlc-*` command suite** via `registerCommand` (parity with cursor/opencode):
    `adlc-init` (scaffold `.adlc/` + CI template via core scaffold-hygiene),
    `adlc-ticket` (a `ctx.ui.select` picker over `tickets.json` that writes
    `current-ticket.json` through a privileged path — the config freeze applies to the
    agent, not the command), `adlc-spec`, `adlc-decompose`,
    `adlc-approve-spec` (`ctx.ui.confirm` — the G1 human gate as a real modal),
    `adlc-verify-build`, `adlc-prosecute`, `adlc-distill`, `adlc-maintain`. Ticket-id
    `getArgumentCompletions`. All degrade gracefully when `!ctx.hasUI` (rpc/print).
3.2 **Footer widget upgrade** (`setWidget`/`setFooter`): ticket + enforcement state +
    context-usage % + last gate result, replacing the bare status pill.
3.3 **Gate-result message renderer** (`registerMessageRenderer`) so gate output renders
    structured in the TUI instead of raw console writes.

### Phase 4 — Pi-unique capabilities (leapfrog)

4.1 **Deterministic P5 prosecutor.** `registerTool("adlc_prosecute")` drives
    fan-out → dedupe → verify → loop-until-dry in first-party code using
    `@adlc/core`'s tested lens machinery (`LENSES`, `VERIFIER`, `dedupeFindings`,
    `survivesVerification`, `shouldContinue`, `recordFinding`), spawning
    **fresh-context child `pi` subprocesses** per lens (official subagent pattern,
    print/rpc mode) — keyless by construction (children use the user's configured
    provider/model). `/adlc-prosecute` becomes a thin invoker.
4.2 **TICKET-DONE finally has a listener:** `message_end` watcher detects the completion
    protocol the doctrine already demands and offers/starts prosecution (design-intent
    §4 shipped). `TICKET-BLOCKED:` gets surfaced + recorded.
4.3 **Native `adlc_gate` tool:** the model calls `adlc_gate({gate, args})` instead of
    being prose-instructed to shell out; `execute()` runs the CLI via `pi.exec` and
    returns structured results with a custom `renderResult`. Skills shrink to routing.
4.4 **Compaction defense** (`session_before_compact`): supply a custom compaction that
    pins ticket doctrine, rail set, and open gate evidence into the summary; re-assert
    doctrine via the `context` event on the first post-compaction call. No sibling can
    do this — compaction is exactly when context-rot [F3] strikes.
4.5 **P6 integrate:** `session_shutdown` behavior-diff capture + `/adlc-accept`
    (`behavior-diff` / `accept` wrapped, `ctx.ui.confirm` for the human decision).
4.6 **Fork-based repair:** on hard gate failure, offer `fork(entryId)` back to the
    labeled pre-failure entry — session-tree-native rollback (labels from 2.4).

### Phase 5 — Distribution & install ease

5.1 **Publish `@adlc/pi-package` to npm:** drop `private`, add
    `"keywords": ["pi-package"]` (pi.dev gallery), a correct `pi` manifest
    (`extensions`, `skills`), pi core packages as `peerDependencies: "*"` (packaging
    rule), `@adlc/core` as a runtime `dependency` (install runs `--omit=dev`). Fold into
    the lockstep `/release` flow.
5.2 **Install becomes one command:** `pi install npm:@adlc/pi-package` (user-global) or
    `pi install -l npm:@adlc/pi-package` (project-local: lands in `.pi/`, auto-installs
    for every teammate on trusted startup — the best team-install story of all six
    integrations). Rewrite install docs; `/adlc-init` finishes repo scaffolding
    in-session.
5.3 **Version-matrix smoke** in CI: current pinned pi + latest, catching upstream
    hook-contract drift (the 0.80.0 pi-ai compat alias is slated for removal).
5.4 Docs truth pass v2: `pi.mdx` shipped-map rewrite, `docs/integrations/pi.md` becomes
    a status ledger, package-reference update.

## Risks / open questions

- **Doctrine size per turn:** appending to every turn's system prompt costs tokens;
  keep the block compact and consider `context`-event injection only when stale.
- **Child-session P5 cost:** lens children bill the user's configured model; bound lens
  count/rounds, surface which model answered (same posture as opencode 4.x).
- **Non-TUI modes:** `ctx.ui.custom`/dialogs are TUI-only; every command and gate must
  degrade in `rpc`/`json`/`print` mode (live-deny CI runs in rpc mode, which also
  pins this).
- **pi API velocity:** 0.79→0.80 was additive for us, but the compat entrypoint will be
  removed; isolate all pi imports behind one adapter module so a bump is one file.
- **Trust model:** project-local (`.pi/`) resources load only after trust; user-global
  install avoids the gap — document both paths.
- **Node floor:** pi requires Node ≥ 22.19; note for contributors (repo dev currently on 24).

## Ticket slicing (P2 sketch)

Phase 1 → 2 tickets: (T-pi-1) core delegation + shell ladder + symlink resolve +
system-prompt fix; (T-pi-2) tool_result blast radius + suppression operative-only +
live-deny CI + docs truth v1. Rails: `.adlc/*` trust roots, CI gate config, the live-deny
test itself once green.
Phase 2 → 2 tickets: (T-pi-3) build-gate + flail; (T-pi-4) evidence rail + custom-tool
coverage + user_bash advisory.
Phase 3 → 2 tickets: (T-pi-5) command suite + scaffolder; (T-pi-6) widget + renderer.
Phase 4 → 3 tickets: (T-pi-7) deterministic P5 + TICKET-DONE listener; (T-pi-8)
adlc_gate + compaction defense; (T-pi-9) P6 integrate + fork repair.
Phase 5 → 1 ticket: (T-pi-10) npm publish + install docs + version matrix + docs truth v2.

Each ticket gated by P5 prosecution before merge per house rules.
