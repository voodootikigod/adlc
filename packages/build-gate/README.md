# build-gate

Machine-checkable fitness-to-build gate (ADLC C13 — [issue #48](https://github.com/voodootikigod/adlc/issues/48)).

Nothing else in ADLC deterministically prevents **starting** a high-blast-radius
ticket's build (P4) when the executing session's context is degraded ("context
rot"). `build-gate` closes that gap: it derives a ticket's risk tier, checks a
machine-checkable context-fitness signal, and denies the build unless an
audited override is recorded.

## ADLC Phase

**P3 → P4 entry gate.** Sits between rail-freeze (P3) and supervised build
execution (P4). Guards one invariant: a **high-risk** ticket must not begin
its build in a **degraded** session.

## Usage

```
build-gate <ticket-id> [--depth <n>] [--session-bytes <n>] [--transcript <path>]
           [--depth-threshold <n>] [--bytes-threshold <n>] [--tickets <path>]
           [--reason <text>] [--json]
```

### Flags

| Flag | Default | Description |
|------|---------|-------------|
| `<ticket-id>` | — | Ticket to gate (required) |
| `--depth <n>` | — | Precomputed tool-call-count depth signal |
| `--session-bytes <n>` | — | Precomputed transcript byte-size signal |
| `--transcript <path>` | — | Derive depth/session-bytes from this transcript file |
| `--depth-threshold <n>` | 40 | Tool-call count past which a session is "degraded" |
| `--bytes-threshold <n>` | 8388608 (8 MiB) | Transcript bytes past which a session is "degraded" |
| `--tickets <path>` | `.adlc/tickets.json` | Path to tickets file |
| `--reason <text>` | — | Free-text reason recorded with an override |
| `--json` | off | Emit machine-readable JSON result |
| `--help` | — | Print this help and exit 0 |

The library export `DEFAULT_BYTES_THRESHOLD` (`lib/depth-signal.mjs`) remains
`HARD_BYTES` (256 KiB) by design, so the two numbers are not expected to agree:
this binary's flag default is the recalibrated operating threshold.

A CLI process can't observe its own caller's context state — the caller (a
hook, CI wrapper, or any harness) must supply the signal via `--depth`/
`--session-bytes`, or point `--transcript` at a transcript file to derive it
from. Supplying **neither** defaults the signal to "not degraded" — a gate
given no signal cannot deny.

### Exit codes

```
0  allow (gate passes)
1  operational error (bad ticket id, missing tickets file, bad thresholds)
2  deny (gate fails)
```

## Risk tier

A ticket is **high risk** if it declares `"risk": "high"`, OR any of these
derived signals fire from fields already on the ticket:

- `external: true` — writes back to / creates / deletes in an external system
- `mutatesIdentity: true` — mutates identity
- `scope`/`rails` glob-matches `.adlc/manifest.jsonl` — mutates the gate-evidence ledger
- `scope`/`rails` glob-matches `.adlc/tickets.json` or `.adlc/current-ticket.json` — touches the trust root
- `category` is `contract` or `architecture`

A declared `"risk": "normal"` can **never** downgrade a derived-high signal —
that would be a silent, undetectable way to defeat the gate.

## Context-fitness signal

A proxy for "this session is deep," mirroring
[`@adlc/flail-detector`](../flail-detector)'s existing transcript-size /
tool-call-count scanning approach: a tool-call-count (`--depth`) and a
transcript byte count (`--session-bytes`), each compared to a threshold.
Either signal past its threshold means the session is **degraded**.

## Audited override

Set `ADLC_BUILD_GATE_BYPASS=1` to deliberately override a deny (mirrors the
`ADLC_RAILS_BYPASS` pattern used by [`rails-guard`](../rails-guard)). The
override is **only** honored if it can be durably recorded to
`.adlc/manifest.jsonl` as a `build-gate-bypass` entry — an override that
cannot be recorded is refused, never silently allowed.

## Toolkit modules (Path A — reusable by any harness)

- `lib/risk.mjs` — `computeRiskTier(ticket)` / `deriveRiskSignals(ticket)`
- `lib/depth-signal.mjs` — `computeDepthSignal({ text, bytes })` / `isDegraded({...})` (absolute hard band via `@adlc/context-handoff` `isHardDegraded`; inclusive `>=` at `HARD_DEPTH` / `HARD_BYTES`)
- `lib/decide.mjs` — `decideBuildGate({ riskTier, degraded, bypass, recordBypass })`
- `lib/override.mjs` — `recordOverride({...})`
- `lib/active-ticket.mjs` — `resolveActiveTicketId({ dir, env })`, the shared
  `ADLC_TICKET` env var / `.adlc/current-ticket.json` convention already used
  by every other harness integration (codex, opencode, cursor, antigravity)

## Claude Code integration (Path B — self-enforcing)

`plugins/adlc-claude-code/hooks/adlc-hook.mjs`'s `buildgate` PreToolUse mode
supplies the in-session context signal (the same transcript-window staging
the `flail` mode already does) and computes the risk tier, context-fitness
signal, and allow/deny decision **entirely locally** — verbatim ports of
this package's `lib/risk.mjs` / `lib/depth-signal.mjs` / `lib/decide.mjs`
logic, marked "KEEP IN SYNC" in the hook source. It does **not** shell out to
`adlc build-gate` for the decision; `adlc` (via `gate-manifest`) is invoked
only to durably record an audited override, mirroring how `rails` never
needs `adlc` for its own core decision either. See
`docs/specs/build-gate-fitness.md`, including its **Known limitations**
section (unreadable-transcript fail-closed behavior, and the unprotected
`.adlc/current-ticket.json` pointer as a Bash-reachable, CI-unbackstopped
escape hatch).
