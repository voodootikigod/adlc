# Intent: what to pull from `antigravity-booster` into the ADLC

**Status:** evaluation, pre-spec. Nothing here is a commitment.
**Date:** 2026-09-11
**Subject:** `../antigravity-booster` @ v0.7.0 (89 tracked files, `lib/` 3,696 LOC, `test/` 5,823 LOC)
**Evaluated against:** ADLC @ v1.11.1 (32 packages, 30 `adlc` subcommands, 8 host plugins)

---

## 0. The framing correction

The obvious read is "booster has capabilities the ADLC lacks, port them." That read is
wrong, and getting it wrong would cause us to rebuild things we already own.

**Booster is a client of the ADLC, not a fork of it.** It shells out to nine `adlc`
tools — `model-router`, `merge-forecast`, `hollow-test`, `flail-detector`,
`consensus-fix`, `gate-manifest`, `rails-guard`, `review-calibration`, `--version` —
with a uniform call convention (`execFile`, `--json`, `maxBuffer: 10MB`, and every
single call recovering its result from `err.stdout` because our tools gate-fail with
exit 2 *and still emit valid JSON*).

So the question is not "what does booster have." It is "what did booster have to build
*around* our tools in order to actually run a fleet from a spec" — because that
negative space is our gap.

### Claims I checked and withdrew

Four things I expected to be gaps are not. Recording them so nobody re-opens them:

| Claimed gap | Reality | Evidence |
|---|---|---|
| No edge-parallax (D3 contract mode) | **Implemented.** `--edge T1 T2`, emits `agreements`/`divergences`/`score`/`threshold`/`gate`. | `packages/parallax/bin/parallax.mjs:158-210` |
| Fleet doesn't sandbox gate commands | **Implemented, and ahead of booster.** `bwrap --unshare-net` plus an egress proxy/bridge and env-scrub; repo config *cannot* disable it (N1); fails closed per §7.3. Booster just denies network — it has no egress plane. | `packages/fleet/lib/{sandbox,egress-proxy,egress-bridge,env-scrub,preflight}.mjs` |
| Ticket-id case collisions unguarded | **Guarded at the store.** `CASE_COLLISION` rejected on both backends, so the collision booster's `validatePlan` defends against cannot reach fleet's lowercasing worktree namer. | `packages/tickets/lib/stores/git-tree.mjs:96`, `stores/directory.mjs:41` |
| No worktree/merge/revert lifecycle | **Implemented, and ahead of booster.** `revertMerge` resets to `preMergeSha` only if HEAD is still exactly our merge commit, else `git revert -m 1` and **quarantines the branch** (`ok:false` → no further merge, no PR). Booster just `reset --hard`s. | `packages/fleet/lib/worktrees.mjs:205-234` |

The pattern: **where our tools and booster's overlap, ours are generally stronger.**
Booster is a thin, fast orchestration shell over a deeper toolkit. What it teaches us
is mostly about *composition and policy*, not about primitives.

---

## 1. The one real capability gap

### 1.1 `agb plan` — a decomposition compiler (P2)

**What it is.** Prose plan → validated, provenance-stamped ticket DAG, via a
two-stage loop with feedback (`lib/plan.mjs:309`, `compilePlan`):

- *Stage A — structural, free, deterministic, up to 3 attempts.* Schema, per-ticket
  validation, duplicate/unknown-edge/cycle checks, tier+pool routability, and a
  pairwise declared-scope overlap forecast. Every failure is fed **back into the
  converter prompt** as text rather than surfaced to the human.
- *Stage B — LLM gates, at most 2 passes.* `coldstart` and edge-`parallax` run
  concurrently, flattened into one blocking list; one feedback re-conversion; re-gate.
- *Advisory.* `premortem` runs once on the survivor and never vetoes.
- *On success only.* Project into the ticket store, then run `model-router` to
  **overwrite** the model's own tier guesses with deterministic assignments, then
  `merge-forecast` to annotate width.

**What we have.** P2 is fully specified in doctrine (`ADLC.md:228-248`, gate =
"coldstart per ticket + merge-forecast certifies width") and every *validator* exists
as a package. But **no CLI authors the DAG.** There is no `decompose` verb in
`packages/cli/lib/registry.mjs`. Ticket authoring is one-at-a-time and manual
(`adlc ticket create --input`), and `autopilot` is strictly 1 issue → 1 ticket → 1
fleet run with no fan-out. `ADLC.md:518` describes P2's mechanism as "Epic/ticket
breakdown with 'full context per ticket' constraint" — a *practice*, not a tool.

