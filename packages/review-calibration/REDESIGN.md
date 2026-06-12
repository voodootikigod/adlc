# review-calibration redesign — verifier-based recall

## The bug this fixes

`lib/scorer.mjs` scores a plant **caught** when the review output either mentions
`basename:line±3` **or** contains a ≥12-char substring of the mutated line. Both
conditions are satisfied by a reviewer that simply *echoes the changed lines* and
understands nothing. The package's own E2E test proves it: a "report every changed
line" fake reviewer scores recall 1.0 and the gate passes.

Root cause: the tool scores the reviewer's **raw text** against the plant's
**location**, not the reviewer's **verified findings** against the plant's
**defect**. The doctrine already has the missing piece — P5: *"findings are claims;
reproduce or kill."* review-calibration shortcut past the verifier and string-matched
the first reviewer's output instead.

The fix: **a plant is caught only when a reviewer finding, verified, actually
identifies the planted defect.** Echoing produces no verified finding → recall 0.

---

## 1. Plant schema v2

Current plant: `{ file, absolutePath, line, operator, original, mutated }`.

Add three fields:

```jsonc
{
  "file": "src/auth.mjs",
  "line": 42,
  "original": "  if (user.role === 'admin') {",
  "mutated":  "  if (user.role !== 'admin') {",

  "operator": "invert-comparison",   // the mechanical MOVE (unchanged)
  "category": "auth-bypass",         // NEW: the real bug CLASS (was conflated w/ operator)
  "defect":   "Inverted admin check — non-admins now pass the guard.", // NEW: what's wrong
  "witness": {                       // NEW (optional): behavioral discriminator
    "kind": "test",                  // "test" | "io"
    "ref":  "test/auth.cal.test.mjs" // a test that PASSES on original, FAILS on mutant
  }
}
```

- **`category`** is what C8 promised to break recall down by (auth-bypass, off-by-one,
  race, contract-violation, error-swallowing). The current code keys per-category
  scoring on `operator` — a mechanical-move name, not a bug class — so the advertised
  "low recall on races → add a concurrency lens" payoff is unreachable. Mechanical
  mutants get a heuristic `operator → category` map; `--plants-file` authors supply it.
- **`defect`** is the natural-language ground truth a judge compares findings against.
  Auto-generated for mechanical mutants from `operator + original→mutated`; authored
  for `--plants-file` plants.
- **`witness`** is what makes a plant a *real, reproducible bug* rather than a vibe.
  A plant with no witness that discriminates it from the original is an **equivalent
  mutant** (see §4) and must be excluded, not scored as missed.

---

## 2. Two-tier scoring

Replace `isPlantCaught` (string match) with a scorer chosen by capability, **never
silently falling back to string match**.

### Tier 1 — behavioral verification (default, deterministic, model-free)

Preconditions: the plant has a `witness`, and the reviewer emits structured findings
(file/line + a reproduction or enough to locate). For each plant `P`:

1. `locating` = reviewer findings whose `file` matches and `line` is within tolerance
   of `P.line`. No locating finding → **MISSED**.
2. Execute `P.witness` against **both** the mutated tree and the restored original at
   `P`'s location. The witness must pass on original and fail on mutant — this confirms
   `P` is genuinely defective (and not equivalent).
3. `P` is **CAUGHT** iff a locating finding's claim is corroborated by the witness:
   the reviewer pointed at the spot the witness proves is broken. (If the reviewer
   emits its own repro, run *that* instead and require it to discriminate — strict
   "reproduce or kill".)

An echoer locates lines but its findings carry no defect claim a witness corroborates,
and it emits no repro → catches nothing. Scoring is deterministic and tied to behavior,
**no model in the loop**.

### Tier 2 — semantic judge (fallback for prose-only reviewers, cheap model)

When witnesses or reviewer-repros aren't available, score by recognition, not echo.
For each plant `P`:

1. `locating` = findings within a generous location tolerance of `P.line`.
2. For each locating finding `F`, call a **cheap-model judge**:
   `judge(P.defect, P.original→P.mutated, F.description, F.evidence) → {match: bool}`
   "Does this finding identify *this specific* defect?"
3. `P` is **CAUGHT** iff any locating finding is judged `match: true`.

Recognition (does finding X describe defect Y, both given) is far easier than generation
(find the bug) — the generator–verifier gap (E1). An echoer's generic text
("this line changed") is judged `false`. The judge is calibrated and bounded (§3).

### Legacy — string match (opt-in, loudly deprecated)

`--scorer string` keeps the old behavior **only** with a stderr banner: *"string-match
scoring is defeated by line-echoing; this recall number is not trustworthy."* Default
is `behavioral`, then `judge` if an LLM is configured, else **`opError` (exit 1)** —
the tool refuses to emit a recall number it cannot justify rather than quietly
string-matching.

---

## 3. Calibrating the calibrator (the regress, bounded)

Two reference reviewers with known-correct scores pin the scorer at both extremes —
no infinite regress, just two anchors:

- **Echoer (negative control).** Built-in reviewer that emits every changed line as a
  finding with generic text. A correct scorer gives it **recall ≈ 0**. Shipped as the
  package's own CI self-test. *This is the test that would have caught the original bug
  — and the existing E2E test currently asserts the echoer PASSES, enshrining the bug.
  That assertion gets inverted.*
- **Oracle (positive control).** Built-in reviewer handed the plant list directly and
  emitting perfect findings (correct location + defect + repro). A correct scorer gives
  it **recall = 1.0**. If the oracle scores < 1.0, the scorer has false negatives.

Any scorer satisfying echoer→0 and oracle→1 is monotone-correct at the boundaries. Both
controls are deterministic and free.

**For the Tier-2 judge specifically:** ship a small labeled fixture (~20 `(finding,
plant)` pairs: genuine matches, echoes, near-misses, wrong-defect) with known yes/no.
The judge must hit ≥ threshold agreement with the labels or the tool warns the judge is
unreliable. Matching is easy and the fixture is small, so the regress bottoms out in one
cheap measurement per model. Report the measured judge-agreement alongside recall so the
number carries its own uncertainty.

---

## 4. Equivalent-mutant exclusion (correctness fix)

A mechanical mutant that changes no observable behavior is an **equivalent mutant** —
there is no bug to find, so scoring it as "missed" dishonestly deflates recall. The
classic hard problem of mutation testing; handle it explicitly:

- A plant must have a witness that discriminates mutant from original.
- If a witness is supplied, verify it discriminates (fail otherwise — bad witness).
- If none is supplied (mechanical mutant), **attempt to derive one**: run the repo's
  own suite, or a fuzz harness, against original vs mutant. If nothing discriminates →
  the mutant is equivalent → **drop it from the denominator and log it**.
- An unwitnessable mutant in uncovered code is not "missed" — it's a question about
  reviewing untested code, which is legitimately Tier-2 (semantic) territory or
  excluded, never counted against recall.

---

## 5. Reviewer protocol (composes with adversarial-review)

Verification needs findings as **data**, not prose. `adversarial-review --json` already
emits findings with `file`, `line_start`, `line_end`, `evidence`, `body`,
`recommendation`, `confidence` — most of the schema. So:

- review-calibration parses the reviewer's JSON findings (tolerant: needs at least
  `file`, a line, and a description/evidence; consumes a `repro` field if present for
  Tier 1).
