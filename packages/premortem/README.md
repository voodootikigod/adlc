# @adlc/premortem

Failure-first spec stress test — **ADLC phase C2 / P1 gate**.

Inverts sycophancy: instead of asking "any problems with this plan?", it tells a
frontier model the project already failed and asks it to write the postmortem.
The model generates concrete, checkable risks anchored to the actual spec
content. Output feeds back as interrogation questions for the next P1 review.

Runs once per spec. Cheap. No bespoke judgement needed.

---

## Usage

```
premortem <spec.md> [--tier cheap|mid|frontier] [--out report.md] [--json] [--prompt-only] [--record-verdict <file|->]
```

### Arguments

| Argument / Flag | Description | Default |
|---|---|---|
| `<spec.md>` | Path to the spec file to analyse **(required)** | — |
| `--tier` | Model tier: `cheap`, `mid`, or `frontier` | `frontier` |
| `--out <path>` | Write markdown report to this file instead of stdout | stdout |
| `--json` | Emit machine-readable JSON `{ causes: [...] }` | false |
| `--prompt-only` | Print the exact system + user prompt, then exit 0 — **no API key needed** | false |
| `--record-verdict <file\|->` | With `--prompt-only`: read the operator's answer from `<file>` (or stdin when `-`) and record it into `.adlc/manifest.jsonl` via `gate-manifest` | — |
| `--help` | Print usage and exit 0 | false |

### Examples

```bash
# Run against a spec, print to stdout
premortem specs/checkout-v2.md

# Write the report to a file
premortem specs/checkout-v2.md --out reports/premortem-checkout.md

# Machine-readable output for orchestrators
premortem specs/checkout-v2.md --json

# Inspect the prompt without spending tokens
premortem specs/checkout-v2.md --prompt-only

# Use a cheaper model for quick iteration
premortem specs/checkout-v2.md --tier mid
```

---

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | Report produced successfully (or `--prompt-only` / `--help`) |
| `1` | Operational error — missing spec file, no LLM provider configured, malformed model response |
| `2` | *(reserved for future gate-fail use; not currently emitted)* |

---

## Output format

The default markdown report contains:

1. **Failure Causes table** — cause, earliest observable signal, and prevention per item.
2. **Questions to fold into interrogation** — numbered list of interrogation questions, one per cause, ready to paste into the next P1 spec review.

---

## ADLC phase served

**C2 — P1 stress test.**  Sits at the end of the P1 (spec approval) phase.  After
a spec has passed `speccheck` (C1), `premortem` runs one frontier-model
completion with the adversarial postmortem charter.  The resulting questions are
appended to the spec review checklist before the spec is locked.

---

## LLM configuration

The tool requires exactly one of:

```
ANTHROPIC_API_KEY   → uses claude-opus-4-8 at frontier tier
OPENAI_API_KEY      → uses gpt-5.1 at frontier tier
GEMINI_API_KEY      → uses gemini-2.5-pro at frontier tier
```

Force a provider: `ADLC_PROVIDER=anthropic`
Override model by tier: `ADLC_MODEL_FRONTIER=claude-opus-4-8`

Use `--prompt-only` to get the exact prompt for pasting into any harness when no
key is available.

---

## Recording the operator's prompt-only verdict

In Claude Code (and similar harnesses without a bare API key) `--prompt-only`
is how premortem is normally run: the tool prints the failure-mode prompt, and
the operator (the model itself) answers it and applies judgment. Without
`--record-verdict`, that self-assessed verdict — and any spec hardening it
produced — never enters the audit trail; only the fact that a prompt was
printed is observable. `--record-verdict <file|->` closes that gap: after
printing the prompt as usual, it reads the operator's answer from `<file>` (or
stdin when `-`) and records it into `.adlc/manifest.jsonl` via
`@adlc/gate-manifest`'s own `record()` — reusing its hash-chaining/signing
logic rather than reimplementing it.

```sh
# Operator writes their conclusion to a file, then records it
premortem specs/checkout-v2.md --prompt-only --record-verdict verdict.txt

# Or pipe the answer straight from stdin
echo "confirmed: process.chdir throws under vitest threads pool" \
  | premortem specs/checkout-v2.md --prompt-only --record-verdict -
```

`--record-verdict` requires `--prompt-only` (exit 1 otherwise). The recorded
entry's `gate` is `premortem`, `data.verdict` holds the operator's text
verbatim, and `data.specPath` records which spec the prompt covered.

---

## Core gaps

None.  All required functionality (`complete`, `extractJson`, `detectProvider`,
`promptOnly`, `opError`, `parseArgs`, `printJson`, `readStdin`) is available in
`@adlc/core`. Recording prompt-only verdicts reuses `@adlc/gate-manifest`'s
`record()` directly (see `lib/verdict.mjs`) rather than reimplementing its
hash-chain/signing logic.

---

## Relationship to sibling tools

- **speccheck (C1)** — runs before `premortem`; ensures every acceptance criterion has a verification method.
- **coldstart (C3)** — runs after `premortem`; stress-tests individual tickets for missing information.
- **premortem** is advisory (`exit 0` on success) because it produces questions, not binary pass/fail.  A future integration could promote flagged questions to tickets and gate on them via `coldstart`.
