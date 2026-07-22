# Tokenomics Review — ADLC vs. Token-Efficient Engineering Practice

> Analysis date: 2026-07-22. Benchmarked against Google Cloud's "Guide to AI
> tokenomics: eleven principles for token-efficient software engineering" and a
> three-way audit of this repo (doctrine docs, the Claude Code plugin surface,
> and the 29-package implementation). Token figures are estimates (chars/4).

## Verdict

Tokenomics is **not missing from the ADLC doctrine** — ADLC.md is ahead of the
Google article at the theory level (Principle 9 barbell, §6 economics, Appendix
E frontier-free doctrine, Appendix F prompt-cache discipline, the explicit
rejection of token quotas and caveman-compression). Security is likewise the
*most* developed dimension of the repo, not the least (threat model doc,
ADR-0005/0007, the trust-root cross-model gate, a dedicated prosecution lens).

What is missing is the **implementation layer of the tokenomics doctrine**:

1. The stated unit of account — **cost per merged, verified change** (§6) — is
   defined but never computed. Nothing in the codebase parses API `usage`
   fields, records spend, or reports the §6 diagnostics.
2. Several doctrine promises are unimplemented: C11 says the gate-manifest
   records "token spend per phase" (ADLC.md:661) — it records none. D1 says
   model-router emits `{model, mode, budget}` (ADLC.md:816) — it emits no
   budget. The ticket schema carries a `budget` field
   (`packages/ticket-sync/lib/schema.mjs:52`) that no code reads.
3. **No prompt caching anywhere**, despite fan-out being the core mechanism and
   Appendix F naming prompt-cache discipline as the token-economics primitive.

The doctrine says "let the gates, not the wallet, end loops" — but the gates
cannot currently see the wallet at all.

---

## 1. Scorecard against the eleven principles

| # | Google principle | ADLC status | Evidence |
|---|---|---|---|
| 1 | Start with a balanced model, scale on failure | **Ahead.** Tier = f(escape cost); ladder cheap→mid with regeneration-not-rescue; frontier-free doctrine | ADLC.md Principle 7, §D1; `packages/model-router` (deterministic, no LLM); docs/models-by-phase.md |
| 2 | Use skills from the beginning | **Doctrine ahead, artifact behind.** P7 mines skills; but the plugin's own SKILL.md is a 2,730-token wall loaded whole on every trigger | `plugins/adlc-claude-code/skills/adlc/SKILL.md` (10.9 KB) |
| 3 | Automate with scripts and CLI tools | **Exemplary.** 29 zero-dep packages; "control flow is code, judgment is models" (D0); orchestration never consults an LLM for sequencing | ADR-0010; `packages/fleet`, `merge-forecast`, `model-router` all deterministic |
| 4 | Delegate output-heavy tasks, reconcile results only | **Mostly aligned.** "Conclusions, never transcripts" (F3 response); fleet never re-ingests worker transcripts | ADLC.md:37; `packages/fleet/lib/scheduler.mjs:60,139` — but see evidence-echo gap (§3.3) |
| 5 | Divide and conquer (plan big-context, execute clean) | **Exemplary.** P1/P2 frontier spec → fresh cheap builder per atomic ticket; coldstart gate enforces ticket self-sufficiency | ADLC.md P2/P4; `packages/coldstart` |
| 6 | Shift verification left | **Strong.** spec-lint/coldstart at pennies before build; rails + hollow-test before P4; heavy P5 spend is deliberate (barbell), not late discovery | ADLC.md:245-248, C1, C3, C4 |
| 7 | Undo when adrift; don't pile corrective prompts | **Exemplary.** Two-strike regeneration; flail-detector; "the most expensive fix is a long conversation with a confused agent" | ADLC.md:298-303; `packages/flail-detector` |
| 8 | Be specific with context | **Strong.** Atomic tickets executable from their own text; declared file scopes; contracts pinned before fan-out | ADLC.md P2, §D2 |
| 9 | Iterate on rules, not on re-prompting | **Exemplary — this is P7.** lesson-foundry demotes findings to lints "~free forever"; skill-rot invalidates stale caches; rejection-mining | ADLC.md C9, C10, C13 |
| 10 | Avoid uncontrolled loops; strict stop conditions | **Doctrine yes, enforcement leaky.** P5 caps rounds; gate-fuzzing has a budget — but the budget undercounts, parallax has no hard cap, and ticket budgets are decorative (§3.4) | see §3.4 |
| 11 | New session per topic | **Core doctrine (E4/F3)** — but the fresh-context tax is unmanaged: the same diff is re-read up to 10× per prosecute run with zero caching (§3.2) | skills audit, §3.2 |

