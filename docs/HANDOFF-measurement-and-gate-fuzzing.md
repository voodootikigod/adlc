# Handoff: Measurement Producers + Gate-Fuzzing

Self-contained brief for a fresh context window. Assumes **zero** prior session
memory. Read top to bottom, then start at "Execution plan."

---

## 0. Project context

- **Repo:** `/Users/voodootikigod/Projects/adlc` — the **Agentic Development
  Lifecycle (ADLC)** toolkit: ~19 zero-dependency, `npx`-runnable Node ESM CLIs,
  each a CI-shaped gate (exit `0` = pass, `2` = gate fails, `1` = operational
  error). Tests are `node:test` (`node --test packages/<pkg>/test/*.test.mjs`).
- **Doctrine:** `ADLC.md` (repo root). The lifecycle phases P0–P7, the flaw
  inventory F1–F8, the property exploits E1–E5, Principle 7 (model tiering),
  Appendix C (the tool catalog), Appendix E (the frontier-free doctrine).
- **Blog series:** `docs/posts/` (9 posts). Post 9 (`09-the-gates-didnt-hold.md`)
  publicly promises the gate-fuzzing tool — building it is now load-bearing.
- **Conventions:** `CONVENTIONS.md`. Shared lib is `@adlc/core`, imported as
  `../../core/index.mjs`. Many small files; immutable patterns; zero deps;
  errors via `opError` (exit 1), gates via `pass()` / `gateFail()`.
- **`@adlc/core` exports** (`packages/core/index.mjs`): `parseArgs, pass,
  gateFail, opError, printJson` (cli); `complete, fan, extractJson,
  detectProvider, resolveModel` (llm — `complete({tier:'cheap'|'mid'|'frontier',
  system, prompt, maxTokens})`, throws if no provider); `git, gitDiff,
  changedFiles, isDirty, isGitRepo, resolveBase, refExists, coChange, churn,
  pairKey` (git); `appendEntry, readEntries, sha256, hashFiles, withLedgerLock,
  ledgerPath, ADLC_DIR` (ledger); `validateTicket, loadTickets, topoSort,
  computeFloat, globMatch, inScope, scopesOverlap` (tickets); `mutate.*`
  (generateMutants, applyMutant, changedLinesFromDiff).

### Git state (read before branching)

- **Branch:** `fix/adversarial-review-gate-hardening` (NOT merged to main yet).
- **Commits this work builds on** (all signed; SSH/1Password signing is ON —
  if a commit fails with `1Password: failed to fill whole buffer`, the user must
  unlock 1Password, then retry):
  - `fa0e0e8` core: `resolveBase` (fail-closed freeze baselines) + ledger write lock
  - `fb6f1f0` 11-gate hardening sweep
  - `05632a8` review-calibration verifier-based rebuild
  - `9e9cdd6` editorial number fixes (posts + ADLC.md)
  - `f4af6ab` post 9
  - (`bf95ab8`, `9ec347f` add an `agy` CLI provider to core — someone else's
    work on the branch; not part of this roadmap.)

---

## 1. What the last session did (state you inherit)

