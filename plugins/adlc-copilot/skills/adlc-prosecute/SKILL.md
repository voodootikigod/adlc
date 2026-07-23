---
name: adlc-prosecute
description: Run the multi-lens P5 adversarial prosecution fan-out and record ADLC P5 review evidence and P6 acceptance packet workflows in the GitHub Copilot CLI. Fans out five independent read-only lenses, dedupes findings, verifies each independently, and loops until dry before recording evidence.
---

ADLC_COPILOT_SENTINEL_PROSECUTE_V1

# ADLC Prosecute

## The multi-lens prosecution fan-out (P5)

The GitHub Copilot CLI ships six read-only prosecution agents
(`agents/adlc-prosecutor-*.agent.md`) — the five lenses plus the verifier — each
with a read-only tool allowlist so a lens cannot mutate the change it judges. Run
the fan-out as a loop:

1. **Fan out five independent lenses.** Invoke each of the following read-only agents
   independently against the change diff, collecting each lens's JSON findings
   array: `adlc-prosecutor-correctness`,
   `adlc-prosecutor-security`, `adlc-prosecutor-contract`, `adlc-prosecutor-diff`,
   `adlc-prosecutor-tests` (`plugins/adlc-copilot/agents/adlc-prosecutor-*.agent.md`). Each
   lens hunts one specific failure class only — do not let one lens's prompt bleed into
   another's judgment.
2. **Dedupe.** Combine all five lenses' findings and dedupe with `dedupeFindings` from
   `lib/prosecutor.mjs` (re-exported, by reference, from `@adlc/core`), keeping the
   highest-severity instance of each `findingKey`-identical finding.
3. **Verify independently.** For each deduped finding, invoke
   `adlc-prosecutor-verifier` once, with a fresh context and no memory of other
   findings' verdicts. Its job is to try to refute the finding, not confirm it — default
   to refuted on weak evidence. Collect `{ real, reason, repro }` per finding.
4. **Decide survival.** A finding survives only if `survivesVerification` (strict
   majority of valid `real: true` votes) says so. A finding with no valid vote survives
   as an unverified blocker (fail closed) rather than being silently dropped.
5. **Loop until dry.** If any finding survived this round, fix it, then repeat steps 1-4
   against the updated diff. Use `shouldContinue` (`maxDry: 2`, the default) to decide
   when to stop: two consecutive rounds with zero surviving findings ends the loop.

This is the same fan-out → dedupe → independent-verify → loop-until-dry shape Claude
Code's `prosecutor-{correctness,security,contract,diff,tests,verifier}` subagents
implement — Copilot reuses the identical pure orchestration logic
(`findingKey`/`dedupeFindings`/`survivesVerification`/`shouldContinue`) from
`@adlc/core` via `plugins/adlc-copilot/lib/prosecutor.mjs`, delegated across the six
read-only prosecution agents so no lens can mutate the change it judges.

**Fallback:** where a live in-session subagent fan-out cannot be exercised, run the
cross-model gate `npx adversarial-review --providers <a,b>` as the independence
backstop — the same cross-model P5 fallback the sibling integrations document.

## Automatic Stop-time reminder

The plugin's `agentStop` review hook checks the session's changed files against the
risk-tier categories (auth/trust-boundary, security-control deny-path, secrets,
data-loss/destructive, schema-migration, CI/CD supply-chain) and, if any are
touched with no recorded `adversarial-review` gate-manifest entry for the
active ticket, surfaces an advisory nudge to run the loop above and record
its evidence. This does not replace running the loop yourself — it is a
safety net for the case where it was skipped.

## Recording evidence

Once the loop above is dry, capture the transcript and record the reviewer-produced
evidence with `adlc prosecute`.
The transcript must name the ticket and reviewed `git-worktree:<hash>` revision that P5
records. Do not pass `--revision` in normal git worktrees; auto-resolved revisions keep
P6 staleness protection active.
The P5 input must also include `review_packet` with prompt path/hash, reviewed-input
path/hash, and `clean_worktree` equal to the reviewed revision.

For scoped P5 evidence:

```sh
adlc prosecute --input .adlc/p5-passes.json --ticket <ticket-id> --dir .adlc --json
adlc run p5 --ticket <ticket-id> --dir .adlc --json
```

P6 strict mode requires P5 evidence:

```sh
adlc behavior-diff capture --config behavior.json --out .adlc/before.json
adlc behavior-diff compare .adlc/before.json .adlc/after.json --json
adlc accept --ticket <ticket-id> --packet .adlc/packet.json --before .adlc/before.json --after .adlc/after.json --dir .adlc --json
adlc run p6 --ticket <ticket-id> --dir .adlc --json
```

The bundled docs fixture is static. Use it only with its fixture revision:

```sh
adlc prosecute --input docs/examples/p5-passes.json --ticket T1 --revision docs-example-revision --dir .adlc --json
```
