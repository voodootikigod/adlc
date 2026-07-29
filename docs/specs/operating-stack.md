# Spec — The ADLC Operating Stack (quartermaster layer)

**Phase:** P1 working spec. Deliverable of this ticket is the **design** (this spec);
the build items in §9 are follow-on tickets, each independently executable. Companion
strategy doc (personal economics, kept out of repo): `~/ideal-agentic-setup.md`.

Status: **proposed, revision 3** — revised after two cross-model adversarial review
rounds (codex). Round 1: registry-as-attack-surface, tier-only routing gap, gateway
identity assertion, missing quorum, non-computable monitors, undefined fallback.
Round 2: symbolic selection still downgradeable, fallback transport collision,
gateway quorum collapse, unvalidated job labels, usage-schema incompatibility,
undefined telemetry producers. Proposed plugin/package name: `adlc-quartermaster`
(alternatives in §11).

---

## 1. Goal

Define the ADLC's **operating stack**: the layer that decides *which judgment source
serves which lifecycle phase, through which channel, at what cost class, with what
fallback* — and makes those decisions deterministic, recorded, and periodically
re-evaluated against measured data instead of vibes.

Today this knowledge lives in heads and chat transcripts. The router assigns abstract
tiers (`cheap`/`mid`/`frontier`), but nothing binds a tier to a concrete **channel**
(provider/model + transport + rate window + cost class). This spec makes that binding
a declarative, versioned, **operator-local** artifact — nothing in a candidate tree
participates in channel selection — and closes the loop with spend telemetry.

This is **process engineering**: the layer above both the harness columns
(`plugins/adlc-*`) and the multiplexer layer (`plugins/adlc-herdr`). Most teams
optimize inside a harness; this layer optimizes the *portfolio* of harnesses,
providers, and subscriptions as a single system.

## 2. Why this is a new layer, not a 9th harness column

Following the argument in `docs/herdr-integration-plan.md` §1:

- Harness plugins live *inside* one harness. herdr lives *above* harnesses
  (observation). The quartermaster lives above **both**: it decides which harness
  is even in the driver's seat for a given call, and on whose subscription.
- It is cross-harness by construction: it emits configuration the fleet's
  WorkerAdapter layer (`packages/fleet/lib/adapters/`) and the cross-model gate
  consume; it never touches harness internals.
- Like the herdr plugin, it is **not an enforcement tier** for code changes — rails,
  gates, and P5 prosecution stay where they are. It *is* authoritative for one thing
  only: channel selection and its recording.

## 3. The stack (layers, fixed roles)

| Layer | Component | Role | Never does |
| --- | --- | --- | --- |
| Cockpit | herdr + `plugins/adlc-herdr` | Human-supervised parallel sessions; observe `.adlc/` state | Decide control flow |
| Orchestrator | `@adlc/fleet` | Deterministic ticket execution: worktrees, sandbox, gates, merges | Let a model decide ordering/retries/merges (D0) |
| Quartermaster | **this spec** | Bind lifecycle jobs → channels; record transport; watch triggers | Author or review code; read any config from the candidate tree |
| Model plane | harness adapters (claude-code, opencode, codex, …) | Judgment | Hold control flow |
| Rails | deterministic gates | Free enforcement | Consume tokens |

## 4. The channel registry — operator-local, entirely

**Design rule (review round 2, finding 1): the candidate tree participates in
channel selection not at all.** Revision 2's committed "symbolic half" is deleted —
any repo-side selection, however symbolic, is a downgrade surface (repoint
`frontier` at a cheap target, swap trust-root members for weak-but-distinct
families). The registry is now a single operator-local file.

### 4a. Channel names are a closed set, fixed by this spec

`frontier`, `frontier-metered`, `mid`, `cheap`, plus the reviewer groups in §6.
Code references channels only by these names. Adding a channel is a spec revision,
not a config edit — so a registry cannot invent routes the routing contract (§5)
never sanctioned.

### 4b. `quartermaster.json` — operator-local registry

Lives outside every candidate tree, resolved the way `adversarial-review` resolves
its config: absolute path in the operator's home/XDG dir; a configured path that is
relative or inside the repo under review **disables** the registry (loud notice)
rather than loading it. Fleet workers never read it; only the dispatching fleet
process does.

