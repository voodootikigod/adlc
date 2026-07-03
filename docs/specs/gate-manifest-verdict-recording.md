# Spec — Record prompt-only gate verdicts into gate-manifest (closes #44)

**Issue:** In Claude Code, `coldstart`, `premortem`, and `parallax` run with `--prompt-only`:
the tool prints an audit prompt, the operator (the model itself) answers it and applies
judgment, but that self-assessed verdict never entered the audit trail — only the fact
that a prompt was printed was observable, and among the phases exercised in the issue's
motivating example only `hollow-test` produced a `gate-manifest` record.

## Fix

Added `--record-verdict <file|->` to the prompt-only flow of all three packages
(`packages/coldstart`, `packages/premortem`, `packages/parallax`). When passed alongside
`--prompt-only`, the tool still prints the exact prompt(s) (unchanged evidence surface),
then reads the operator's answer from `<file>` (or stdin when `-`) and records it into
`.adlc/manifest.jsonl` by calling `@adlc/gate-manifest`'s own `record()` function
(`packages/gate-manifest/lib/record.mjs`) — reusing its hash-chaining/HMAC-signing logic
rather than reimplementing it. Each package gained a small `lib/verdict.mjs` (read
file-or-stdin, call `record()` with `gate: '<package-name>'` and package-specific
context — ticket id(s) for coldstart, spec path for premortem, mode + ticket ids /
question / request for parallax's three modes). The import of `verdict.mjs` (and
transitively `@adlc/gate-manifest`) is lazy — dynamic `import()` inside the
`--record-verdict` branch only — so plain `--prompt-only` runs are unaffected. Omitting
the flag is byte-for-byte the previous `--prompt-only` behavior (same `promptOnly()`
call, no manifest write). Passing `--record-verdict` without `--prompt-only` is an
operational error (exit 1).

## Acceptance criteria

- AC1: For each of coldstart/premortem/parallax, `--prompt-only --record-verdict <file>`
  exits 0, still prints the prompt(s), and appends exactly one entry to
  `.adlc/manifest.jsonl` with `gate` equal to the package name, `data.promptOnly: true`,
  and `data.verdict` containing the verbatim contents of `<file>`.
- AC2: `--record-verdict -` reads the verdict from stdin instead of a file, with the same
  resulting entry shape.
- AC3: `--record-verdict` without `--prompt-only` exits 1 with a clear error
  (`--record-verdict requires --prompt-only`).
- AC4: Omitting `--record-verdict` leaves existing `--prompt-only` behavior — exit code,
  stdout, and the absence of any `.adlc/manifest.jsonl` write — unchanged.

## Verification

```sh
node --test packages/coldstart/test/*.test.mjs
node --test packages/premortem/test/*.test.mjs
node --test packages/parallax/test/*.test.mjs
node --test packages/gate-manifest/test/*.test.mjs
npm test   # full workspace suite — regression check across every package/plugin
```
