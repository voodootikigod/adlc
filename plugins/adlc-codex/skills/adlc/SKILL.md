---
name: adlc
description: Route software work through the Agentic Development Lifecycle in Codex. Use when the user asks to apply ADLC, operate in ADLC, triage work, or choose the next ADLC gate.
---

ADLC_CODEX_SENTINEL_PHASE_ROUTER_V1

# ADLC Router

Classify the work before acting:

- Trivial: direct edit, existing rails, one prosecution pass.
- Bounded: write or identify rails, build, prosecute-lite.
- Substantial: P1-P7 full lifecycle.
- Architectural: P1 design alternatives, then full lifecycle.

Use deterministic ADLC CLIs for pass/fail. Skills may recommend commands; they do not
declare gates complete unless the relevant CLI and `.adlc/manifest.jsonl` evidence pass.

Start with:

```sh
adlc preflight --json
```

For strict phase assertions, use:

```sh
adlc run <p1|p2|p3|p4|p5|p6|p7> --dir .adlc --json
```

P3, P4, P5, and P6 assertions are ticket-scoped; include `--ticket <ticket-id>` for
those phases.

## The adversarial-review loop

Reference `adversarial-review` at **P1** (design review of the ticket/spec) and **P3**
(attack the declared rail *set* for adequacy — is every invariant covered and
unbypassable) — recommended practice today via `--prompt-only` or diff review, since it
only reviews a git diff/branch and first-class artifact input (`--input`) is a deferred
follow-on — and at **P5** (built code; ≥2 distinct providers on the risk gate), where it
runs directly. It is a cross-model, fresh-context ship/no-ship review that loops
review→fix→re-review until clean (`exit 0 = SHIP`). Flags: `--verify` (refute stale
findings), `--loop` (autonomous fix loop over working-tree code changes only, needs a
write sandbox), `--providers` (multi-provider quorum). Installed separately — invoke via
`npx adversarial-review` if not on PATH. See ADR-0008 (adversarial-review coverage map)
in the ADLC repo.