```json
{
  "version": 3,
  "channels": {
    "frontier":         { "adapter": "claude-code", "model": "default",          "transport": "subscription:anthropic-max",  "provider": "anthropic" },
    "frontier-metered": { "adapter": "claude-code", "model": "default",          "transport": "api:anthropic-batch",         "provider": "anthropic" },
    "mid":              { "adapter": "opencode",    "model": "zai/glm-5.2",      "transport": "gateway:opencode-go",         "provider": "zai",      "rateWindow": "5h" },
    "cheap":            { "adapter": "opencode",    "model": "deepseek/v4-flash","transport": "gateway:opencode-go",         "provider": "deepseek", "rateWindow": "5h" }
  },
  "reviewerGroups": {
    "cross-model-routine":    { "quorum": 1, "members": [
      { "adapter": "opencode", "model": "qwen/qwen3.7-coder", "transport": "gateway:opencode-go", "provider": "alibaba" } ] },
    "cross-model-trust-root": { "quorum": 2, "members": [
      { "adapter": "opencode", "model": "moonshot/kimi-k3",   "transport": "gateway:opencode-go", "provider": "moonshot" },
      { "adapter": "codex",    "model": "default",            "transport": "subscription:chatgpt-plus", "provider": "openai", "directAuth": true } ] }
  }
}
```

Validation rules (load-time, before any dispatch):

1. **Closed names:** every §4a channel name present, no others; unknown keys are
   errors, not extensions.
2. **Adapter allowlist:** `adapter` must name a module in
   `packages/fleet/lib/adapters/`; no `command`/argv-shaped fields exist in the
   schema at all — execution shape stays inside the adapter modules.
3. **Fallback transports must differ** (review round 2, finding 2): `frontier` and
   `frontier-metered` sharing a `transport` value is a validation error — the only
   fallback edge exists to change transport, so identical transports make it
   unsatisfiable by construction.
4. **Transport taxonomy is closed:** `subscription:*` (harness-native auth, direct
   to provider), `api:*` (direct metered API), `gateway:*` (mediated). The prefix
   is load-bearing for §6's quorum rules.
5. **Fail closed:** missing registry, disabled path, schema violation, or a channel
   the routing contract requests that has no entry → gate failure before dispatch.
   No defaults.

The repo carries only `docs/integrations/quartermaster-registry.md` — schema
reference and an annotated example. Dispatch never reads it.

## 5. Lifecycle-job routing contract (validated, not caller-trusted)

**Design rules (round 1 finding 2; round 2 finding 4).** `assign.mjs` keeps
emitting `{tier, mode, budget}` unchanged. Channel selection is a distinct total
function — and it does not trust the caller's job label:

```
routeJob({ job, assignment, ticket }) -> { channel } | { reviewerGroup } | { deterministic: true }
```

- `job` is a closed enum (unknown → throw).
- `ticket` carries the authoritative scheduling facts (`float`, `category`).
  For `build.*` jobs, `routeJob` **derives** the build class itself:
  `category ∈ {contract, spec, architecture}` → spec-class; else `float === 0` →
  critical-path; else ladder-start. A caller-supplied `build.*` label that
  disagrees with the derivation **throws** (mislabeled dispatch is a bug, not a
  route).
- Non-build jobs are structural (the call site *is* the lifecycle stage — the
  prosecution driver calls with `prosecute.*`, the gate runner with `gate.*`), so
  label validation is derivation for `build.*` and enum-membership elsewhere.

| `job` | Routing | Notes |
| --- | --- | --- |
| `build.spec-class` (derived) | `frontier` | category ∈ {contract, spec, architecture} |
| `build.critical-path` (derived) | `frontier` | `float === 0`; overrides assignment tier for channel purposes; assignment tier still governs budget |
| `build.ladder-start` (derived) | assignment tier's channel (`cheap`/`mid`) | Escalation per F8 is a fresh attempt |
| `prosecute.lens` | `mid` | First-pass fan-out |
| `prosecute.verdict` | `frontier` | The **only** overflow-eligible job (§7) |
| `review.cross-model.routine` | group `cross-model-routine` | |
| `review.cross-model.trust-root` | group `cross-model-trust-root` | Quorum ≥2 (§6) |
| `maintain.ratchet` / `maintain.mining` | `mid` | Scheduled, latency-irrelevant |
| `maintain.calibration` | `frontier-metered` | Batch pricing |
| `gate.deterministic.*` | `{deterministic: true}` | Asserting a channel here is an error |

## 6. Cross-model attestations: quorum with gateway discounting

**Design rules (round 1 findings 3–4; round 2 finding 3).**

**Quorum.** Trust-root review is a reviewer group: `quorum` members must return
independent verdicts; provider families must be pairwise distinct after
`cross-model.mjs#normalizeProvider`; none may equal the author's family. Fewer
reachable members than `quorum` **fails closed** with a loud under-satisfaction
notice. Verdicts combine per `docs/specs/multimodel-review.md`: any material
finding → `needs-attention`; `approve` requires all quorum members to approve.

