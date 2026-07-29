# Spec — The ADLC Operating Stack (quartermaster layer)

**Phase:** P1 working spec. Deliverable of this ticket is the **design** (this spec);
the build items in §9 are follow-on tickets, each independently executable. Companion
strategy doc (personal economics, kept out of repo): `~/ideal-agentic-setup.md`.

Status: **proposed, revision 2** — revised after a cross-model adversarial review
(codex, 6 findings: registry-as-attack-surface, tier-only resolver gap, gateway
identity assertion, missing trust-root quorum, non-computable monitors, undefined
fallback). Proposed plugin/package name: `adlc-quartermaster` (alternatives in §11).

---

## 1. Goal

Define the ADLC's **operating stack**: the layer that decides *which judgment source
serves which lifecycle phase, through which channel, at what cost class, with what
fallback* — and makes those decisions deterministic, recorded, and periodically
re-evaluated against measured data instead of vibes.

Today this knowledge lives in heads and chat transcripts. The router assigns abstract
tiers (`cheap`/`mid`/`frontier`), but nothing in the repo binds a tier to a concrete
**channel** (provider/model + transport + rate window + cost class). This spec makes
that binding a declarative, versioned artifact — with the executable half of the
binding held **operator-local, outside the candidate tree** — and closes the loop
with spend telemetry.

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
| Quartermaster | **this spec** | Bind lifecycle jobs → channels; record transport; watch triggers | Author or review code; carry executable config in the candidate tree |
| Model plane | harness adapters (claude-code, opencode, codex, …) | Judgment | Hold control flow |
| Rails | deterministic gates | Free enforcement | Consume tokens |

## 4. Two-part channel registry (trust-split by design)

**Design rule (from review finding 1): nothing in the candidate tree may select an
adapter, a command, or argv.** The fleet's existing boundary — adapters have
different containment; repository config must not choose them — is preserved by
splitting the registry into a symbolic half (committed) and an executable half
(operator-local):

### 4a. Committed: `.adlc/channels.json` — symbolic only

Maps channel **names** to symbolic intent. Schema-validated; contains **no**
`adapter`, `command`, or argv-shaped fields — their presence is a validation error.

```json
{
  "version": 2,
  "channels": {
    "frontier":        { "wants": "anthropic/frontier",  "costClass": "flat" },
    "frontier-metered":{ "wants": "anthropic/frontier",  "costClass": "metered" },
    "mid":             { "wants": "zai/glm-5.2",         "costClass": "flat", "rateWindow": "5h" },
    "cheap":           { "wants": "deepseek/v4-flash",   "costClass": "flat", "rateWindow": "5h" }
  },
  "reviewerGroups": {
    "cross-model-routine":    { "members": ["alibaba/qwen3.7-coder"], "quorum": 1 },
    "cross-model-trust-root": { "members": ["moonshot/kimi-k3", "openai/frontier"], "quorum": 2 }
  }
}
```

### 4b. Operator-local: `quartermaster.json` — the executable binding

Lives outside every candidate tree (resolved the same way `adversarial-review`
resolves its config: absolute path in the operator's home/XDG dir; a path inside
the repo under review **disables** rather than supplies it). Maps each symbolic
`wants` string to `{adapter, model, transport, provider}` from an
**operator-approved allowlist**. Fleet workers never read it; only the dispatching
fleet process does.

Resolution rules:

1. **Fail closed, both halves.** A committed channel whose `wants` has no
   operator-local binding is a gate failure, not a default. An operator binding
   naming an adapter not in `packages/fleet/lib/adapters/` is a config error at
   load, before any dispatch.
2. **The committed half can only narrow, never escalate.** Removing a channel or
   pointing `wants` at a *different allowlisted* symbolic target is legal from the
   repo; nothing committed can change containment, commands, or argv, because those
   exist only operator-side.
3. **Every reviewer-group member is a `provider/model` symbolic ID** whose provider
   segment is the underlying model author, normalized per
   `cross-model.mjs#normalizeProvider`. The operator binding must agree
   (§6 mismatch rule).
4. `.adlc/channels.json` remains in the fleet's protected-control-file scan
   (defense in depth for mid-run mutation) — but per rule 2 this is **not** the
   security boundary; the operator-local split is.

## 5. Lifecycle-job routing contract (not tier-only)

