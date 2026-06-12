# gate-fuzzing — Architecture Design (v3)

> ADLC C-tool. A standing red-team / GAN-for-the-lifecycle. A generator-adversary
> produces candidate diffs designed to **pass every configured gate while being
> genuinely wrong**. Each gate a wrong-but-passing diff defeats is a calibration
> finding that hardens that gate. This turns *"we found 11 bypasses once"*
> (HANDOFF §1, §4; Post 8 "The Gates Didn't Hold") into *"finding bypasses is a
> CI gate."*
>
> **Status:** v3 — build complete. v3 applies six must-fixes from a second
> prosecution pass on the v2 design. The implementation is in `lib/` and `bin/`;
> tests are in `test/`. All 65 tests pass (incl. the load-bearing
> `test/isolation.test.mjs` proving candidate-execution isolation, Fix 2).

---

## v3 Amendments (the six must-fixes applied to v2)

These six changes override the v2 doc where they conflict:

### Fix 1: Concrete sandbox profiles (CRITICAL)

Both `bwrap` (Linux) and `sandbox-exec` (macOS) are implemented concretely in
`lib/sandbox.mjs`:

- **Linux bwrap:** `bwrap --unshare-all --ro-bind / / --bind <clone-dir> <clone-dir> --dev /dev --proc /proc --die-with-parent --new-session --chdir <clone-dir> -- <cmd> <args>` — no `--share-net`; network is unshared/denied by `--unshare-all`.
- **macOS sandbox-exec:** `sandbox-exec -p '<SBPL>'` with profile: `(version 1)(deny default)(allow process*)(allow file-read*)(deny network*)(allow file-write* (subpath "<clone-dir>"))(allow file-write-data (path "/dev/null"))`.
- Refuses to run without sandbox unless `--unsafe-no-sandbox` is passed (prints a loud stderr warning). This is enforced in `bin/gate-fuzzing.mjs` before any candidate execution.

### Fix 2: Hardened git clone + per-candidate disposable clone lifecycle (FULLY WIRED)

**Security-critical, fully wired end-to-end.** Every candidate executes in a FRESH
disposable clone, NEVER the real working tree. The lifecycle (`lib/clone.mjs`,
`lib/provision.mjs`, driven per-candidate by `lib/loop.mjs`) is:

1. `cloneDir = mkdtempSync(...)`.
2. `git clone --local --no-hardlinks <repo-root> <cloneDir>` — `--no-hardlinks`
   is mandatory: plain `--local` hardlinks share object-store inodes, so a forgery
   candidate could corrupt the SOURCE repo. The clone is hardened with
   `-c core.hooksPath=/dev/null -c core.fsmonitor=false`.
3. The candidate diff is applied in `cloneDir` (`git apply`, hardened). Candidate
   `setup` steps run in `cloneDir` **under the OS sandbox** (`spawnCandidateCmd`).
4. Gates and the witness run inside `cloneDir` **under the sandbox** bound to the
   clone (writes confined to `cloneDir`; the read-only baseline witness chdirs into
   the baseline dir but its writes are still denied outside the clone).
5. `finally { rmSync(cloneDir, {recursive,force}) }` — the clone is ALWAYS
   destroyed, even on throw/timeout (`classifyOneCandidate` in `lib/loop.mjs`).
6. If no sandbox binary is available, the run refuses (exit 1 / surfaced error)
   unless `--unsafe-no-sandbox` is passed, which prints a loud warning that it must
   only be used in a disposable VM.

The CLI additionally refuses to run against a non-git or dirty working tree (a
clone of a dirty tree is non-reproducible and the candidate diff may not apply).

A load-bearing isolation test (`test/isolation.test.mjs`) proves a hostile
candidate's setup/witness cannot plant a sentinel file in the source repo or the
process cwd, and that the clone is always cleaned up. Reverting the loop to run
candidates in cwd makes that test fail.

### Fix 3: Independence sources reduced to (a) and (b)

