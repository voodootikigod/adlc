# Recommended Models by Phase

> **Snapshot date: July 2026.** Model lineups, prices, and benchmark standings decay
> fast — this document is a cache, and caches need invalidation
> ([ADLC Principle 10](../ADLC.md)). Re-verify against provider pricing pages before
> committing budget, run [`adlc model-ratchet`](./tools/model-ratchet.md) after any
> model swap, and let your own [`gate-manifest`](./tools/gate-manifest.md) first-pass
> ledger override every static prior on this page once you have ≥3 samples per tier.

The [ADLC theory series](https://voodootikigod.com/series/adlc) argues that using the
most expensive model everywhere is the wrong default: **model tier is a function of
the cost of detecting an error, not of task prestige** (Principle 7). The toolkit
makes that mechanical — [`adlc model-router`](./tools/model-router.md) reads rail
density and DAG float and emits an abstract tier (`cheap` / `mid` / `frontier`) per
ticket. What neither the theory nor the router resolves is the binding from abstract
tier to a concrete model. This document is that binding: recommended models per tier,
per phase, for the major providers and for open-weight/local deployment.

## The three tiers

| Tier | Definition | Belongs on |
| --- | --- | --- |
| `cheap` | Errors are caught instantly and deterministically by dense rails; regeneration costs pennies | Codemods, mechanical refactors under test, formatting, dedup with green suites, triage classification, ladder starts |
| `mid` | Errors are caught by rails + prosecution; paying for single-pass perfection is waste | The build phase proper, rail authoring, prosecution passes, distillation mining |
| `frontier` | Errors are *expensive to detect* — a subtly wrong artifact sails through every gate | Specs, decomposition, interface contracts, final verdicts |

Two doctrine points shape everything below:

1. **"Frontier" means the best model you are allowed to run — not the most expensive
   model that exists.** The [Frontier-Free Doctrine](../ADLC.md#appendix-e--the-frontier-free-doctrine)
   sets an Opus-class ceiling as the *design center*: the lifecycle must hit its
   accuracy targets with Opus/Sonnet/Haiku-class models alone. Fable-class and
   GPT-5.5-Pro-class models are optional headroom, never a requirement. You never
   need a model smarter than the gate it must pass.
2. **Measure the stack, not the model.** A 3-pass mid-tier prosecution stack with
   0.85 planted-bug recall *is* the more capable reviewer than a 1-pass frontier
   model at 0.6 — [`adlc review-calibration`](./tools/review-calibration.md) makes
   that exchange rate a number. Tier labels are cold-start estimates only.

## Phase → tier map

| Phase | Tier | Why |
| --- | --- | --- |
| **P0 Triage** | cheap | Classification with low escaped-error cost — a mis-triaged ticket is caught by the lifecycle it's routed into. Route-by-risk logic itself is deterministic code. |
| **P1 Interrogate** | **frontier** | The spec is the least-verified artifact in the system; a subtly wrong requirement poisons everything downstream. *"Do not economize in this phase"* (ADLC.md). [`parallax`](./tools/parallax.md) divergence readings can run on mid — the signal is disagreement between readings, not the brilliance of any one. |
| **P2 Decompose** | **frontier** for contracts and boundaries; **cheap** as the gate probe | Interface contracts are frontier work for the same reason as specs. The [`coldstart`](./tools/coldstart.md) gate *deliberately* uses a cheap model as the probe: if a cheap model can enumerate what's missing from a ticket, the ticket is underspecified for the mid model that will build it. |
| **P3 Rail** | mid | Tests, stubs, and contract skeletons authored from spec alone in fresh context. [`hollow-test`](./tools/hollow-test.md) catches weak rails deterministically, so frontier is unnecessary; go frontier only for contract-heavy rails on low-coverage surfaces. |
| **P4 Build** | router-decided: **ladder cheap→mid** with float, **direct best-tier** on the critical path | This is [`model-router`](./tools/model-router.md)'s home turf. Float > 0 and rail density ≥ 0.5 → start cheap and ladder up on gate failure (escalation is regeneration, never rescue — F8). Float = 0 → skip the ladder, use the tier with the best first-pass rate from your manifest. Rail density below the floor → frontier, and treat it as a P3 finding. |
| **P5 Prosecute** | **mid, stacked** — plus a **second provider family** on high blast radius | Search replaces insight (E2): N fresh-context mid passes with loop-until-dry beat one frontier pass, and the cost model favors fanning out cheap readers. For trust-boundary, deny-path, auth, secrets, data-loss, schema, or CI/CD changes, run ≥2 *distinct-family* providers ([ADR-0007](./adr/0007-multimodel-adversarial-review.md)) — different models have different blind spots, and cross-family review has caught deny-path bypasses that same-family prosecution missed. |
| **P6 Integrate** | none (human gate) | [`behavior-diff`](./tools/behavior-diff.md) and [`gate-manifest`](./tools/gate-manifest.md) are deterministic. The human is the frontier tier here. |
| **P7 Distill** | mid for mining; **rent one frontier pass to mint structure** | Banking replaces presence (E4): lesson mining and rejection mining run fine on mid. Occasionally rent the frontier model to crystallize judgment into artifacts — a skill, a contract template, an interrogation template — then spend mid inside that structure indefinitely. |

The barbell (Principle 9) falls out of this table: heavy spend at P1–P2 and P5, light
in the middle where rails make building cheap.

## Tier → model, by provider

Prices are USD per million tokens, input/output, standard API rates (batch and cache
discounts excluded). Benchmark numbers are directional only — **SWE-bench Verified
and SWE-bench Pro are different benchmarks with non-comparable scores.**

### Anthropic

| Tier | Model | Price (in/out) | Context | Notes |
| --- | --- | --- | --- | --- |
| cheap | Claude Haiku 4.5 (`claude-haiku-4-5`) | $1 / $5 | 200K | The reference cheap tier; 200K context reinforces the E3 rule that cheap-tier tickets must be small |
| mid | Claude Sonnet 5 (`claude-sonnet-5`) | $3 / $15 (intro $2 / $10 through 2026-08-31) | 1M | Near-Opus on coding/agentic work; the default build and prosecution model |
| frontier | Claude Opus 4.8 (`claude-opus-4-8`) | $5 / $25 | 1M | The doctrine's design-center ceiling; specs, contracts, verdicts |
| above ceiling | Claude Fable 5 (`claude-fable-5`) | $10 / $50 | 1M | Optional headroom for the hardest long-horizon P1/P2 work; the lifecycle must not *require* it |

### OpenAI

| Tier | Model | Price (in/out) | Context | Notes |
| --- | --- | --- | --- | --- |
| cheap | GPT-5.4 nano | $0.20 / $1.25 | ~1M | GPT-5.4 mini ($0.75 / $4.50) is the stronger cheap pick when the ladder start keeps failing |
| mid | GPT-5.4 | $2.50 / $15 | ~1M | Previous flagship, still served; solid mid-tier |
| frontier | GPT-5.5 | $5 / $30 | ~1M | Powers Codex; 58.6% SWE-bench Pro. Strong cross-family P5 counterpart to an Anthropic-primary stack |
| above ceiling | GPT-5.5 Pro | $30 / $180 | ~1M | Max-reasoning tier; same caveat as Fable — headroom, not requirement |

The GPT-5.6 preview family (Sol/Terra/Luna) is preview-only as of this snapshot — do
not put previews in the routing table; pin models per task (F8).

### Google

| Tier | Model | Price (in/out) | Context | Notes |
| --- | --- | --- | --- | --- |
| cheap | Gemini 3.1 Flash-Lite | $0.25 / $1.50 | ~1M | Gemini 2.5 Flash-Lite ($0.10 / $0.40) is the absolute price floor for triage-class work |
| mid | Gemini 3.5 Flash | $1.50 / $9 | ~1M | Strong quality-for-price mid; Gemini 3 Flash ($0.50 / $3) is the budget mid |
| frontier | Gemini 3.1 Pro | $4 / $18 (>200K ctx rate) | 2M | ~80.6% SWE-bench Verified; the 2M window suits interrogation over large existing codebases |

### xAI

| Tier | Model | Price (in/out) | Context | Notes |
| --- | --- | --- | --- | --- |
| cheap | Grok 4.1 Fast | $0.20 / $0.50 | 2M | Huge context at cheap-tier price |
| mid / frontier | Grok 4.3 | $1.25 / $2.50 | 1M | The price/performance outlier of this snapshot: ~73.6% SWE-bench, notably strong on long-chain agentic loops. Frontier-priced work at mid-tier cost — a good P5 cross-family pick |

### Mistral

| Tier | Model | Price (in/out) | Context | Notes |
| --- | --- | --- | --- | --- |
| cheap | Mistral Small 3.2 | $0.08 / $0.20 | — | Cheapest general model in this snapshot; Codestral ($0.30 / $0.90) is code-tuned but its 32K context limits it to small, well-railed tickets |
| mid | Mistral Medium 3.5 | ~$1 / $3 (verify) | 256K | 77.6% SWE-bench Verified (vendor); also open-weight — see below. Mistral's Large/Medium price tiering was inconsistent across sources at snapshot time — verify before routing |

### Open-weight, hosted APIs

These matter for two reasons: they are the cheapest capable tiers available, and they
are *distinct model families* — exactly what the P5 multi-provider quorum needs.

| Tier | Model | Price (in/out) | Context | Notes |
| --- | --- | --- | --- | --- |
| cheap | DeepSeek V4 Flash | $0.14 / $0.28 | 1M | Extreme cache discount (~98%); arguably the best cheap-tier value of the snapshot |
| cheap/mid | MiniMax M3 | ~$0.30 / $1.20 (launch promo) | 1M | ~59% SWE-bench Pro (vendor); verify steady-state pricing |
| mid | Kimi K2.6 (Moonshot) | $0.55 / $2.65 | ~256K | ~58.6% SWE-bench Pro; the strongest open agentic/tool-use pick — good P4 builder and P5 reviewer |
| mid | GLM-5.2 (Z.ai) | $1.40 / $4.40 (cheaper via OpenRouter) | 1M | 62.1% SWE-bench Pro — beat GPT-5.5 on that benchmark; MIT license |
| frontier-adjacent | DeepSeek V4 Pro | $1.74 / $3.48 (promo $0.44 / $0.87) | 1M | ~80% SWE-bench Verified (semi-verified) — the highest open-weight coding score of the snapshot |

### Local / self-hosted

Local models are a legitimate **cheap tier** — and on strong hardware a legitimate
**mid tier** — for rail-dense work where the gates do the verification. The practical
ceiling for a single machine at this snapshot is ~71–72% SWE-bench Verified
(Qwen3-Coder-Next). Do **not** assign local models frontier duties (P1/P2 specs and
contracts): those phases exist precisely because their errors escape gates, and
escaped-error cost is where the capability gap bites.

| Hardware | Recommended | Tier it can serve |
| --- | --- | --- |
| 16GB RAM / GPU | gpt-oss-20b (Apache 2.0); Qwen2.5-Coder 7B/14B | cheap: formatting, codemods, triage, coldstart probe |
| 24–32GB GPU (RTX 4090/5090) | Qwen3-Coder-30B-A3B (Apache 2.0, 262K ctx); Devstral Small 2 (24B, Apache 2.0) | cheap, and ladder starts on rail-dense P4 tickets |
| 64–128GB unified (Mac Studio) or 96GB GPU | **Qwen3-Coder-Next (80B/A3B, Apache 2.0)** — ~70.6% Verified, the sweet spot; Devstral 2 (123B) / gpt-oss-120b at Q4 | mid: P4 builds, P3 rails, P5 fan-out passes |
| Multi-GPU cluster | GLM-5.2 (~372GB INT4), Kimi K2.x, DeepSeek V4 | usually better rented via API unless data-residency forces self-hosting |

Notes for local routing:

- The coldstart gate's "hand the ticket to a fresh cheap model" probe is a perfect
  local job — free, private, and the *weaker* the probe the more honest the gate.
- Skip Llama 4 for coding work (~24% Verified at snapshot); the Llama line is no
  longer competitive on this axis.
- A local cheap tier changes the ladder math: when the ladder start costs ~$0,
  `--floor` can be more permissive for float-rich tickets, because failed cheap
  attempts cost only wall-clock that float absorbs.

## Suggested P5 cross-family quorums

Anchor on your primary family, then add one *different* family per ADR-0007. Pairs
that work at this snapshot:

| Primary stack | Cross-family second | Budget alternative |
| --- | --- | --- |
| Claude Sonnet 5 / Opus 4.8 | GPT-5.5 | GLM-5.2 or Kimi K2.6 |
| GPT-5.5 | Claude Opus 4.8 | Gemini 3.1 Pro |
| Open-weight (Qwen/DeepSeek) | Claude Sonnet 5 or Gemini 3.5 Flash | Grok 4.3 |

A single provider's clean approve on high-blast-radius paths is advisory, not a
gate-pass — this repo's own history includes ~17 deny-path bypasses found only by the
second family.

## Keeping this honest

- **Your ledger beats this page.** `model-router` prefers empirical per-repo priors
  from `.adlc/manifest.jsonl` (model × ticket-category × first-pass outcome) over any
  static table. This page is the cold-start estimate.
- **Re-verify on model churn.** New model ships → [`adlc model-ratchet`](./tools/model-ratchet.md)
  schedules re-prosecution; [`adlc review-calibration`](./tools/review-calibration.md)
  re-measures reviewer recall before you trust a swap.
- **Benchmark hygiene.** Vendor-reported numbers, promo pricing, and preview models
  were all flagged inline; treat every number here as directional and every price as
  perishable.