**This is the missing link between `adlc spec` (P1) and `adlc fleet` (P4).** We built
both ends and left the middle to human typing. It is also, not coincidentally, the
phase whose absence makes `fleet` hard to reach: fleet consumes a ticket DAG that
nothing in the toolkit produces.

**All coding agents?** Yes — core package. Booster's version takes *either* an
Antigravity brain id or a local markdown path; only brain discovery
(`~/.gemini/antigravity/brain/`) is host-specific and belongs in `plugins/adlc-gemini`.

**Doctrine conflict — one real tension, stated honestly.** D0 says *"control flow is
code; judgment is models,"* and that the orchestrator must **never consult a model
about sequencing** (`ADLC.md:740-748`). `agb plan` has a model emit the DAG — i.e. a
model proposes sequencing. A careful reader would call that a D0 violation.

I think the resolution is a distinction D0 currently fails to draw, and should:

> D0 forbids a model deciding sequencing **at dispatch time**, inside the loop, where
> the decision is unreproducible and rots with the context. It does not forbid a model
> **proposing** a decomposition that is then frozen, deterministically validated, and
> executed by a scheduler that never asks again. The first is a boss agent; the second
> is a compiler. Compilers may use heuristics; schedulers may not.

If we adopt the compiler, `ADLC.md` D0 needs that paragraph, or the tool reads as
doctrine-violating to anyone who checks.

**Simplification available to us.** Booster needs `plan.json` *and* a projection into
`.adlc/tickets/` because it must serve two consumers, and it pays for that with
`planToAdlcTickets` vs `planTicketToRailTicket`, a both-stores failure mode, and
`discardProjection` to stop the rebase breaking. **We have no such split** — our
compiler should emit tickets into the canonical store directly and the entire
bridge layer disappears.

**Benefit.** Closes the only phase we gate in theory and not in practice; makes fleet
reachable from a spec; and converts "did we decompose this well?" from taste into
`coldstart` + edge-`parallax` + `merge-forecast` exit codes.

---

## 2. Policy and composition lessons (no new primitives)

### 2.1 The gate failure-policy table — **adopt as doctrine**

Booster makes a *differentiated, deliberate* decision per tool about what happens when
the gate itself is unavailable:

| Policy | Tools | Booster's stated reason |
|---|---|---|
| Fail **closed** | `rails-guard` | operational error ≡ violation |
| Fail **open** | `flail-detector` | "an unverifiable signal must not itself cut a build's normal retry short" |
| Degrade to advisory | the other seven | "a broken audit trail must never fail an otherwise-successful build" |

We have exit-code conventions (`CONVENTIONS.md:39-42`, 0/1/2) — that is the
*producer* side. We have **nothing written down for the consumer side**: what an
orchestrator does when the gate can't run. The extractable principle:

> A gate that protects an **invariant** fails closed. A gate that optimizes a
> **heuristic** fails open. A gate that records **evidence** degrades to advisory.
> Every gate integration must name which of the three it is.

This is a genuine addition to the theory — the Goodhart Annex covers agents *gaming*
gates; nothing covers gates being *absent*. An absent gate that fails open silently is
a false green, and we have no rule forbidding it.

### 2.2 Code decides the verdict, not the model — **adopt**

`lib/prosecute.mjs:109-119`:

```js
const modelBlocking  = findings.some(f => f.severity === 'critical' || f.severity === 'high');
const hollowBlocking = !!(hollowTest?.ok && hollowTest.survived > 0);
const verdict = (modelBlocking || hollowBlocking) ? 'block' : parsed.verdict === 'block' ? 'block' : 'ship';
```

