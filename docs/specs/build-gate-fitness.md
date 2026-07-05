# Spec — Machine-checkable fitness-to-build gate (issue #48)

## Problem

ADLC gates the *quality* of a change (coldstart, prosecute/P5) but nothing
deterministically prevented **starting** a high-blast-radius ticket's build
(P4) when the executing session's context was degraded ("context rot"). The
motivating incident (T9 of `@adlc/ticket-sync`, PR #33: idempotent `gh issue
create` + id-reassignment with store-wide edge rewrite) was paused correctly
only because the operator happened to ask "should we pause?" — human judgment,
not a machine-checkable gate.

## What was built

Per the issue's recommended composition ("ship Path B first, with the
risk-tier/gate logic factored into a reusable toolkit"):

1. **`@adlc/build-gate`** (`packages/build-gate/`) — the reusable toolkit
   (Path A):
   - `lib/risk.mjs` — risk-tier derivation: declared `risk: 'high'`, OR any of
     `external`, `mutatesIdentity`, scope/rails touching
     `.adlc/manifest.jsonl` or the trust root (`.adlc/tickets.json`,
     `.adlc/current-ticket.json`), OR `category` in `{contract, architecture}`.
     A declared `risk: 'normal'` can never downgrade a derived-high signal.
   - `lib/depth-signal.mjs` — the context-fitness proxy: tool-call-count
     (`--depth`) and transcript bytes (`--session-bytes`), mirroring
     `@adlc/flail-detector`'s existing transcript-size/tool-call-count
     scanning approach.
   - `lib/decide.mjs` — the pure allow/deny decision.
   - `lib/override.mjs` — durable override recording to
     `.adlc/manifest.jsonl` (`build-gate-bypass` entries).
   - `lib/active-ticket.mjs` — the shared `ADLC_TICKET` env var /
     `.adlc/current-ticket.json` active-ticket convention, matching every
     other ADLC harness integration (codex, opencode, cursor, antigravity).
   - `bin/build-gate.mjs` — the CLI: `adlc build-gate <ticket-id> [--depth
     <n>] [--session-bytes <n>] [--transcript <path>] [...]`. Registered in
     `packages/cli/lib/registry.mjs`.
2. **Claude Code hook** (`plugins/adlc-claude-code/hooks/adlc-hook.mjs`,
   `buildgate` mode) — Path B, self-enforcing: a new PreToolUse hook (same
   `Edit|Write|MultiEdit|NotebookEdit` matcher as `rails`) that resolves the
   active ticket, computes its risk tier and this session's context-fitness
   signal **entirely locally** (verbatim-ported copies of the toolkit logic,
   marked "KEEP IN SYNC", the same convention already used for `globMatch`),
   and denies the edit when the ticket is high-risk and the session is
   degraded — unless `ADLC_BUILD_GATE_BYPASS=1` is set AND the override is
   durably recorded via `adlc gate-manifest record build-gate-bypass`
   (mirrors the `ADLC_RAILS_BYPASS` pattern exactly: an override that cannot
   be audited is refused, never silently allowed).

The core enforcement decision does not depend on the `adlc` CLI being on
`PATH` (mirroring `rails`'s own design) — only the audited-override recording
does. This means installing the plugin cannot brick a session that hasn't
opted into the `ADLC_TICKET`/`.adlc/current-ticket.json` convention, and the
gate keeps working even if `@adlc/cli` isn't globally installed.

## Acceptance criteria

- [x] Risk tier is derivable from ticket fields and overridable via a
      declared `risk: 'high'` field, without a silent downgrade path.
- [x] A context-fitness signal (transcript depth/bytes) is exposed to the
      gate: `--depth`/`--session-bytes`/`--transcript` on the CLI; computed
      in-session by the CC hook from `transcript_path`.
- [x] `build-gate` denies a high-risk build past threshold; an audited
      override is recorded via the gate-manifest; exit code `2` on deny.
- [x] The CC PreToolUse hook enforces this in-session for declared/derived
      high-risk tickets.
- [x] Docs + tests (offline; injected signal) — see below.

## Verification

```
node --test packages/build-gate/test/*.test.mjs
node --test plugins/adlc-claude-code/hooks/test/build-gate.test.mjs
node --test packages/cli/test/*.test.mjs
npm test   # full suite, from the repo root
```

## Known limitations

- **Unreadable transcript_path fails closed.** If a high-risk ticket's
  `transcript_path` exists at hook time (passes `existsSync`) but a subsequent
  `fileSize`/`readFileSync` fails — permission error, or a TOCTOU race where
  the file is deleted/replaced between the two checks — the hook denies
  rather than treating the unreadable file as "zero bytes, not degraded". The
  context-fitness signal cannot be computed for a ticket already known to be
  high-risk, so an unverifiable session must not be allowed through.
- **The active-ticket pointer is a Bash-reachable escape hatch (partially
  mitigated).** Build-gate is an opt-in gate: "no active ticket declared →
  allow" is by design (it mirrors rails' "no rails declared → allow").
  `.adlc/current-ticket.json` is now frozen as a rails trust root (same
  treatment as `.adlc/tickets.json`) whenever the ticket set declares ANY
  rails, so a structured edit (`Edit`/`Write`/`MultiEdit`/`NotebookEdit`)
  that overwrites the pointer is denied. Two gaps remain: (1) the PreToolUse
  hook only matches those structured-edit tools — never Bash (same reason as
  rails-guard — see `docs/integrations/claude-code.md`'s Gaps section) — so
  `rm .adlc/current-ticket.json` or an out-of-band overwrite via Bash still
  clears the pointer with zero risk evaluation and zero manifest entry,
  weaker than even `ADLC_BUILD_GATE_BYPASS=1` (which is at least audited);
  and (2) a ticket that is high-risk *without* declaring any `rails` (e.g.
  purely via `category: 'contract'`) gets no trust-root protection at all,
  since rails() no-ops when the ticket set declares zero rails. Unlike
  rails' equivalent Bash gap, there is **no CI diff backstop** possible here:
  `.adlc/current-ticket.json` is gitignored local session state (not
  tracked), so there is no commit-time diff for a CI gate to inspect, and
  the degradation signal (transcript depth) can't be reconstructed after
  the fact regardless. Treat build-gate as a strong in-session backstop, not
  a substitute for human review at P5/P6 on high-risk tickets.
