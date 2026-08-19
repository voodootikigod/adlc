---
name: release-audit
description: >-
  Production-readiness audit of the whole @adlc suite before cutting a release. Audits every
  shipped artifact in parallel — all 31 packages and all 8 host plugins — plus four
  suite-level agents, hunting release-BLOCKING issues rather than general code smells. Also
  triages open GitHub issues against the code to say which still reproduce. Runs on the
  currently selected model; no cross-model provider. Triggers on "release audit", "are we
  ready to release", "production readiness", "what's blocking the release", "audit before
  release", "pre-release check", "release blockers", "can we ship 1.11".
user-invocable: true
argument-hint: "[version] [--since <tag>] [--packages a,b,c] [--skip-issues]"
---

# Release Audit

A **GO / GO-WITH-RISK / NO-GO** read on the suite before a release. Every shipped artifact
gets its own agent, in parallel, and the verdict is arithmetic over what they return — not
a model's summary of them.

This is not `/adversarial-review`. That reviews a **diff** and deliberately runs on a
*different* model, because a model reviewing its own output is a weak critic. This audits
**standing state** — a landmine that shipped in 1.4.0 and is still there is exactly what a
diff review structurally cannot see — and runs on the **currently selected model**, with a
refute pass rather than a second provider as the precision mechanism.

## When to use

- Before `/release` — the readiness question, asked before the mechanical bump.
- "What is blocking 1.11.0?" / "are we ready to ship?"
- After fixing blockers: re-run narrowed with `--packages` (that run can never return GO).

## What counts as a blocker

Three booleans, all of which each agent must assert explicitly:

| test | meaning |
|---|---|
| `user_hits_it` | someone running `npm i @adlc/<pkg>@<version>` actually encounters it |
| `needs_another_release` | it cannot be fixed after the fact |
| `worse_than_status_quo` | it is worse than what the last release already shipped |

Anything failing one of the three is **SHOULD-FIX** (ship, eyes open) or **BACKLOG**. A
BLOCKER that does not carry all three assertions is demoted automatically — the severity
claim was never actually made. Agents are told outright that most findings are not blockers.

Failure classes, in priority order: **false-green** (a gate exiting 0 when it should exit 2,
or failing open on malformed input — this product is a suite of gates, so this is the
signature risk) → install/first-run → undeclared breaking change → trust boundary → secrets
→ data loss → doc-claim → dependency.

## Procedure

### 1. Start the background suite

The agents run for minutes and are read-only, so the test suite is free if it runs
alongside them. Launch it first, in the background, capturing to a log:

```bash
env -u ADLC_TICKET node scripts/run-tests.mjs > <scratch>/suite.log 2>&1
```

`<scratch>` is the session scratchpad directory, not `/tmp`.

`env -u ADLC_TICKET` is load-bearing: an exported `ADLC_TICKET` reproducibly fails the
segments that assert no-ticket-selected behaviour, which reads as a real regression and
would force a spurious NO-GO. `run-tests.mjs` scrubs `ADLC_MANIFEST_KEY` and friends
itself, but not this one.

A red suite makes the verdict NO-GO no matter what the agents find.

### 2. Collect (Phase A)

```bash
node scripts/release-audit-collect.mjs [version] [--since <tag>] [--packages a,b,c] [--skip-issues] \
  > <scratch>/input.json
node scripts/release-audit-collect.mjs [same flags] --workflow-args > <scratch>/wargs.json
```

This discovers every shipped artifact (including `plugins/adlc-claude-code`, which has no
`package.json` — it ships via `.claude-plugin/plugin.json`), computes per-artifact churn
since the baseline tag, routes open GitHub issues to artifacts, and runs the cheap
mechanical probes by **importing** `release.mjs`'s own checks rather than restating them.

Defaults: version = next minor from the root `package.json`; baseline = newest `vX.Y.Z` tag.

Two outputs, deliberately: `input.json` is the full document Phase C builds the report from,
and `wargs.json` is the projection the fan-out consumes. `args` is passed inline in the
Workflow tool call, so its size is paid on every run — the projection drops the per-unit file
inventory and everything else no prompt reads, roughly halving it. Never pass `input.json`
as `args`.

### 3. Fan out (Phase B)

