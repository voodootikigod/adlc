# gate-manifest

**ADLC C11 — cross-cutting provenance.** A hash-chained evidence ledger that records what each ADLC gate verified, proving to auditors (and CI) that agentic code was checked before it shipped. Set `ADLC_MANIFEST_KEY` to add HMAC-SHA256 signatures so the chain attests *authorship*, not just internal consistency (see [Signing & provenance](#signing--provenance)).

## ADLC phase

Serves **C11** (cross-cutting provenance / agentic SLSA). Consumed by **P6 human-gate** reviewers who need `attest` output as a PR comment, and by **CI** which runs `verify` as a blocking gate.

## Usage

```
gate-manifest record <gate-name> [--ticket id] [--data '{json}'] [--files a,b,c] [--dir path] [--json]
gate-manifest verify [--json] [--dir path] [--allow-legacy-unsigned]
gate-manifest show   [--ticket id] [--json] [--dir path]
gate-manifest attest [--ticket id] [--dir path]
gate-manifest repair-chain --reason "..." [--write] [--attest-unsigned] [--json] [--dir path]
```

Prosecution, runner acceptance, rails evidence, and manual gate records use the
same atomic chain writer. `repair-chain` recovers ledgers made
by older raw appenders: it refuses valid ledgers, preserves the original bytes
in a hash-named backup, rechains entries in order, and records the repair as the
final entry. Signed ledgers require the original matching `ADLC_MANIFEST_KEY`;
repair verifies every existing signature before it rewrites anything. If keyed
repair would sign previously unsigned entries, it refuses unless the operator
passes `--attest-unsigned`; the repair plan and audit entry disclose their count
and original line numbers.

### record

Append one entry to `.adlc/manifest.jsonl`.

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
  "prev": "<sha256 of the previous raw JSONL line, or null>",
  "sig": "<HMAC-SHA256 over the canonical entry bytes — present only when ADLC_MANIFEST_KEY is set>"
}
```

When `ADLC_MANIFEST_KEY` is set, `record` appends a `sig` (the human output prints `(signed)` / `(unsigned)`). See **Signing & provenance** below.

| Flag | Description |
|------|-------------|
| `--ticket id` | Associate this entry with a ticket id (optional) |
| `--data '{json}'` | Arbitrary JSON payload (must be valid JSON; malformed → exit 1) |
| `--files a,b,c` | Comma-separated paths; each is SHA-256 hashed (missing files hash to null) |
| `--dir path` | Override ledger directory (default `.adlc`) |
| `--json` | Print the recorded entry as JSON |

### verify

Walk the raw ledger lines and validate the hash chain. Every entry's `prev` must equal `sha256` of the exact raw bytes of the previous line; sequence numbers must start at 1 and increase strictly by 1 (contiguous from 1).

```sh
gate-manifest verify                            # human-readable
gate-manifest verify --json                      # machine-readable
gate-manifest verify --allow-legacy-unsigned      # tolerate an honest pre-signing prefix
```

**Exit 0** when valid (or empty manifest). **Exit 2** when the chain is broken — reports the seq and line number of the first break.

When `ADLC_MANIFEST_KEY` is set, `verify` additionally checks every entry's HMAC signature. By default every entry must carry a valid sig: a missing sig (`unsigned entry`) or a wrong sig (`signature invalid`) breaks the chain. The JSON result includes `signed: true` only when a key was present and every entry verified cryptographically; otherwise `signed: false`.

`--allow-legacy-unsigned` relaxes the missing-sig requirement, but only for a **contiguous legacy prefix**: entries before the first entry in the file that carries a sig (i.e. entries recorded before this ledger ever adopted signing). As soon as the scan passes that first signed entry, every later entry is "signed-era" and a missing sig on it still breaks the chain — an attacker cannot regress a signed ledger back to unsigned by appending plain entries after the fact. A **present-but-invalid** signature is rejected everywhere, at any position, with or without this flag — this only tolerates an honest unsigned history, never a tampered one. Use this flag for routine health checks (e.g. a Stop hook) on a ledger that predates signing; omit it when you specifically want to prove the whole chain is under key control (e.g. a forge-from-scratch check).

Honest limit: if a manifest has **zero** signed entries, this flag reports the whole file as a valid legacy prefix — a wholesale-forged, entirely-unsigned chain is indistinguishable from a ledger that genuinely predates signing end to end (sha256 is public and keyless; forging it needs no secret). `signed` stays `false` in both cases, so it cannot be used to tell them apart. A caller that needs a stronger guarantee (proof that at least one entry is under key control) must check for that itself.

| Flag | Description |
|------|-------------|
| `--json` | Emit `{ valid, message, count, signed, break }` |
| `--dir path` | Override ledger directory |
| `--allow-legacy-unsigned` | Tolerate a missing sig on the contiguous legacy prefix only |

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

The atomic writer derives `prev` from the byte-exact ledger state while holding
the append lock—never from parsed and re-serialized entries. The `prev` field is
`sha256(previous raw JSONL line)` (null for the first entry). Tampering any
middle line breaks all subsequent links and is detected by `verify`.

## Signing & provenance

The hash chain alone proves **internal consistency**, not **authorship**. `sha256` is a public, keyless function: anyone who can write `manifest.jsonl` can recompute every `prev` and forge a clean chain from scratch. On its own the chain is therefore *not* cryptographic provenance — do not represent a hash-chain-only pass as in-toto/SLSA attestation.

To get real provenance, generate a secret signing key with the ceremony below — not
`export ADLC_MANIFEST_KEY="$(openssl rand -hex 32)"`. That form, and equally
`export ADLC_MANIFEST_KEY="$(cat handoff-file)"`, put the key in a shell **assignment**:
with tracing enabled (`set -x`, or any CI runner that logs commands) the shell prints the
command AFTER expanding it, so the key ends up in the terminal or build log regardless of
where the value came from. `generate-key` never prints the key on any stream — it writes
it to a mode-0600 file at an operator-chosen path OUTSIDE the repository, and prints only
the path and a one-way fingerprint. Load it with `read`, not `export VAR="$(...)"`: `read`
writes directly into the variable without the value ever appearing as an expanded command
argument, so it is safe under tracing even with no `set +x` needed:

```sh
gate-manifest generate-key --output /path/outside/the/repo/manifest-key.txt
# fingerprint: <sha256 of the key — safe to log, not the key itself>

# STOP — store the CONTENTS of that file in your secret manager (CI secret store,
# vault, etc.) now, before going any further. The file is the ONLY durable copy of
# this key: deleting it before it is stored elsewhere makes the key permanently
# unrecoverable, and every signature ever made with it becomes unverifiable.

IFS= read -r ADLC_MANIFEST_KEY < /path/outside/the/repo/manifest-key.txt
export ADLC_MANIFEST_KEY
rm /path/outside/the/repo/manifest-key.txt   # only once the key is durably stored elsewhere
gate-manifest record spec-lint --ticket T-42
gate-manifest verify --json    # → { ..., "signed": true }
```

- **record** keeps its compatible v1 signature over `{ seq, gate, ts, ticket?, data?, files, prev }`. Generalized first-party evidence uses `sigVersion: 2` and signs canonical JSON for every entry field except `sig`, including ticket, revision, and provenance data.
- **verify** (run with the key) requires every entry to carry a valid sig — comparison is constant-time (`crypto.timingSafeEqual`). A missing sig → `unsigned entry`; a wrong sig → `signature invalid`. Either breaks the chain (exit 2). This defeats the forge-from-scratch attack: without the key, an attacker cannot produce valid signatures.
- **verify** without a key still checks the hash chain but reports `signed: false`, so callers cannot claim cryptographic provenance.

Zero-dependency: HMAC comes from Node's built-in `node:crypto`. Key management (rotation, distribution) is out of scope for this tool — supply the key via the environment.

## Sibling tools

- `rails-guard` (C5) — appends its own proof here after verifying diff is rails-clean.
- `hollow-test` (C4) — appends coverage and mutation results.
- `review-calibration` (C8) — appends prosecution verdicts and calibration score.

## Core gaps

None for ledger/CLI primitives — `sha256`, `hashFiles`, `appendEntry`, `readEntries`, `ledgerPath`, `ADLC_DIR`, `parseArgs`, `pass`, `gateFail`, `opError`, `printJson` from `@adlc/core` cover them. Core exposes `sha256` but no keyed-MAC primitive, so HMAC signing uses Node's built-in `node:crypto` (`createHmac`, `timingSafeEqual`) directly in `lib/sign.mjs` — still zero runtime dependencies.