Net: ADLC already encodes 8 of 11 principles at or above the article's level.
The gaps cluster in principles 10 and 11 — loop budgets that don't bind, and
fresh contexts whose shared prefix is re-paid instead of cached — plus the
overarching measurement gap the article doesn't even ask for.

---

## 2. What already works (do not regress)

- **Deterministic substitution for LLM judgment** everywhere routing, scheduling,
  conflict forecasting, and gate evaluation happen. This is the single biggest
  token saving in the design and it is structural, not incidental.
- **`--prompt-only` mode** (`packages/core/lib/llm.mjs`) — emit the prompt for
  the host agent instead of spending API tokens. Widely used (parallax,
  premortem, consensus-fix, gate-fuzzing).
- **Cheap-model probes as gates** — coldstart deliberately uses the *weak* model
  as the instrument ("the weaker the probe, the more honest the gate").
- **Structured JSON output with small caps** — review-calibration judges at
  64 max tokens; spec-lint/coldstart at 1024.
- **Bounded prompt inputs in the mining tools** — rejection-mining and
  lesson-foundry cap clusters at 5 samples × 300 chars.
- **Fleet's untrusted-log fencing** — worker output is fenced as a retry hint,
  never accumulated into a growing parent context.

---

## 3. The gaps

### 3.1 The measurement gap (highest priority)

§6 defines the unit of account; §6's diagnostics ("spend concentrated in P4 →
re-exploring", "P5 trending up → P7 broken") are a self-diagnosis framework —
and none of it is observable, because:

- `packages/core/lib/llm.mjs` never reads `usage` / `prompt_tokens` off any
  provider response. Spend is invisible at the only chokepoint that sees every
  call.
- `packages/gate-manifest` records models and verdicts but not tokens, despite
  C11 specifying "token spend per phase."
- No tool computes cost-per-merged-verified-change, so the §4 argument against
  token quotas ("govern cost-per-merge instead") has no mechanism backing it.

**Fix:** parse `usage` in `complete()`/`fan()`, thread `{model, inputTokens,
outputTokens, cachedTokens, phase}` into the gate-manifest entry, and add an
`adlc spend` report that emits the barbell histogram and the four §6
diagnostics. This is small (one chokepoint), closes the doctrine's largest
open promise, and makes every other optimization measurable instead of vibes.

### 3.2 The fresh-context tax (largest recurring spend)

Fresh context per lens is correct doctrine (E4). But a full
`/adlc:adlc-prosecute` run on a 400-line diff ≈ **86K tokens, ~70% of which is
the same diff read 10 times** (5 lenses × 2 rounds), uncapped in diff size and
up to 5 rounds. Compounding it:

- The 5 lens agent files are ~85% identical (~600 identical chars paid inside
  every lens context every round).
- The trust-root/ADR-0007 explanation is triplicated across SKILL.md,
  the prosecute command, and prosecutor.md (~1.2 KB in every prosecutor spawn).
- Lens findings quote evidence verbatim into the orchestrator, then verifiers
  are told to re-read the same lines from disk — the same text transits context
  2–3× per finding.

**Fix:** (a) prompt caching (§3.3) makes the re-reads nearly free without
touching the fresh-context doctrine — same bytes, cached prefix; (b) inject the
shared lens preamble once from the command and keep only the per-lens
differentiator in each agent file; (c) move the trust-root explanation to one
reference doc loaded only when that tier is hit.

### 3.3 No prompt caching (cheapest fix, biggest multiplier)

`core/lib/llm.mjs:74-83` sends no `cache_control`. `fan()` and
`fanProviders()` are pure resamples of one identical prompt — the ideal cache
hit — yet each of consensus-fix's ×3, gate-fuzzing's up-to-×60, and parallax's
×3 calls re-pays full input price. Marking the system block + stable prompt
prefix cacheable is a one-file change with an up-to-90% input discount on
every fan-out in the toolkit. Appendix F already names this as doctrine
("prompt-cache discipline: stable system prefixes"); the code just doesn't do
it.

### 3.4 Budgets that don't bind

- `gate-fuzzing` is the only tool with a token budget, and it undercounts:
  `lib/loop.mjs:84` calls the estimator without the prompt text, so the 200K
  budget meters **output only** — real spend can run several-× past "budget."
  The estimator already accepts the prompt; pass it.