Build a self-contained script and hand the Workflow tool its path:

```bash
node scripts/release-audit-workflow.mjs --input <scratch>/wargs.json --out <scratch>/workflow.mjs
```

```
Workflow({ scriptPath: "<scratch>/workflow.mjs" })
```

No `args` are passed. The builder embeds the collected document as `INPUT_DOC`, so nothing has to be
transcribed into the tool call — the document reaches the script byte-exact from disk
rather than through hand-copied JSON. Issue titles are written by anyone who can open an
issue and are embedded verbatim, so `<`, U+2028 and U+2029 are escaped on the way in.

Invoking this skill **is** the opt-in for multi-agent orchestration, and this run
deliberately exceeds the default workflow size guideline — auditing each artifact
individually is the point. Write the workflow's returned `{ reports: [...] }` to `<scratch>/reports.json`.

A workflow script has no filesystem and no `child_process`; it reads only `args`. That is
why Phase A exists and why the script needs no editing between runs.

### 4. Synthesize (Phase C)

```bash
node scripts/release-audit-synthesize.mjs \
  --input <scratch>/input.json \
  --reports <scratch>/reports.json \
  --suite <scratch>/suite.log \
  --json <scratch>/release-audit-<version>.json
```

Exit `0` = GO or GO-WITH-RISK, `2` = NO-GO, `1` = could not run.

`--suite` is not optional in practice: omitting it means nothing is known about the tests,
which is the same state as a suite that did not run, so the verdict is NO-GO. The flag
cannot be skipped to obtain a cleaner result.

It grounds every finding (the quoted evidence must appear verbatim in the cited file),
dedupes, applies the demotion rules, folds in the probe results and the suite outcome, and
computes the verdict. Print its terminal output as-is.

### 5. Publish the report

Load the `artifact-design` skill, then build the full report as an HTML page from the
Phase C JSON and publish it with the **Artifact** tool: every artifact's section, all three
buckets, the issue-verdict table, demoted findings with their reasons, and the mechanical
baseline. Keep the terminal output terse; the detail lives at the URL.

### 6. Report honestly

Give the verdict and the blockers as the synthesizer computed them. Do not soften a NO-GO,
and do not act on findings — deciding what to fix is the maintainer's call.

## Demotion rules — why nothing is ever deleted

| rule | trigger | effect |
|---|---|---|
| ungrounded | quoted evidence is not in the cited file | BLOCKER → SHOULD-FIX |
| refuted | the verification agent broke the claim | BLOCKER → SHOULD-FIX |
| hollow | the reporting unit examined no files | BLOCKER → SHOULD-FIX |
| unasserted | `blocker_test` is not all three true | BLOCKER → SHOULD-FIX |

A deleted finding is unreviewable. A demoted one still appears, with the demotion named, so
a human can disagree.

## Fail-closed behaviour

- A shipped artifact that produced **no report** forces NO-GO. `release.mjs` states the rule
  this borrows: *"could not check" must never render as "verified"*.
- A report listing **no files examined** is hollow, not clean, and also forces NO-GO.
- A suite log with **no summary line** counts as not-run, never as green.
- A `--packages` run is capped at GO-WITH-RISK — it has nothing to say about what it skipped.
- An **absent** `--suite` is treated exactly like a suite that did not run: NO-GO.
- A failed or skipped `gh issue list` is named in the verdict, so an untriaged backlog can
  never read as "no blocking issues". Same for a fetch that hit its 500-issue limit.
- A finding citing a path outside the repository is rejected rather than read — the cited
  path is model-authored, and grounding must not become an arbitrary-file probe.

## Verification

```bash
node scripts/release-audit-collect.mjs --skip-issues | head -20   # emits JSON, exit 0
node --test scripts/test/release-audit-*.test.mjs
```

Both helpers live flat in `scripts/` so `scripts/<name>.mjs → scripts/test/<name>.test.mjs`
maps under mutation-gate's fast path; nesting them would drop the whole diff to the slow
path, whose budget is 3 mutants total.

## Related

- `/adversarial-review` — diff-scoped, cross-model. Different question, different scope.
- `/release` — the mechanical cut. This skill answers whether that should happen.
- `scripts/preflight.mjs` — the PR gates. Green preflight is necessary, not sufficient.
