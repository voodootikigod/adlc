---
name: adlc-rail-build
description: Run ADLC P3-P4 rail and build workflows in Codex, including frozen rails, hollow-test, rails-guard, preflight, flail detection, and the context-fitness build gate.
---

ADLC_CODEX_SENTINEL_RAIL_BUILD_V1

# ADLC Rail And Build

P3 rails are authored before P4 build and are frozen during P4. Initialize the
project with `$adlc-init`, then select the ticket through the normal ADLC ticket
workflow. The native Codex hook automatically arms when
`.adlc/current-ticket.json` selects an incomplete ticket with non-empty rails.

Use `ADLC_P4_ENFORCEMENT=1` only to force enforcement in automation or unusual
shell workflows. Use `ADLC_P4_ENFORCEMENT=0` only as a deliberate local opt-out;
it does not bypass the authoritative CI gate. `ADLC_TICKET` remains an explicit
selection override when no current-ticket file is present.

## Context-fitness build gate

A second PreToolUse hook, `adlc-build-gate.mjs`, guards against continuing a
high-blast-radius build in a context-rotted session. It only applies to
tickets whose risk tier is `'high'` (declared `risk: 'high'`, an
external-system effect, identity mutation, or scope/rails touching the
manifest or ticket-store trust root, or category `contract`/`architecture`) —
a normal-risk ticket is never gated. For a high-risk ticket, the hook reads
the session transcript (`transcript_path` on the hook payload) and denies the
next mutating tool call once the session looks context-degraded. Depth is the
primary signal: 40 or more tool calls in a bounded window (inclusive — 40
itself trips it). A tool call is a Codex rollout `response_item` tagged
`function_call`, `custom_tool_call`, `web_search_call`, `tool_search_call` or
`image_generation_call`; the result half of each pair and the `event_msg`
mirrors (`patch_apply_end`, `exec_command_end`, `web_search_end`) are not
counted again. The transcript byte count is a secondary ceiling at 8 MiB — a routine
fresh session with several plugins and skills loaded already runs to hundreds
of kilobytes, so the byte signal only catches sessions the depth count somehow
missed. It does not gate a fresh or shallow session, even a high-risk one.

If you hit this gate: resume in a fresh session (or an isolated subagent)
rather than continuing in a degraded one — that is the fix, not the bypass.
To override deliberately, set `ADLC_BUILD_GATE_BYPASS=1`; the override is
refused unless it durably records to the gate-manifest
(`adlc gate-manifest record build-gate-bypass`), so an unaudited bypass is
never silently honored.

Required gates:

```sh
adlc hollow-test --test-cmd "npm test"
adlc preflight --test-cmd "npm test" --json
adlc rails-guard --ticket "$ADLC_TICKET" --tickets .adlc/tickets.json --record --json
adlc flail-detector session.log --json
```

Hooks are immediate guardrails. `adlc rails-guard` and the required CI job are
the deterministic rail-freeze proof.
