# Spec — The ADLC Operating Stack (quartermaster layer)

**Phase:** P1 working spec. Deliverable of this ticket is the **design** (this spec);
the build items in §8 are follow-on tickets, each independently executable. Companion
strategy doc (personal economics, kept out of repo): `~/ideal-agentic-setup.md`.

Status: **proposed**. Proposed plugin/package name: `adlc-quartermaster`
(alternatives in §10).

---

## 1. Goal

Define the ADLC's **operating stack**: the layer that decides *which judgment source
serves which lifecycle phase, through which channel, at what cost class, with what
fallback* — and makes those decisions deterministic, recorded, and periodically
re-evaluated against measured data instead of vibes.

Today this knowledge lives in heads and chat transcripts. The router assigns abstract
tiers (`cheap`/`mid`/`frontier`), but nothing in the repo binds a tier to a concrete
**channel** (harness adapter + provider/model + transport + rate window + cost class).
This spec makes that binding a declarative, versioned artifact and closes the loop
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
| Quartermaster | **this spec** | Bind tiers → channels; record transport; watch triggers | Author or review code |
| Model plane | harness adapters (claude-code, opencode, codex, …) | Judgment | Hold control flow |
| Rails | deterministic gates | Free enforcement | Consume tokens |

## 4. Channel registry (`.adlc/channels.json`)

A declarative, schema-validated registry — the single source of truth binding
router tiers to executable channels.

```json
{
  "version": 1,
  "channels": {
    "frontier": {
      "adapter": "claude-code",
      "model": "default",
      "transport": "subscription:anthropic-max",
      "costClass": "flat",
      "fallback": "frontier-metered"
    },
    "frontier-metered": {
      "adapter": "claude-code",
      "model": "default",
      "transport": "api:anthropic-batch",
      "costClass": "metered"
    },
    "mid": {
      "adapter": "opencode",
      "model": "zai/glm-5.2",
      "transport": "subscription:opencode-go",
      "costClass": "flat",
      "rateWindow": "5h"
    },
    "cheap": {
      "adapter": "opencode",
      "model": "deepseek/v4-flash",
      "transport": "subscription:opencode-go",
      "costClass": "flat",
      "rateWindow": "5h"
    },
    "cross-model-routine": {
      "adapter": "opencode",
      "model": "qwen/qwen3.7-coder",
      "transport": "subscription:opencode-go",
      "provider": "alibaba"
    },
    "cross-model-trust-root": {
      "adapter": "opencode",
      "model": "moonshot/kimi-k3",
      "transport": "subscription:opencode-go",
      "provider": "moonshot",
      "escalation": "cross-model-frontier"
    },
    "cross-model-frontier": {
      "adapter": "codex",
      "model": "default",
      "transport": "subscription:chatgpt-plus",
      "provider": "openai"
    }
  }
}
```

Rules:

1. **Model-router consumes, never invents.** `assign.mjs` keeps emitting
   `{tier, mode, budget}`; a new resolution step maps tier → channel via this
   registry and hands the fleet `{adapter, adapterArgs}`. Unknown tier or missing
   channel **fails closed** (no silent default to a metered channel).
2. **Every cross-model channel declares `provider`** (the underlying model author's
   identity, normalized per `cross-model.mjs`), because the gate's distinctness
   check runs on provider, not transport.
3. **`fallback` is a channel name, not a behavior.** Fallback traversal is
   deterministic and at most one hop; a fallback that is itself unreachable is a
   gate failure, not a retry loop.
4. The registry is a **protected control file** in fleet runs (same integrity-scan
   class as `.adlc/tickets.json`): workers must not rewrite their own supply chain.

## 5. Phase → channel routing (normative table)

