# Spec — Codex context-fitness build gate (T49)

**Phase:** P1 contract for porting Claude Code's `buildgate` enforcing hook to
`plugins/adlc-codex`, reusing the existing `@adlc/build-gate` package.

**Revision note:** this replaces an earlier draft that described a fictional
"tool-call budget" mechanism. `@adlc/build-gate` already exists in this repo
(`packages/build-gate`) and does something different — see below. Read this
revision, not the ticket's original body text, for the actual design.

## Problem

`plugins/adlc-claude-code/hooks/adlc-hook.mjs`'s `buildgate` mode denies a
PreToolUse call when: the active ticket is risk-tier `'high'`
(`packages/build-gate/lib/risk.mjs`'s `computeRiskTier`) **and** the current
session is context-degraded (`packages/build-gate/lib/depth-signal.mjs`'s
`isDegraded`: tool-call count over a bounded transcript window > 40, or
transcript byte size > 256 KiB). A normal-risk ticket is always allowed; a
high-risk ticket in a shallow/fresh session is allowed; only the
high-risk-and-degraded combination denies, and only until the operator
resumes fresh or records an audited override.

`plugins/adlc-codex` has no equivalent. Its only PreToolUse hook,
`adlc-rails-guard.mjs`, protects frozen *paths*, not session context-fitness.

## Why Claude Code inline-copies instead of importing

`plugins/adlc-claude-code/hooks/adlc-hook.mjs` does **not** `import` from
`@adlc/build-gate`. It carries a verbatim inline copy of
`deriveRiskSignals`/`computeRiskTier` (from `risk.mjs`) and
`countToolCalls`/`computeDepthSignal`/`isDegraded` (from `depth-signal.mjs`),
each marked `KEEP IN SYNC with packages/build-gate/lib/*.mjs` in comments.
Reason: a hook script runs from the plugin's *installed* location (not the
monorepo), which has no `node_modules` — the same reason
`plugins/adlc-codex/hooks/adlc-rails-guard.mjs`'s shell classifier is a
verbatim inline copy of `@adlc/core/lib/shell.mjs` (see that file's own
`KEEP IN SYNC` header). Codex's hooks have the identical constraint — this
spec follows the same inline-copy pattern, not a new package extraction.

## Verified platform fact: `transcript_path`

Confirmed against Codex's live hooks documentation: the common hook input
fields shared across hook events include `session_id`, `transcript_path`
(string | null — "Path to the session transcript file, if any"), `cwd`,
`hook_event_name`, `model`, `permission_mode`. `PreToolUse` additionally
carries `turn_id`, `tool_name`, `tool_use_id`, `tool_input`. This means the
depth/bytes context-fitness signal is computable in Codex exactly as in
Claude Code — `input.transcript_path`, if non-null and readable, is the same
tail-windowed transcript scan `packages/build-gate/lib/depth-signal.mjs` (and
Claude Code's copy of it) already implements.

If `transcript_path` is null/missing/unreadable for a **high-risk** ticket,
the gate cannot verify context-fitness and must fail closed (deny) — exactly
Claude Code's behavior. Do not treat a missing transcript as "shallow, allow."

## Deny output convention

Codex's own PreToolUse deny convention (see `adlc-rails-guard.mjs`'s `fail()`)
is `console.error(message); process.exit(2)` — **not** Claude Code's
structured `hookSpecificOutput` JSON payload. This hook must speak Codex's
convention, not import Claude Code's.

## Active-ticket resolution

`plugins/adlc-codex/hooks/adlc-rails-guard.mjs` already implements
`resolveActiveTicketId()` (env `ADLC_TICKET` vs `.adlc/current-ticket.json`,
fail-closed on conflict). The new build-gate hook reuses this — either by
importing it from `adlc-rails-guard.mjs` (both are ES modules in the same
`hooks/` directory, so a same-directory import is safe and does not cross the
"cannot resolve npm packages" boundary, which is specifically about resolving
packages from `node_modules`) or, if the spec author finds a structural reason
that import is awkward, a verbatim copy with the same `KEEP IN SYNC` comment
convention used elsewhere in this file. Prefer the import — it is a local
file, not an npm package, so nothing about the installed-plugin constraint
blocks it.

## Bypass