- `ticket.budget` (schema.mjs:52) is never read. The flail-detector's declared
  trigger "token spend past the ticket budget" (ADLC.md:587) cannot fire.
- parallax's fold-and-re-fan loop exits on convergence threshold only — the one
  core loop with no hard round/token ceiling ("two rounds typical" is an
  expectation, not a cap). P5, by contrast, caps at max N rounds.

**Fix:** one shared budget helper in core (fed by real `usage` once §3.1
lands), enforced at the fan()/loop level; add `--max-rounds` to parallax.

### 3.5 Recompute where a cache exists

`coldstart` re-audits every ticket sequentially on every run
(`lib/gate.mjs:64-70`) even though `ticketHash` is already computed for
manifest binding. Key gate results by content hash and skip unchanged tickets —
repeat runs drop from O(all tickets) to O(changed). Same pattern applies to
re-prosecuting unchanged hot files in model-ratchet.

### 3.6 Oversized payloads in two tools

- `consensus-fix` embeds **full file contents both directions** — every source
  file inlined into all N=3 prompts (`lib/prompt.mjs:23-25`), and each
  candidate returns *full new file content* (`:42-48`). Output tokens dominate
  here. Send the failing region + referenced ranges; request unified diffs.
- `parallax --route` inlines full context files into all N=3 fan prompts with
  no truncation (`lib/prompts.mjs:91-100`). Reuse the `tail()` capping helper
  that consensus-fix already has.
- `fleet` strike-2 charters re-embed uncapped prior build/gate logs
  (`lib/charters.mjs:37-48`); add a fence length cap.

### 3.7 Plugin surface hygiene (user-side spend)

Installing the plugin costs **~1,000 always-loaded tokens per session**, ~42%
of it the descriptions of 7 prosecutor agents — 6 of which are only ever
invoked programmatically by the prosecute command and never model-selected by
name. Slim those descriptions to one line each. The router SKILL.md should
keep its routing table and defer per-phase flag detail to `references/`
(progressive disclosure), cutting the per-trigger load from ~2.7K to under 1K.

---

## 4. On security being "a missing piece"

It isn't, on the evidence. Security has: a dedicated executable threat model
(docs/ticket-store-threat-model.md), SECURITY.md with explicit in-scope
classes, a dedicated P5 lens (prosecutor-security), and the strongest gate in
the toolkit — trust-root-tier changes *fail closed* without a distinct-family
cross-model approve (ADR-0007; ~17 deny-path bypasses in this repo's history
were found only by the second family).

The one genuinely open edge is **security of the agent process itself**:
prompt injection via untrusted ticket bodies, spec text, PR threads
(rejection-mining ingests them), and worker logs. Fleet already fences worker
output as untrusted; nothing systematically fences ticket/spec/mined content
before it enters prosecutor or builder prompts, and no lens is chartered to
hunt injection *of the lifecycle* rather than injection *in the product*. That
is a worthwhile future hardening item — and it is one paragraph, not a missing
pillar.

---

## 5. Recommended sequence

| Order | Change | Effort | Impact |
|---|---|---|---|
| 1 | Parse `usage` in core/llm.mjs; record per-phase tokens in gate-manifest; `adlc spend` report with §6 diagnostics | S–M | Makes the unit of account real; everything else becomes measurable |
| 2 | `cache_control` on system + stable prefix in core/llm.mjs | S | Up to ~90% input discount on every fan-out (consensus-fix ×3, gate-fuzzing ×60, parallax ×3, P5 lenses) |
| 3 | Fix gate-fuzzing budget to count prompt tokens; enforce `ticket.budget`; cap parallax rounds | S | Doctrine's loop budgets actually bind |
| 4 | Dedupe lens boilerplate + de-triplicate trust-root text + slim agent descriptions + SKILL.md progressive disclosure | S | ~40–50% off prosecute overhead beyond the diff; ~½ off always-loaded footprint |
| 5 | Content-hash gate cache (coldstart, ratchet re-runs) | M | Repeat runs O(changed) not O(all) |
| 6 | consensus-fix → diff-based patches; cap parallax route + fleet charter payloads | M | Kills the worst per-call payloads |
| 7 | Lifecycle prompt-injection fencing + an injection-of-the-harness charter note in SECURITY.md | M | Closes the real security edge |

Items 1–3 are the "missing piece": they convert tokenomics from doctrine into
instrumentation. Items 4–6 are efficiency inside the existing design. Nothing
here touches the barbell — P1 and P5 stay heavy on purpose; the goal is to
stop paying for the same bytes twice, not to spend less on quality.
