# ADLC Codebase Review — Principle-Fidelity Audit

**Date:** 2026-08-10
**Baseline of record:** the eight-post [ADLC series](https://voodootikigod.com/series/adlc) plus the repo's own `ADLC.md` (1,183 lines)
**Method:** 7 fresh-context lenses explored the repo in parallel, each blind to the others; every lens's findings then went to a separate refute-chartered verifier. 14 agents, 2.26M tokens.
**Result:** 56 findings surfaced → **51 confirmed, 5 downgraded, 0 refuted.** The two critical headlines were re-verified by hand.

*This document is an audit findings report produced on 2026-08-10. It is reference documentation and contains no source code, configuration, or runtime changes. Severities describe conditions observed in the repository during the audit; remediation of those conditions is tracked separately.*

---

## The gates fail closed. The wall around them isn't switched on.

Measured against the founding thesis of the ADLC series — agentic development made **dependable and trustable by engineering around the ways LLMs actually fail**, not by hoping they behave — the toolkit is built to its own principle almost everywhere the code does the deciding. The trust the doctrine is designed to remove leaks back in at the **last mile**: the mechanical wall that turns fail-closed gates into merge-blocking facts is largely unwired, and the prosecution phase — the crown jewel — trusts model prose where the doctrine demands executed evidence.

### One-paragraph verdict

The **gate implementations** are exemplary: enforcing hooks deny on malformed input, failed `chdir`, symlink loops, and any crash (exit 2); rails-guard's baseline never defaults to HEAD; the manifest chain is genuinely anti-forge; `review-calibration` measures its own measurer. This is F4/F5 done right, and several tools now **exceed the published blog**.

But three seams let the model back into the trust boundary: (1) none of the fail-closed CI gates are **required status checks**, so a gate that DENIES can still merge; (2) P5 "verified findings" and the loop-until-dry exit are **model self-report** — the verifier executes nothing; and (3) the two human gates and the in-session enforcement path are **convention/opt-in by default**. The parts are principled; the assembled system still asks you to trust the LLM in the exact places the doctrine says never to.

### Scorecard

| Metric | Value |
|---|---|
| Findings surfaced | 56 |
| Confirmed on re-derivation | 51 |
| Critical / root-cause | 4 |
| Refuted by verify pass | 0 |

---

## The eight seams, by root cause

Fifty-one confirmed findings collapse into eight root causes. The four rated critical/high at the top are load-bearing — they define what an agent can actually get away with. Severity is the corrected value after the adversarial verify pass.

| # | Seam | Severity |
|---|---|---|
| 01 | The merge wall isn't switched on | **critical** |
| 02 | The prosecutor can't run anything | **high** |
| 03 | The two human gates aren't bound to a human | **high** |
| 04 | The trust anchor is reachable in-session | **critical** |
| 05 | The default local path is advisory | **high** |
| 06 | The weakest harness sets the guarantee | medium |
| 07 | Vacuous edges inside individual gates | medium |
| 08 | The cost ratchet isn't turning yet | medium |

> **The diagram in one line:** five fail-closed CI gates (rails-guard, mutation-gate, cross-model, ledger guard — each correctly `exit 2` / `fail() ≠ 0`) feed a merge decision that no required check blocks. The code says DENY; the branch ruleset never asks. `required_status_checks = test(18/20/22)` only.

---

## 01 — The merge wall isn't switched on

*The single load-bearing finding. Every ADLC gate is correctly fail-closed in code — and none of them can block a merge. This is the root cause behind roughly a dozen "backstopped by CI (non-required)" caveats in the other seams.*

### 🔴 CRITICAL · gap · confirmed (re-checked by hand)
**A gate that exits 2 (DENY) can still merge — the fail-closed exit codes have no merge-blocking effect**

**What I found.** The live `main` branch ruleset lists exactly three required status checks — `test (18)`, `test (20)`, `test (22)` — and requires **0 approving reviews** with `require_code_owner_review: false`. rails-guard, the mutation gate, the append-only findings-ledger guard, the reviewer-directed-comment gate, and the cross-model trust-root verifier all run in *separate, non-required* jobs. A PR any of them DENIES merges the moment the unit-test legs go green.

**Why it matters.** Principle 5 is "protect the rails *mechanically*, not by instruction." The gate code honors it perfectly — `fail()` is documented to *never* return 0. But a fail-closed exit code that nothing requires is, in `ci.yml`'s own words, **"theatre."** Every "unbypassable"/"required check" claim in the docs is currently aspirational.

**Refs:** `gh api …/rules/branches/main → test(18/20/22) only` · `.github/workflows/ci.yml:236` · `scripts/rails-guard-ci.mjs:17` · `cross-model-gate.yml`

**Recommendation.** Add `rails-guard`, `mutation-gate`, `cross-model-gate`, and `pre-ga-gate` to `required_status_checks.contexts`, and set `require_code_owner_review: true` with `required_approving_review_count ≥ 1`. This is a configuration change, not a code change — the wall is built; it just isn't load-bearing yet.

---

## 02 — The prosecutor can't run anything

*Prosecution (P5) is the doctrine's answer to sycophancy and hallucination. The scaffolding around it is genuinely rigorous — but at its core, a "verified finding," a "killed finding," and a "dry pass" are all text the model wrote, not evidence a machine reproduced.*

### 🟠 HIGH · diverges · confirmed
**"Verified" and "killed" verdicts are model self-report — nothing is executed to confirm them**

**What I found.** The prosecution verifier consumes verdicts as data; it cannot run a test, trace a code path, or trigger an input. A finding is "verified" or "killed" because another model *said so*, and loop-until-dry treats a "dry pass" as satisfied by any non-empty string. That is precisely the F4 failure mode — "evidence or it didn't happen" — aimed at the critic instead of the builder, which Principle 2 says applies symmetrically.

**The honest nuance.** The *packaging* is strong: the schema rejects an empty `passes` array, a dry pass requires non-empty `dry_evidence`, a zero-finding packet requires a `no_findings_attestation`, and every "killed" finding requires a verification-proof object. The runner binds evidence to a content-hashed revision, refuses to attest over untracked files, and re-hashes transcripts at assert time. So the evidence is **revision-bound and un-swappable** — it just isn't **reproduced**. The structure guarantees the model attached *a* proof to *this* change; it does not guarantee the proof is real.

**Refs:** `packages/core/lib/prosecutor.mjs:107` · `packages/prosecute/lib/run.mjs:358` · `packages/prosecute/lib/schema.mjs:147`

**Recommendation.** Require an *executed* artifact for each verdict that admits one: a failing→passing test for a "fixed" finding, an exit-coded repro for a "killed" one, and compute the dry-pass exit from executed results rather than from the presence of prose. Keep the model for judgment where execution is impossible; gate everything that *can* be run on the run. This is the same discipline `review-calibration` already applies (see Strengths) — extend it into the live loop.

### 🟡 MEDIUM · diverges · confirmed
**Fleet, the auto-merging lane, runs a single prosecution pass — not loop-until-dry**

**What I found.** The unattended path most in need of F6 (finding-count-prior) protection runs one prosecution pass and merges. The doctrine's "repeat with fresh contexts until K consecutive passes find nothing" is exactly where single-pass review systematically undercounts, and it's absent on the lane where no human is watching.

**Refs:** `packages/fleet/lib/gate-pipeline.mjs` · `packages/fleet/lib/prosecute.mjs:22`

**Recommendation.** Run the same loop-until-dry the interactive path runs before an unattended auto-merge, or gate auto-merge on a convergence count the code measures.

---

## 03 — The two human gates aren't bound to a human

*"Two human gates and everything between is machine-checked" is the title of post 2 and the spine of the whole model. The machine-checked middle is largely built. The two human anchors that give it meaning are convention.*

### 🟠 HIGH · gap · confirmed
**An agent can mint both P1 spec-approval and P6 behavioral-acceptance evidence itself**

**What I found.** Completion and acceptance are agent-runnable self-declarations. Nothing binds P1 approval or P6 acceptance to a human identity the agent cannot produce — no signed human token, no required GitHub review by a person, no out-of-band approval. The phase runner asserts that *an* acceptance record exists and is revision-bound; it does not assert that a *human* authored it.

**Why it matters.** The published promise is "is this what I meant?" and "is this what I meant, running?" as the two irreplaceable moments. If an agent can satisfy both, the barbell has no human end — the entire "exactly two human gates" guarantee reduces to a naming convention.

**Refs:** `packages/runner/lib/acceptance.mjs:182` · `runner/lib/assertions.mjs:7`

**Recommendation.** Bind P1 and P6 to something an agent can't forge: a required human GitHub review (ties into §01's ruleset fix), a signed approval token held outside the repo, or an operator-side confirmation the runner verifies rather than accepts. Until then, document the two gates as advisory so no one mistakes convention for enforcement.

