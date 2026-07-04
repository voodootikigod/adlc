---
description: Prosecute a change before merge (P5) — fan out five lens subagents, dedupe, independently verify, and loop until dry.
argument-hint: [ticket-id] (defaults to the active ticket)
---

# /adlc-prosecute — hostile pre-merge review (P5)

Prosecute the change for the active ticket. Prerequisite: a clean G4 build (rails
green, build + lint clean, no suppressions) for **$ARGUMENTS** (default to the
active ticket) on the branch under review with a clean working tree.

This command replicates the multi-lens adversarial loop from the OpenCode
integration (`plugins/adlc-opencode/command/adlc-prosecute.md`) — fan-out across
independent lenses, cross-lens dedupe, independent verifier refutation, and
loop-until-dry convergence — using Claude Code subagents instead of OpenCode's
`@agent` syntax. The pure dedupe/verify/convergence contract is shared code:
`plugins/adlc-claude-code/lib/prosecutor.mjs` (unit-tested in
`plugins/adlc-claude-code/lib/test/prosecutor.test.mjs`).

## 1. Fan out the lenses

Invoke these five prosecution subagents **independently** via the Task tool, each
given the full change diff for **$ARGUMENTS**: `prosecutor-correctness`,
`prosecutor-security`, `prosecutor-contract`, `prosecutor-diff`,
`prosecutor-tests`. Each returns a JSON array of findings (possibly empty) —
`severity`, `file`, `line_start`, `line_end`, `title`, `body`, `evidence`,
`recommendation`. Collect every finding from every lens into one list.

## 2. Dedupe

Merge findings across lenses, deduping by file + line range + normalized title
(`findingKey` in `lib/prosecutor.mjs`), keeping the highest severity when two
lenses report the same defect (`dedupeFindings`). Do this deterministically —
do not drop a finding because it "sounds like" another unless the key matches.

## 3. Verify each finding

For each deduped finding, invoke the `prosecutor-verifier` subagent
**independently** (fresh context, one finding at a time) to try to refute it. A
finding **survives** only if a strict majority of verification votes confirm it
real (`survivesVerification`); refuted findings are dropped. A finding with zero
valid verification votes (verifier crash, timeout, unparseable output) also
**survives** as an unverified blocker — a pre-merge gate must fail closed, never
silently drop a finding because the verifier didn't run.

## 4. Loop until dry

Repeat steps 1-3 until two consecutive rounds surface no new confirmed findings
(`shouldContinue`, `maxDry: 2`). A round is "dry" when it contributes zero net-new
surviving findings versus the running set; two dry rounds in a row end the loop.
Cap total rounds at a sane bound (e.g. 5) and report if the loop is cut off before
going dry — that is itself a finding ("convergence did not complete").

## 5. Record + verdict

Report the surviving findings (severity, file, evidence, recommendation) and a
ship/no-ship verdict. On CLEAR, record prosecution evidence:

```
adlc gate-manifest record prosecution --files <changed files>
```

For formal `adlc run p5` phase assertion (ticket- and revision-bound, dry-pass
convergence with provenance), use the runner path — harness-agnostic, not
exclusive to any one CLI: package the surviving/killed findings per lens into the
`@adlc/prosecute` input shape (see `packages/prosecute/README.md`) and run
`adlc prosecute --input <file> --ticket <id>` followed by `adlc run p5 --ticket
<id>`. Material (surviving, non-refuted) findings block the merge regardless of
which recording path is used.