**Design rule (from review finding 2): tier resolution alone cannot express the
routing table.** `assign.mjs` keeps emitting `{tier, mode, budget}` unchanged, but
channel selection is a distinct function with the lifecycle **job** as an explicit
input:

```
routeJob({ job, assignment }) -> { channel } | { reviewerGroup } | { deterministic: true }
```

`job` is a closed enum; the function is total over it (unknown job → throw). The
normative table — every row of which gets a table-driven acceptance test (AC2):

| `job` | Routing | Notes |
| --- | --- | --- |
| `build.spec` / `build.contract` / `build.architecture` | `frontier` | Regardless of assignment tier |
| `build.critical-path` (`float === 0`) | `frontier` | **Overrides** `assign.mjs`'s mid/prior tier for channel purposes; assignment tier still governs budget |
| `build.ladder-start` (`float > 0`) | assignment tier's channel (`cheap` or `mid`) | Escalation per F8 is a fresh attempt |
| `prosecute.lens` | `mid` | First-pass fan-out |
| `prosecute.verdict` | `frontier` | Overflow-eligible (§7) — the only overflow-eligible job |
| `review.cross-model.routine` | group `cross-model-routine` | |
| `review.cross-model.trust-root` | group `cross-model-trust-root` | Quorum ≥2, distinct families (§6) |
| `maintain.ratchet` / `maintain.mining` | `mid` | Scheduled, latency-irrelevant |
| `maintain.calibration` | `frontier-metered` | Batch pricing |
| `gate.deterministic.*` | `{deterministic: true}` | No channel, no tokens — asserting a channel here is an error |

## 6. Cross-model attestations: quorum + bound identity

**Design rules (from review findings 3 and 4).**

**Quorum.** Trust-root review is a reviewer **group**, not a channel:
`quorum` members must return independent verdicts, members' provider families must
be pairwise distinct after `normalizeProvider` (a group with a collapsed duplicate
fails validation), and none may equal the author's family. Fewer reachable members
than `quorum` **fails closed** with a loud under-satisfaction notice — a degraded
run must not masquerade as a full one. Verdict combination follows
`docs/specs/multimodel-review.md`: any material finding → `needs-attention`;
`approve` requires all quorum members to approve. This spec's registry supplies the
provider list that spec's `--providers` mode consumes.

**Bound identity.** The prior draft claimed gateway mediation "adds no new forgery
class" — the review refuted that: when automation signs a registry-derived provider
string, the HMAC authenticates the *recorder*, not the reviewer. Retracted, and
replaced with binding:

- The `provider` recorded in an attestation must come from the **operator-local**
  binding (§4b), never from the committed file or a CLI flag, when recorded by
  automation.
- The signed entry additionally records: `transport`, the resolved `model`, and the
  SHA-256 **digest of the operator-local binding file** used at resolution time.
  A verifier can then detect after the fact that an attestation was minted under a
  since-revised binding.
- The recorder **rejects** a record whose `(model, transport)` pair is absent from
  the binding or whose bound provider disagrees with the `provider` argument.