---

## 04 — The trust anchor is reachable in-session

*The CI path handles the manifest signing key exactly right — key isolation there is exemplary (see Strengths). The in-session path regressed, and the fix for it is currently reverted off `main`. Two related exposures.*

### 🔴 CRITICAL · diverges · confirmed (re-checked by hand)
**The enforcing handoff hook dynamic-imports project-resolvable code with the signing key in its environment**

**What I found.** The PreToolUse `handoff` hook resolves `@adlc/context-handoff` by walking into the *project's* `node_modules`, then `import()`s the result inside a process that inherits `ADLC_MANIFEST_KEY`. A repo (or a compromised transitive dep) shipping a package by that name wins resolution, can return `{deny:false}` to silently disable the context-rot deny-set, and can read/exfiltrate the trust anchor for every manifest attestation. The hook's export-presence check is a *shape* check, not a *trust* check.

**Status — this is a known, currently-un-landed fix.** This exact issue was filed as ticket #479 and fixed by commit `08c3eae` ("scrub the manifest key before importing project-resolved code"), which lives on two branches. I confirmed by hand that `08c3eae` is **not** an ancestor of `HEAD`, and that #479 was reverted by #480 (`4922c03`). So `main` currently ships the vulnerable resolver.

**Refs:** `plugins/adlc-claude-code/hooks/handoff-resolve.mjs:56` · `…/handoff-resolve.mjs:101` · `…/adlc-hook.mjs:1644` · `git: 08c3eae not on main · reverted #480`