**Source (c) suite-minus-G corroboration is removed.** It was logically vacuous — if another gate catches the candidate, that means the *suite* held (candidate is `caught`), not that the witness is independently corroborated. Trying to run it provides no independence guarantee for the target gate's defeat.

Kept independence sources (in `lib/oracle.mjs`):
- **(a) Contract-derived witness** — mechanically derived from the gate's declared contract (`witnessSource: 'contract-derived'`). Fully independent by construction.
- **(b) Independent-context approval** — a separate fresh-context lens confirms the witness pins a genuine defect (`witnessSource: 'independently-approved'`).

### Fix 4: inconclusiveRounds threaded through verdict

A round exceeding `--max-fail-rate` is `inconclusive` and **must NOT advance `dryStreak`**. `inconclusiveRounds` is counted by `runLoop` and passed to `computeVerdict`. If the run never produced a clean dry-streak AND all rounds were inconclusive, `computeVerdict` returns `inconclusive` with `exitCode: 1` (strict) or `exitCode: 0` with loud warning (lenient). Implemented in `lib/loop.mjs` and `lib/verdict.mjs`.

### Fix 5: Behavioral-only defeats default to REPORT, not exit-2

Only contract-derived (a) defeats drive `exit 2` by default. Behavioral defeats (witness source `independently-approved`) default to `exit 0` with the defeats listed in the report (`summary: 'behavioral-defeats-reported'`). The `--fail-on-behavioral` flag opts into `exit 2` for behavioral defeats. All defeat records include a `witnessSource` field. Implemented in `lib/verdict.mjs`.

### Fix 6: Diversified potency canary

The potency canary's planted hole class is rotated across runs. `lib/controls.mjs` exports `canaryGateDescriptor(seedOverride?)` which picks a random class from the 12-class taxonomy each run (or uses an injected seed for deterministic tests). The adversary prompt for the canary is built via `buildCanaryPromptContext()` which intentionally omits the seed prior — the adversary must deduce the bypass class from the gate source, not regurgitate the seed. This ensures beating the canary is genuine capability, not prompt-matching.

---

## 0. Doctrine anchors

(unchanged from v2 — see v2 for full text)

---

## 1. Definition of a "defeat"

(unchanged from v2 — clauses 1–5 apply; clause 5 is now independence sources (a) and (b) only per Fix 3)

### 1.1 Oracle independence (revised)

Only two independence sources remain (Fix 3):

- **(a) Contract-derived** — fully independent, model-free for contract gates
- **(b) Independent-context approval** — fresh-context lens for behavioral gates

Source **(c) suite-minus-G corroboration is removed** as logically vacuous.

---

## 5. The tool's own control

(§5.1–5.4 unchanged from v2)

### 5.5 Live potency canary (revised — Fix 6)

The canary's planted hole class is now **rotated per run** (Fix 6). The canary gate is constructed by `canaryGateDescriptor()` which picks a random taxonomy class. The adversary prompt is built WITHOUT the seed prior (`buildCanaryPromptContext` omits `seed.prior`), so the adversary must discover the class by reading the gate source — not by echoing the prompt back. This ensures ≥1 distinct canary class per run and prevents gaming via prompt regurgitation.

---

## 9. File / module layout (v3 — actual)