- Prose-only reviewers can't be calibrated rigorously — documented, and `--scorer
  string` is the explicit gameable legacy for them.
- The two tools compose exactly as the doctrine intends: adversarial-review is the
  reviewer under test; review-calibration measures its stack.

---

## 6. Pipeline (new recall computation)

```
1. Select plants (mechanical mutants and/or --plants-file), each with category + defect (+ witness).
2. Equivalent-mutant filter (§4): keep only plants whose witness discriminates mutant vs original.
3. Apply surviving plants to the working tree (existing runner; restore in finally — unchanged).
4. Run reviewer → parse structured findings[].
5. Restore tree.
6. Per plant P:
     locating = findings near P.line in P.file
     if none            → MISSED
     elif Tier 1        → CAUGHT iff witness/repro discriminates at P's location
     elif Tier 2        → CAUGHT iff judge(P.defect, finding) == match for some locating finding
7. recall    = caught / |surviving plants|        (equivalent mutants already excluded)
   per-category recall keyed on P.category
   precision = truePos / (truePos + falsePos)      where falsePos = findings asserting a
               defect at a location with NO plant   (now a real precision number, not "informational")
8. Controls (self-test, not the gate): echoer recall ≈ 0, oracle recall = 1.0.
9. Gate: exit 2 if recall < --min-recall  (and optionally precision < --min-precision).
         exit 1 if a control fails (echoer > ε or oracle < 1) — the SCORER is broken, not the reviewer.
```

---

## 7. Gate + manifest integration

The recall number means more when it carries the method that produced it. Each run
emits, for gate-manifest (C11): `{ recall, precision, scorer: behavioral|judge|string,
judgeAgreement?, plantsTotal, plantsEquivalentExcluded, perCategory, model }`. A review
verdict downstream then inherits *the calibrated recall of the stack that issued it*,
which is the original C8 promise.

---

## 8. Cost — fits the frontier-free constraint

- **Tier 1 (default):** model-free at scoring time. Cost = N plants × 2 witness
  executions. Deterministic, cheap. This is the doctrine win — calibration needs no
  model, just execution and a witness.
- **Tier 2 (fallback):** N × (located findings) cheap-model judge calls — pennies — on
  a recognition task, with the judge calibrated once per model from a 20-pair fixture.
- **Controls:** free.

No frontier model anywhere. The rigorous path is entirely deterministic.

---

## 9. Migration / build plan

| File | Change |
|------|--------|
| `lib/scorer.mjs` | Replace `isPlantCaught` string match with `scorePlant(plant, findings, {tier, judge, exec})`. Keep `countFalsePositives` but base it on located defect-claims, returning real precision. |
| `lib/verify.mjs` *(new)* | `discriminates(witness, origTree, mutantTree, cwd)` — run a witness, assert pass-on-original / fail-on-mutant. Powers Tier 1 and the equivalent-mutant filter. |
| `lib/judge.mjs` *(new)* | `judgeMatch(defect, diff, finding, completeFn)` + `calibrateJudge(fixture, completeFn)`; ships the labeled fixture. |
| `lib/controls.mjs` *(new)* | `echoReviewer(diff)` and `oracleReviewer(plants)` reference reviewers for the self-test. |
| `lib/findings.mjs` *(new)* | Parse reviewer JSON (adversarial-review shape + tolerant fallback) into `{file, line, description, evidence, repro?}`. |
| `lib/targets.mjs` | Add `category` + `defect` to mechanical plants (operator→category map); extend `--plants-file` schema with `category`/`defect`/`witness`. Equivalent-mutant filtering hook. |
| `bin/review-calibration.mjs` | `--scorer behavioral\|judge\|string` (default behavioral; error if none viable, never silent string match); `--min-precision`; run controls as a self-gate. |
| `test/*` | **Invert** the test that asserts the echoer passes → assert echoer recall ≈ 0. Add: oracle recall = 1.0; equivalent-mutant excluded from denominator; witness discrimination; judge calibration against the fixture; Tier-1 behavioral catch end-to-end. |

### The one assertion to flip first

The existing E2E test asserts a line-echoing fake reviewer yields `gatePass: true`. That
assertion *is* the bug, frozen into the suite. Inverting it (echoer recall ≈ 0,
gatePass false) is the RED that drives the whole redesign — write it first.
