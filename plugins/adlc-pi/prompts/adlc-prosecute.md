---
description: Prosecute a change before merge (P5) — run the five prosecution lenses sequentially, verify each finding, loop until dry, run the deterministic gates, and record the verdict.
argument-hint: "[ticket-or-request]"
---

# /adlc-prosecute — hostile pre-merge review (P5)

Prosecute the change for the active ticket. Requires a clean G4 build
(`/adlc-verify-build`). Target: `$ARGUMENTS` (default to the active ticket in
`.adlc/current-ticket.json`). See the `adlc-prosecute` skill for the evidence
recording reference.

## Preferred path: call the `adlc_prosecute` tool

The pi extension ships a native `adlc_prosecute` agent tool (Phase 4). **Call it
first** — do not prose-shell the lenses. It runs the deterministic P5 loop in
first-party code: it fans out **one fresh-context child `pi` per lens** over the
ticket diff (genuinely independent reviewers, unlike a single-context sequential
pass), dedupes across lenses, verifies each survivor with fresh verifier
children, loops until dry, and records every confirmed finding to the `.adlc`
findings ledger. It returns a structured verdict (`CLEAN` or `FINDINGS`).

```
adlc_prosecute            # active ticket, diff vs merge-base with main
adlc_prosecute { "base": "<ref>", "ticket": "<id>" }
```

Treat a `FINDINGS` verdict as no-ship until each confirmed finding is addressed;
`CLEAN` means the fresh-context loop converged with nothing surviving
verification. Degraded lenses are reported and are NOT counted as clean. After a
`CLEAN` tool verdict, still run the cross-model risk gate (step 6 below) for
risk-gated changes, then record the prosecution evidence (step 7).

## Fallback: the manual sequential loop

Use the sections below only when the native tool is unavailable (e.g. a
non-pi runtime, or child sessions cannot spawn). **Read before trusting this
fallback's verdict.** Here the five prosecution lenses run SEQUENTIALLY in this
one context, worked by the same model that reads this command. Sequential
same-context lenses have **weaker independence** than the tool's fresh-context
fan-out: conclusions from an earlier lens can anchor a later one, and a blind
spot in this session repeats across all five passes. Do not treat this loop as
equivalent to an independent review. For the cross-model risk gate, run
`npx adversarial-review --providers <a,b>` (two distinct providers) — step 6
below — so at least one genuinely different model examines the change.

This fallback is self-contained: everything the loop needs (lens briefs, dedupe
rule, verification rule, stop rule) is defined below.

## 0. Collect the evidence

Precondition: a CLEAN working tree — commit (or stash) everything first. The
hollow-test gate in step 5 mutates files in place and refuses to run on a dirty
tree (exit 1: "commit or stash first"), so an uncommitted change cannot complete
this prosecution.

Establish the target ticket (its `scope`, spec, and acceptance criteria from
`.adlc/tickets.json`) and the change under prosecution:
`git diff <base-branch>...HEAD`. Every lens reviews this same diff plus whatever
surrounding code it needs to read. Lenses are read-only reviewers: while
prosecuting, do not edit files or run state-changing commands — a reviewer that
can rewrite the evidence is not a reviewer.

## 1. Run the five lenses, sequentially

Work through each lens below **in order, one at a time**. Before starting each
lens, deliberately set aside the previous lens's conclusions and re-read the diff
from scratch under the new lens's mandate only — this is the closest a single
context can get to independent reviewers, and it is imperfect (see the caveat
above).

Every lens uses the same stance and output shape:

> You are a hostile pre-merge reviewer. Your only job is to **break confidence in
> the change**, not validate it. For each finding, produce an object with:
> `severity` (critical|high|medium|low), `file`, `line_start`, `line_end`
> (post-change line numbers; 0,0 = file-level), `title`, `body`, `evidence`
> (quoted verbatim from the diff), and `recommendation`. Output a JSON array of
> findings (empty if none). Do not soften or speculate beyond the evidence — a
> finding you cannot ground in the diff does not belong.

### Lens 1 — Correctness
Hunt specifically for: logic errors, off-by-one and boundary mistakes, broken
invariants, incorrect results, mishandled error/empty/null cases, and state that
can desync.

### Lens 2 — Security
Hunt specifically for: auth and trust-boundary holes, injection
(SQL/shell/path), secrets in code or logs, SSRF, unsafe deserialization, missing
input validation at boundaries, and who-controls-the-control bypasses.

### Lens 3 — Contract conformance
Hunt specifically for: API/schema/type drift, backwards-incompatible changes,
undocumented response shape changes, and violations of the ticket's declared
contract or shared types.

### Lens 4 — Spec-vs-implementation diff
Hunt specifically for: places where the implementation diverges from the
spec/acceptance criteria, behavior changes not reflected in the spec, and scope
creep beyond the ticket.

