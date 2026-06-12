# gate-fuzzing — Architecture Design (Opus mint-pass)

> ADLC C-tool. A standing red-team / GAN-for-the-lifecycle. A generator-adversary
> produces candidate diffs designed to **pass every configured gate while being
> genuinely wrong**. Each gate a wrong-but-passing diff defeats is a calibration
> finding that hardens that gate. This turns *"we found 11 bypasses once"*
> (HANDOFF §1, §4; Post 8 "The Gates Didn't Hold") into *"finding bypasses is a
> CI gate."*
>
> **Status:** DESIGN ONLY. No implementation here. Build is the Sonnet pass under
> TDD against this doc. This doc is written to be *prosecuted*: a fresh-context
> reviewer should attack §1 (defeat definition), §6 (anti-gaming), and §5 (the
> control) first — those are the load-bearing decisions.

---

## 0. Doctrine anchors (why each call is what it is)

- **C-tool DNA** (CONVENTIONS.md, ADLC Appendix C): zero runtime deps,
  `npx`-runnable Node ESM, deterministic exit `0`/`2`/`1`, `--json`,
  `--prompt-only`, tests run offline with no provider, `<400` lines per file,
  writes only inside `packages/gate-fuzzing/`, never edits `packages/core/`.
- **Principle 3 / F2** (never judge your own context's work): the adversary runs
  in **fresh contexts by construction** — each `complete()` / `fan()` call is
  stateless (core `llm.mjs`). The gate suite under test is authored in a
  *different* context than the adversary. gate-fuzzing is the institutionalized
  form of "a fresh context with a refute charter is the only thing that sees the
  blind spot" (Post 8).
- **Appendix E / Frontier-free**: no frontier model in the runtime loop. The
  adversary is **N fanned cheap/mid models** (E2 — search replaces insight), and
  the *verdict* (is this a real defeat?) is **deterministic** (E1 — the
  generator-verifier gap: judging a defeat with a witness is model-free). Opus is
  spent *once* on this design (E4 — banking), not per-run.
- **Appendix D0** (control flow is code, judgment is models): the loop, budget,
  scheduling, exit-code decision, and defeat-confirmation are **plain code**. No
  model decides when to stop, what passed, or what to record. Models only
  *generate candidates* (a judgment task) and optionally *triage* (§4.4).
- **§5 Goodhart Annex**: gate-fuzzing is itself a gate, so it is itself
  Goodhartable — a fuzzer that reports "0 defeats" because it is *blind* is the
  exact failure it exists to prevent. §5 of this doc (the control) bounds it,
  mirroring review-calibration's `controls.mjs`.

**Reuse, do not rebuild.** gate-fuzzing composes with
`packages/review-calibration/lib/`:
- `verify.mjs` — `runWitness`, `verifyWitness`. A **witness** is a command that
  PASSES on the correct version and FAILS on the wrong one. This *is*
  gate-fuzzing's oracle. We import its convention (exit 0 = behavior intact,
  non-zero = defect observable) verbatim.
- `controls.mjs` — the echo/oracle bounding *pattern* (a negative control that
  must score ~0, a positive control that must score 1.0). gate-fuzzing's control
  (§5) is the structural analogue: a sound stub it must NOT defeat, a defeatable
  stub it MUST defeat.
- `findings.mjs`, `judge.mjs`, `scorer.mjs` — reused only where noted (§4.4
  optional triage judge). The core defeat decision uses none of them — it is
  witness-only.

---

## 1. Definition of a "defeat" (precise, falsifiable)

A candidate `C` (a diff + a witness + a target-gate list, see §1.2) **defeats**
the configured gate suite **iff ALL of the following hold**:

1. **C is valid** (anti-gaming, §6): the diff applies cleanly to the freeze
   baseline, and the resulting tree passes the *validity gates* — build, lint,
   typecheck — that are part of the configured suite. An invalid candidate is
   never counted; it is discarded with reason `invalid:<which>`.
2. **C passes ALL configured gates honestly.** Every gate in the suite (§7),
   invoked as a `0/2/1` CLI against the candidate tree, exits `0`. A gate that
   exits `1` (op error) aborts the candidate as `inconclusive` — not a defeat,
   not a pass (we cannot certify a defeat through a broken gate). A gate that
   exits `2` means the candidate was *caught*: not a defeat (the suite held).
3. **C is genuinely wrong, proven by a held-out ORACLE.** The candidate carries
   a **witness** (`{ cmd, args }`, review-calibration `verify.mjs` shape). The
   witness must **discriminate**: it PASSES on the baseline tree and FAILS on the
   candidate tree. This is `verifyWitness`/`runWitness` applied at the
   *tree* level (see §1.3). The witness is **held out** from the gate suite — it
   is never one of the gates the candidate had to pass.

> **A candidate with no discriminating witness is NOT a defeat.** This is the
> anti-crying-wolf rule, lifted directly from review-calibration's
> equivalent-mutant exclusion (`filterEquivalentMutants`): a diff that passes all
> gates but whose "wrongness" cannot be demonstrated by an executable witness is
> *not evidence of a gate hole* — it may simply be correct, or its wrongness may
> be unobservable (an equivalent mutant of the whole repo). We refuse to report
> it. **Defeat = (passes every gate) AND (a held-out witness proves it broken).**
> Both halves are deterministic and executable. No model is in the verdict.