**Gateway discounting (the round-2 fix).** An unauthenticated gateway can alias or
misroute model IDs, so declared families behind one gateway cannot prove diversity.
Rule: **all members sharing a `gateway:*` transport count as one family for quorum
purposes**, regardless of declared provider. Consequently a quorum-2 group must
include at least one member on a `subscription:*` or `api:*` transport — a channel
whose auth handshake is with the provider itself (`directAuth: true` marks this;
validation requires it on non-gateway members). The reference registry satisfies
this: Kimi-K3-via-gateway (one seat) + codex-direct-to-OpenAI (one seat).

**Bound identity.** When automation records an attestation:

- `provider` comes from the operator-local registry, never from a CLI flag or any
  committed file.
- The signed entry records `provider`, `transport`, resolved `model`, and the
  SHA-256 digest of the registry file used at resolution — so a later verifier can
  detect an attestation minted under a since-revised registry.
- The recorder rejects a record whose `(model, transport)` is absent from the
  registry or whose provider disagrees with the registry's binding.
- **Honest limit, stated plainly:** none of this proves which model a gateway
  actually served (ADR-0007's conceded class). What the design guarantees is
  (a) forging a provider label requires compromising the operator-local registry
  or the CI key — not a PR branch; and (b) gateway uncertainty can never satisfy
  more than one quorum seat.

## 7. Fallback: a state machine, not a graph

**Design rule (round 1 finding 6).** Exactly one fallback edge exists:
`frontier → frontier-metered`, traversable only by `prosecute.verdict`, and — per
§4b rule 3 — guaranteed by validation to change transport.

- **Eligible failure classes** (pre-execution only): adapter binary absent, auth
  failure, or a rate-limit/cap response received **before any output**. Mid-run
  timeouts, partial output, nonzero exits after output, and gate failures are
  **not** fallback-eligible — they flow to the fleet's existing two-strike policy.
- **Attempt isolation:** a fallback attempt is a fresh attempt (F8 semantics) —
  no reuse of the failed attempt's partial state. (`prosecute.verdict` is
  read-only over the candidate diff, so this is trivially satisfied; stated for
  future edges.)
- **Telemetry attribution:** each attempt records its own usage entry labeled with
  its channel; a traversal records both attempts.
- **One hop, then stop:** an unreachable fallback is a gate failure.
- All other jobs: channel unreachable → immediate gate failure.

## 8. Telemetry and trigger monitors

**Design rules (round 1 finding 5; round 2 findings 5–6): adopt the existing
schema, and name every producer.**

### 8a. Usage records: the existing gate-manifest schema, unchanged

`packages/gate-manifest/lib/spend.mjs` already defines the spend contract:
`usage: { inputTokens, outputTokens, cachedTokens, provider, model, tier }`,
aggregated by `aggregateSpend()`. This spec **adopts those field names verbatim**
and adds nothing to them except that recorders SHOULD populate `provider`/`model`
from the registry resolution. Monitors read manifest entries through
`aggregateSpend()` — no parallel token schema exists. (Rev 2's `tokensIn/tokensOut`
envelope is deleted; it would have aggregated to zero.)

### 8b. Event records: every consumer has a named producer

Non-usage telemetry lives in `.adlc/telemetry/events.jsonl` (append-only; each
record `{v: 1, ts, kind, ...}`; unknown `kind`s are skipped and counted). All
times UTC; windows are rolling and inclusive of the current day.

| `kind` | Producer (who writes it) | Fields |
| --- | --- | --- |
| `cap-hit` | dispatch wrapper, from exit-code classification (probe per harness, §11 Q3; unprobed harnesses never emit it) | `channel` |
| `rate-limit` | dispatch wrapper, from adapter 429/limit classification | `channel`, `model` |
| `merge` | fleet, on each successful integration-branch merge (same code path that marks `completed:true`) | `runId`, `ticket` |
| `fallback` | dispatch wrapper, on a §7 traversal | `from`, `to`, `job` |
| `gate-failure.channel` | fleet, when a dispatch fails closed on channel resolution | `channel`, `job` |

Escalation is not a separate event: attestation entries (§6) carry a `seatRole`
field — `"member"` or `"escalation"` — written by the recorder; the idle-reviewer
monitor counts `seatRole: "escalation"` entries in the manifest itself.

### 8c. Monitors