### Lens 5 — Test audit
Hunt specifically for: tests that assert nothing meaningful, mock-only
verifications, tests that would pass against a broken implementation, missing
coverage of the change's core behavior, and suppressed/skipped assertions.

Collect every finding from every lens into one list.

## 2. Dedupe

Merge findings across lenses, deduping by **file + line range + normalized
title** (trim, lowercase, collapse internal whitespace). When two lenses report
the same defect, keep the **highest severity** (critical > high > medium > low).
Dedupe only on that key — do not drop a finding because it "sounds like" another
one.

## 3. Verifier pass — adversarially re-examine each finding

For each deduped finding, run the verifier brief:

> You are given ONE prosecution finding. Try to **refute it**, not to agree.
> Steps: (1) re-read the finding's evidence in context; (2) construct the most
> concrete reproduction or counterexample you can; (3) decide: REAL (a genuine
> defect a maintainer should act on — you built a concrete repro or mechanism),
> REFUTED (you built a concrete counterexample, or proved it is already handled),
> or CANNOT-DECIDE (neither succeeded). Be specific and mechanistic; "looks fine"
> is not a reason.

**Honesty note on the verification semantics:** here there is one model (you)
re-examining its own findings in the same context, which is weaker than the
fan-out integrations' strict majority of independent verifier votes. Adapt the
contract honestly:

- REAL, with a concrete repro or mechanism → the finding **survives**.
- REFUTED, with a concrete counterexample or proof it is already handled → the
  finding is **dropped**. A vague "probably fine" does not refute anything.
- Cannot decide (evidence unclear, cannot trace the code path) → the finding
  **survives as an unverified blocker**. A pre-merge gate fails closed: never
  silently drop a finding because verification did not complete.

## 4. Loop until dry

Repeat steps 1–3 until **two consecutive rounds surface no new confirmed
findings** (a round is dry when it contributes zero net-new surviving findings
versus the running set). Cap the loop at 5 rounds; if it is cut off before going
dry, report that as a finding itself ("convergence did not complete").

## 5. Deterministic gates

These are mechanical, not judgment:

- **Hollow-test** (always) — are the tests load-bearing? Run
  `adlc hollow-test --test-cmd "<the project's test command>"`. It mutates the
  changed code to find tests that pass without actually testing the behavior
  (hence the clean-tree precondition in step 0 — it mutates in place and
  restores). On a clone with no resolvable `main`/`master`, pass an explicit
  `--base <ref>`. Exit `2` = hollow tests found; fix them before merging.
- **Behavior-diff** (only for HTTP-observable services) — is the change visible?
  The capture tool probes a RUNNING HTTP target: `behavior.json` must declare
  `baseUrl` plus a non-empty `routes` array of `{method, path}` entries. There is
  no base-branch mode — to get a "before" snapshot, check out and run the base
  yourself, then capture. Run
  `adlc behavior-diff capture --config behavior.json --out before.json`, repeat
  for `after.json` on the change, then
  `adlc behavior-diff compare before.json after.json`. For projects with no HTTP
  surface (CLIs, libraries), skip this gate and note the skip in the verdict.

## 6. Cross-model adversarial review (the risk gate)

Run `npx adversarial-review --providers <a,b>` (≥2 distinct providers on the risk
gate) — a fresh-context, cross-model ship/no-ship review. Given the
weaker-independence caveat above, this step carries the cross-model weight for
this flow; do not skip it for risk-gated changes (auth/trust boundaries, deny
paths, secrets, destructive data operations, schema migrations, CI/CD/supply
chain). The default invocation is single-shot: fix its findings and re-run until
it exits 0 (`exit 0 = SHIP`). If no API keys are configured, use
`npx adversarial-review --prompt-only` and answer the review prompt yourself, but
prefer a genuinely different model for security-critical changes.

When the review passes, record it so the risk-tier stop-audit has a satisfiable
record instead of nagging unconditionally:

```
adlc gate-manifest record adversarial-review --ticket <id> --files <risk-gated paths> --data '{"providers":"<a,b>","verdict":"SHIP"}'
```

`--ticket <id>` scopes the record to THIS ticket — a ticketless entry satisfies
the stop-audit for ANY later ticket touching the same files. `--files` is a
comma-separated list of repo-root-relative paths and must cover the risk-gated
changed paths the review actually examined (a space-separated list silently
records only the first path).

## 7. Record + verdict

Report the surviving findings (severity, file, evidence, recommendation) and a
ship/no-ship verdict. On CLEAR, record the prosecution evidence:

```
adlc gate-manifest record prosecution --ticket <id> --files <changed files>
```

(`--files` here too: comma-separated, repo-root-relative.)

Material (surviving, non-refuted) findings block the merge — including unverified
blockers, until they are verified or refuted.
