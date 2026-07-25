# ADR: Risk-tiered multi-model adversarial review

**Status:** **Accepted — recommended practice generally; GATED (required) for the
trust-root tier as of 2026-07-11 (T39).** See [Update 2026-07-11](#update-2026-07-11--gated-for-the-trust-root-tier-t39).
(Superseded `Proposed` on 2026-06-27.) Adopt reviewer **diversity** as a risk-gated P5 practice: for
high-blast-radius changes, require an independent verdict from **≥2 distinct providers**
and treat a single provider's clean `approve` as **advisory, not a gate-pass**. Ship the
`--providers` multi-provider mode in the `adversarial-review` skill as the mechanism. Do
**not** yet build mechanical enforcement into `coldstart`/the router (defer, exactly as
[ADR-0005](./0005-adversarial-design-review-gate.md) deferred its P2-entry enforcement).
The full design is the [multi-model review spec](../specs/multimodel-review.md).

**Date:** 2026-06-27
**Deciders:** Chris Williams (with three independent models — Claude, Codex/GPT, and
Gemini — acting as the counter-models for the case study below).

> Related: [ADR-0005](./0005-adversarial-design-review-gate.md) adds an adversarial
> gate for the *design* (P1→P2); the P5 prosecution surface ([ADR-0001](./0001-codex-native-adlc-integration.md),
> the `prosecutor` subagent in [ADR-0003](./0003-adlc-claude-code-plugin.md)) is the
> adversarial gate for *built code*. This ADR is orthogonal to both: it governs **how
> many, and how diverse, the reviewing models must be** for either gate to be trusted.

---

## Context

The `adversarial-review` skill is already model-agnostic and, inside Claude Code or
Cursor, **prefers a single provider different from the builder** — a model reviewing its
own output is a weak critic. That is correct but insufficient. Its `--passes <n>` flag
samples **one** model N times: it raises recall on that model's blind spots but adds **no
provider diversity**. Nothing in the toolkit says *how many distinct providers* a review
needs, or that a single clean `approve` is not proof.

The cost of that gap is concrete and was observed directly (see Validation): different
providers have **different blind spots**, and a security-critical deny path can earn a
zero-finding approve from one strong model while a second strong model finds a
high-severity bypass in a single pass.

## Decision

### 1. Risk gate (when ≥2 distinct providers are required)

Reuse the `model-router` (D1) risk tiers. A change is **high-blast-radius** — and so
requires an independent verdict from **≥2 distinct-family providers** — when it touches
any of: authentication / authorization / **trust boundary**; a security control or
**deny path** (rail guards, validators, sandboxes); secrets handling; data-loss /
destructive / irreversible operations; schema or migration changes; CI/CD or
supply-chain config. For those changes a single provider's `approve` is **advisory**,
never a gate-pass. Everything else defaults to **single cross-model** review (today's
behavior); trivial / non-security changes may skip review entirely.

### 2. Mechanism — `adversarial-review --providers`

A new multi-provider mode, distinct from `--passes`:

- `--providers <a,b[,c]>` runs the same review prompt against each named provider
  independently (API key or local CLI; e.g. `gpt`, `gemini`, `claude`).
- **Merge + dedup** all findings into one report, keyed by `(file, line range,
  category)`; a finding raised by multiple providers is tagged with its corroborators
  (corroboration is signal — it raises confidence).
- **Quorum-aware verdict:** `needs-attention` if **any** provider returns a material
  finding at/above `--fail-on`; `approve` only if **all** selected providers approve.
  `--quorum <n>` may relax this deliberately.
- **Distinct-family auto-selection** when `--providers` is omitted but the risk tier (or
  the operator) requests multi-model: pick ≥2 providers from *different* families, never
  the builder's family twice.
- **No silent downgrade:** if fewer than the requested providers are reachable, run what
  is available and emit a loud notice that multi-provider was under-satisfied — a
  degraded run must not masquerade as a full one.

### 3. Evidence-driven escalation via `review-calibration`

Diversity should be applied where it demonstrably helps, not as blanket ceremony. Tie
the requirement to `review-calibration` (P5, "who reviews the reviewer"), which measures
a reviewer's injected-mutant recall on *this* repo: a **measured low single-model recall**
is the principled trigger for adding the second provider. This keeps the practice
honest — escalate on evidence of missed defects, not on a fixed model count.

### 4. Placement in the phase model

This is a **P5 (Prosecute)** practice for built code and applies equally to the
[ADR-0005](./0005-adversarial-design-review-gate.md) P1 design-review gate. Like
ADR-0005, adoption is by **operator invocation** (run the skill with `--providers` on
qualifying changes); mechanical enforcement in the gate path is **deferred** until the
manual practice proves insufficient.

## Consequences

**Positive.** Security-critical changes get genuinely independent scrutiny; corroborated
findings carry visible confidence; a single model's approve can no longer be mistaken for
proof; the escalation is evidence-driven via `review-calibration`.

**Negative / cost.** Each added provider is real tokens and wall-clock, and findings must
be triaged across reports. This is acceptable **only** because it is risk-gated — applied
to high-blast-radius code, not everywhere.

**Diminishing returns (explicit caveat).** Value comes from provider **diversity, not
count**: a third model from a family already represented adds little, and beyond ~2–3
distinct providers the marginal yield shows sharply diminishing returns. The Cursor case study's long
single-provider loop also shows that most late-round findings were narrow edges already
covered by the unbypassable CI backstop — multi-model is highest-value on the load-bearing
security logic, not on every diff. Do not prescribe a fixed N; prescribe *diversity on the
changes that warrant it*.

## Alternatives considered

- **Status quo (one different-from-builder provider).** Rejected for high-blast-radius
  code: the Validation shows one strong model's approve is not proof.
- **Always run N≥3 models on every change.** Rejected: cost without commensurate value on
  low-risk diffs; conflates count with diversity.
- **More `--passes` on a single model.** Rejected: raises recall on one model's blind
  spots but never crosses a provider boundary, so it cannot catch a cross-provider blind
  spot — exactly the failure mode observed.
- **Mechanical P5-entry enforcement now.** Deferred, mirroring ADR-0005: prove the manual
  practice first.

## Validation (the Cursor build, 2026-06-27)

On the ADLC Cursor rails-guard integration (PR #40 — a security control whose entire job
is to deny edits):

1. A same-model (**Claude**) P5 prosecution passed after catching one classifier bug.
2. A cross-model **Codex/GPT** `adversarial-review` loop ran **18 rounds** to a
   **zero-finding `approve`**, hardening many real in-session bypasses along the way.
3. A third model, **Gemini 3.1 Pro**, then found a **high-severity** multi-root
   relative-path rail bypass GPT had missed across all 18 rounds — and, after the fix,
   correctly flagged that the fix was *incomplete* (a path-mangling on different-depth
   roots) plus a `JSON.parse` fail-open. It converged to its own clean `approve` two
   rounds later.

A single model's clean approve was demonstrably **not proof**. The high-severity finding
surfaced **only** when an independent provider with different priors was added.
**Diversity, not count, was the load-bearing variable.**

## Adoption / next steps

1. ~~Accept this ADR (P6 human gate)~~ — **Accepted 2026-06-27.**
2. ~~Build the `--providers` mode in the `voodootikigod/adversarial-review` repo per the
   spec's AC4–AC7 (follow-on ticket).~~ — **done.** `--providers` (multi-provider
   selection, quorum-aware verdict, dedup, under-satisfaction accounting AC4–AC7) is
   implemented in `src/llm.js` / `src/review.js`. Remaining follow-ons tracked in
   [ADR-0008](./0008-adversarial-review-coverage-map.md): `--input` artifact mode and a
   loop-convergence summary.