**Recommendation.** Land the resolver-trust fix on `main`: import the gate implementation only from a plugin-owned/vendored path (or a realpath verified inside a trusted root), scrub `ADLC_MANIFEST_KEY` from the hook env before *any* project-resolved import, and fail closed with a distinct reason when resolution lands in a project-writable location. The reason it was reverted is worth capturing — if the scrub broke a legitimate flow, that flow is the real design problem to solve.

### 🔴 CRITICAL · gap · confirmed
**A builder-accessible signing key lets the builder mint the cross-model approve that gates its own merge**

**What I found.** Where the manifest signing key is reachable by the builder's context (the in-session case above being one route), the builder can produce a signed cross-model approval attesting to its own work — the F2 failure mode the whole prosecution architecture exists to prevent. The chain math is sound; it just trusts whoever holds the key, and in-session that can be the builder.

**Refs:** `packages/gate-manifest/lib/sign.mjs` · `cross-model.mjs:12`

**Recommendation.** Treat the key as a CI-only secret (the cross-model-gate workflow already models this correctly) and remove every code path that places it in a builder-reachable environment. The read-side author-anchoring is already correct — the gap is purely custody.

---

## 05 — The default local path is advisory

*Out of the box, the in-session experience mostly warns rather than blocks. The teeth exist — they're behind env flags — but a fresh install's default posture is the opposite of the doctrine's "tool layer, not prompt layer."*

### 🟠 HIGH · diverges · confirmed
**The default harness path turns every LLM-backed gate into self-review with an unconditional exit 0**

