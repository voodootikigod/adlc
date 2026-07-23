---
description: Prosecute a change before merge (P5) — Task fan-out across five fresh-context prosecutor agents, verify findings, converge, run mechanical gates, and record evidence.
---

# /adlc-prosecute — hostile pre-merge review (P5)

Prosecute the change for the active ticket. Requires a clean G4 build
(`/adlc-verify-build`). Target: the text after the command (default to the
active ticket in `.adlc/current-ticket.json`).

**Preferred path — Task / custom-agent fan-out (packaged agents).** Cursor
ships plugin agents under `agents/`. Fan out **one fresh Task (or custom
agent) context per lens**, then the verifier — do **not** claim Cursor has no
subagent fan-out. Exact agent `name`s:

| Lens key (`@adlc/core`) | Agent `name` |
| --- | --- |
| `correctness` | `prosecutor-correctness` |
| `security` | `prosecutor-security` |
| `contract` | `prosecutor-contract` |
| `diff` | `prosecutor-diff` |
| `tests` | `prosecutor-tests` |
| (verifier) | `prosecutor-verifier` |

Until an installed-Cursor proof records distinct subagent/context ids for all
five lenses + verifier receipt, matrix/docs say **packaged-but-unverified**,
not agents-backed.

**Degraded fallback only — sequential same-context.** If Task / custom-agent
fan-out is unavailable, run the five lenses sequentially in this one context.
That fallback has **weaker independence** than fresh-context fan-out
(conclusions can anchor later lenses). Do not treat the fallback as equivalent
to independent review. For the cross-model risk gate, still run
`npx adversarial-review --providers <a,b>` (step 6).

## 0. Collect the evidence + write the P5 marker

Precondition: a CLEAN working tree — commit (or stash) everything first. The
hollow-test gate in step 5 mutates files in place and refuses to run on a
dirty tree.

Establish the target ticket (its `scope`, spec, and acceptance criteria from
`.adlc/tickets.json`) and the change under prosecution:
`git diff <base-branch>...HEAD`. Lenses are read-only reviewers: while
prosecuting, do not edit product files or run state-changing commands except
the mechanical gates in step 5 and the marker/evidence commands below.

**P5 marker (session-matched, fenced — T64 helper).** Before fan-out, write a
fresh marker via the plugin's `writeP5Marker` helper (user-scoped state dir
`~/.adlc` / `ADLC_CURSOR_STATE_DIR`, never consumer `.adlc/`):

```js
// From a short node one-liner in the consumer repo (adjust path if needed):
import { writeP5Marker, clearP5Marker } from '@adlc/cursor/lib/session-state.mjs';
import { randomUUID } from 'node:crypto';
const runId = randomUUID();
const sessionId = process.env.ADLC_CURSOR_SESSION_ID; // required for named sessions
writeP5Marker({ sessionId, ticketId: '<active>', runId });
// store runId for cleanup
```

Shape: `{ ts, ticketId, sessionId, runId }`. Overlapping same-session starts:
replace with a new `runId` (only the owner clears). On completion **and** on
documented abort paths, `clearP5Marker({ sessionId, runId })` (compare-and-
delete on `runId` only). Hooks (`preToolUse` Task allowlist + `subagentStart`)
read the same helper — mismatched sessionId ≡ absent.

## 1. Fan out the five lenses (fresh contexts)

For each lens in order, spawn a **fresh** Task / custom-agent with the matching
`name` from the table above. Pass the same diff + ticket/spec context; do not
share prior lens conclusions into later lens prompts.

Every lens uses the same stance and output shape:

> You are a hostile pre-merge reviewer. Your only job is to **break confidence
> in the change**, not validate it. For each finding, produce an object with:
> `severity` (critical|high|medium|low), `file`, `line_start`, `line_end`
> (post-change line numbers; 0,0 = file-level), `title`, `body`, `evidence`
> (quoted verbatim from the diff), and `recommendation`. Output a JSON array of
> findings (empty if none). Do not soften or speculate beyond the evidence — a
> finding you cannot ground in the diff does not belong.

### Lens 1 — Correctness (`prosecutor-correctness`)
Hunt specifically for: logic errors, off-by-one and boundary mistakes, broken
invariants, incorrect results, mishandled error/empty/null cases, and state
that can desync.

### Lens 2 — Security (`prosecutor-security`)
Hunt specifically for: auth and trust-boundary holes, injection
(SQL/shell/path), secrets in code or logs, SSRF, unsafe deserialization,
missing input validation at boundaries, and who-controls-the-control bypasses.

### Lens 3 — Contract conformance (`prosecutor-contract`)
Hunt specifically for: API/schema/type drift, backwards-incompatible changes,
undocumented response shape changes, and violations of the ticket's declared
contract or shared types.