Report-only (exit 0 quiet / exit 2 findings, house convention). GitHub issues use
dedup key `quartermaster:<trigger>:<ISO-week>`; an existing open issue for a key is
updated, not duplicated. Monitors never mutate the registry.

| Trigger | Rule (deterministic) | Issue |
| --- | --- | --- |
| Frontier cap-hits | `cap-hit` on >2 distinct UTC days in trailing 30 days | "Re-upgrade subscription" |
| Rate-window collision | ≥1 `rate-limit` on a UTC day that also has ≥1 `merge` | "Add direct API for model X" |
| Metered overflow | `aggregateSpend` over `api:*`-transport entries, priced via versioned `pricing.json` (`{version, model, inPerMTok, outPerMTok, currency:"USD"}`), > `overflowUsdThreshold` (default 30, operator-local) in trailing 30 days; pricing version quoted in the finding | "Revisit tiering" |
| Idle frontier reviewer | 0 `seatRole:"escalation"` attestations in trailing 60 days **and** ≥5 trust-root reviews in the window (opportunity denominator) | "Cancel frontier reviewer line" |
| Channel unreachable | any `gate-failure.channel` | Incident |

Missing or unparsable telemetry for a trigger → that trigger reports **unknown**
(distinct from quiet), exits 2, and names the missing file/schema — degraded data
cannot silently pass.

## 9. Build plan — what must be built / enhanced / improved

Ordered by dependency, each a candidate ticket:

1. **Per-phase usage recording** (issue #272 — the *write* side; `spend.mjs`'s
   read side already exists): P4/P5 recorders populate `usage` per §8a, including
   registry-resolved `provider`/`model`. *Enhance: `prosecute`, `runner`,
   `gate-manifest` record call sites.*
2. **Operator-local registry + `routeJob`** (core): §4b loader (path rule,
   validation rules 1–5), §5 routing with build-class derivation and mislabel
   rejection, consumed by fleet dispatch. *Build: new package (or extend
   `model-router`).*
3. **OpenCode Go wiring**: verify `opencode run -m <model>` headless against Go
   models on both machines; point the fleet's blocking cross-model prosecution at
   the opencode adapter via the registry; keep fail-closed. *Enhance: operator
   config + docs; `fleet/adapters/opencode.mjs` unchanged.*
4. **Attestation binding + quorum** (§6): `transport`/`model`/registry-digest/
   `seatRole` fields on `recordCrossModelReview`, recorder mismatch rejection,
   reviewer-group validation with gateway discounting, under-satisfaction
   fail-closed. *Enhance: `prosecute/cross-model.mjs`, `gate-manifest` record
   shape; consumes `multimodel-review.md`'s `--providers`.*
5. **Telemetry producers + monitors** (§8b–c): event writers in the dispatch
   wrapper and fleet merge path, `adlc quartermaster check`. *Build: new package;
   producer-to-monitor round-trip tested.*
6. **Maintenance orchestration contract**: dev-one systemd timer set (nightly scan /
   weekly mining + calibration / monthly ratchet) documented as a versioned
   contract in `docs/integrations/`, with fail-modes (no `ADLC_MANIFEST_KEY`,
   report-only, gh-issue dedup per §8c). *Document + dotfiles; no repo code.*
7. **review-calibration over the new reviewers**: planted-bug recall for each
   reviewer-group member, so quorum membership is evidence-driven. *Enhance:
   `review-calibration` provider config.*
8. **multimodel `--providers` dependency**: quorum engine specified in
   `docs/specs/multimodel-review.md` (separate repo build); §6 defines the consumer
   contract, including gateway discounting. *Track as external dependency.*
9. **Deferred, trigger-gated**: pi adapter headless verification
   (`docs/specs/pi-native-flush.md`); local inference on upgraded hardware; herdr
   phase-3 fleet tabs (observability only).

## 10. Non-goals

- Not an enforcement tier for code changes; gates and rails are untouched.
- No model ever selects a channel at runtime (D0 applies to supply, too).
- Nothing in a candidate tree selects, narrows, or hints channel choice — there is
  deliberately **no** repo-side knob (rev 2's committed half is deleted, not
  restricted).
- No dedicated inference hardware in the reference stack; re-entry is trigger-gated
  (§8), not aspirational.
- Not a billing system: cost classes and thresholds are coarse signals for humans,
  not an accounting ledger.
- The personal-subscription economics doc stays out of the public repo.

## 11. Open questions

1. Package/plugin name: `adlc-quartermaster` vs `adlc-supply` vs folding into
   `model-router` as a `channels` module. (Naming only; seams fixed by §4–§6.)