A mutation survivor is an **automatic block the prosecutor's own verdict cannot
overrule**, and it is injected into the prompt as a finding the model is told to
investigate anyway. This is Principle 2 ("evidence or it didn't happen") applied to
the *critic* — we state it in doctrine (`ADLC.md:66-67`, "this applies symmetrically
to critics") but I could not find the place where our P5 composition enforces it
mechanically the way these four lines do.

### 2.3 The errored-lens rule — **adopt, and it is urgent**

`lib/review.mjs:113-121`: any lens that **errored** resets the dry counter, and
convergence requires `dry >= dryPasses && lastErrors.length === 0`. Stated reason:
*"empty findings from a rate-limited/errored model would otherwise fake convergence
and wave untested code through."*

`ADLC.md:337-339` defines loop-until-dry as "2 consecutive passes produce zero
verified findings" — with **no clause about the reviewer having actually run**. A
rate-limited provider returns zero findings, which counts as a dry pass, which ships.

This is not hypothetical for us. Our own operating notes record agy quota exhaustion
mid-review as a recurring event, with codex as the fallback. Under the current
definition, a quota-exhausted review round is indistinguishable from a clean one.

---

## 3. Two findings the comparison surfaced

### 3.1 `fence()`'s tag is predictable on truncated input — **verify, then fix**

`packages/core/lib/text.mjs:47-50`:

```js
const capped = tail(raw, maxChars);
const tag = `${label}-${capped.length}`;
return `<<UNTRUSTED:${marker}:${tag}>>\n${capped}\n<<END:${label}:${tag}>>`;
```

The comment argues the tag is "unguessable from content the model doesn't control."
I do not think that holds:

- **When the input is truncated** — the common case for a large diff — `capped.length`
  is exactly `maxChars`. Both `label` and `maxChars` are literals at the call site. The
  closing marker is therefore fully determined and attacker-knowable: an injected
  `<<END:diff:diff-120000>>` closes the fence early, and everything after it is read
  as instructions.
- **When it isn't truncated**, the tag is a fixed point on the attacker's own payload
  length — solvable by padding.

Booster uses `randomUUID()` per call (`lib/charters.mjs:11`), which is unguessable by
construction. That is strictly stronger and costs nothing.

Note `packages/context-handoff/lib/brief.mjs:61-63` takes a *different and valid*
approach — static delimiters, but it **strips** any occurrence from the input first.
Either defense works; a content-derived tag with no stripping is the one that doesn't.

**This needs a written test before it's called a bug** — construct a diff containing
the predicted close marker and confirm the model-facing string ends the fence early.
If it reproduces, this is a P5-relevant injection hole in a shared core primitive used
by every LLM-backed tool we ship.

### 3.2 Large diffs: we degrade, booster blocks — **doctrine decision needed**

Our operating notes record that `adversarial-review` goes summary-only past a
byte cap, and that findings get dropped for lack of grounding — a known false-green
mode we work around by scoping diffs smaller.

Booster refuses. `MAX_DIFF_CHARS = 120_000` → `verdict: 'block'`, critical/scope,
**explicitly not truncated**, with the reason spelled out: a builder could pad an
early-sorting file with boilerplate and push a real change past the prosecutor's
window, then collect a `ship` on what the prosecutor *did* see.

That is a Goodhart move our annex does not list, and booster's policy is the one
consistent with our own rule that *"every gate ships with its anti-vacuity defense, or
it isn't a gate."* A reviewer that silently reviews less than the diff is vacuous.

**Proposed annex row:** *Pad the diff to push changes past the reviewer's window* →
*Diff over the grounding cap is a hard block, never a truncation.*

---

## 4. Worth taking, lower stakes

| Item | Where | All agents? | Doctrine | Why |
|---|---|---|---|---|
| **`sweep`** — one operation × N targets, disjoint scope per target, cheap tier, no edges | core (ticket generator over fleet) | yes | compliant — single writer per partition, partition = one file | We run this shape constantly across 32 packages (codemods, doc mirrors, dep bumps) and hand-author it every time. ~60 LOC in booster. |
| **Plugin contract handshake** — integer `adlcContract`, exact equality, **abort before any repo mutation**; missing field degrades | core + all 8 plugins | yes | extends Principle 1 to the tool layer | We ship 32 packages and 8 plugins in lockstep and have *no* skew check. This session was blocked for an hour by an installed plugin older than main still arming a hook `main` had disconnected. That is precisely the failure this prevents. |
| **`reserved` vs `inFlight` dual counter** | `packages/fleet` | yes | compliant | Non-obvious: N tickets dispatched in one tick all observe `inFlight === 0` and stampede one pool, because slots aren't acquired until several awaits later. Cheap fix, real bug. |
| **`assertStillHeld()`** — re-verify the lock *inside* the merge critical section; absent ≡ **lost, never free** | `packages/fleet` | yes | compliant | Start-of-run checks go stale during a long run. Port the assertion; **do not** port booster's lock primitive (see §6). |
| **Per-tool run state**: atomic write-temp-rename `run.json` + append-only `events.jsonl`, both `0600` in `0700`, `chmod` applied unconditionally | `packages/fleet` | yes | neutral | Readers never see a torn file; the event stream is what any dashboard (incl. `adlc-herdr`) should consume instead of polling state. |

---

## 5. Host-specific — belongs in a plugin, not core

- **Brain artifact discovery** (`~/.gemini/antigravity/brain/`, `agb brains`) → `plugins/adlc-gemini`.
- **The sidecar's Antigravity plugin registration** (mints a token, writes a throwaway plugin dir, `agy plugin install`, uninstalls on exit) → `plugins/adlc-gemini`. The *web dashboard itself* is a separate question; `adlc-herdr` already occupies the observability niche in-terminal.
- **Tier→model tables and pool membership** (`TIER_CANDIDATES`, `PROSECUTORS`, `DEFAULT_CAPS`) → these are provider facts. We already have the right home: `@adlc/quartermaster` does per-ticket seat routing and is operator-local by design. Booster's tables are a *capacity* layer; quartermaster is a *selection* layer. They compose.

---

## 6. Do not port

| Item | Why |
|---|---|
| **`prosecution.dryPasses` default of 1** | `ADLC.md:337` requires **2** consecutive dry passes. Booster's default is a quota-driven weakening of our own gate. |
| **Rebase without re-prosecution** | Booster explicitly trades this away to halve prosecution cost, leaning on the post-merge gate. We already know better — our own practice is *re-attest after the final rebase, not before*, because the revision digest doesn't survive a rebase. Adopting booster's tradeoff would regress a lesson we already paid for. |
| **`lib/lock.mjs`'s stale-reclaim primitive** | Booster documents its own unfixable defect (their issue #54): the reclaiming `rename` briefly vacates the canonical path, voiding `mkdir` exclusion, so two live runs can hold one lock. Take `assertStillHeld`, not the primitive. |
| **`plan.concurrencyCap`** | Written by `applyMergeForecast` and **read by nothing** — their `docs/guidelines.md:56` admits it. If we port width annotation, wire it to dispatch in the same change or don't ship it. |
| **The JSONL→legacy flail-detector transcoder** | Pure impedance-matching against our own CLI's input format. If anything, it's a signal `flail-detector` should accept JSONL natively. |

---

## 7. Open doctrinal question: quota-pool-aware concurrency

**What booster does.** Per-pool semaphores with independent caps
(`{gemini-flash: 8, gemini-pro: 4, claude: 4, gpt-oss: 2}`), FIFO waiters, and direct
slot handoff so a synchronous `acquire()` can't steal a released slot in the microtask
gap. Width is bounded by *provider capacity*, not just by the DAG.

**Where we are.** Partial. Every fleet adapter declares `export const pool = 'default'`
and nothing reads it; `--concurrency N` is a flat integer. `autopilot` has real quota
gating (5-hour and 7-day windows, "unknown quota = no run") but it is Claude-specific
and gates *whether to start*, not *how wide to go*.

**The tension.** `ADLC.md:431` rejects "token quotas as cost control" — *"Caps the
wrong variable… Govern cost-per-merged-verified-change; let the gates, not the wallet,
end loops."* Read literally, pool caps look like the rejected thing.

I think they are not, and the theory should say so. §4 rejects **budget** as a
*stopping condition* — ending a prosecution loop because money ran out. Pool capacity
is a **throughput** constraint, the same *kind* of constraint as D2's integrator
backpressure: it bounds how many things run at once, never whether a gate completes.
D2's width formula (`build ÷ merge`) silently assumes builders are never the
bottleneck. With pooled quota they are.

**Proposed D2 amendment:**

> `width = min(forecast-certified width, build÷merge backpressure, provider pool
> capacity)`. Pool capacity bounds concurrency; it never ends a loop. A gate that
> cannot complete for quota reasons is an errored gate (§2.3), not a passed one.

That last sentence is the important one, and it ties back to §2.3: quota exhaustion
must surface as *error*, never as *clean*.

---

## 8. Recommended sequence

Ordered by (value ÷ cost), and by what unblocks what.

1. **§3.1 fence predictability** — write the reproduction test first. If it
   reproduces, it is a security fix in a core primitive every LLM-backed tool uses,
   and it is a one-line change. Smallest possible diff, highest stakes.
2. **§2.3 errored-lens rule** + **§7's closing sentence** — quota exhaustion must not
   read as convergence. Doctrine edit plus an enforcement point. We are actively
   exposed to this one.
3. **§2.1 failure-policy table** — pure doctrine, no code. Write it down, then audit
   the nine integration points against it.
4. **§4 plugin contract handshake** — directly prevents a failure that cost real time
   today, and is a precondition for trusting anything else we ship in lockstep.
5. **§1 the decomposition compiler** — the big one, and the one that needs a spec of
   its own. Depends on the D0 amendment landing first, or it ships as
   doctrine-violating.
6. **§4 `sweep`** — small, obviously useful, and a natural first consumer of the
   compiler's ticket-generation path.

Items 1–4 are small and independent. Item 5 is a program, and should go through P1
properly rather than being back-doored in as "a port."