**What I found.** `--prompt-only` gates (coldstart and the harness-native LLM gates) always exit 0 and record the model's own verdict; the mechanical block on the adversarial-review Stop hook only fires when `ADLC_ADVERSARIAL_REVIEW_ENFORCEMENT=1`; rail/build-gate enforcement is gated behind `ADLC_*_ENFORCEMENT=1`. Unset — the default — none of these deny. So the shipped default requires *both* the opt-in flags *and* the CI wall from §01 before anything is mechanically enforced; absent either, an unreviewed, risk-gated change is never stopped.

**Refs:** `plugins/adlc-claude-code/hooks/adlc-hook.mjs:818` · `…/adlc-hook.mjs:785` · `packages/coldstart/lib/gate.mjs`

**Recommendation.** Flip the default to enforcing wherever the host can fail closed, and make advisory an explicit, logged opt-*down*. A tool whose safe mode is off-by-default trains its users into the unsafe configuration.

---

## 06 — The weakest harness sets the guarantee

*Eight integrations, very uneven enforcement. Whatever the weakest supported harness allows is the real guarantee, because an agent under pressure will run where the rails are thinnest.*

### 🟡 MEDIUM · gap · confirmed
**Enforcement floor is defined by the opt-in, fail-open integrations — and one deny-set exists in only one of eight**

**What I found.** adlc-gemini (Antigravity) and adlc-cursor are opt-in, declare `failClosed: false` on every hook, and run on hosts that fail open; their "deny proofs" assert the command ran, not that the edit was blocked and the file left byte-identical. The context-handoff (F3) PreToolUse deny exists in *only* the Claude Code plugin — seven of eight integrations lack it. And the flagship Claude Code wrapper itself **fails open on hook timeout/kill**: it exits 1 where only exit 2 blocks. Secret-exposure blocking lives only in this repo's private harness and is deliberately fail-open.

**Refs:** `plugins/adlc-cursor/hooks.json (9× failClosed:false)` · `adlc-gemini/hooks/rails-checker.mjs:188` · `adlc-claude-code/hooks/adlc-hook-run.mjs (exit 1 on timeout)` · `docs/integrations/harness-capability-matrix.md`

**Recommendation.** Publish a minimum enforcement *floor* every integration must meet, and treat the capability matrix as a guarantee rather than a description. Close the Claude Code wrapper's timeout→exit-1 window (map enforcing-mode timeout to exit 2, which the CI wrapper already does). Credit where due: the matrix already names most of these honestly — the gap is that honesty about a fail-open default doesn't close it.

---

## 07 — Vacuous edges inside individual gates

*Gate-by-gate, a handful of paths pass by doing nothing, or can be dodged by formatting. Individually medium; collectively they're the F5 (reward-hacking) surface a builder probes first.*

### 🟠 HIGH · diverges · confirmed
**spec-lint passes vacuously on a spec with zero acceptance criteria (or criteria under a non-matching heading)**

**What I found.** The P1 gate whose entire job is enforcing F1 ("make satisfaction machine-checkable") returns pass when there are no criteria to check, or when criteria sit under a heading its scanner doesn't recognize. A spec that specifies nothing sails through the gate designed to reject under-specification.

**Refs:** `packages/spec-lint/bin/spec-lint.mjs`

**Recommendation.** Fail closed on zero recognized criteria; treat "no criteria found" as the strongest under-specification signal, not the absence of one.

### 🟠 HIGH · diverges · confirmed
**The suppression-marker gate is a case-sensitive, per-line substring scan over a closed list**