### 1.1 Truth table

| Diff valid? | Passes all gates? | Witness discriminates? | Verdict |
|---|---|---|---|
| no | — | — | `invalid` (discarded, §6) |
| yes | a gate exits 2 | — | `caught` (suite held — good) |
| yes | a gate exits 1 | — | `inconclusive` (op error — surface, never count) |
| yes | all exit 0 | no / absent | `unwitnessed` (NOT a defeat — no crying wolf) |
| yes | all exit 0 | yes | **`DEFEAT`** (a gate hole — §4 records it) |

Only the last row drives exit code `2`. Everything else is exit `0` *for that
candidate* (the run-level exit code is §3).

### 1.2 What artifacts a candidate carries (the structured-output contract)

A candidate is a JSON object — the contract the adversary must emit (§2.4) and
the unit the loop consumes:

```jsonc
{
  "id": "cand-<uuid>",              // assigned by the harness, not the model
  "strategy": "base-ref-window",    // taxonomy class (§2.2) — for clustering/reporting
  "targets": ["rails-guard"],       // which gate(s) this is designed to defeat (claim)
  "rationale": "commits the rail edit so `git diff HEAD` sees a clean tree",
  "diff": "<unified diff against the freeze baseline>",
  "witness": {                      // the held-out oracle — REQUIRED to ever count
    "cmd": "node",
    "args": ["--test", "test/freeze.witness.test.mjs"],
    "expect": "passes-on-baseline-fails-on-candidate"   // documented invariant
  },
  "setup": [                        // OPTIONAL ordered shell-free steps (argv arrays)
    ["git", "add", "-A"],           // e.g. the "commit then clean tree" attack needs a commit
    ["git", "commit", "-m", "x", "--no-verify"]
  ]
}
```

- `diff` + `setup` together make the attack **concrete and reproducible**.
  `setup` is the mechanism for taxonomy classes that aren't pure file edits
  (class 1/2: commit-then-clean-tree; class 3: forge a ledger entry). `setup`
  steps are **argv arrays, never shell strings** — anti-injection (taxonomy §12),
  spawned with `shell:false` exactly like `runWitness`.
- `witness` is the held-out oracle. Without it, the candidate can at best reach
  `unwitnessed`. The harness *verifies the witness discriminates against the
  baseline before crediting any defeat* — a candidate that lies about its witness
  (witness also fails on baseline, or passes on candidate) is discarded
  `invalid:witness`.
- `id` and ordering are harness-assigned. The model never supplies trust-bearing
  fields (cf. taxonomy §4 "trust agent-supplied data").

### 1.3 Where the witness runs — tree-level, sandboxed

review-calibration's `verifyWitness` mutates a single line in place and restores
it. gate-fuzzing operates at **whole-diff** granularity, so it generalizes that
to a tree:

1. Materialize a disposable **candidate sandbox** = a `git worktree` (or
   `mkdtemp` + `git clone --local`) at the freeze baseline. Never touch the
   user's working tree (CONVENTIONS rule 8; `isDirty` refusal up front).
2. Apply `diff` + run `setup` in the sandbox → the **candidate tree**.
3. Run `witness` against the **baseline** tree → must exit `0` (passes).
4. Run `witness` against the **candidate** tree → must exit non-`0` (fails).
5. Discriminates iff (3) passed and (4) failed and neither timed out — the exact
   `verifyWitness` invariant, hoisted to trees. Restore/destroy the sandbox in a
   `finally`.