2. `rateWindow` utilization: sampled pre-flight or observed on collision? Start
   observed-only; pre-flight couples to gateway internals.
3. Cap-hit exit-code classification per subscription harness — probe per harness
   before enabling §8b's `cap-hit` producer; until probed, the cap-hit monitor
   reports **unknown** rather than quiet.
4. Whether `build.ladder-start` escalation should emit a `fallback`-like event for
   monitor visibility (it is an F8 fresh attempt, not a §7 traversal — likely a
   distinct `kind: "escalation"` event; decide during build item 5).

## 12. Acceptance criteria

1. **No candidate-tree participation in selection.** With a registry file present
   inside the repo under review (any path) and a valid operator-local registry, a
   fleet dry-run dispatches per the operator registry and emits a notice that the
   in-repo file was ignored; with the operator path configured to point inside the
   repo, loading is disabled and dispatch fails closed. Verified by
   `packages/quartermaster/test/registry-isolation.test.mjs` (`assert` on dispatched
   argv, notice text, and fail-closed exit).
2. **Registry validation rules 1–5.** Fixtures: unknown channel name; missing §4a
   channel; adapter not in `packages/fleet/lib/adapters/`; any `command`/argv-shaped
   key; `frontier` and `frontier-metered` sharing a transport; non-gateway
   trust-root member lacking `directAuth` — each rejected at load with an error
   naming the rule. Verified by
   `packages/quartermaster/test/registry-validation.test.mjs` (`assert` per fixture).
3. **`routeJob` derivation and totality.** Table-driven test over every §5 row,
   plus: `float === 0` ticket labeled `build.ladder-start` → throw;
   `category: "spec"` ticket labeled `build.critical-path` → throw; `float === 0`
   with assignment tier `mid` → channel `frontier`; unknown job → throw;
   `gate.deterministic.*` with a channel assertion → throw. Verified by
   `packages/quartermaster/test/route-job.test.mjs`.
4. **Quorum with gateway discounting.** A trust-root group of two gateway-transport
   members with distinct declared providers fails validation (one effective
   family); the reference shape (gateway + directAuth) passes; at runtime, one of
   two members unreachable → nonzero exit, under-satisfaction notice, no `approve`
   recorded. Verified by `packages/prosecute/test/quorum.test.mjs` (`assert` on
   validation error, exit code, and notice text).
5. **Attestation identity is bound.** Recording with a `(model, transport)` absent
   from the registry, or a provider disagreeing with the registry binding, throws;
   a valid record carries `provider`, `transport`, `model`, `seatRole`, and the
   registry SHA-256. Verified by new cases in
   `packages/prosecute/test/cross-model.test.mjs` (`assert` on throw and on entry
   fields including digest).
6. **Fallback through the real resolver.** Driving the actual registry loader and
   resolver (not stubs): `prosecute.verdict` with a simulated pre-execution auth
   failure on `frontier` dispatches `frontier-metered`, `assert` the two attempts'
   transports differ, and both usage entries plus one `fallback` event are
   recorded; a mid-run timeout does not traverse; any other job with an
   unreachable channel fails the gate. Verified by
   `packages/quartermaster/test/fallback.test.mjs`.
7. **Usage round-trip through the existing aggregator.** Entries recorded per §8a
   flow through `aggregateSpend()` and produce nonzero `byPhase` totals for P4/P5
   (guarding against the rev-2 field-name bug); the overflow monitor prices those
   same entries via a fixture `pricing.json` and quotes its version. Verified by
   `packages/gate-manifest/test/usage-roundtrip.test.mjs` (`assert` on totals and
   on the monitor's priced finding).
8. **Producer-to-monitor round trips.** For each §8b `kind`, the *producing* code
   path (dispatch wrapper / fleet merge path) writes the record and the
   corresponding monitor consumes it: a merge + rate-limit same-day pair trips the
   collision trigger; recorded `seatRole:"escalation"` attestations suppress the
   idle-reviewer trigger while ≥5 reviews without them fire it; fixtures for each
   row also cover the non-crossing case (exit 0) and missing-file **unknown**
   (exit 2 naming the file); a second run against an open issue key updates rather
   than duplicates (gh stubbed). Verified by
   `packages/quartermaster/test/check.test.mjs` (`assert` on exit codes and issue
   calls).
9. **This spec passes its own gate.** `node packages/spec-lint/bin/spec-lint.mjs
   docs/specs/operating-stack.md` exits 0 (no WISH criteria). Verified by running
   the command in CI; exit code 0 required.