3. ~~Document the risk-tier policy in `docs/toolkit.md`~~ — **done** (Typical flow, step 6).
4. ~~Revisit mechanical enforcement once trust-boundary features are built often enough
   that operator invocation proves insufficient~~ — **done for the trust-root tier**
   (2026-07-11, T39; see the Update below). The remaining tiers stay operator-invoked.

## Update (2026-07-11) — gated for the trust-root tier (T39)

The trigger in step 4 fired. Across the opencode T30–T35 arc and PR #104, every real
correctness/security bug was caught by a cross-model (codex/GPT) pass **only after**
same-model ADLC P5 returned a clean SHIP. Root cause: a same-model prosecutor validates
the author's own tests, which encode the author's blind spot. For the highest-risk
surface that is too load-bearing to leave optional, so cross-model review is now a
**required, mechanically-enforced P5 gate** — no longer merely recommended — for a
narrow **trust-root tier**.

**What is trust-root tier.** A change is trust-root tier iff its diff (`git diff
--name-only <base>...HEAD`) touches any of:

- an **exact trust-root file**: `scripts/rails-guard-ci.mjs`, `docs/ci/rails-guard.yml`,
  `scripts/test/rails-guard-workflow-hashes.json`, `.adlc/tickets.json`;
- an **enforcement package** (emits an exit-2 gate): `packages/rails-guard/`,
  `packages/prosecute/`, `packages/gate-manifest/`, `packages/build-gate/`;
- a **gated-artifact producer** (writes `.adlc/tickets.json`): `packages/ticket-prune/`,
  `packages/ticket-sync/`;
