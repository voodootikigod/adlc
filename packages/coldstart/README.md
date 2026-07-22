# coldstart — ADLC P2 Ticket Executability Gate

Checks whether a ticket is fully self-contained before a build agent touches it.
A cheap-tier LLM plays the role of a fresh agent with no prior context and lists
every question it would have to ask a *human* before it could start executing.
Empty gap list → gate passes (exit 0). Non-empty → exit 2 with gaps per ticket.

This is **ADLC phase C3 / P2** — the last check before a ticket enters the build
queue. Pennies per ticket; catches the #1 cause of build-phase flailing.

---

## Usage

```
coldstart <ticket-id> [options]
coldstart --all     [options]
```

### Options

| Flag | Default | Description |
|------|---------|-------------|
| `--tickets <path>` | `.adlc/tickets.json` | Path to the tickets file |
| `--all` | off | Run the gate on every ticket in the file |
| `--force` | off | Bypass the cache entirely and re-audit every target ticket |
| `--max-age <days>` | `30` | Treat a cached verdict older than this as stale; `0` treats every cache entry as stale |
| `--prompt-only` | off | Print the exact prompt(s) and exit 0 — no LLM call made |
| `--record-verdict <file\|->` | — | With `--prompt-only`: read the operator's answer from `<file>` (or stdin when `-`) and record it into `.adlc/manifest.jsonl` via `gate-manifest` — see below |
| `--json` | off | Machine-readable JSON output for orchestrators |

---

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | Gate passes — ticket(s) are fully executable |
| `1` | Operational error — bad input, unknown ticket id, missing file, no provider |
| `2` | Gate fails — one or more tickets have gaps |

---

## Examples

```sh
# Check a single ticket
coldstart T1

# Check all tickets, output JSON
coldstart --all --json

# Print the exact prompt without calling an LLM (paste into any harness)
coldstart T1 --prompt-only

# Use a custom tickets file
coldstart T3 --tickets path/to/tickets.json
```

---

## Caching

A real (non-`--prompt-only`) audit records `{ticketHash, model, gaps}` into
`.adlc/manifest.jsonl` after it runs. The NEXT run, for the SAME ticket, skips
the LLM call entirely when it finds a matching entry: same `ticketHash` (the
ticket's content is unchanged — editing anything about it produces a
different hash) and same *resolved* model id (not just the same `--tier` —
switching `ADLC_MODEL_CHEAP` invalidates the cache even though `--tier cheap`
stays the same flag). A cached run reports `"cached": true` in `--json`
output and `(cached)` in the human-readable report.

```sh
# First run audits for real and records the verdict
coldstart --all

# Second run, nothing changed: instant, no LLM calls
coldstart --all

# Force a fresh audit regardless of any cache entry
coldstart --all --force

# Don't trust anything cached more than a week ago
coldstart --all --max-age 7
```

Caching only applies to the real LLM path — `--prompt-only` (with or without
`--record-verdict`) is unaffected, and the `ADLC_GATE_MOCK_RESPONSE` test
seam never reads or writes the cache (a mocked verdict must never be able to
shadow, or be shadowed by, a real one).

---

## Recording the operator's prompt-only verdict

In Claude Code (and similar harnesses without a bare API key) `--prompt-only` is
how coldstart is normally run: the tool prints the audit prompt, and the
operator (the model itself) answers it and applies judgment. Without
`--record-verdict`, that self-assessed verdict is never captured — only the
fact that a prompt was printed is observable. `--record-verdict <file|->`
closes that gap: after printing the prompt(s) as usual, it reads the
operator's answer from `<file>` (or stdin when `-`) and records it into
`.adlc/manifest.jsonl` via `@adlc/gate-manifest`'s own `record()` — reusing its
hash-chaining/signing logic rather than reimplementing it.

```sh
# Operator writes their answer to a file, then records it
coldstart T1 --prompt-only --record-verdict verdict.txt

# Or pipe the answer straight from stdin
echo "PASS: no gaps found" | coldstart T1 --prompt-only --record-verdict -
```

`--record-verdict` requires `--prompt-only` (exit 1 otherwise). The recorded
entry's `gate` is `coldstart`, `data.verdict` holds the operator's text
verbatim, and `data.ticketIds` lists every ticket the prompt covered (useful
with `--all`).

---

## What counts as a gap?

The model is instructed that **information derivable from the repo does not count
as missing**. Only genuine human-only questions are gaps:

- Data shapes referenced but not embedded (e.g. "use the UserSchema" with no schema)
- Contracts named but absent (edge points to a missing type file)
- Acceptance criteria that cannot be mechanically verified
- Vague scope ("improve", "clean up", "fix")
- Unstated target files when they cannot be inferred from context

---

## JSON output schema

```json
{
  "ok": true,
  "results": [
    {
      "id": "T1",
      "pass": true,
      "gaps": []
    },
    {
      "id": "T2",
      "pass": false,
      "gaps": [
        { "what": "UserSchema", "why_blocking": "Shape referenced in body but not defined." }
      ]
    }
  ]
}
```

---

## Provider configuration

The tool auto-detects the first available provider in order:
`ANTHROPIC_API_KEY` → `OPENAI_API_KEY` → `GEMINI_API_KEY`.

Force a provider: `ADLC_PROVIDER=openai`.
Override the cheap-tier model: `ADLC_MODEL_CHEAP=claude-haiku-4-5`.

Without a provider, the tool exits 1 unless `--prompt-only` is passed.

---

## ADLC phase served

**C3 / P2** — ticket executability gate. Runs after `spec-lint` (C1) and before
the ticket enters the build queue. Part of the Cheap Wins cluster alongside C1
and C5 (`rails-guard`).

---

## Core gaps

`@adlc/core` (frozen) has no completion-aware ticket loader: `loadTickets`
returns every ticket including ones tombstoned with `completed: true`. `--all`
audits open backlog, so `lib/active-tickets.mjs` filters completed tickets
locally (an identical copy lives in `merge-forecast` and `model-router`). A
by-id coldstart still uses the full set, so you can always audit a completed
ticket you name explicitly. Everything else is available in `@adlc/core`:
`loadTickets`, `complete`, `extractJson`, `parseArgs`, `pass`, `gateFail`,
`opError`, `printJson`, `promptOnly`, `detectProvider`.