- Honest limit, restated precisely: this still cannot prove which model a gateway
  *actually served* (same class as ADR-0007's concession). What it newly guarantees
  is that a forged provider label requires compromising the **operator-local
  binding file or the CI key** — not merely committing a registry edit to a PR
  branch.

## 7. Fallback: a state machine, not a graph

**Design rule (from review finding 6).** Exactly one fallback edge exists:
`frontier → frontier-metered`, and only the `prosecute.verdict` job may traverse it.

- **Eligible failure classes** (pre-execution only): adapter binary absent, auth
  failure, or a rate-limit/cap response received **before any output**. Timeouts
  mid-run, partial output, nonzero exits after output, and gate failures are
  **not** fallback-eligible — they are ordinary failures handled by the fleet's
  existing two-strike policy.
- **Attempt isolation:** a fallback attempt is a **fresh attempt** in the same
  sense as F8 escalation — clean worktree state, no reuse of the failed attempt's
  partial work. (For `prosecute.verdict` the attempt is read-only over the
  candidate diff, so isolation is trivially satisfied; the rule is stated for
  future edges.)
- **Telemetry attribution:** each attempt records its own usage entry, labeled
  with its channel; a fallback traversal records both attempts.
- **One hop, then stop:** an unreachable fallback is a gate failure. No retry
  loops, no second hop.
- All other jobs: channel unreachable → gate failure immediately (fail closed).

## 8. Trigger monitors (economics as deterministic checks)

**Design rule (from review finding 5): every trigger names its telemetry schema,
clock semantics, and dedup key.** All times UTC; weeks are ISO-8601; windows are
rolling and inclusive of the current day. Telemetry lives in
`.adlc/telemetry/*.jsonl` (append-only, schema-versioned per record). Monitors are
report-only (exit 0 quiet / exit 2 findings, house convention); they open GitHub
issues with a dedup key `quartermaster:<trigger>:<ISO-week>` and update the
existing open issue for a key instead of filing a duplicate; they never mutate
either registry half.

| Trigger | Telemetry record | Rule (deterministic) | Issue |
| --- | --- | --- | --- |
| Frontier cap-hits | `{ts, kind:"cap-hit", channel}` from wrapper exit-code classification (probe per harness, §11 Q3) | cap-hit records on >2 distinct UTC days within the trailing 30 days | "Re-upgrade subscription" |
| Rate-window collision | `{ts, kind:"rate-limit", channel, model}` from adapter responses | ≥1 record on a day that also has a `kind:"merge"` record | "Add direct API for model X" |
| Metered overflow | `{ts, kind:"usage", channel, tokensIn, tokensOut}` + `pricing.json` (versioned: `{version, model, inPerMTok, outPerMTok, currency:"USD"}`) | Σ(cost) over trailing 30 days > `overflowUsdThreshold` (default 30, operator-local) — pricing version recorded in the finding | "Revisit tiering" |
| Idle frontier reviewer | attestation records (§6) | 0 escalation records in trailing 60 days **and** ≥5 trust-root reviews in the same window (opportunity denominator — no-eligible-work never fires) | "Cancel frontier reviewer line" |
| Channel unreachable | fleet gate-failure records naming a channel | any | Incident |

Missing or unparsable telemetry for a trigger → that trigger reports **unknown**
(distinct from quiet), exits 2, and says which file/schema was missing — degraded
data cannot silently pass.

## 9. Build plan — what must be built / enhanced / improved

Ordered by dependency, each a candidate ticket:

1. **Per-phase spend recording** (existing issue #272, foundation): gate-manifest
   entries carry `usage`; the §8 telemetry schema is the record shape. *Enhance:
   `gate-manifest`, `prosecute`, `runner`.*
2. **Two-part registry + `routeJob`** (core): committed symbolic schema (§4a),
   operator-local binding loader with outside-the-repo path rule (§4b), the
   lifecycle-job routing contract (§5) consumed by fleet dispatch. *Build: new
   package (or extend `model-router`).*
3. **OpenCode Go wiring**: verify `opencode run -m <model>` headless against Go
   models on both machines; point the fleet's blocking cross-model prosecution at
   the opencode adapter via the operator binding; keep fail-closed. *Enhance:
   operator config + docs; `fleet/adapters/opencode.mjs` unchanged.*
4. **Attestation binding + quorum** (§6): `transport`/`model`/binding-digest fields
   on `recordCrossModelReview`, recorder mismatch rejection, reviewer-group
   validation, under-satisfaction fail-closed. *Enhance: `prosecute/cross-model.mjs`,
   `gate-manifest` record shape; consumes `multimodel-review.md`'s `--providers`.*
5. **Trigger monitors** (§8): telemetry writers + `adlc quartermaster check`.
   *Build: new package; consumes #272 data.*
6. **Maintenance orchestration contract**: dev-one systemd timer set (nightly scan /
   weekly mining + calibration / monthly ratchet) documented as a versioned
   contract in `docs/integrations/`, with fail-modes (no `ADLC_MANIFEST_KEY`,
   report-only, gh-issue dedup per §8). *Document + dotfiles; no repo code.*
7. **review-calibration over the new reviewers**: planted-bug recall for each
   reviewer-group member, so cheap-reviewer recall is measured and quorum
   membership is evidence-driven. *Enhance: `review-calibration` provider config.*
8. **multimodel `--providers` dependency**: quorum engine specified in
   `docs/specs/multimodel-review.md` (separate repo build); §6 defines the consumer
   contract. *Track as external dependency.*
9. **Deferred, trigger-gated**: pi adapter headless verification
   (`docs/specs/pi-native-flush.md`); local inference on upgraded hardware; herdr
   phase-3 fleet tabs (observability only).

## 10. Non-goals

- Not an enforcement tier for code changes; gates and rails are untouched.
- No model ever selects a channel at runtime (D0 applies to supply, too).
- No dedicated inference hardware in the reference stack; re-entry is trigger-gated
  (§8), not aspirational.
- Not a billing system: cost classes and thresholds are coarse signals for humans,
  not an accounting ledger.
- The personal-subscription economics doc stays out of the public repo.
- The committed registry is **not** a mechanism for contributors to reconfigure
  execution — by construction (§4) it cannot be.

## 11. Open questions

1. Package/plugin name: `adlc-quartermaster` vs `adlc-supply` vs folding into
   `model-router` as a `channels` module. (Naming only; the seam is fixed by §4–§5.)
2. Should `rateWindow` utilization be sampled proactively (pre-flight) or only
   observed on collision? Start observed-only; pre-flight adds coupling to gateway
   internals.
3. Cap-hit telemetry source per subscription harness (harness logs vs. wrapper
   exit-code classification) — probe per harness before building §8 row 1; until
   probed, that row reports **unknown** rather than quiet.

## 12. Acceptance criteria

1. **Committed registry is symbolic-only and cannot select execution.** A
   `channels.json` containing `adapter`, `command`, or argv-shaped fields is
   rejected at validation; a fleet dry-run from a branch whose committed registry
   attempts adapter selection dispatches per the **operator-local** binding
   unchanged. Verified by `packages/quartermaster/test/registry-trust-split.test.mjs`
   (`assert` on validation error naming the forbidden field; `assert` on dispatched
   argv matching operator binding, not the committed file).
2. **`routeJob` is total and matches §5 exactly.** Table-driven test enumerating
   every §5 row — including `build.critical-path` with `assign.mjs` emitting `mid`
   (must still route `frontier`), `prosecute.verdict` overflow eligibility, both
   reviewer groups, and `gate.deterministic.*` rejecting channel assertion; unknown
   job throws. Verified by `packages/quartermaster/test/route-job.test.mjs`.
3. **Operator-local binding path rule.** A binding path inside the repo under
   review disables config (loader returns null + loud notice) rather than loading
   it; absolute external path loads. Verified by
   `packages/quartermaster/test/binding-path.test.mjs` (`assert` both behaviors).
4. **Reviewer-group quorum fails closed.** With one of two trust-root members
   unreachable, the review run exits nonzero with an under-satisfaction notice and
   no `approve` is recorded; duplicate-family groups fail validation. Verified by
   `packages/prosecute/test/quorum.test.mjs` (`assert` on exit code and notice
   text; `assert` on validation error for `["moonshot/x", "moonshot/y"]`).
5. **Attestation identity is bound.** Recording with a `(model, transport)` pair
   absent from the binding, or a provider disagreeing with the bound provider, is
   rejected; a valid record carries `provider`, `transport`, `model`, and the
   binding-file SHA-256. Verified by new cases in
   `packages/prosecute/test/cross-model.test.mjs` (`assert` on thrown mismatch;
   `assert` on entry fields including digest).
6. **Fallback state machine.** `prosecute.verdict` with a pre-execution auth
   failure on `frontier` dispatches `frontier-metered` once and records two usage
   attempts; a mid-run timeout does **not** traverse fallback; any other job with
   an unreachable channel fails the gate immediately. Verified by
   `packages/quartermaster/test/fallback.test.mjs` (`assert` per class).
7. **Monitors are computable and dedup issues.** Each §8 row has a fixture
   crossing and a fixture not crossing its threshold (`adlc quartermaster check`
   exit 2 / exit 0 respectively — exit codes asserted); missing telemetry for a row
   yields **unknown** at exit 2 naming the file; a second run against an
   already-open issue key updates rather than duplicates (gh stubbed). Verified by
   `packages/quartermaster/test/check.test.mjs`.
8. **Spend records exist per phase.** After a gated run with #272 landed, manifest
   entries for P4/P5 include a `usage` object matching the §8 schema. Verified by
   `packages/gate-manifest/test/usage-recording.test.mjs`.
9. **This spec passes its own gate.** `node packages/spec-lint/bin/spec-lint.mjs
   docs/specs/operating-stack.md` exits 0 (no WISH criteria). Verified by running
   the command in CI; exit code 0 required.