| Lifecycle job | Channel | Notes |
| --- | --- | --- |
| P0/P2 spec, contract, architecture tickets | `frontier` | Router already forces frontier for these categories |
| P4 build, critical path (`float === 0`) | `frontier` | |
| P4 build, ladder start (`railDensity >= 0.5`) | `cheap` → escalate per F8 | Escalation is a fresh attempt, never a rescue |
| P5 lens fan-out, first pass | `mid` | |
| P5 verifier / final verdict | `frontier` (overflow: `frontier-metered`) | Never downgraded |
| Cross-model gate, routine | `cross-model-routine` | |
| Cross-model gate, trust-root tier | `cross-model-trust-root` | |
| Cross-model escalation | `cross-model-frontier` | Codex; subject to the 60-day §7 trigger |
| model-ratchet sweeps, rejection-mining | `mid` | Scheduled, latency-irrelevant |
| review-calibration scoring | `frontier-metered` | Batch pricing |
| skill-rot, ticket-prune, rails-*, spec-lint | — deterministic | No channel, no tokens |

## 6. Attestation transport recording

`recordCrossModelReview()` gains an optional `transport` field, recorded alongside
the existing raw `provider` string:

- `provider` stays the **underlying model author** (e.g. `moonshot`) — the
  distinctness decision is unchanged and still normalizes per `normalizeProvider()`.
- `transport` records mediation honestly (e.g. `opencode-go`), so the manifest never
  implies a direct provider relationship that a gateway actually mediated.
- The documented honest limit of ADR-0007 (honest-party attestation, not
  cryptographic proof) is unchanged; a gateway adds no new forgery class beyond the
  ones already conceded.

## 7. Trigger monitors (economics as deterministic checks)

The strategy's re-evaluation triggers become machine-checkable counters, evaluated by
the maintenance cadence — never mid-run:

| Trigger | Signal source | Threshold | Action surfaced |
| --- | --- | --- | --- |
| Frontier cap-hits | harness cap-hit events logged to `.adlc/` telemetry | >2 days/week, 30d window | "Re-upgrade subscription" issue |
| Rate-window collisions on a channel | adapter 429/limit responses per channel | any on a merge day | "Add direct API for model X" issue |
| Metered overflow spend | gate-manifest per-phase usage records | >$30/mo equiv | "Revisit tiering" issue |
| Escalations to `cross-model-frontier` | manifest attestation records | 0 in 60d | "Cancel frontier reviewer line" issue |
| Channel unreachable | fleet gate failures naming a channel | any | Incident issue |

Monitors are report-only (exit 0 = quiet, exit 2 = findings, matching the house gate
convention); they open labeled GitHub issues; they never mutate the registry.

## 8. Build plan — what must be built / enhanced / improved

Ordered by dependency, each a candidate ticket:

1. **Per-phase spend recording** (existing issue #272, foundation): gate-manifest
   entries carry `usage` (tokens or request counts per phase/channel). Everything in
   §7 and the empirical priors depend on this. *Enhance: `gate-manifest`,
   `prosecute`, `runner`.*
2. **Channel registry + resolution** (new, the core of this spec): schema,
   validation, tier→channel resolution consumed by fleet `adapterArgs`; fail-closed
   semantics; protected-file status. *Build: new package (or extend `model-router`).*
3. **OpenCode Go wiring**: verify `opencode run -m <model>` headless against Go
   models on both machines; point the fleet's blocking cross-model prosecution at
   the opencode adapter; keep fail-closed. *Enhance: `fleet/adapters/opencode.mjs`
   config, docs.*
4. **Attestation `transport` field** (§6). *Enhance: `prosecute/cross-model.mjs`,
   `gate-manifest` record shape, docs.*
5. **Trigger monitors** (§7): counters + `quartermaster check` CLI. *Build: new
   package; consumes #272 data.*
6. **Maintenance orchestration contract**: the dev-one systemd timer set
   (nightly scan / weekly mining + calibration / monthly ratchet) documented as a
   versioned contract in `docs/integrations/`, with the wrapper script's
   fail-modes (no `ADLC_MANIFEST_KEY`, report-only, gh-issue reporting). *Document +
   dotfiles; no repo code.*
7. **review-calibration over the new reviewers**: planted-bug recall for the
   `cross-model-routine` and `cross-model-trust-root` channels, so cheap-reviewer
   recall is measured and the escalation policy is evidence-driven (ties to
   `docs/specs/multimodel-review.md`). *Enhance: `review-calibration` provider
   config.*
8. **multimodel `--providers` dependency**: the quorum/diversity engine for
   high-blast-radius changes is already specified in
   `docs/specs/multimodel-review.md` (separate repo build); this spec's registry
   supplies its provider list. *Track as external dependency.*
9. **Deferred, trigger-gated**: pi adapter headless verification
   (`docs/specs/pi-native-flush.md`); local inference on upgraded hardware; herdr
   phase-3 fleet tabs (observability only).

## 9. Non-goals

- Not an enforcement tier for code changes; gates and rails are untouched.
- No model ever selects a channel at runtime (D0 applies to supply, too).
- No dedicated inference hardware in the reference stack; re-entry is trigger-gated
  (§7), not aspirational.
- Not a billing system: cost classes and thresholds are coarse signals for humans,
  not an accounting ledger.
- The personal-subscription economics doc stays out of the public repo.

## 10. Open questions

1. Package/plugin name: `adlc-quartermaster` vs `adlc-supply` vs folding into
   `model-router` as a `channels` module. (Naming only; the seam is fixed by §4.)
2. Should `rateWindow` utilization be sampled proactively (pre-flight) or only
   observed on collision? Start observed-only; pre-flight adds coupling to gateway
   internals.
3. Where cap-hit telemetry for subscription harnesses comes from (harness logs vs.
   wrapper exit codes) — probe per harness before building §7 row 1.

## 11. Acceptance criteria

1. **Registry schema fails closed.** A `channels.json` with an unknown tier
   reference, missing `adapter`, or missing `provider` on a `cross-model-*` channel
   is rejected. Verified by `packages/quartermaster/test/channels-schema.test.mjs`
   (invalid fixtures → validation error; `assert` on error message naming the field).
2. **Tier → channel resolution is deterministic and total.** For every tier
   `model-router` can emit, resolution returns `{adapter, adapterArgs}` or throws;
   no silent default. Verified by `packages/quartermaster/test/resolve.test.mjs`
   (property-style loop over all tiers × fixture registries; `assert` on fail-closed
   throw for missing channels).
3. **Fleet consumes the resolution.** A fleet dry-run against a fixture registry
   dispatches the opencode adapter with the registry's model for a `cheap`-tier
   ticket. Verified by `packages/fleet/test/channel-dispatch.test.mjs` asserting the
   adapter invocation argv.
4. **Attestation transport recorded without weakening distinctness.** Recording with
   `{provider: "moonshot", transport: "opencode-go"}` produces a manifest entry
   carrying both; distinctness still rejects `provider === authorProvider` regardless
   of differing transports. Verified by new cases in
   `packages/prosecute/test/cross-model.test.mjs` (`assert` on entry fields; `assert`
   on thrown distinctness error when providers match but transports differ).
5. **Spend records exist per phase.** After a gated run with #272 landed, manifest
   entries for P4/P5 include a `usage` object. Verified by
   `packages/gate-manifest/test/usage-recording.test.mjs`.
6. **Trigger monitors follow gate exit-code convention.** `adlc quartermaster check`
   exits 0 with no findings and exit code 2 when a fixture telemetry file crosses a
   §7 threshold, printing the trigger name. Verified by
   `packages/quartermaster/test/check.test.mjs` asserting exit codes on fixtures.
7. **Registry is protected in fleet runs.** A worker mutation of `channels.json`
   inside a fleet worktree fails the protected-control-file integrity scan. Verified
   by extending `packages/fleet/test/` integrity-scan cases (`assert` on gate
   failure naming the file).
8. **This spec passes its own gate.** `node packages/spec-lint/bin/spec-lint.mjs
   docs/specs/operating-stack.md` exits 0 (no WISH criteria). Verified by running
   the command in CI; exit code 0 required.
