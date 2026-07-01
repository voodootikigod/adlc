---
name: adlc
description: >-
  Routes agentic development work to the right Agentic Development Lifecycle
  (ADLC) gate from inside OpenCode. Use when shaping a spec or ticket, deciding
  how to fan work out to models, protecting frozen rails during a build,
  prosecuting a change before merge, or distilling repeated findings into
  defenses. Triggers on "shape this spec", "is this ticket ready", "freeze these
  tests", "prosecute this change", "is this safe to merge", "ADLC", "which gate",
  "spec-lint", "premortem", "coldstart", "rails-guard", "hollow-test".
---

# ADLC phase router (OpenCode)

Describe what you're doing; this routes you to the gate that fits. Gates run via
the `adlc <tool>` dispatcher (`npm i -g @adlc/cli`). LLM-backed gates support
`--prompt-only` — inside OpenCode, the model answers the printed prompt, so no
API key is required.

| You're trying to… | Phase | Gate |
| --- | --- | --- |
| Triage / author a ticket | P0 | `adlc preflight`, `/adlc-ticket` |
| Pin down a vague spec | P1 | `adlc spec-lint`, `adlc premortem`, `adlc parallax`, `adversarial-review` |
| Slice work across models | P2 | `adlc coldstart`, `adlc merge-forecast`, `adlc model-router` |
| Freeze tests/contracts as rails | P3 | `adlc rails-guard` + the in-session rails-guard hook, `adversarial-review` |
| Build under supervision | P4 | `adlc flail-detector`, `adlc consensus-fix` |
| Prosecute before merge | P5 | `adlc hollow-test`, `adlc behavior-diff`, `adlc review-calibration`, `adversarial-review` |
| Decide to integrate | P6 | `adlc gate-manifest` (human gate) |
| Distill findings into defenses | P7 | `adlc lesson-foundry`, `adlc rejection-mining` |

## The adversarial-review loop

A cross-model, fresh-context ship/no-ship review that loops review→fix→re-review until
clean (`exit 0 = SHIP`). Recommended at **P1** (design review of the ticket/spec), **P3**
(attack the declared rail *set* for adequacy — is every invariant covered and
unbypassable), and **P5** (built code; ≥2 distinct providers on the risk gate). Flags:
`--verify` (refute stale findings), `--loop` (autonomous fix loop, working-tree only),
`--providers` (multi-provider quorum). See ADR-0008 (adversarial-review coverage map) in
the ADLC repo.

## Rail enforcement in this harness

The bundled plugin wires a `tool.execute.before` hook that denies structured
`edit`/`write` to frozen rails declared by the active ticket. It is **advisory in
session and gated on host SDK capability** — the unbypassable layer is the
commit-time CI gate (`docs/ci/rails-guard.yml`). See
[`docs/integrations/opencode.md`](../../../docs/integrations/opencode.md).
