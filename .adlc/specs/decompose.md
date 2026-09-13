# Spec: `@adlc/decompose` — the P2 decomposition compiler

**Phase:** P2 Decompose · **Status:** **PARKED** — blocked on #1003 · **Revision:** v4
**Date:** 2026-09-13

> ## Parked, and why
>
> This spec is **not approved and not being built.** Four adversarial premortem
> rounds produced 29 verified findings, and the rate never dropped. The recurring
> killer was the same in every round: *the emitted DAG is not applicable.*
>
> That is not bad luck. This specifies a **producer for a consumer that does not
> exist** — there is no atomic multi-ticket write path (#1003), and
> `adlc ticket create --input` takes one ticket while persisting a supplied id
> verbatim (`service.mjs:106`), so a provisional `T1` collides with the 96 legacy
> `T<n>` shards already in the store. With no ground truth to validate against,
> every round re-litigated what the DAG must look like.
>
> **Unblocks when #1003 lands.** Then re-spec against a real consumer, stripped to
> the rules that survived all four rounds — schema, cycle, intra-batch edge
> resolution — plus two corrections round 4 earned: require non-empty `body` and
> `scope` (`validateTicket` checks neither, `schema.mjs:4-12`), and namespace
> provisional ids so they cannot alias the store. Rule 6 and the advisories should
> be deleted outright; `merge-forecast` already does that work correctly and this
> spec got it wrong in four different ways.
>
> Everything below is the v4 text, kept for its verified constraints. Read it as
> evidence, not as a plan.

> **Revision history.** Three adversarial premortems, three failures, and each
> time the defects clustered **outside** the compiler's actual job — in v2 the
> gate-orchestration loops, in v3 the store write's trust-root contract. v4 draws
> the boundary where the complexity isn't: `decompose` is a pure function from
> spec to validated DAG. It does not write anything. A fourth round then found the
> defects had moved into the validation rules themselves — see the parking note.

---

## 1. Problem

P2 Decompose is specified (`ADLC.md:148,228-248`) and every DAG *validator* ships
— `coldstart`, `parallax --edge`, `model-router`, `merge-forecast`. Nothing
*authors* the DAG. There is no `decompose` verb; tickets are written one at a time
by hand, and `@adlc/autopilot` is one issue → one ticket with no fan-out.

## 2. Solution: a pure function

`decompose` takes an approved spec and emits a **structurally validated ticket
DAG as JSON**. It reads the ticket store read-only for advisory context. It writes
nothing — not the store, not the manifest, not a rail.

What it deliberately does not do, and why:

- **It does not write the ticket store.** v3 did, and six of eight premortem
  findings were in that contract: candidate `rails` freeze the repo on write
  (`rail-freeze.mjs:140-143` unions rails over every non-completed ticket, and the
  PreToolUse hook reads the same from the working tree); `storeDeclaresRails`
  (`trust-root.mjs:78`) ignores `completed`, so one railed candidate permanently
  converts a rail-free store into a frozen trust root; `--allow-unsigned` appends
  unsigned entries onto an already-signed chain, and `verifyChain` then fails for
  every later keyed gate toolkit-wide; N evidence appends land *after* the ticket
  transaction releases its journal, so a failure at append k strands the store
  half-evidenced with no rollback. None of that is decomposition. It is the batch
  write's contract, and it deserves its own ticket and its own premortem.
- **It does not emit `rails`.** Rails are a P3 artifact — `ADLC.md:262-264`
  requires them authored "in a context that will never see the implementation,"
  which is not a P2 converter. A DAG with no rails freezes nothing and grants
  nothing.
- **It does not run the P2 LLM gates.** `coldstart`, `parallax --edge` and
  `merge-forecast` run against the applied DAG, as separate `adlc` invocations.

Consequences worth stating plainly: `decompose` is **not** a producer of a gated
artifact, so it does not join `PRODUCER_PREFIXES` and its own changes are not
trust-root tier on that account. Applying the emitted DAG is a separate,
deliberate act by whoever owns the store.

### 2.1 Prerequisite: the D0 doctrine amendment

`ADLC.md` D0 (`:740-748`) says the orchestrator "never consults [a model] about
sequencing." Ship this into §D0 **in the same PR**:

> D0 forbids a model deciding sequencing **at dispatch time**, inside the loop,
> where the decision is unreproducible and rots with the context. It does not
> forbid a model **proposing** a decomposition that is then frozen,
> deterministically validated, and executed by a scheduler that never asks again.
> The first is a boss agent; the second is a compiler. Compilers may use
> heuristics; schedulers may not.

**Provenance caveat.** Authored in `docs/intent/booster-adoption.md`; all three
parallax readings adopted it verbatim after reading that document. An *unverified*
agreement, not a measured convergence — review it on its merits.

## 3. Settled decisions

| # | Question | Resolution | Basis |
|---|---|---|---|
| D1 | Does it write the store? | **No** — emits JSON (§2) | human, P1 (v4) |
| D2 | What blocks the compile? | Structural invalidity only, using the **downstream gate's own predicate** (§5 rule 6) | human, P1 (v4) |
| D3 | Recompile semantics | Each run emits an independent DAG; nothing is superseded | human, P1 |
| D4 | Offline operation | `--from-conversion` makes the compile fully provider-free | human, P1 |
| D5 | Does it emit `rails`? | **No** — P3 artifact (§2) | premortem |
| D6 | Does it mint real ticket ids? | **No** — provisional ids only; the applier mints | v4 |

**D2's history is worth recording, because I got it wrong twice.** v2 made width
certification blocking; v2's premortem showed it inert *because rule 7 already
vetoed the same pairs with the same predicate*. v3 then narrowed rule 7 to a
"real glob intersection" — and carried v2's conclusion forward even though it was
contingent on the rule that changed. The result contradicted itself: v3 required
batches to compile clean that `merge-forecast` hard-vetoes, since
`signalScopeOverlap` (`signals.mjs:21`) takes no `repoFiles` and `pairScore`
short-circuits on it at `:329` with `hardVeto: true`. v4 stops inventing a
predicate and reuses the downstream one.

**D6 follows from D1.** With no store write there is no reason to mint ULIDs, and
minting them made v3's own duplicate-id and case-collision rules unreachable
(`generateTicketId` returns uppercase Crockford base32 with 80 bits of entropy, so
a duplicate is a 2^-80 event and a case-fold onto a legacy `a142` is impossible).
Provisional ids keep those checks meaningful.

## 4. Package shape

```
packages/decompose/
├── package.json      deps: @adlc/core, @adlc/tickets, @adlc/merge-forecast
├── bin/decompose.mjs
├── lib/{convert,structural,advisory,run}.mjs
├── test/
└── README.md
```

`@adlc/tickets` for per-ticket schema validation only — no `TicketService`, no
transaction. `@adlc/merge-forecast` for `parallelEligiblePairs`
(`reachability.mjs:69`) and `signalScopeOverlap` (`signals.mjs:21`). Sibling
`@adlc/*` imports are normal here (34 of `@adlc/gate-manifest`, 31 of
`@adlc/tickets` across the repo).

### 4.1 CLI

```
decompose <spec.md|->  | --file <spec.md> | --request "<prose>" | --from-conversion <dag.json>

  --out <path>                  write the DAG JSON here (default: stdout)
  --tickets <path>              store to read for advisories (default: canonical)
  --tier <cheap|mid|frontier>   accepted; only `frontier` permitted
  --max-attempts <n>            converter budget (default 3)
  --json · --prompt-only · --help
```

There is no `--write`, no `--allow-unsigned`, and no manifest interaction.

`--tier` must be **declared and accepted** — `scripts/test/flag-consistency.test.mjs:5,124`
requires every model-calling package to register `--prompt-only` and `--tier`, and
`@adlc/core`'s `parseArgs` runs `strict: true`, so an undeclared flag throws
`ERR_PARSE_ARGS_UNKNOWN_OPTION` instead of a useful message. Accept `frontier`;
reject `cheap`/`mid` naming the pin (`ADLC.md:98-102`).

On success the tool prints how to apply the DAG and the P2 gate commands to run
against it afterwards, so the gate stays discoverable.

### 4.2 Output

```json
{
  "version": 1,
  "sourceSpecHash": "<sha256 of the spec text>",
  "converterTier": "frontier",
  "attempts": 1,
  "tickets": [ { "id": "T1", "title": "…", "body": "…", "category": "…",
                 "scope": ["…"], "edges": [{"to": "T2"}] } ],
  "advisories": [ { "kind": "scope-overlap-active" | "rails-collision" | "id-collision",
                    "candidate": "T1", "against": "T-01…", "detail": "…" } ]
}
```

`rails` is absent by construction (D5). Ids are provisional (D6).

### 4.3 Exit codes

| Code | Meaning |
|---|---|
| 0 | DAG structurally valid; JSON emitted. Advisories may be present |
| 1 | Operational: unreadable spec, unreadable store, no provider without `--prompt-only`/`--from-conversion` |
| 2 | Gate fail: converter budget exhausted with structural findings surviving. No JSON emitted |

A malformed converter reply is **not** operational — it folds in as a structural
finding and consumes one attempt.

## 5. Validation

One loop, bounded by `--max-attempts` (default 3). Blocking rules:

1. Per-ticket schema via `@adlc/tickets`.
2. Duplicate provisional id within the batch (case-insensitively).
3. Every `edges[].to` resolves to a provisional id **in this batch**.
4. **No edge may name a ticket outside the batch.** Dependency pressure lands on
   the target — `topoSort()` does `indegree[e.to] += 1`, as does `topoWaves()` —
   so an edge into an existing ticket would change that ticket's readiness and
   wave while its shard stays byte-identical, invisible to `rails-guard-ci`'s
   add-vs-alter contract. Keeping the batch self-contained makes the emitted DAG
   applicable without touching anything that already exists.
5. Cycle detection via `topoSort()`.
6. **Scope conflict among parallel-eligible pairs, using `scopesOverlap`
   verbatim** — the exact predicate `signalScopeOverlap` wraps and
   `merge-forecast` hard-vetoes on, over the exact pair set
   `parallelEligiblePairs` yields. Do not invent a narrower test. Its false
   positives (`src/auth` vs `src/authz/**`) fall in the fail-safe direction, and
   agreeing with the downstream gate by construction is worth more than
   precision. Edge-connected pairs are excluded by `parallelEligiblePairs`, so a
   scaffold-then-build split remains expressible — it just has to declare its
   edge.

Advisory only, reported in `advisories[]`, never blocking:

- Candidate scope overlapping an **active** ticket's scope. v1 made this blocking
  and it rejected everything: `scopesOverlap` is a prefix test and this repo has
  three active repo-wide tickets, two of them release tickets declaring
  `packages/**`.
- Candidate scope intersecting an **active** ticket's `rails`. v3 made this
  blocking; the store holds 54 unique active rails including
  `packages/cli/lib/registry.mjs`, which this very program must edit, so blocking
  on it means `decompose` cannot decompose its own spec. It is already enforced
  downstream by the PreToolUse hook and by `rails-guard-ci`.
- Provisional id colliding with an existing ticket id (the store holds short
  legacy ids like `I1`, `a142`). Advisory because the applier mints real ids.

All blocking failures aggregate into one feedback block for a full re-emission.
Exhausting the budget is exit 2.

## 6. Trust-root tier

`decompose` is not a producer of a gated artifact and does **not** join
`PRODUCER_PREFIXES`.

It remains true that creating any package edits `package.json` and
`package-lock.json`, both exact `TRUST_ROOT_FILES` in
`packages/prosecute/lib/tier.mjs`, so **this PR is still trust-root tier and needs
a signed cross-model attestation bound to its reviewed revision.** What v4 removes
is the *recurring* burden: no `tier.mjs` edit (itself enforcement-tier), and no
attestation on every future change to the package.

## 7. Repo conformance

- `apps/docs/test/toolkit-packages.test.mjs:16` — `ALL_PACKAGES` must stay
  bijective with the `packages/` listing; `:25` requires
  `apps/docs/content/docs/toolkit/decompose.mdx`.
- `scripts/test/flag-consistency.test.mjs` — add `decompose` to its `PACKAGES`
  table (hand-maintained, no completeness guard, so omission is silent).
- `scripts/test/prompt-fencing.test.mjs:30` — add `lib/convert.mjs` to `GUARDED`.
- `packages/cli/lib/registry.mjs` — the `decompose` verb.

## 8. Acceptance criteria

Every criterion names the verification method that decides it.

- **AC1** — A spec compiles to a structurally valid DAG emitted as JSON. Verified by `packages/decompose/test/compile.test.mjs` — real `decompose --from-conversion <fixture> --json`, assert exit 0 and a parseable document matching the §4.2 shape.
- **AC2** — The emitted DAG is accepted by the downstream gate. Verified by `packages/decompose/test/handoff.test.mjs` — import `runForecast` from `@adlc/merge-forecast` in-process, run it on the emitted tickets, assert `gateFailures` is empty. This is the criterion v3 lacked and why its predicate contradiction shipped.
- **AC3** — Rule 6 uses `scopesOverlap` verbatim. Verified by `packages/decompose/test/structural.test.mjs` — assert `src/auth` vs `src/authz/**` is REJECTED (matching `signalScopeOverlap`), not certified.
- **AC4** — Edge-connected pairs may share scope. Verified by `packages/decompose/test/structural.test.mjs` — an overlapping pair joined by an edge compiles clean; the same pair unconnected exits 2.
- **AC5** — No emitted ticket carries `rails`. Verified by `packages/decompose/test/compile.test.mjs` — assert `rails` is absent on every emitted ticket even when the converter proposes one.
- **AC6** — A cyclic batch is rejected. Verified by `packages/decompose/test/structural.test.mjs` — cyclic fixture exits 2 and no JSON is emitted.
- **AC7** — An edge naming a ticket outside the batch is rejected. Verified by `packages/decompose/test/structural.test.mjs` — assert exit 2 and that the error names the out-of-batch target.
- **AC8** — A duplicate provisional id is rejected case-insensitively. Verified by `packages/decompose/test/structural.test.mjs` — a batch containing `T1` and `t1` exits 2.
- **AC9** — Scope overlap against an active ticket is advisory, not blocking. Verified by `packages/decompose/test/real-store.test.mjs` — run against a copy of this repo's real `.adlc/tickets/` store, which holds three active repo-wide-scope tickets, assert exit 0 with an `advisories[]` entry of kind `scope-overlap-active`.
- **AC10** — Rails collision against an active ticket is advisory. Verified by `packages/decompose/test/real-store.test.mjs` — emit a candidate scoped to `packages/cli/lib/registry.mjs`, which the real store rails, assert exit 0 and a `rails-collision` advisory.
- **AC11** — The converter retries at most `--max-attempts` then exits 2. Verified by `packages/decompose/test/pipeline.test.mjs` — stub converter always invalid, assert exactly 3 calls.
- **AC12** — A malformed converter reply consumes an attempt rather than exiting 1. Verified by `packages/decompose/test/pipeline.test.mjs` — stub returns unparseable text once then a valid batch, assert exit 0.
- **AC13** — The tool never writes to the ticket store or the manifest. Verified by `packages/decompose/test/compile.test.mjs` — hash the entire `.adlc/` tree including `manifest.d/` before and after a full compile, assert byte equality.
- **AC14** — `--from-conversion` completes with every provider environment variable unset. Verified by `packages/decompose/test/cli.test.mjs` — assert exit 0 and a valid emitted DAG with no provider configured.
- **AC15** — `--from-conversion` spawns no subprocess. Verified by `packages/decompose/test/cli.test.mjs` — stub `node:child_process` and assert zero invocations on that path. The claim is scoped to this path: a CLI-backed provider spawns on the converter path by design.
- **AC16** — `--prompt-only` prints the converter prompt and exits 0 with no provider. Verified by `packages/decompose/test/cli.test.mjs` — assert exit 0 and the prompt on stdout.
- **AC17** — `--out` writes the DAG to a file and stdout stays clean. Verified by `packages/decompose/test/cli.test.mjs` — assert the file parses and stdout carries only the human report.
- **AC18** — `--tier frontier` is accepted; `cheap` and `mid` are rejected with a clear message. Verified by `packages/decompose/test/cli.test.mjs` plus membership in `scripts/test/flag-consistency.test.mjs`'s table.
- **AC19** — Success output names how to apply the DAG and the P2 gate commands. Verified by `packages/decompose/test/cli.test.mjs` — assert stdout mentions `coldstart`, `parallax` and `merge-forecast`.
- **AC20** — An unreadable ticket store is an operational error, not a gate failure. Verified by `packages/decompose/test/cli.test.mjs` — point `--tickets` at a corrupt file, assert exit 1.
- **AC21** — The `decompose` verb is registered and dispatches. Verified by `packages/cli/test/registry.test.mjs` — assert `decompose` resolves to `@adlc/decompose`.
- **AC22** — Repo conformance guards pass. Verified by `apps/docs/test/toolkit-packages.test.mjs` (bijection + `decompose.mdx`) and `scripts/test/prompt-fencing.test.mjs` (`lib/convert.mjs` in `GUARDED`).
- **AC23** — No test reaches the network. Verified by `packages/decompose/test/pipeline.test.mjs` — stub `fetch` and `child_process` across the suite and assert zero calls on every non-converter path.

## 9. Non-goals

Writing the ticket store (§2 — its own ticket, with its own premortem). Gate
orchestration. Emitting rails. Antigravity brain discovery. Superseding tickets
from an earlier compile. Host integration-doc tables. The `sweep` generator and
pool-aware concurrency (`docs/intent/booster-adoption.md` §4, §7).

## 10. Known risk

`decompose` embeds spec text into a frontier-model prompt.
`@adlc/core`'s `fence()` derives its tag from the capped content length, so fenced
content can compute and forge its own closing marker. **Now reproduced and filed as
#1005** (P0) — it is not conditional on truncation, and `tail()`'s bias also means an
over-cap spec silently loses its opening sections. This is a prerequisite, not a
follow-up: any re-spec adds a nineteenth call site embedding repository-controlled
text into a frontier-model prompt.

## 11. Round-four findings, recorded for the re-spec

v4 was never approved. These were verified against the code and must be answered
by whatever replaces it:

- **The output is not applicable.** `planCreate` mints an id only when absent
  (`service.mjs:106`), so a provisional `T1` persists verbatim and hits
  `TICKET_EXISTS` against the 96 legacy `T<n>` shards in the store. Applying the
  DAG leaf-first satisfies the edge check but not the id namespace. Blocked on
  #1003.
- **Rule 6 is not the downstream predicate.** `merge-forecast` filters pairs to
  the same wave (`forecast.mjs:170-175`) before vetoing; `parallelEligiblePairs`
  does not. v4 is therefore stricter than the gate it claimed parity with —
  the same error v3 made in a different place.
- **`validateTicket` requires only `id` and `title`** (`schema.mjs:4-12`), not
  `body` or `scope`. Since `scopesOverlap` reads `a.scope ?? []`, a scope-less
  batch passes every blocking rule — a reward-hacking gradient for a bounded
  retry loop, and coldstart then hard-fails every ticket downstream.
- **`fence()` is forgeable always, not only on truncation.** The tag is
  `${label}-${capped.length}` (`core/lib/text.mjs:48`), a pure function of content
  the author controls. `tail()` also keeps the *last* `maxChars`, so an over-cap
  spec silently loses its opening sections and compiles clean. Reproduced and filed
  as **#1005**.
- **No glob∩glob primitive exists** in the declared dependencies; the only
  implementations are two divergent copies inside `@adlc/autopilot`. Any advisory
  comparing scope globs to rails globs needs one promoted into `@adlc/core` first.
- **Hollow criteria:** AC21 named a file that does not exist; AC13 could not fail;
  AC10 passed on literal string equality; AC2 asserted `gateFailures` empty on a
  forecast that had scored nothing.