Determinism note: the witness is run **twice** per credited defeat (baseline +
candidate). Cost is `2 × witnesses`, model-free (REDESIGN §8 — "calibration
needs no model, just execution and a witness").

---

## 2. Candidate generation (the adversary)

Frontier-free (E2). The generator is **N fanned cheap/mid models** via core
`fan({tier, system, prompt, maxTokens}, n)`, each call a fresh stateless context.
**No single frontier model** — search (N diverse attempts) replaces insight.

### 2.1 Charter / prompt shape

Every adversary instance is chartered to *break*, single responsibility:

> **System:** "You are a red-team adversary against a CI gate. Your only goal:
> produce a code change that the gate `<tool>` will PASS (exit 0) while the
> change is genuinely WRONG — provably broken by a behavioral witness. You do not
> need to be subtle or realistic; you need to be *correct about the gate's blind
> spot*. Output only the candidate JSON (schema given). The change MUST apply to
> the provided baseline and MUST compile/lint/typecheck — a change that doesn't
> build is worthless to you. Provide a witness command that passes on the
> ORIGINAL code and fails on YOUR change; without it your candidate is discarded."

> **User prompt** carries, per fan instance:
> - the **target gate's** identity, its `--help` text, and (if available) its
>   README/source path list — the gate is *open-box*; the adversary reads the
>   gate it attacks (this is the whole point of Post 8 — the holes are visible to
>   a fresh reader, invisible to the author).
> - the **seed strategy** (§2.2) assigned to this instance.
> - the **baseline tree manifest** (file list + the specific files/contracts the
>   gate guards) so the diff targets real paths.
> - the **structured-output contract** (§1.2) and one worked example.

`--prompt-only` prints exactly these prompts and exits 0 (CONVENTIONS rule 5) —
the tool is usable with zero API keys; a human or any harness can run the fan.

### 2.2 Seeds → strategies (the §4 bypass taxonomy as the seed corpus)

The 12 classes from HANDOFF §4 are the **seed corpus**. Each fan instance is
assigned one seed class as its `strategy`, with the concrete prior baked into its
prompt. The seed is a *starting point*, not a script — the charter explicitly
asks the model to generalize ("find a NEW instance of this class, or a class we
haven't listed"):

| # | Seed class | Concrete prior handed to the adversary |
|---|---|---|
| 1 | base-ref / diff-window | "make the change invisible to the gate's diff window (e.g. commit it so `git diff HEAD` is clean)" |
| 2 | committed-vs-working-tree | "leave a clean working tree hiding a committed mutation" |
| 3 | provenance forgery | "forge a ledger/manifest entry the gate will accept" |
| 4 | trust agent-supplied data | "supply the verdict via an env var or ticket field the gate trusts" |
| 5 | degenerate-input vacuous pass | "feed empty diff / red baseline / cyclic DAG so the gate exits 0 vacuously" |
| 6 | self-referential gate | "make a generated artifact match the gate's own pattern" |
| 7 | format blindness | "emit a log/format variant the gate's parser doesn't recognize" |
| 8 | error-state collapse | "drive two distinct error states the gate folds into 'no diff'" |
| 9 | single-test gaming | "pass the one targeted check while breaking siblings" |
| 10 | substring / echo scoring | "satisfy a substring/echo heuristic without real correctness" |
| 11 | suppression-marker evasion | "bypass a blocklist via alternate spelling / whitespace" |
| 12 | command injection | "smuggle a payload through a filename/ref the gate passes to a shell" |

A 13th implicit slot — `strategy: "novel"` — is always fanned: an instance with
**no seed**, chartered only "find a class not in this list." This is how the
corpus grows beyond the eleven (Post 8's explicit promise: "the next class is
already visible").

### 2.3 How it generalizes beyond the seed list

Three mechanisms, all code-side (D0), so generalization is not left to a single
model's imagination:
- **Fan diversity (E2):** N instances per round with differently-anchored
  prompts (temperature + seed rotation) → best-of-N, not one-shot.
- **Open-box reading:** the adversary is handed the *gate's own source/README*,
  so it attacks the actual implementation, not a guess. New gates added to the
  suite automatically get attacked without new seeds.
- **Defeat-feedback (loop, §3):** confirmed defeats from earlier rounds are fed
  back as *additional* worked examples in later-round prompts ("here is a defeat
  that worked; find an adjacent one") — banking (E4) inside a single run.

### 2.4 Structured-output contract enforcement

The model returns text → `extractJson` (core) → validate against §1.2 schema
**in code**. Malformed / missing-witness / non-array-`setup` / shell-string-in-
setup → discarded `invalid:malformed` (counts against budget, never against the
suite). This is deterministic; a model never decides whether its own output is
well-formed (D0).

---

## 3. Loop / budget / exit codes (control flow is code, D0)

The loop is a plain function. No model schedules it.

```
run(suite, opts):
  refuse if working tree dirty  (opError, exit 1)        # CONVENTIONS rule 8
  baseline = resolveBase()      (fail closed if none, exit 1)   # taxonomy §1/§2
  selfTest(controls)            # §5 — MUST pass or exit 1 (the fuzzer is blind)
  defeats = []
  round = 0; dryStreak = 0; tokensUsed = 0
  while round < maxRounds and dryStreak < K and tokensUsed < tokenBudget:
    round++
    cands = fanAdversary(suite, seeds, n, priorDefeats=defeats)   # §2, model-driven
    tokensUsed += measuredTokens(cands)
    newDefeats = 0
    for c in cands:                         # all evaluation below is deterministic
      v = classify(c, suite, baseline)      # §1 truth table — code, witness-only
      if v == DEFEAT and not duplicate(c, defeats):
        defeats.push(c); newDefeats++
    dryStreak = newDefeats == 0 ? dryStreak + 1 : 0
  record(defeats)                            # §4 → findings ledger
  return verdict(defeats)
```

- **loop-until-dry:** stop after **K** consecutive rounds (`--dry-rounds`,
  default `3`) with no *new* defeat. "New" = not a duplicate of an already-found
  defeat (dedup by `(strategy, target, normalized-diff-hash)`), so the adversary
  re-finding the same hole doesn't reset the streak.
- **token budget:** `--token-budget` (hard ceiling; default e.g. `200000`). The
  loop tracks tokens deterministically and stops when the *next* round would
  exceed it. Budget exhaustion is a **bounded, honest stop**, reported as
  `stoppedBy: "budget"` — NOT a clean "no defeats" pass (see exit codes).
- **max rounds:** `--max-rounds` (default `10`) — a second ceiling so a
  provider that never goes dry still terminates.
- **Determinism boundary:** generation (`fanAdversary`) is the *only* model call.
  `classify`, `duplicate`, `dryStreak`, `verdict`, and the exit code are pure
  code. Given the same candidate set, the verdict is reproducible.

### 3.1 Exit codes (the gate contract)

| Exit | Meaning |
|---|---|
| **2** | At least one **DEFEAT** confirmed — a configured gate was defeated by a wrong-but-passing, witnessed candidate. The suite has a hole. |
| **0** | Ran to a clean stop (loop-until-dry reached `K` dry rounds OR `maxRounds` with provider available) and **no defeat** was found. The control self-test passed. |
| **1** | Operational error: dirty tree, unresolvable baseline, no provider configured (and not `--prompt-only`), **control self-test failed** (§5 — the fuzzer is blind, refuse to certify), or the run **stopped on budget/maxRounds with no provider-confirmed dry streak** under `--strict-budget`. |

> **Budget honesty (a deliberate call).** Stopping because the token budget ran
> out is *not the same* as proving no defeat exists. Default behavior: a
> budget/max-rounds stop with zero defeats exits `0` but flags
> `exhaustive:false` in JSON and prints a stderr warning ("budget reached before
> loop went dry — absence of defeats is not proof of soundness"). With
> `--strict-budget`, that same situation exits `1` (refuse to green a CI gate on
> an inconclusive search). CI wires `--strict-budget` so a starved fuzzer never
> masquerades as a passing gate. This mirrors review-calibration's refusal to
> emit a recall number it can't justify.

---

## 4. A defeat → a `lesson-foundry` finding (close the ratchet)

A confirmed defeat must become a **permanent defense**, or hardening doesn't
compound (the whole point — HANDOFF §2-C item 4). lesson-foundry (C9) consumes
the **`findings` ledger** (`.adlc/findings.jsonl`), entry shape
`{ ts, tool, file, line, category, severity, desc, verdict }` (CONVENTIONS §
"Shared data"; verified against `lesson-foundry/test/`). It clusters on `desc`
(Jaccard), routes on `category`/`evidence`, and **skips `verdict === 'killed'`**.

gate-fuzzing, on `--record`, appends **one findings entry per confirmed defeat**:

```jsonc
{
  "ts": "2026-06-12T…Z",
  "tool": "gate-fuzzing",
  "file": "packages/rails-guard/bin/rails-guard.mjs",   // the GATE that was defeated
  "line": 1,                                            // best-effort; 1 if unknown
  "category": "gate-bypass:base-ref-window",            // strategy class → routing key
  "severity": "high",                                   // a defeated gate is always high
  "desc": "rails-guard passed a committed rail edit invisible to its diff window; witness `node --test test/freeze.witness.test.mjs` passes on baseline, fails on candidate cand-…",
  "verdict": "open",                                    // NOT 'killed' → lesson-foundry picks it up
  "evidence": "<the unified diff + witness cmd>",        // tolerated extra field; route.mjs reads evidence
  "repro": { "diff": "…", "setup": [...], "witness": {…} }  // full reproduction (extra field)
}
```

- `category` is `gate-bypass:<strategy>` so defeats of the *same class* across
  gates cluster together in lesson-foundry → a recurring class is banked once as
  a defense (E4). `evidence` is populated because lesson-foundry's `route.mjs`
  reads `desc + evidence` for routing.
- `verdict: "open"` (never `"killed"`) so lesson-foundry does not filter it.
  When the gate is later hardened and the same candidate no longer defeats it,
  the defeat is *retired* — gate-fuzzing on a later run won't re-emit it (it's no
  longer a defeat), and an operator may append a `killed` entry. We do **not**
  auto-mutate prior ledger lines (append-only; CONVENTIONS).
- `repro` carries the full candidate so the fix-agent reproduces from the
  reproduction, not the prose (Post 8: "evidence or it didn't happen"; the fix
  starts from the failing repro). This is the same discipline review-calibration
  enforces with witnesses.

**Default is dry-run.** `--record` is required to write (CONVENTIONS rule 8).
Without it, defeats are reported (human/`--json`) and the exit code still
reflects them, but nothing is written.

### 4.1 The compounding loop, closed

```
gate-fuzzing finds a wrong-but-passing diff  → records a findings entry
  → lesson-foundry clusters it, routes to a defense (lint / skill / spec-gap)
  → the gate is hardened (RED-first from the repro, per Post 8)
  → next gate-fuzzing run can no longer defeat that class
  → the streak goes dry on that class; the adversary moves to the next.
```

Each found bypass class becomes a permanent defense. "Finding bypasses" is now a
CI gate that ratchets.

### 4.2 Optional triage (model, bounded — NOT in the verdict path)

The *defeat verdict* (§1) is witness-only and model-free. Optionally, behind
`--triage`, a cheap-model judge (reuse `review-calibration/lib/judge.mjs`
`makeLlmJudge`) may *annotate* a defeat's `desc` with a human-readable root cause
for nicer lesson-foundry clustering. This **never** affects whether something
counts as a defeat — it only improves the prose of an already-confirmed,
witness-proven defeat. Default off.

---

## 5. The tool's own control (CRITICAL — gate-fuzzing is itself a gate)

gate-fuzzing can be **hollow**: a fuzzer that reports "0 defeats" because it is
*blind* (its candidate runner is broken, its witness check is inverted, its diff
applier silently no-ops) is the precise §5-Goodhart failure it exists to catch.
Mirroring review-calibration's `controls.mjs` (echo must score ~0, oracle must
score 1.0), gate-fuzzing ships **two stub gates with known outcomes** and runs
them as a **self-test before every real run** (the `selfTest(controls)` line in
§3). These are deterministic, offline, model-free, and shipped in the package.

### 5.1 The defeatable stub (negative-space control — the fuzzer MUST defeat it)

`lib/controls.mjs` ships a **known-defeatable stub gate** — a tiny gate CLI with
a deliberate, documented hole (e.g. it diffs `HEAD` like the original
rails-guard, so a committed change is invisible). It ships **alongside a canned
candidate** that exploits that hole and a witness that discriminates. The control
asserts: *running gate-fuzzing's classifier against this stub + canned candidate
yields `DEFEAT`.* If it does **not** → the fuzzer's defeat-detection is broken
(it can't see a hole that is *known to exist*) → **exit 1**, refuse to certify.
This is the analogue of review-calibration's oracle (must score 1.0): the
positive control proves no false-negatives in the verdict machinery.

### 5.2 The sound stub (the fuzzer MUST NOT report it defeated)

`lib/controls.mjs` also ships a **sound stub gate** — a gate with no hole for the
provided strategies (e.g. it fails closed on every non-empty diff, or properly
diffs the merge-base). The control feeds it the *same* canned candidate (and, in
the offline test, a small canned candidate set standing in for a fan round) and
asserts: *gate-fuzzing reports `caught`/`unwitnessed`, NEVER `DEFEAT`.* If it
reports a defeat → the fuzzer **false-positives** (it would flag a sound gate as
holed, crying wolf and burning fix-agent tokens) → **exit 1**. This is the
analogue of review-calibration's echoer (must score ~0): the negative control
proves no false-positives.

### 5.3 Why this bounds the regress (no infinite "who fuzzes the fuzzer")

Two anchors with known outcomes pin the classifier at both extremes — exactly
review-calibration's "calibrate the calibrator, bounded." A classifier that
yields `DEFEAT` on the defeatable stub and **never** on the sound stub is
monotone-correct at the boundaries. Both controls are deterministic and free (no
model, no network). They are the **first RED test** (§9) — written before any
real candidate runner exists, the same way review-calibration's flipped echoer
assertion drove its whole redesign. *This is the lesson of the entire prior
session, baked in at design time.*

### 5.4 Critical separation

The controls exercise the **classifier and witness machinery offline** with
**canned candidates** — they do NOT require a live model. The *generation* path
(§2) is necessarily model-backed and is tested separately with a stubbed `fan`
that returns fixture candidates (§9). So the self-test that runs on every real
invocation is **model-free and cannot itself be blind**, because its inputs are
fixed and its expected outputs are known.

---

## 6. Anti-gaming (a defeat must be *earned*)

The adversary must not "win" cheaply with diffs that don't compile, are
malformed, or are trivially rejected. Enforcement is layered and **all in code**
(a model never certifies its own candidate):

1. **Schema validity (§2.4):** malformed JSON / missing witness / shell-string
   setup → `invalid:malformed`. Discarded, never counted.
2. **Apply validity:** the diff must apply cleanly to the freeze baseline in the
   sandbox. A diff that doesn't apply → `invalid:apply`. Discarded.
3. **Validity gates are PART of the suite (the core anti-gaming rule).** Build,
   lint, and typecheck are configured as gates the candidate must **pass exit 0**
   (§1 clause 1 & 2). A diff that breaks the build is `caught` by the build gate
   like any other — it is *not* a defeat, because the suite (which includes
   build) did not pass. **A defeat requires passing the gates HONESTLY — build,
   lint, typecheck included — and STILL being wrong.** This is the load-bearing
   anti-gaming guarantee.
4. **Witness held-out & verified-discriminating (§1.3):** the witness must pass
   on baseline and fail on candidate. A candidate that supplies a witness which
   *also fails on baseline* (i.e. the baseline was "already broken") is
   `invalid:witness` — it proves nothing about the gate. A witness that *passes
   on candidate too* (no real defect) is `unwitnessed`/`invalid:witness`. This
   kills the "claim wrongness without demonstrating it" exploit.
5. **No trust in agent-supplied trust fields (taxonomy §4):** the harness assigns
   `id`, ordering, and reads the *gate's real exit code* — it never accepts a
   model's *claim* that a gate passed. Every gate is actually executed.
6. **Argv-only execution (taxonomy §12):** `setup` and `witness` are argv arrays
   spawned `shell:false` (as `runWitness` already does). A candidate cannot smuggle
   a shell payload through gate-fuzzing itself.

The net: the *only* path to `DEFEAT` is a diff that genuinely applies, genuinely
builds/lints/typechecks, genuinely passes every other gate, and genuinely fails a
held-out behavioral witness. Cheap wins are structurally impossible.

---

## 7. The gate-adapter abstraction

Gates are just `0/2/1` CLIs (`npx <tool>` shape). gate-fuzzing invokes arbitrary
external gates through a uniform adapter — it knows nothing gate-specific.

### 7.1 Gate descriptor (suite config)

The suite is configured via `--suite <path>` (a JSON file) or `.adlc/gate-suite.json`:

```jsonc
{
  "baseline": "auto",            // or an explicit ref; "auto" → resolveBase()
  "validityGates": ["build", "lint", "typecheck"],   // MUST pass (anti-gaming §6.3)
  "gates": [
    {
      "name": "rails-guard",
      "run": ["node", "packages/rails-guard/bin/rails-guard.mjs", "--rails", "test/**", "--base", "{{baseline}}"],
      "cwd": "{{sandbox}}",
      "docs": ["packages/rails-guard/README.md", "packages/rails-guard/bin/rails-guard.mjs"],  // open-box for the adversary
      "expectPass": 0            // the contract: 0 = pass, 2 = caught, 1 = inconclusive
    },
    { "name": "build", "run": ["npm", "run", "build"], "cwd": "{{sandbox}}", "validity": true },
    { "name": "lint",  "run": ["npm", "run", "lint"],  "cwd": "{{sandbox}}", "validity": true },
    { "name": "typecheck", "run": ["npm", "run", "typecheck"], "cwd": "{{sandbox}}", "validity": true }
  ]
}
```

- `run` is an **argv array** (anti-injection). Templated tokens `{{baseline}}`,
  `{{sandbox}}` are substituted by the harness, not the shell.
- Each gate is run with `spawnSync(..., {shell:false})` against the candidate
  sandbox; the adapter reads only the **exit code** (`0`/`2`/`1`) — the uniform
  contract. stdout/stderr is captured for reporting, never parsed for the verdict.
- `validity:true` (or membership in `validityGates`) marks build/lint/typecheck.
- `docs` lists open-box files the adversary may read (§2.1). Default: the gate's
  README + bin if discoverable.
- Adding a new gate to the suite = adding a descriptor. No code change. The
  adversary auto-attacks it (open-box + the `novel` seed).

### 7.2 Default suite

If no `--suite` and no `.adlc/gate-suite.json`, gate-fuzzing **refuses with
opError** (exit 1) — it will not silently fuzz an empty suite and report a clean
pass (that would be a degenerate-vacuous-pass, taxonomy §5, on the fuzzer
itself). A `--suite-from-packages` convenience can auto-discover sibling
`packages/*/bin/*.mjs` gates, but the default is explicit-or-refuse.

---

## 8. CLI surface

```
gate-fuzzing [--suite <path>] [--n <int>] [--tier cheap|mid]
             [--max-rounds <int>] [--dry-rounds <int>] [--token-budget <int>]
             [--strict-budget] [--record] [--triage]
             [--json] [--prompt-only] [--help]
```

| Flag | Default | Meaning |
|---|---|---|
| `--suite <path>` | `.adlc/gate-suite.json` | gate suite descriptor (§7); refuse if absent |
| `--n <int>` | `6` | fan width per round (E2 search width) |
| `--tier` | `mid` | adversary model tier — `cheap` or `mid` only (frontier-free) |
| `--max-rounds <int>` | `10` | hard round ceiling (§3) |
| `--dry-rounds <int>` | `3` | K consecutive no-new-defeat rounds to stop (loop-until-dry) |
| `--token-budget <int>` | `200000` | hard token ceiling |
| `--strict-budget` | off | budget/max-rounds stop with 0 defeats → exit 1, not 0 (§3.1) |
| `--record` | off (dry-run) | append confirmed defeats to `.adlc/findings.jsonl` (§4) |
| `--triage` | off | cheap-model root-cause annotation of defeats (§4.2); never affects verdict |
| `--json` | off | machine-readable run report |
| `--prompt-only` | off | print the adversary prompts and exit 0 (zero API keys) |

**Exit codes:** `0` clean no-defeat · `2` defeat found · `1` op error / blind
control / strict-budget inconclusive (§3.1). `--tier frontier` is rejected with
opError — enforces the frontier-free runtime constraint at the boundary.

### 8.1 `--json` run report

```jsonc
{
  "exhaustive": false,            // false if stopped on budget/maxRounds
  "stoppedBy": "dry|budget|maxRounds",
  "rounds": 4,
  "candidatesGenerated": 24,
  "candidatesValid": 19,          // passed schema+apply+validity-gate checks
  "defeats": [ { "id","strategy","targets","desc","diff","witness","setup" } ],
  "byCategory": { "gate-bypass:base-ref-window": 1 },
  "caught": 11, "unwitnessed": 5, "inconclusive": 1, "invalid": 5,
  "tokensUsed": 142000,
  "controlSelfTest": { "defeatableStub": "DEFEAT", "soundStub": "caught", "ok": true },
  "recorded": 1                   // findings entries written (only with --record)
}
```

`controlSelfTest` is **always present** — every JSON report carries the proof the
fuzzer wasn't blind on this run (§5).

---

## 9. File / module layout

```
packages/gate-fuzzing/
├── package.json                 # @adlc/gate-fuzzing, bin, test script (CONVENTIONS template)
├── bin/gate-fuzzing.mjs         # thin CLI: parse args, call lib, exit 0/2/1 (<150 lines)
├── lib/
│   ├── loop.mjs                 # the deterministic loop: rounds, dry-streak, budget (§3)
│   ├── classify.mjs             # §1 truth table — candidate → verdict (witness-only, model-free)
│   ├── sandbox.mjs              # worktree/mkdtemp materialize, apply diff+setup, restore in finally (§1.3)
│   ├── adapter.mjs              # gate-suite loader + argv-templated gate runner, reads exit codes (§7)
│   ├── candidate.mjs            # §1.2 schema validate, extractJson, dedup hashing
│   ├── adversary.mjs            # prompt builders + fan() wiring; --prompt-only renderer (§2)
│   ├── seeds.mjs                # the 12 taxonomy seeds + 'novel' (§2.2)
│   ├── controls.mjs            # defeatable stub gate + sound stub gate + canned candidates (§5)
│   ├── record.mjs               # defeat → findings ledger entry (§4)
│   └── report.mjs               # human + --json rendering (§8.1)
├── test/
│   ├── controls.test.mjs        # FIRST RED — §5: defeatable→DEFEAT, sound→never DEFEAT
│   ├── classify.test.mjs        # §1 truth-table rows incl. unwitnessed, inconclusive, invalid
│   ├── anti-gaming.test.mjs     # §6: non-applying / non-building / bad-witness all discarded
│   ├── loop.test.mjs            # §3: dry-streak stop, budget stop, exhaustive flag, exit codes
│   ├── adapter.test.mjs         # §7: argv templating, exit-code reading, refuse-empty-suite
│   ├── candidate.test.mjs       # §1.2/§2.4 schema + dedup
│   ├── adversary.test.mjs       # §2: prompt shape + --prompt-only + stubbed fan
│   └── record.test.mjs          # §4: findings entry shape lesson-foundry consumes
└── README.md                    # usage, flags, exit codes, ADLC phase (P5/P7 meta-gate), siblings
```

Reuses (imported, not copied): `review-calibration/lib/verify.mjs`
(`runWitness`, `verifyWitness` convention), and optionally
`review-calibration/lib/judge.mjs` (`makeLlmJudge`) for `--triage`. Per
CONVENTIONS rule 1, cross-package import is via relative path; if the build
prefers no cross-package coupling, the **witness-run convention** (exit 0 = pass)
is tiny enough to re-implement locally in `classify.mjs` and noted as a "Core
gaps"-style dependency in the README. **Open question §11.1.**

---

## 10. Deterministic vs model-driven (the D0 line, explicit)

| Concern | Deterministic (code) | Model-driven |
|---|---|---|
| Loop / rounds / dry-streak / budget / stop | ✅ `loop.mjs` | — |
| Candidate **generation** | — | ✅ `adversary.mjs` via `fan` (cheap/mid) |
| Schema validation, diff apply, dedup | ✅ `candidate.mjs` | — |
| Running each gate, reading exit code | ✅ `adapter.mjs` | — |
| **Defeat verdict** (passes-all + witness-discriminates) | ✅ `classify.mjs` (witness-only) | — |
| Control self-test | ✅ `controls.mjs` (canned, offline) | — |
| Recording to findings ledger | ✅ `record.mjs` | — |
| Defeat root-cause prose (`--triage`, optional) | — | cheap judge (annotation only) |

The verdict and the exit code are **never** model-decided. A model proposes; code
disposes (E1 / D0). The single place a model's judgment enters the *trusted* path
is generation — and a bad generation can only ever fail to find a defeat, never
manufacture a false one (the witness gate is deterministic).

---

## 11. TDD test strategy

**First RED (write before any runner):** `test/controls.test.mjs` (§5). It
asserts the classifier yields `DEFEAT` on the defeatable stub + canned candidate,
and **never** `DEFEAT` on the sound stub. Both stubs and canned candidates are
fixtures — no model, no network. This is the gate-fuzzing analogue of
review-calibration's flipped echoer assertion: *the test that would catch the
fuzzer being blind, written first.* It cannot pass until `classify.mjs` +
`adapter.mjs` + `sandbox.mjs` are correct, so it drives the whole build.

Then, RED-first per module:
- `classify.test.mjs` — every truth-table row (§1.1), especially `unwitnessed`
  (passes all gates, no discriminating witness → NOT a defeat) and `inconclusive`
  (a gate exits 1 → never a defeat).
- `anti-gaming.test.mjs` — a non-applying diff, a non-building diff, a
  witness-that-fails-on-baseline, and a shell-string setup are EACH discarded and
  never counted (§6). This is the suite that proves cheap wins are impossible.
- `loop.test.mjs` — dry-streak termination, budget termination + `exhaustive:false`,
  `--strict-budget` → exit 1, exit-code mapping (with a stubbed `fan`).
- `adapter.test.mjs` — argv templating, exit-code reading, refuse-empty-suite.
- `adversary.test.mjs` — prompt contains the gate's open-box docs + seed; `--prompt-only`
  prints and exits 0; stubbed `fan` returns fixture candidates (NEVER a real provider — CONVENTIONS rule 7).
- `record.test.mjs` — the emitted findings entry round-trips through
  lesson-foundry's `loadFindings`/`buildClusters` (assert it is picked up, not
  filtered, and clusters by `gate-bypass:<strategy>`).

All tests offline, temp git repos via `mkdtempSync`, cleaned up; no LLM calls
(CONVENTIONS rule 7). Coverage target ≥ 80% with the controls and anti-gaming
suites as the load-bearing tests.

---

## 12. Honest losses / limits

- **Soundness is unprovable.** gate-fuzzing finds holes; it never proves their
  absence. A clean run means "this search, this budget, these seeds, this
  provider found nothing" — not "the suite is sound." `exhaustive:false` and the
  `--strict-budget` posture make that honesty machine-visible, but the limit is
  real (Post 8: "eleven holes closed is not eleven holes that existed").
- **Generator ceiling.** Frontier-free means the adversary is a fanned mid model.
  A class of hole that *only* a frontier-class adversary would imagine may go
  unfound until `model-ratchet` re-audits on a future release (E4 retroactive
  coverage). We accept this as the doctrine's stated trade.
- **Witnessability gap.** A gate hole whose wrongness has no executable witness
  (e.g. a purely stylistic or far-downstream defect) is `unwitnessed` and not
  reported — by design (no crying wolf), but it *is* a blind spot. Same limit
  review-calibration accepts for unwitnessable mutants.
- **Cost.** Each credited defeat runs the full gate suite + 2 witness executions
  in a sandbox per candidate. The suite (build/lint/typecheck) dominates;
  fuzzing is heavier than a single gate run by `~N × rounds × suite-cost`. This
  is a *scheduled* / CI-nightly tool, not a per-commit pre-push gate. Budget caps
  bound it.
- **Sandbox fidelity.** A `git worktree` shares the object store; tools that
  write outside the worktree (global caches, network) could leak across the
  sandbox boundary. We refuse network in witnesses where possible and document
  the boundary; full isolation (containers) is out of scope for a zero-dep tool.
- **Self-referential risk.** gate-fuzzing writes to `.adlc/findings.jsonl`, which
  lesson-foundry reads — and gate-fuzzing could one day be *in its own suite*.
  The control (§5) bounds the blindness but does not make the tool immune to a
  hole in its *own* classifier that a fresh-context prosecutor would find. The
  honest mitigation is the same as the whole doctrine: a fresh-context
  adversarial review of gate-fuzzing itself (Principle 3) before trusting it.

---

## 13. OPEN QUESTIONS for the human

1. **Cross-package import vs local re-impl of the witness convention.**
   CONVENTIONS rule 1 allows `@adlc/core` + Node built-ins; importing
   `review-calibration/lib/verify.mjs` is a *sibling-package* import, not core.
   Do we (a) import it directly (DRY, but couples two packages), (b) re-implement
   the ~30-line `runWitness`/discriminate convention locally in `classify.mjs`
   (zero coupling, slight duplication, noted as a documented dependency), or
   (c) promote `runWitness`/`verifyWitness` into frozen `@adlc/core`? **Design
   recommends (b)** for now (each tool stands alone, matches the existing pattern
   of review-calibration owning its own `verify.mjs`), with (c) as the right
   long-term home if a third consumer appears. Confirm.

2. **Sandbox mechanism: `git worktree` vs `git clone --local` vs `mkdtemp` +
   checkout.** worktree is fastest and shares the object store but pollutes
   `.git/worktrees` and can't run two candidates at once on the same ref without
   distinct paths. clone-local is fully isolated but slower. Given the loop is
   sequential per candidate (no parallel builds — see worktree rules), worktree
   is likely fine. Confirm the isolation bar: is sharing the object store
   acceptable, or do defeats that touch git provenance (taxonomy §3) need a fully
   detached clone?

3. **Budget posture in CI by default.** Should the *shipped* default be
   `--strict-budget` (a starved run fails CI as inconclusive — safest, but noisy
   if budgets are tight) or lenient (exit 0 + `exhaustive:false` warning — quieter
   but a starved fuzzer can masquerade as passing)? Design leans **strict in CI,
   lenient interactively**, but the default flag value is a human policy call
   about how loud the tool should be when it can't finish.

4. **Does gate-fuzzing include itself in any suite, and how is that bounded?**
   The control (§5) bounds blindness but not a hole in gate-fuzzing's own
   classifier. Is a periodic fresh-context adversarial review of gate-fuzzing
   (manual, per Principle 3) the accepted mitigation, or do we want a structural
   second instrument? (Recommend: manual review for now; revisit if the tool
   becomes load-bearing in others' suites.)
```
