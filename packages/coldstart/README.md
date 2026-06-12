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
| `--prompt-only` | off | Print the exact prompt(s) and exit 0 — no LLM call made |
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

None. All required functionality is available in `@adlc/core`:
`loadTickets`, `complete`, `extractJson`, `parseArgs`, `pass`, `gateFail`,
`opError`, `printJson`, `promptOnly`, `detectProvider`.
