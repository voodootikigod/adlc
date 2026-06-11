# gate-manifest

**ADLC C11 — cross-cutting provenance.** A hash-chained evidence ledger that records what each AIDLC gate verified, proving to auditors (and CI) that agentic code was checked before it shipped.

## ADLC phase

Serves **C11** (cross-cutting provenance / agentic SLSA). Consumed by **P6 human-gate** reviewers who need `attest` output as a PR comment, and by **CI** which runs `verify` as a blocking gate.

## Usage

```
gate-manifest record <gate-name> [--ticket id] [--data '{json}'] [--files a,b,c] [--dir path] [--json]
gate-manifest verify [--json] [--dir path]
gate-manifest show   [--ticket id] [--json] [--dir path]
gate-manifest attest [--ticket id] [--dir path]
```

### record

Append one entry to `.aidlc/manifest.jsonl`.

```sh
gate-manifest record spec-lint --ticket T-42 --data '{"model":"haiku","pass":true}' --files src/foo.mjs,src/bar.mjs
```

The entry stored:

```json
{
  "seq": 3,
  "gate": "spec-lint",
  "ticket": "T-42",
  "ts": "2024-01-01T00:00:00.000Z",
  "data": { "model": "haiku", "pass": true },
  "files": { "src/foo.mjs": "<sha256>", "src/bar.mjs": "<sha256>" },
  "prev": "<sha256 of the previous raw JSONL line, or null>"
}
```

| Flag | Description |
|------|-------------|
| `--ticket id` | Associate this entry with a ticket id (optional) |
| `--data '{json}'` | Arbitrary JSON payload (must be valid JSON; malformed → exit 1) |
| `--files a,b,c` | Comma-separated paths; each is SHA-256 hashed (missing files hash to null) |
| `--dir path` | Override ledger directory (default `.aidlc`) |
| `--json` | Print the recorded entry as JSON |

### verify

Walk the raw ledger lines and validate the hash chain. Every entry's `prev` must equal `sha256` of the exact raw bytes of the previous line; sequence numbers must be strictly monotonically increasing.

```sh
gate-manifest verify          # human-readable
gate-manifest verify --json   # machine-readable
```

**Exit 0** when valid (or empty manifest). **Exit 2** when the chain is broken — reports the seq and line number of the first break.

| Flag | Description |
|------|-------------|
| `--json` | Emit `{ valid, message, count, break }` |
| `--dir path` | Override ledger directory |

### show

Print entries from the ledger, optionally filtered by ticket.

```sh
gate-manifest show
gate-manifest show --ticket T-42
gate-manifest show --ticket T-42 --json
```

| Flag | Description |
|------|-------------|
| `--ticket id` | Filter to entries with this ticket id |
| `--json` | Emit `{ entries, skipped }` |
| `--dir path` | Override ledger directory |

### attest

Generate a Markdown summary suitable for a PR comment.

```sh
gate-manifest attest --ticket T-42
```

Output example:

```markdown
## Gate evidence for T-42

| seq | gate | ts | files | data |
|-----|------|-----|-------|------|
| 1 | spec-lint | 2024-01-01T… | 0 | — |
| 2 | hollow-test | 2024-01-01T… | 3 | model=haiku |

Chain status: **valid** (2 entries)
```

| Flag | Description |
|------|-------------|
| `--ticket id` | Filter entries and use ticket id in heading |
| `--dir path` | Override ledger directory |

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Gate passes (record, show, attest always; verify when chain is valid) |
| 1 | Operational error (bad input, unreadable file, malformed `--data` JSON) |
| 2 | Gate fails (verify detects chain break) |

## Chain integrity

`record` reads the ledger file via `readFileSync` (raw bytes) — never via `readEntries` which re-serialises and would lose byte-exact fidelity. The `prev` field is `sha256(previous raw JSONL line)` (null for the first entry). Tampering any middle line breaks all subsequent `prev` hashes, detected by `verify`.

## Sibling tools

- `rails-guard` (C5) — appends its own proof here after verifying diff is rails-clean.
- `hollow-test` (C4) — appends coverage and mutation results.
- `review-calibration` (C8) — appends prosecution verdicts and calibration score.

## Core gaps

None — `sha256`, `hashFiles`, `appendEntry`, `readEntries`, `ledgerPath`, `AIDLC_DIR`, `parseArgs`, `pass`, `gateFail`, `opError`, `printJson` from `@aidlc/core` cover all requirements.