The real environment variable is `ADLC_BUILD_GATE_BYPASS` (not a
Codex-specific name). Setting it to `'1'` on a high-risk-and-degraded call
triggers an attempt to durably record the override via
`adlc gate-manifest record build-gate-bypass --ticket <id> --data <json>`
(shelled to the globally-installed `adlc` binary, mirroring Claude Code's
`recordBuildGateBypass`). If the record call does not exit 0, the bypass is
refused (deny) — an unaudited override is never honored.

## Deliverables

1. `plugins/adlc-codex/hooks/adlc-build-gate.mjs` — new hook. Structure:
   - Read stdin JSON payload (`hook_event_name`, `tool_name`, `transcript_path`,
     etc., matching Codex's documented common fields).
   - Resolve active ticket (reuse `resolveActiveTicketId` from
     `adlc-rails-guard.mjs`). No active ticket → allow (opt-in gate, matching
     Claude Code).
   - Load `.adlc/tickets.json`, find the ticket. Missing/unreadable → deny,
     fail closed (risk cannot be verified).
   - Compute risk tier via the inline `KEEP IN SYNC` copy of
     `deriveRiskSignals`/`computeRiskTier`. Not high risk → allow.
   - Read `transcript_path`. Missing/unreadable → deny, fail closed.
   - Compute depth/bytes signal via the inline `KEEP IN SYNC` copy of
     `countToolCalls`/`computeDepthSignal`/`isDegraded`, using the same
     tail-windowing (`MAX_SCAN_BYTES`) Claude Code's hook uses so this stays
     bounded-cost regardless of transcript length. Not degraded → allow.
   - Degraded: check `ADLC_BUILD_GATE_BYPASS`. Set and recordable → allow
     (audited). Set but not recordable → deny. Not set → deny, with a message
     naming the bypass variable and recommending a fresh session.
2. `plugins/adlc-codex/hooks/hooks.json` — add `adlc-build-gate.mjs` to the
   existing `PreToolUse` entry (same matcher as `adlc-rails-guard.mjs`, since
   both must fire on the identical mutating-tool set).
3. `plugins/adlc-codex/hooks/test/build-gate.test.mjs` — a **drift test**
   importing both the new hook's exported pure functions and
   `packages/build-gate`'s real exports, asserting identical output across a
   shared fixture set (ticket objects, transcript windows) — the precedent is
   `packages/core/test/shell.test.mjs`, which does this for the rails-guard
   shell classifier. Also covers: normal-risk always-allow, high-risk-shallow
   allow, high-risk-degraded deny, missing-transcript-on-high-risk fail-closed
   deny, bypass-recorded allow, bypass-record-failure deny.
4. `plugins/adlc-codex/skills/adlc-rail-build/SKILL.md` updated to document
   the gate and `ADLC_BUILD_GATE_BYPASS`.

## Acceptance criteria

- **AC1:** High-risk ticket + degraded session → next mutating PreToolUse call
  denied (exit 2). VERIFY: `plugins/adlc-codex/hooks/test/build-gate.test.mjs`.
- **AC2:** Normal-risk ticket, or high-risk-but-shallow session → always
  allowed regardless of tool-call volume. VERIFY: same test file.
- **AC3:** The hook's risk-tier and depth-signal computations are IDENTICAL to
  `packages/build-gate`'s real exports across the shared fixture set (the
  drift test). VERIFY: same test file.
- **AC4:** A recorded `ADLC_BUILD_GATE_BYPASS` override appears in
  `.adlc/manifest.jsonl` as a `build-gate-bypass` gate-manifest entry via the
  real `adlc gate-manifest record` path. VERIFY: same test file, using a temp
  `.adlc` dir and a real `adlc` invocation.
- **AC5:** `adlc rails-guard --base main --ticket T49` passes; `npm test`
  passes at the root; existing `plugins/adlc-codex/hooks/test/*.test.mjs`
  suite passes unmodified in behavior.
- **AC6:** Missing/unreadable `transcript_path` on a high-risk ticket fails
  closed (deny) — never silently treated as shallow. VERIFY: same test file.

## Out of scope

- Changing `packages/build-gate`'s own logic, tiering rule, or thresholds.
- Retroactively adding a drift test for Claude Code's own inline copy (a real
  gap, but not this ticket).
- T54/T50/T51/T52/T53.