**What I found.** The marker *list* (unlike the diff parser wrapped around it, which is genuinely hardened) is dodged by trivial formatting: case variation, whitespace, string concatenation, or a suppression spelling not in the closed set. The distilled lens the repo itself wrote says text-scanning gates must derive operative-vs-inert *authoritatively* (parse, don't grep) — the marker check doesn't meet its own bar.

**Refs:** `packages/rails-guard/lib/suppressions.mjs`

**Recommendation.** Normalize (case, whitespace, unicode) before matching, and where a linter directive grammar exists, parse it rather than substring-scan. The diff-parser hardening next door is the model to follow.

### 🟡 MEDIUM · gap · confirmed
**Coverage-lag registries new surfaces can silently escape**

**What I found.** The `run-tests` plugin segments are hand-enumerated with no completeness guard against `plugins/`, and the `completed:true` backlog filter is three byte-identical hand copies with no drift guard — a new consumer that forgets it re-opens closed tickets. The mutation gate exempts TypeScript by language and passes string/regex-only changes with a warning. Each is a place where adding a surface silently shrinks the guarded set.

**Refs:** `scripts/run-tests.mjs` · `scripts/mutation-gate.mjs:159` · `completed:true (×3 copies)`

**Recommendation.** Add bijectivity/completeness tests (the docs registry already does this — `ALL_PACKAGES` must equal the `packages/` listing exactly; copy that pattern), and extend mutation coverage to TypeScript.

---

## 08 — The cost ratchet isn't turning yet

*Post 6's thesis is "run N+1 cheaper than run N." The machinery to make that measurable is designed and partly built — but the loop that would prove it's working isn't closed, and the scheduled jobs that keep it turning don't exist.*

### 🟡 MEDIUM · gap · confirmed
**The compounding-cost claim is instrumented but unmeasured, and the maintenance cron is absent**

**What I found.** The repo's own findings ledger records **zero spend**, so "cheaper each run" can't be computed from real data. The calibration recall number — the thing that "turns 'I do adversarial review' into a number" — never reaches the manifest or the prosecution verdicts. And there are exactly three scheduled workflows (copilot-live-canary, ceremony-drift, pi-version-matrix); **none** run `skill-rot` or `model-ratchet`, so the weekly cache-invalidation and frontier-re-prosecution the doctrine promises don't fire. The parts exist as tools; the metabolism that runs them on a schedule doesn't.

**Refs:** `.adlc/findings.jsonl (spend: 0)` · `.github/workflows/*.yml (3 cron, 0 relevant)` · `packages/skill-rot` · `packages/model-ratchet`

**Recommendation.** Wire real spend capture into the ledger, carry the calibration recall into the manifest so verdicts are self-describing, and add the `skill-rot`/`model-ratchet` scheduled workflows. Without them the ratchet is a design, not an observable — and the cost curve can't be asserted.

### The long tail (low severity, confirmed)

`ticket-sync` carries no stated model-flaw traceability (the design rule says every tool must trace to one); `gate-fuzzing`'s canary seed uses unseeded `Math.random`; coldstart verdict-reuse is wall-clock dependent; `rails-guard --record` can write a manifest entry whose `railFiles` proof is silently empty when `git ls-files` fails. None defeat a core guarantee; all are worth a cleanup pass.

---

## Where it upholds the principle — and exceeds the blog

*Where the codebase has grown past the original vision. These are the load-bearing strengths the audit confirmed — the reason the seams above read as last-mile wiring rather than a broken foundation.*

- **The gate code is exemplary fail-closed engineering.** Enforcing hooks deny on malformed stdin, un-enterable project dirs, symlink loops, and any crash (exit 2); rails-guard's `fail()` is structurally "never 0"; the freeze baseline *never* defaults to HEAD ("a builder who commits a rail edit would leave a clean tree and forge a pass"); hollow-test is a lattice of fail-closed refusals. *The foundation is sound.*

- **The CI cross-model gate is textbook trust-boundary engineering** — and the correct architecture the in-session hook (§04) fails to mirror. `pull_request_target` runs BASE code over the PR tree materialized as data-only, `persist-credentials:false`, the push credential deferred past `npm ci`, per-PR concurrency closing the revocation race. The signing key never reaches PR-controlled code. *(cross-model-gate.yml)*

- **review-calibration is the strongest deterministic loop in the toolkit** and exceeds its blog sketch: planted bugs are witness-verified by *actual execution* (pass-on-original, fail-on-mutant), the LLM judge is calibrated against a labeled fixture, and a meta-control fails the run if the scorer itself is broken. This is exactly the "evidence or it didn't happen" discipline §02 asks the live loop to adopt — it already exists here. *(packages/review-calibration)*

- **The manifest chain is genuinely anti-forge where the key is held honestly:** per-entry HMAC, terminal revocation no later approve can undo, a protected orphan-branch anchor closing truncation, and carry-forward with computed (never asserted) digest equality plus a hard depth cap. *(gate-manifest · prosecute/attestation-store)*

- **New tool classes the blog never imagined.** `gate-fuzzing` is a standing red-team of the gates themselves; `build-gate` denies mutations in context-rot-degraded sessions on code-computed thresholds (F3 as a tool-layer fact, enforced on Bash too); `quartermaster` keeps model supply an operator decision, never the repo-under-review's. Growth mostly kept flaw-traceability. *(gate-fuzzing · build-gate · quartermaster)*

- **The toolkit prosecutes itself.** hollow-test caught itself *exempting itself* from mutation and fixed it with an include-list; mutation-gate solved its own coverage-lag with a shared predicate and a cross-contract test; ADR-0009 was amended to delete its own injection-shaped sentence. Self-prosecution in the truest sense. *(the ratchet works on the ratchet)*

- **Prompt-injection is defended as a first-class threat.** Diff/ticket content is declared DATA in every charter, instruction-like text is itself reportable as a finding, planted "refute this" text is treated as evidence a finding is real, and a CI + preflight gate rejects repo text that tries to steer a reviewer. *(prosecutor-verifier · reviewer-directed-comment gate)*

- **Zero-dependency holds suite-wide.** All 31 packages declare only `@adlc/*` workspace deps — the entire runtime is Node builtins. All 18 blog tools exist as real packages with the documented 0/1/2 exit contract. The generated-reader pattern kills a whole keep-in-sync failure class after a real `ticketId` drift bug. *(the published claims are true)*

- **Fleet embodies the orchestration doctrine.** A deterministic scheduler (no model decides ordering/retries/merges), single-writer enforced by scope-overlap serialization *and* a fail-closed post-build scope gate, an OS sandbox repo-committed config cannot weaken, and a prosecutor binary resolved only against trusted absolute PATH entries so a worker can't plant a fake reviewer. *(packages/fleet)*

---

## How this review was run, and how much to trust it

The audit dogfooded the doctrine it was auditing: **seven fresh-context lenses** (fail-closed, trust-boundary, hollow-defense, bypassability, gate-determinism, integration-parity, principle-drift) explored the repo in parallel, each blind to the others; every lens's findings then went to a **separate, refute-chartered verifier** that tried to kill them by re-deriving each claim from the actual code and searching for a compensating control. Only findings that survived that pass are reported. Baseline of record: the eight-post series plus the repo's own `ADLC.md` (1,183 lines).

**An honest note on the zero-refutation rate.** The verify pass downgraded five findings and refuted none. Two readings: the evidence was genuinely airtight, or a refute charter that kills nothing warrants a small discount. I lean toward the first — the two critical headlines rest on external facts I re-verified by hand (the live branch ruleset lists only `test(18/20/22)`; commit `08c3eae` is not an ancestor of `HEAD` and #479 was reverted by #480). Still: treat the four critical/high seams as action items, and independently re-confirm the medium/low tail before acting on any single line item. This report locates and argues; it doesn't replace running the specific gate against your specific concern.

**The one thing to take away.** This is not a codebase that trusts the model out of naivety — it fails closed almost everywhere the code decides, it red-teams itself, and it writes its own weaknesses down. The trust re-enters at the boundaries between the built gates and the deployed system: the required-checks configuration, the human-identity binding, the in-session defaults, and the one place the doctrine most forbids it — a prosecution verdict that no machine reproduces. Close those and the assembled system finally matches the tools.