- a **declared rails deny-path** of any ticket in `.adlc/tickets.json`.

The classifier is `packages/prosecute/lib/tier.mjs` — pure, offline, deterministic. It is
the binary trust-root decision only, distinct from `@adlc/core`'s model frontier/direct/
ladder `risk-tier.mjs`.

**The attestation.** A cross-model verdict is recorded through the existing
`@adlc/gate-manifest` chained ledger as a `cross-model-review` entry carrying
`{ provider, authorProvider, verdict, revision }`. `packages/prosecute/lib/run.mjs` then
requires — in addition to the two-consecutive-dry-pass / three-distinct-lens condition —
a `cross-model-review` **`approve`** whose `provider` is **distinct** from the author and
whose `revision` equals the reviewed revision. Missing → `exit 2` naming exactly what is
required. Recording is `adlc prosecute record-cross-model --ticket <id> --provider <p>
--author-provider <a> --verdict approve [--input <passes.json>] [--revision <r>]`, which
resolves the revision the same way the gate does so the record binds to the gate's revision.

**Author identity is anchored to the prosecution run, not the attestation.** The distinctness
check does not compare the entry's own two self-reported fields against each other — an
attestation defines *both* sides, so a same-provider author could otherwise record
`provider:"claude", authorProvider:"openai"` and pass. Instead the prosecution declares the
author via `--author-provider` (or `ADLC_AUTHOR_PROVIDER`), and the gate requires the
reviewer's `provider` to differ from *that* prosecution-declared author and the record to
have been made for that author context (`entry.data.authorProvider === author`). A tiered
run with no author-provider **fails closed** (exit 1) — distinctness cannot be proven without
knowing the author. Also fail-closed: the tier is computed from the **working tree** vs base
(so an uncommitted trust-root edit still tiers), and an unresolvable base ref refuses the run
(CI must fetch/provide the base) rather than run ungated.

**Honest limitation.** Like rails-guard, this gate **cannot cryptographically prove a
model actually ran.** The residual is now narrower: the author identity comes from the
**prosecution invocation** (a CI-set env var / explicit flag), not from a field the author
buries in an attestation — so the self-reported-both-sides forgery is closed. A determined
author who also lies about `--author-provider` at invocation can still evade, but in CI that
value is set by the pipeline, not the author. What the gate buys is an **auditable,
revision-bound, append-only, distinct-provider, author-anchored record**: a stale attestation
against an old diff does not satisfy a new revision (the revision binding), and a same-provider
"review" is refused at record time and rejected at read time (the distinct-provider rule). We
deliberately did **not** sign the provider assertion with a CI-held key — that was rejected in
#104/T36 as exposing keys to CI for marginal gain; the revision binding, not a signature, is
what stops the stale-attestation bypass. The gate raises the bar and makes the omission visible
in an auditable ledger; it is defense in depth behind the unbypassable rails-guard CI diff gate,
not a cryptographic proof of review.

**Honest limitation — the gate shares a runner with candidate code (#326).** The tier gate
is *folded into the required `test` job* because a separate job cannot be made a required
check on this repo's plan (it would enforce nothing). That job necessarily installs and runs
candidate code, so any candidate-controlled code that executes in the runner *before* the gate
step can shim `node`/`npm` (e.g. onto `$GITHUB_PATH`, which GitHub persists to later steps) and
make the gate — and every other check in the job — pass without an attestation. Cross-model
prosecution of #326 surfaced a ladder of these: an untiered root/nested `package.json`
`postinstall`; a workspace `bin` named `node` linked into `node_modules/.bin` and hit during a
rebuild; a candidate `.npmrc`. **The tractable layers are closed** — the root install manifests
(`package.json`/`package-lock.json`) are a tier surface (a dependency/version/script change
tiers → requires an attestation); the gate's job installs with `--ignore-scripts` and rebuilds
only a lockfile-pinned trusted-native allowlist (a drift guard keeps the allowlist complete),
so no *first-party* lifecycle script runs; the attestation read fails closed on a manifest whose
hash chain does not `verify()`. **The residual is the general limit, not a unique weakness:** a
PR that executes arbitrary code in the runner defeats `npm test`, `rails-guard`, and
`mutation-gate` too, so the cross-model gate is no weaker than any other required check, and
every such attack requires *visibly-malicious build config in the PR diff* — which is exactly
what the branch-protection **CODEOWNERS / human-review backstop** exists to catch (the same
backstop the trust-root code itself relies on). Fully closing this needs a truly isolated
required job, which the repo's plan does not allow; until then it is accepted, documented, and
deliberately not chased into an infinite regress of runner-escape variants.
