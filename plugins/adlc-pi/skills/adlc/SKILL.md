---
name: adlc
description: Route software work through the Agentic Development Lifecycle in Pi. Use when the user asks to apply ADLC, operate in ADLC, triage work, or choose the next ADLC gate.
---

# ADLC Router (Pi Integration)

Classify the work before acting:

- Trivial: direct edit, existing rails, one prosecution pass.
- Bounded: write or identify rails, build, prosecute-lite.
- Substantial: P1-P7 full lifecycle.
- Architectural: P1 design alternatives, then full lifecycle.

Use deterministic ADLC CLIs for pass/fail. Skills may recommend commands; they do not declare gates complete unless the relevant CLI and `.adlc/manifest.jsonl` evidence pass.

Start with:

```sh
adlc preflight --json
```

For strict phase assertions, use:

```sh
adlc run <p1|p2|p3|p4|p5|p6|p7> --dir .adlc --json
```

P3, P4, P5, and P6 assertions are ticket-scoped; include `--ticket <ticket-id>` for those phases.