```
packages/gate-fuzzing/
├── package.json                 # @adlc/gate-fuzzing, bin, test script
├── bin/gate-fuzzing.mjs         # CLI: parse args, control self-test, loop, verdict (<150 lines)
├── lib/
│   ├── witness.mjs              # runWitness + discriminateWitness N-trial unanimous (§1.4)
│   ├── oracle.mjs               # independence check: contract-derived vs independently-approved (§1.1)
│   ├── classify.mjs             # §1.8 truth table: out-of-scope/wrong-claim/caught/inconclusive/unwitnessed/DEFEAT
│   ├── controls.mjs             # defeatable stub + sound stub + canary + runControlSelfTest (§5)
│   ├── candidate.mjs            # schema validation (§2.4) + pinned dedup hash (§3.3)
│   ├── seeds.mjs                # 12-class bypass taxonomy + novel + sampleSeeds/randomSeed (§2.2)
│   ├── loop.mjs                 # deterministic loop: rounds/dryStreak/inconclusiveRounds/budget (§3)
│   ├── verdict.mjs              # computeVerdict: inconclusiveRounds + witnessSource + failOnBehavioral (§3.1)
│   ├── sandbox.mjs              # bwrap + sandbox-exec concrete profiles + spawnCandidateCmd (§1.7)
│   ├── fan.mjs                  # adversary prompt builders + fanAdversary (injectable completeFn) (§2)
│   ├── gate-adapter.mjs         # suite loader + argv-templated gate runner (§7)
│   └── record.mjs               # defeat → repro artifact + cluster finding (§4)
├── test/
│   ├── controls.test.mjs        # FIRST RED: defeatable→DEFEAT, sound→not DEFEAT, out-of-scope→not DEFEAT
│   ├── oracle.test.mjs          # independence: contract/approved→independent; no-source→unwitnessed
│   ├── classify.test.mjs        # all §1.8 truth table rows including flaky witness, unknown target
│   ├── witness.test.mjs         # unanimous/flaky/timeout discrimination (F8)
│   ├── candidate.test.mjs       # schema validation + pinned dedup hash (§3.3)
│   ├── loop.test.mjs            # dry-streak/inconclusiveRounds/budget/duplicate-dedup (§3)
│   ├── verdict.test.mjs         # Fix 4 (inconclusiveRounds) + Fix 5 (behavioral REPORT)
│   └── sandbox.test.mjs         # bwrap/sandbox-exec argv shapes, SBPL, detectSandbox
└── README.md
```

---

## 13. Open questions (v3 status)

All six prosecution-flagged must-fixes are implemented. The v2 genuinely-irreducible open questions remain:

1. **Independent-witness lens fidelity (§1.1b).** Implemented with `witnessSource: 'independently-approved'` and Fix 5's REPORT default. CI gating policy for behavioral defeats is left to the operator via `--fail-on-behavioral`.

2. **lesson-foundry `gate-fix` route (§4.5).** Not implemented here (out of scope). `record.mjs` writes SPEC-GAP-routed findings to `findings.jsonl` and repro artifacts to `.adlc/gate-defeats/`.

3. **gate-fuzzing in its own suite.** Accepted mitigation: fresh-context adversarial review before trusting in others' suites (Principle 3).

### v3 status of formerly-deferred items

- **Full clone lifecycle — DONE (Fix 2).** The `mkdtemp + git clone --local
  --no-hardlinks + git apply + setup + gate/witness-execution + finally:destroy`
  pipeline is fully wired per-candidate in `lib/clone.mjs` + `lib/provision.mjs`,
  driven by `lib/loop.mjs`, and exercised by the load-bearing `test/isolation.test.mjs`.
  Candidates never execute in the real working tree.
- **Git clone hardening — DONE (Fix 2).** Every harness git invocation goes through
  `hardenedGit()` in `lib/clone.mjs`, which prepends
  `-c core.hooksPath=/dev/null -c core.fsmonitor=false`.
- **Canary round — still deferred (non-security).** `canaryGateDescriptor()` and
  `buildCanaryPromptContext()` are production-ready in `lib/controls.mjs` (Fix 6 class
  rotation + no-seed-prior prompt), but the canary *round* is not yet driven by the
  CLI loop. This is a potency-check gap, not an isolation gap: a real run still
  classifies candidates correctly and is fully sandboxed; it just does not yet
  self-verify adversary potency each run. The behavioral oracle lens (b) likewise
  ships with a `null` approval fn by default (behavioral defeats stay `unwitnessed`
  until an operator injects a real fresh-context approval model), which is the
  conservative posture. Neither affects the security-critical isolation guarantee.