### Lens 4 — Spec-vs-implementation diff (`prosecutor-diff`)
Hunt specifically for: places where the implementation diverges from the
spec/acceptance criteria, behavior changes not reflected in the spec, and scope
creep beyond the ticket.

### Lens 5 — Test audit (`prosecutor-tests`)
Hunt specifically for: tests that assert nothing meaningful, mock-only
verifications, tests that would pass against a broken implementation, missing
coverage of the change's core behavior, and suppressed/skipped assertions.

Collect every finding from every lens into one list. Record each pass for
`adlc prosecute` using core lens keys `correctness`, `security`, `contract`,
`diff`, `tests` (no lossless remapping — the recorder accepts these keys).

## 2. Dedupe

Merge findings across lenses, deduping by **file + line range + normalized
title** (trim, lowercase, collapse internal whitespace). When two lenses report
the same defect, keep the **highest severity** (critical > high > medium >
low). Prefer `@adlc/core` `dedupeFindings` semantics — do not invent a third
convergence implementation.

## 3. Verifier pass — fresh context per finding (`prosecutor-verifier`)

For each deduped finding, spawn a **fresh** `prosecutor-verifier` Task /
custom-agent (fail-closed: if no valid verifier vote can be obtained, the
finding **survives** as an unverified blocker — never silently drop).

Verifier brief:

> You are given ONE prosecution finding. Try to **refute it**, not to agree.
> Steps: (1) re-read the finding's evidence in context; (2) construct the most
> concrete reproduction or counterexample you can; (3) decide: REAL (a genuine
> defect — concrete repro or mechanism), REFUTED (concrete counterexample or
> already handled), or CANNOT-DECIDE. For REAL/REFUTED record
> `{ "real": boolean, "reason": string, "repro": string }`; for CANNOT-DECIDE
> record the vote as a literal `null`. Do NOT encode cannot-decide as
> `{ "real": null }` (that counts as a refutation under `survivesVerification`).

Apply `@adlc/core` `survivesVerification` (strict majority of valid votes).

**Fallback honesty:** if using sequential same-context verification instead of
fresh verifier Tasks, say so — that path has **weaker independence**.

### Record every surviving finding (the P5 → P7 bridge)

As soon as a finding **survives** verification, record it — before it is handed
off to be fixed. Once fixed it stops existing, and a finding that was never
recorded cannot be clustered by `lesson-foundry` (P7), so the lifecycle stops
compounding:

```
adlc prosecute --record-finding \
  --file <repo-relative path> \
  --desc "<plain prose: the pattern, not this instance>" \
  --category <correctness|security|contract|diff|tests> \
  --severity <high|medium|low>
```

Once per surviving finding. `--file` and `--desc` are required — the recorder
fails closed rather than appending a junk entry.

Write `--desc` as **plain prose describing the pattern**, with no quoted or
backticked literals and no identifiers from this diff. `--desc` is the clustering
key: a description tied to one instance clusters with nothing, and literals route
the distilled defense to a lint rule when the real defect usually needs a
spec-gap template.

This is distinct from `gate-manifest record prosecution` in step 5, which records
**that** a prosecution ran. This records **what it found** — only the second one
compounds.

## 4. Loop until dry

Repeat steps 1–3 until **two consecutive rounds surface no new confirmed
findings**. Cap at 5 rounds; if cut off before dry, report that as a finding
("convergence did not complete"). Use `@adlc/core` prosecutor convergence
helpers — no third implementation.

## 5. Deterministic gates

These are mechanical, not judgment:

- **Hollow-test** (always) — `adlc hollow-test --test-cmd "<the project's test command>"`.
  Exit `2` = hollow tests found; fix before merging. On a clone with no
  resolvable `main`/`master`, pass `--base <ref>`.
- **Behavior-diff** (only for HTTP-observable services) —
  `adlc behavior-diff capture` / `compare` as in sibling integrations. Skip
  for CLIs/libraries and note the skip.

## 6. Cross-model adversarial review (the risk gate)

Run `npx adversarial-review --providers <a,b>` (≥2 distinct providers) for
risk-gated changes. If no API keys, `--prompt-only` is allowed but prefer a
genuinely different model for security-critical work.

When the review passes:

```
adlc gate-manifest record adversarial-review --ticket <id> --files <risk-gated paths> --data '{"providers":"<a,b>","verdict":"SHIP"}'
```

`--ticket <id>` and comma-separated `--files` are required (ticket-scoped).

## 7. Record prosecution evidence + clear marker + verdict

Record ticket- and revision-bound evidence via `adlc prosecute` /
`adlc_prosecute` (five-pass packet with core lens keys including `contract`
and `diff` must validate). On CLEAR, also:

```
adlc gate-manifest record prosecution --ticket <id> --files <changed files>
```

Clear **this session's** P5 marker best-effort (`clearP5Marker` with the
`runId` from step 0) on completion and on abort.

Material (surviving, non-refuted) findings — including unverified blockers —
block the merge until verified or refuted.
