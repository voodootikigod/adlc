# Spec: `@adlc/decompose` — the P2 decomposition compiler

**Phase:** P2 Decompose · **Status:** awaiting P1 human approval · **Revision:** v2
**Date:** 2026-09-11

> **v2 changelog.** v1 failed its own premortem on six verified counts. Every one
> is fixed below and each is called out inline as **[v1 defect]**. Two claims v1
> asserted about this codebase were simply false; they are corrected in §4 and §3.

---

## 1. Problem

The ADLC specifies P2 Decompose as "ticket DAG + edge contracts," gated by
"coldstart per ticket + merge-forecast certifies width" (`ADLC.md:148,228-248`),
and ships every *validator* of a ticket DAG as a package: `coldstart`,
`parallax --edge`, `model-router`, `merge-forecast`.

Nothing *authors* the DAG. There is no `decompose` verb in
`packages/cli/lib/registry.mjs`. Tickets are written one at a time by hand via
`adlc ticket create --input`, and `@adlc/autopilot` is strictly one issue → one
ticket → one fleet run with no fan-out.

The consequence is a hole between P1 and P4: `adlc fleet` consumes a ticket DAG
that nothing in the toolkit produces. P2 is the only phase the ADLC gates in
theory and not in practice.

## 2. Solution

`@adlc/decompose` — a compiler. An approved spec (or prose plan) in; a validated
ticket DAG written into the canonical `.adlc/tickets/` store out; a refusal to
write anything that fails its own gates.

### 2.1 Prerequisite: the D0 doctrine amendment

`ADLC.md` D0 (`:740-748`) says the orchestrator "never consults [a model] about
sequencing." A compiler has a model propose the DAG, so `decompose` reads as
doctrine-violating to any reviewer who checks. Ship this paragraph into `ADLC.md`
§D0 **in the same PR**:

> D0 forbids a model deciding sequencing **at dispatch time**, inside the loop,
> where the decision is unreproducible and rots with the context. It does not
> forbid a model **proposing** a decomposition that is then frozen,
> deterministically validated, and executed by a scheduler that never asks again.
> The first is a boss agent; the second is a compiler. Compilers may use
> heuristics; schedulers may not.

**Provenance caveat.** This paragraph was authored in `docs/intent/booster-adoption.md`
and all three parallax readings adopted it verbatim after reading that document.
It is an *unverified* agreement, not a measured convergence, and should be
reviewed on its merits at the P1 gate.

## 3. Settled decisions

| # | Question | Resolution | Basis |
|---|---|---|---|
| D1 | Store-write mechanism | Add `planCreateBatch()` to `@adlc/tickets` | human, P1 |
| D2 | Is width certification blocking? | Yes — **per wave** (§5 Stage C) | human, P1 |
| D3 | Recompile semantics | Additive-only, always | human, P1 |
| D4 | Offline operation | Ship `--from-conversion`, **honestly scoped** (below) | human, P1 |
| D5 | Ticket schema carries a tier? | **No** — `id, title, body, category, duration, budget, scope, rails, completed, edges` | verified |
| D6 | Can looping `planCreate` build a DAG? | **No** — `schema.mjs:49` rejects `edge to unknown ticket` | verified |
| D7 | Is `model-router` blocking? | **No, advisory** — `ADLC.md:828` calls its exit 2 "a P3 finding wearing a routing costume" | author |

**[v1 defect] D4 was overstated.** `--from-conversion` skips only *decompose's own*
converter. Stage B still shells to `coldstart` and `parallax`, and Stage D to
`premortem`; each calls `detectProvider()` and exits 1 without one. `--from-conversion`
buys reproducibility and removes the frontier-tier call — **not** a fully
provider-free compile. The README and `--help` must say exactly this.

## 4. Package shape

```
packages/decompose/
├── package.json      deps: @adlc/core, @adlc/tickets, @adlc/merge-forecast
├── bin/decompose.mjs
├── lib/{convert,structural,gates,width,project,run}.mjs
├── test/
└── README.md
```