An adversarial review (fresh-context, refute-chartered prosecutors) was run on
the toolkit. **Systemic finding:** every gate with an adversarial surface
green-passed input it existed to stop — the gates were built against *honest*
mistakes while the doctrine's threat model is an *adversarial* builder
(F5/Goodhart). Root cause: each gate and its tests were written in one builder
context, so both inherited the same blind spot (Principle 3 — never judge your
own context's work). Eleven gate bypasses were found, reproduced, and fixed
RED-first. **review-calibration** was rebuilt because its recall metric was
gameable by line-echoing.

All 19 packages green (~1,042 tests). Two hollow-measurement items were
deliberately deferred (they need producers that don't exist yet) and the
gate-fuzzing tool was identified as the missing process. **This handoff is those
three items.**

### review-calibration's new internals (gate-fuzzing REUSES these)

`packages/review-calibration/` — see its `REDESIGN.md`:
- `lib/verify.mjs` — `verifyWitness(plant, cwd, runFn)` and
  `filterEquivalentMutants(plants, cwd, runFn)`: a **witness** is a command that
  PASSES on the original and FAILS on the mutant (proves a bug is real, not an
  equivalent mutant). **Gate-fuzzing's "is this candidate actually wrong?"
  oracle is exactly this.**
- `lib/controls.mjs` — `echoReviewer` (must score ~0) and `oracleReviewer` (must
  score 1.0): reference reviewers that BOUND the scorer. **Gate-fuzzing needs the
  same bounding** (a known-defeatable gate it must flag; a sound gate it must not
  false-positive).
- `lib/judge.mjs` — `makeLlmJudge(completeFn, extractJsonFn)`, `referenceJudge`
  (deterministic test double), `calibrateJudge(fixture, judge)`.
- `lib/findings.mjs` — `parseFindings(output)` parses `adversarial-review --json`
  shape (`{findings:[{file,line_start,body,evidence,repro?}]}`).
- `lib/scorer.mjs` — `scorePlants(plants, findings, {judge, verifyRepro})`.

---

## 2. The three roadmap items, grounded in code

### Item A — merge-forecast namespace signals (BARELY blocked)

- **Claim it should back:** catch partition conflicts between parallel tickets
  that *create new files* (route-segment collisions like `[pk]` vs `[voteKey]`
  at the same path depth, duplicate exported symbols, colliding migration ids) —
  the field-verified failure ADLC D2 advertises.
- **Current state:** the signals ALREADY EXIST in
  `packages/merge-forecast/lib/signals.mjs`:
  `signalScopeOverlap(a,b)`, `signalImportRadius(a,b,repoFiles,root)`,
  `signalCoChange(a,b,coChangeData,repoFiles)`,
  `signalNamespaceRoutes(a,b,repoFiles)`, `signalMigrationCollision(a,b,repoFiles)`.
- **The bug:** all of them except `signalScopeOverlap` read `repoFiles` =
  `walkTree(root)` = a walk of files **currently on disk**. New files that the
  parallel tickets will *create* do not exist at forecast time, so the signals
  see nothing → verdict `PARALLEL`, score 0. Inert for exactly the greenfield
  parallel tickets they're meant to protect.
- **The fix:** tickets must DECLARE what they create, and the signals must read
  declared intent (falling back to disk for modify-partition tickets).
  - Add a `creates` field to the ticket schema in
    `packages/core/lib/tickets.mjs` (`validateTicket`). Current ticket fields:
    `id, title, scope[], rails[], edges[{to,contract}], duration`. Add
    `creates: { routes?: string[], exports?: string[], migrations?: string[],
    packages?: string[] }` (exact shape is the Opus contract decision below).
  - Wire `signalNamespaceRoutes` / `signalMigrationCollision` (and optionally a
    new exports/packages signal) to read `a.creates` / `b.creates` in addition
    to globbing disk.
- **NOT blocked on the orchestrator.** Only needs the schema field. Contained.

### Item B — model-router priors (blocked on the orchestrator)

- **Claim it should back:** ADLC D1 — "the manifest ledger IS the routing table:
  per-repo, empirical, self-tuning." Route each ticket to the cheapest model
  tier that clears its gates, learning from history.
- **Current state — dead code:** `packages/model-router/lib/priors.mjs`
  `buildPriors(entries)` only counts `entries` where `entry.type === 'build'`
  with fields `{model, category, firstPass}`. **No tool writes that shape.**
  `gate-manifest`'s `buildEntry` (`packages/gate-manifest/lib/record.mjs`) writes
  `{seq, gate, ts, ticket?, data?, files, prev, sig?}` — no `type:'build'`, no
  `model`, no `firstPass`. So `buildPriors` always returns empty and routing
  collapses to `'mid'` for everything. Tests pass only because they hand-feed the
  fictional shape.
- **Also:** `lib/density.mjs` rail-density = `min(1, rails.length / scopeLen)` —
  a glob-array-length ratio, gameable by adding dummy rail globs. Not real
  coverage.
- **The fix (two phases):**
  - **B-now (unblockable):** define the build-outcome entry contract; make
    priors HONEST — Beta-Bernoulli posterior per (model × category), cold-start
    defaults with a logged warning when there's no history, relabel rail-density
    as a heuristic estimate. Stops the tool silently pretending to self-tune.
  - **B-later (gated on orchestrator):** the orchestrator is the real producer —
    when a build lane finishes it records `{type:'build', model, category,
    ticketId, firstPass, retries, escalated, railDensityRealized}`. Then priors
    is live and routing becomes a contextual bandit (explore cheap tier when
    uncertain, exploit known-good tier otherwise).
- **Blocked on the orchestrator for the real producer.** Do B-now standalone.

### Item C — gate-fuzzing (NET-NEW; unblocked; highest leverage)

- **What it is:** a standing red-team. A generator-adversary produces candidate
  diffs designed to PASS every configured gate while being WRONG; run them
  against the gate suite; each gate a wrong-but-passing diff defeats is a
  calibration finding that hardens that gate. This is what turns "we found 11
  bypasses once" into "finding bypasses is a CI gate." GAN/fuzzer for the
  lifecycle.
- **Why now:** post 9 promises it in print; the gate-hardening sweep was a
  one-time instance of exactly this process; without it, hardening doesn't
  compound.
- **Reuses (do not rebuild):** review-calibration's `verify.mjs` witness/oracle
  (a defeat = candidate passes all gates AND a held-out witness proves it's
  genuinely wrong) and `controls.mjs` bounding pattern.
- **Architecture decisions (the Opus design pass — see below):**
  1. Definition of a "defeat": candidate diff passes all configured gates AND
     fails a held-out oracle/witness (genuinely wrong). No witness → not a defeat
     (avoids crying wolf).
  2. Candidate generation: fan N adversaries (cheap/mid models, frontier-free —
     search replaces insight), seeded with the **bypass taxonomy** in §4.
  3. Loop-until-dry + token budget + deterministic exit codes (0 = no gate
     defeated, 2 = a gate was defeated, 1 = op error).
  4. A defeat → a `lesson-foundry` finding (closes the compounding loop; see
     `packages/lesson-foundry/`).
  5. **The tool's own control** (it is itself a gate): a known-defeatable stub
     gate it MUST flag, and a sound stub gate it MUST NOT false-positive — same
     echo/oracle bounding review-calibration uses. Bake in at design time.
  6. Anti-gaming: the adversary must not "win" by producing diffs that don't
     compile or are trivially malformed — a defeat requires the candidate to
     pass the gates honestly (build/lint included) and still be wrong.

---

## 3. Execution plan + model assignment (Principle 7)

**Rule (ADLC Principle 7 / Appendix E):** frontier tier (here **Opus** — the
ceiling in the frontier-free doctrine) only where an error is *expensive to
detect* — contracts, schemas, adversarial-generation design, routing policy,
final verdicts. **Sonnet** for build-proper, where the dense existing test rails
+ prosecution catch errors cheaply. The pattern is the barbell / E4-banking:
**Opus mints structure in a few expensive passes (a written, prosecuted design
doc); Sonnet builds inside it under rails.**

| Task | Opus (mint structure) | Sonnet (build under rails) |
|------|----------------------|----------------------------|
| **A. merge-forecast `creates`** | Design the `creates` schema: sub-fields, composition with `scope`/`edges`, backwards-compat. Shared contract read by 5 tools — a wrong shape sails through every gate. ~1 pass. | `validateTicket` field + validation; wire the 3 signals to read declared namespaces with disk fallback; tests against existing harness. |
| **B-now. model-router honest** | Design the build-outcome entry contract (producer→consumer) + the routing policy (Beta-Bernoulli posterior, explore/exploit, cold-start). Wrong policy = silent misrouted spend → expensive to detect. | Posterior math, cold-start + warning path, relabel rail-density estimate, tests. |
| **C. gate-fuzzing** | The architecture in §2-C (defeat definition, generation strategy, loop/budget/exit codes, lesson-foundry wiring, the tool's own control, anti-gaming). Highest cost-of-missed-class. | The harness: candidate runners, scoring, ledger, CLI, tests, the N-wide **Sonnet** runtime adversary. |
| **B-later. router self-tuning** | Folds into the orchestrator design. | After orchestrator. |
| **Orchestrator** (separate, larger) | Lane architecture (ADLC D0: deterministic scheduler, no model-as-scheduler) + build-outcome producer contract. | Topological scheduler, worktree/lane runners, work-stealing, the recorder. Its own planning pass. |

### Recommended order

1. **C (gate-fuzzing)** — promised in print, highest leverage, unblocked,
   smaller than it looks (reuses witness/oracle). Opus design → Sonnet build.
2. **A (merge-forecast `creates`)** — cheapest real win, fully unblocked,
   contained. Interleave its small Opus schema pass while C's build runs.
3. **B-now (model-router honest)** — Opus policy/contract → Sonnet build.
4. **Orchestrator** — keystone producer; unblocks B-later and consumes A's
   richer tickets. Separate initiative, own planning pass.

---

## 4. Bypass taxonomy (seed corpus for gate-fuzzing's adversary)

The eleven classes found this session — feed these to the adversary as starting
strategies; it should generalize beyond them:

1. **Base-ref / diff-window** — gate diffs against `HEAD`; a *committed* change
   is invisible to `git diff HEAD`. (rails-guard) → fix was `resolveBase`.
2. **Committed-vs-working-tree** — a clean working tree hides a committed
   mutation; freeze checks must diff the merge-base, fail closed.
3. **Provenance forgery** — keyless `sha256` chain is recomputable; forge entries
   from scratch. (gate-manifest) → fix was HMAC (`ADLC_MANIFEST_KEY`).
4. **Trust agent-supplied data** — an env var (or ticket field) supplies the
   verdict. (coldstart `ADLC_GATE_MOCK_RESPONSE`) → gate behind `NODE_ENV=test`.
5. **Degenerate-input vacuous pass** — empty diff / red baseline / cyclic DAG →
   exit 0. (hollow-test `--test-cmd false`; merge-forecast cycle).
6. **Self-referential gate** — a generated gate matches its own pattern string.
   (lesson-foundry) → exclude output dir / node_modules / .git.
7. **Format blindness** — a supervisor parses a log format the real producer
   doesn't emit. (flail-detector → parse real Claude Code JSONL `tool_use.input.file_path`).
8. **Error-state collapse** — two error states treated as "no diff." (behavior-
   diff: dead server passes as identical).
9. **Single-test gaming** — a fix passes the one repro by breaking siblings.
   (consensus-fix → add `--rails` regression gate).
10. **Substring / echo scoring** — reviewer echoes changed lines; scorer counts
    the mention. (review-calibration → verifier-based scoring).
11. **Suppression-marker evasion** — alternate spellings / whitespace bypass a
    substring blocklist. (rails-guard suppressions).
12. **Command injection** — untrusted filename/ref into `shell:true`. (model-
    ratchet, review-calibration → argv execution).

---

## 5. Working rules for the build

- Branch off `fix/adversarial-review-gate-hardening` (or wherever it has merged
  to by then). Foundation-first if there's a shared `@adlc/core` change
  (e.g. the `creates` field): land core first, then dependents.
- TDD: for every fix/feature, write the failing test first (for gate-fuzzing and
  the measurement fixes, the test should reproduce the gap — e.g. a forecast test
  with not-yet-created colliding routes; a priors test against the REAL emitted
  entry shape, not a fictional one).
- Each gate/tool ships its own **control** (the echo/oracle bounding) so it can't
  silently regress — this is the lesson of this whole session.
- Don't introduce unbacked numbers in docs. SHAs, test counts, exit codes are
  citable; recall/cost figures are not unless measured.
- Commit signing is ON (SSH/1Password). Expect occasional
  `failed to fill whole buffer`; ask the user to unlock, then retry.
- Verify the full suite green before commit:
  `for d in packages/*/test; do node --test "$d"/*.test.mjs || break; done`
  (note: the root `npm test` script only reports the last package — run
  per-package or fix the loop).

---

## 6. First action for the new context

Spawn an **Opus** design pass for **gate-fuzzing** (Item C): produce a written,
prosecutable architecture doc covering the six decisions in §2-C, explicitly
reusing review-calibration's `verify.mjs` witness/oracle and `controls.mjs`
bounding, and seeded with the §4 taxonomy. Then hand the build to **Sonnet**
against that doc under TDD. Interleave the small Opus schema pass for Item A.