**[v1 defect] v1 claimed "sibling `@adlc/*` packages are never imported as
libraries." That is false** — measured across `packages/*/lib` and `packages/*/bin`:
34 imports of `@adlc/gate-manifest`, 31 of `@adlc/tickets`, 3 of
`@adlc/model-router`, 3 of `@adlc/fleet`. The false premise forced an
all-subprocess design, which is what hid the width-semantics defect below.

The rule is therefore:

- **Deterministic logic is imported in-process**: `topoSort`, `scopesOverlap` from
  `@adlc/core`; `runForecast` (`forecast.mjs:26`), `topoWaves` and
  `parallelEligiblePairs` (`reachability.mjs:92,69`) from `@adlc/merge-forecast`.
- **Model-calling gates stay subprocesses**: `coldstart`, `parallax`, `premortem`.
  Every such call recovers its JSON from `err.stdout` on a non-zero exit, because
  these tools gate-fail with exit 2 and still emit valid JSON.

### 4.1 CLI

```
decompose <spec.md|->                 positional path, or - for stdin
decompose --file <spec.md>
decompose --request "<inline prose>"
decompose --from-conversion <dag.json>

  --write                  project into the store (default: dry run)
  --tier <cheap|mid|frontier>   accepted; only `frontier` is permitted (below)
  --tickets <path>         store path (default: resolved canonical store)
  --max-attempts <n>       Stage A budget (default 3)
  --parallax-n <int>       edge fan width, forwarded to parallax
  --allow-unsigned         same contract as ticket-prune / ticket-sync
  --json
  --prompt-only            print the converter prompt, exit 0
  --help
```

**[v1 defect] `--tier` must be accepted, not rejected at parse time.**
`scripts/test/flag-consistency.test.mjs:5,124` requires every model-calling package
to register `--prompt-only` and `--tier` as parseable options and to "reject
anything else with a clear error." v1's AC24 would have failed that suite, and
`@adlc/core`'s `parseArgs` runs `strict: true`, so an undeclared flag throws
`ERR_PARSE_ARGS_UNKNOWN_OPTION` rather than the intended message. Declare `--tier`,
accept `frontier`, and reject `cheap`/`mid` with an explicit message naming the
frontier pin (`ADLC.md:98-102`; `model-router` Rule 1 forces
`contract|spec|architecture` work to frontier).

### 4.2 Exit codes

| Code | Meaning |
|---|---|
| 0 | DAG gated clean — dry-run report, or written under `--write` |
| 1 | Operational: unreadable spec, no provider for a model-calling gate, unresolvable binary, store locked, stale CAS snapshot, missing key without `--allow-unsigned`, **any sibling gate exiting 1** |
| 2 | Gate fail: budget exhausted with blocking findings surviving. Nothing written. |

A malformed converter reply is **not** operational — it folds into Stage A as a
structural finding and consumes one attempt.

## 5. Pipeline

### Stage A — structural (deterministic, in-process, ≤ `--max-attempts`, default 3)

One frontier/direct completion converts the spec into a candidate ticket array
using provisional ids (`T1`, `T2`, …). Validate the merged set:

1. Per-ticket schema via `@adlc/tickets`.
2. Duplicate provisional id within the batch.
3. Case-insensitive id collision against the active store and within the batch.
4. Edge-target resolution: every `edges[].to` resolves within the batch.
5. **No edge may name an existing ticket, as origin *or* target.**
   **[v1 defect]** v1 banned only existing→new edges. But dependency pressure lands
   on the *target*: `topoSort()` does `indegree[e.to] += 1`, and `topoWaves()` the
   same. A new ticket with `{to: <existing id>}` therefore changes that existing
   ticket's indegree, readiness and wave — while its shard stays byte-identical, so
   `rails-guard-ci`'s add-vs-alter contract sees a pure addition and the store is
   deliberately off the tier surface (#326). A compile could silently block a
   ticket a fleet run is already executing. Reject both directions.
6. Cycle detection via `topoSort()`.
7. **Scope-overlap veto, restricted to parallel-eligible pairs within the batch.**
   **[v1 defect]** v1 vetoed overlap against *every* active ticket. Two facts make
   that fatal: `scopesOverlap` is a string-prefix test (`packages/decompose/lib/**`
   vs `packages/**` → `true`; `src/auth` vs `src/authz/**` → `true`, a false
   positive), and this repo has three active repo-wide tickets — two release
   tickets declaring `packages/**`. Every candidate touching any package would be
   rejected, permanently, and the first compile's own output would block every
   later one. Use `parallelEligiblePairs()` so edge-connected tickets may share
   scope (that relationship is exactly what `edges[].contract` expresses), and
   confine the veto to the batch. Overlap against *active* tickets is reported as
   an advisory warning, never a veto.

All failures aggregate into one feedback block for a full re-emission. Exhausting
the budget is exit 2.

### Stage B — LLM gates (blocking, ≤ 2 passes)

Materialise the survivor to a scratch tree and run, concurrently:

- `coldstart --all --tickets <scratch> --json`
- `parallax --edge <A> <B> --tickets <scratch> --json` per batch edge

**Both subprocesses run with `cwd` set to the scratch tree.**
**[v1 defect] v1's dry run was not dry.** `coldstart.mjs:169` runs
`for (const entry of recordPlan) record({ ...entry, key: getKey() })`
unconditionally after `checkAll` — there is no `--no-record` flag. A no-`--write`
compile would permanently append manifest entries bound to provisional ids
`T1..Tn`, and in this segmented repo would create a new tracked segment file.
Because `appendManifestEntry(payload, dir = ADLC_DIR)` resolves `.adlc` from cwd,
setting the subprocess cwd redirects those records into the scratch tree with no
change to coldstart.

**Blocking condition is each tool's own verdict, not raw finding counts.**
**[v1 defect]** v1 blocked on "non-empty `divergences`". parallax emits no
`divergent` field at all, and its real gate is `score <= threshold` (default 0.25)
— it deliberately tolerates a quarter of readings diverging. Blocking on any
divergence would block essentially every pass and burn the re-conversion budget on
noise. Block on parallax's `gate === false`, and on coldstart's non-empty `gaps`.

Non-empty on pass 1 → one feedback re-conversion → re-run Stage A → re-run Stage B
once. Still blocking → exit 2.

### Stage C — per-wave width certification (blocking, per D2)

**[v1 defect] v1 assumed `merge-forecast --width` certifies the whole schedule. It
does not** — `forecast.mjs:134-136` computes `certifiedWidth` from `waves[0]` alone,
and `computeCertifiedWidth` (`:203`) scores only pairs with both endpoints in wave
1. For the canonical foundation-first shape (1 → 4 → 1) the true width is 4 and
`certifiedWidth` is 1, so v1's "natural fan-out width" would have failed every DAG
with an edge — leaving `decompose` able to emit only flat batches, which is what
looping `ticket create` already does. Tracked as **#997**.

Certify **per wave**, using the semantics the tool already implements:

```
waves = topoWaves(candidates)
for i in 0..waves.length-1:
    subDag = candidates minus every ticket in waves[0..i-1]   # earlier waves are "merged"
    runForecast({ tickets: subDag, width: waves[i].length })  # waves[i] is now wave 1
```

Each wave is evaluated as wave 1 of the remaining DAG, which is exactly the
question "if everything upstream had merged, is this wave safe at its own width?"
Any wave failing certification, or any vetoed pair scheduled concurrently, is a
blocking finding → one feedback re-conversion → re-validate A and B → re-run C
once. Still blocking → exit 2. This needs no change to `merge-forecast` and does
not block on #997.

**Determinism caveat.** `pairScore()` folds in `coChange(...)`, so `certifiedWidth`
varies with git history depth — in a shallow worktree the signal is skipped with a
warning and the number changes. Stage C records its forecast inputs and the
resulting per-wave widths in the evidence entry (§7) so a disputed gate result is
reconstructable. The general problem is #997's secondary observation.

### Stage D — premortem (advisory, never vetoes)

Render the surviving DAG plus the source spec to one markdown document and run
`premortem <rendered.md> --tier frontier --json`, cwd set to the scratch tree.
Causes surface in the report and under `advisory.premortem`. They never affect the
exit code.

### Stage E — projection (clean A/B/C, and only under `--write`)

1. Mint real ids via `generateTicketId()`; rewrite provisional edges in one pass.
2. `planCreateBatch(tickets)` + `apply()`, once (§6).
3. `model-router` for the report and evidence only — advisory (D7), nothing written
   back (D5).
4. `runForecast` on the written store, in-process, for the recorded width. **Not**
   claimed as wired into `fleet`; that is a separable follow-up, recorded as a known
   gap in the README rather than stranded the way booster's `plan.concurrencyCap` was.
5. Append evidence (§7).

## 6. New surface in `@adlc/tickets`

`TicketService.planCreateBatch(tickets)` — operation `'batch-create'`. Asserts every
id is genuinely new; validates through the same `#plan`/`validateTickets` path;
applies through the existing `apply(plan, { lock })` transaction.

Chosen over `planReconciliation` (hard-codes `'remote-reconciliation'`,
`service.mjs:202` — every P2 compile would be audited as a ticket-sync event) and
over looping `planCreate` (impossible, D6).

**[v1 defect] v1 claimed the evidence binding is inherited "unmodified." It is not.**
`#plan` carries a single `ticketId`; `apply()` forwards that one id;
`evidenceBinding()` returns all-null hashes when it is null and `recordTicketEvidence`
then stamps `bindingScope: 'store'`. A six-ticket compile would emit one entry naming
no ticket — defeating §7's purpose. `evidence.mjs` already supports a multi-ticket
`ticketIds` field; `applyDirectoryTransaction` never passes it. Delivering per-ticket
binding therefore requires threading `ticketIds` from the plan through `apply()` into
`applyDirectoryTransaction` → `recordTicketEvidence`. **`packages/tickets/lib/transaction.mjs`
is in this diff**, which is a larger blast radius than v1 admitted.

## 7. Evidence

One `gate-manifest` entry per new ticket, gate `decompose`, data: `{ specHash,
converterTier, attempts, gatePasses, coldstart, parallaxEdges, perWaveWidths,
forecastInputs }`. Signed via `ADLC_MANIFEST_KEY`, or unsigned with a warning under
`--allow-unsigned`. Plus the transaction's own `ticket-mutation` entry, bound to
every id in the batch (§6).

## 8. Trust-root tier and landing order

Add `'packages/decompose/'` to `PRODUCER_PREFIXES` in
`packages/prosecute/lib/tier.mjs`. Because `packages/prosecute/` is itself an
`ENFORCEMENT_PREFIXES` entry, that change is trust-root tier on its own account.

**[v1 defect] v1 implied that landing the tier one-liner early keeps later PRs
cheap. It does not.** `TRUST_ROOT_FILES` includes `package.json` and
`package-lock.json` as **exact** matches, and creating a package edits both. Every
PR in this program is trust-root tier and needs a signed cross-model attestation
bound to the reviewed revision, regardless of ordering. Per standing practice the
agent is denied `ADLC_MANIFEST_KEY`, so a human runs that step on each lane. Plan
for it rather than being surprised by it.

## 9. Repo conformance obligations

Adding a package trips four repo-wide guards that v1 ignored entirely:

- `apps/docs/test/toolkit-packages.test.mjs:16` asserts `ALL_PACKAGES` is bijective
  with the on-disk `packages/` listing, and `:25` requires
  `apps/docs/content/docs/toolkit/decompose.mdx` to exist.
- `scripts/test/flag-consistency.test.mjs` — add `decompose` to its `PACKAGES` table
  (the table is hand-maintained with no completeness guard, so omission is silent).
- `scripts/test/prompt-fencing.test.mjs:30` — add `lib/convert.mjs` to `GUARDED`.
- `packages/cli/lib/registry.mjs` — the `decompose` verb entry.

## 10. Acceptance criteria

Every criterion names the verification method that decides it.

- **AC1** — A spec compiles to a valid DAG and is written to the store. Verified by `packages/decompose/test/roundtrip.test.mjs` — scratch git repo, real `decompose --from-conversion <fixture> --write`, commit, run real `scripts/rails-guard-ci.mjs` as a subprocess, assert exit 0.
- **AC2** — A cyclic candidate batch never reaches the store. Verified by `packages/decompose/test/structural.test.mjs` — cyclic fixture exits 2, store snapshot hash unchanged.
- **AC3** — An edge to an unknown provisional id is rejected in Stage A. Verified by `packages/decompose/test/structural.test.mjs` — assert the error names the unresolved target.
- **AC4** — An edge naming an existing ticket is rejected in either direction. Verified by `packages/decompose/test/structural.test.mjs` — assert exit 2 for both `{from: existing}` and `{to: existing}` fixtures.
- **AC5** — A compile does not change any existing ticket's scheduling position. Verified by `packages/decompose/test/structural.test.mjs` — compute `topoWaves` and indegree for every active ticket before and after a successful compile, assert deep equality.
- **AC6** — Scope overlap vetoes only parallel-eligible pairs inside the batch. Verified by `packages/decompose/test/structural.test.mjs` — an edge-connected overlapping pair passes; an unconnected overlapping pair exits 2.
- **AC7** — A batch overlapping a repo-wide active ticket still compiles. Verified by `packages/decompose/test/real-store.test.mjs` — run against a copy of this repo's real `.adlc/tickets/` store, which holds three active repo-wide-scope tickets, and assert exit 0.
- **AC8** — A case-insensitive id collision is caught in Stage A, not at the store. Verified by `packages/decompose/test/structural.test.mjs` — assert the Stage A error fires and `CASE_COLLISION` never throws.
- **AC9** — Stage A retries at most `--max-attempts` then exits 2. Verified by `packages/decompose/test/pipeline.test.mjs` — stub converter always invalid, assert exactly 3 converter calls.
- **AC10** — A malformed converter reply consumes an attempt rather than exiting 1. Verified by `packages/decompose/test/pipeline.test.mjs` — stub returns unparseable text once then a valid batch, assert exit 0.
- **AC11** — Stage B blocks on coldstart gaps and re-converts exactly once. Verified by `packages/decompose/test/pipeline.test.mjs` — stubbed subprocess, assert exactly 2 gate passes then exit 2.
- **AC12** — Stage B blocks on parallax's own gate verdict, not on raw divergence count. Verified by `packages/decompose/test/pipeline.test.mjs` — a stub emitting `divergences` with `gate: true` (score under threshold) must NOT block; `gate: false` must block.
- **AC13** — Stage B leaves the repo's `.adlc/` byte-identical on a dry run. Verified by `packages/decompose/test/pipeline.test.mjs` — hash the entire `.adlc/` tree including `manifest.d/` before and after a no-`--write` run with the REAL coldstart binary, assert equality.
- **AC14** — Every wave of a multi-level DAG is certified, not just the first. Verified by `packages/decompose/test/width.test.mjs` — a 1→4→1 fixture certifies clean end to end against the REAL `runForecast`, not a stub.
- **AC15** — A wave whose width exceeds its certification exits 2. Verified by `packages/decompose/test/width.test.mjs` — fixture with a conflicting pair inside one wave, assert exit 2 naming that wave.
- **AC16** — A sibling gate exiting 1 fails closed. Verified by `packages/decompose/test/pipeline.test.mjs` — stub exits 1, assert `decompose` exits 1 and the store hash is unchanged.
- **AC17** — Sibling JSON is recovered from a gate-fail exit 2. Verified by `packages/decompose/test/pipeline.test.mjs` — stub writes valid JSON and exits 2, assert findings parsed rather than treated as operational.
- **AC18** — Premortem never changes the exit code. Verified by `packages/decompose/test/pipeline.test.mjs` — stub returns causes on a clean DAG, assert exit 0.
- **AC19** — Dry run is the default and mutates nothing. Verified by `packages/decompose/test/cli.test.mjs` — run without `--write`, assert the whole `.adlc/` tree hash is unchanged.
- **AC20** — `planCreateBatch` refuses a non-new id. Verified by `packages/tickets/test/service.test.mjs` — assert a policy error naming the colliding id.
- **AC21** — `planCreateBatch` writes a multi-level DAG atomically. Verified by `packages/tickets/test/service.test.mjs` — 3 tickets across 2 edge levels in one apply, assert all present and `operation` is `batch-create`.
- **AC22** — A failed apply leaves the store byte-identical. Verified by `packages/tickets/test/service.test.mjs` — force a mid-apply failure, assert the snapshot hash is unchanged.
- **AC23** — The transaction's manifest entry names every ticket in the batch. Verified by `packages/tickets/test/transaction.test.mjs` — assert `ticketIds` carries all ids and `bindingScope` is not `store`.
- **AC24** — One signed evidence entry is appended per new ticket. Verified by `packages/decompose/test/roundtrip.test.mjs` — assert entry count equals ticket count, each with `gate: 'decompose'`.
- **AC25** — `--allow-unsigned` warns and still records. Verified by `packages/decompose/test/cli.test.mjs` — assert a warning on stderr and an unsigned entry.
- **AC26** — `--prompt-only` prints the converter prompt, exits 0, needs no provider, writes nothing. Verified by `packages/decompose/test/cli.test.mjs` — assert exit 0, prompt on stdout, `.adlc/` tree unchanged.
- **AC27** — `--from-conversion` skips the converter but still requires a provider for Stage B. Verified by `packages/decompose/test/cli.test.mjs` — with no provider env, assert exit 1 and a message naming the gate that needs one.
- **AC28** — `--tier frontier` is accepted; `cheap` and `mid` are rejected with a clear message. Verified by `packages/decompose/test/cli.test.mjs` plus membership in `scripts/test/flag-consistency.test.mjs`'s table.
- **AC29** — A change to decompose's source classifies trust-root tier. Verified by `packages/prosecute/test/tier.test.mjs` — a diff touching `packages/decompose/lib/run.mjs` tiers; a `packages/decompose/test/` path does not.
- **AC30** — The `decompose` CLI verb is registered and dispatches. Verified by `packages/cli/test/registry.test.mjs` — assert `decompose` resolves to `@adlc/decompose`.
- **AC31** — Repo conformance guards pass. Verified by `apps/docs/test/toolkit-packages.test.mjs` (bijection + `decompose.mdx`) and `scripts/test/prompt-fencing.test.mjs` (`lib/convert.mjs` in `GUARDED`).
- **AC32** — The compiler converges on real input. Verified by `packages/decompose/test/convergence.test.mjs` — compile 3 committed specs from `.adlc/specs/` with recorded converter replays, assert each reaches exit 0 within the attempt budget.
- **AC33** — No test reaches the network. Verified by `npm test` running green with no provider environment variables set.

## 11. Non-goals for v1

Antigravity brain-artifact discovery (belongs in `plugins/adlc-gemini`); wiring
`fleet` to consume the recorded width; superseding tickets from an earlier compile
(D3); host integration-doc tables; the `sweep` generator and pool-aware concurrency
from `docs/intent/booster-adoption.md` §4 and §7.

## 12. Known risk

`decompose` embeds spec text and existing ticket bodies — both repository-controlled
— into a frontier-model prompt. `docs/intent/booster-adoption.md` §3.1 flags that
`@adlc/core`'s `fence()` derives its tag from the capped content length, which is
fully predictable when the input is truncated. That finding is unproven and tracked
separately. `decompose` must use the current fencing primitive and must not
introduce a third scheme; AC31 pins it into the fencing guard list. If the finding
reproduces, it is a prerequisite, not a follow-up.
