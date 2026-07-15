---
name: adlc
description: >-
  Route software work through the Agentic Development Lifecycle in Cursor.
  Use when the user asks to apply ADLC, operate in ADLC, triage work, choose
  the next ADLC gate, or mentions P0–P7 / rails / prosecute.
---

<!-- ADLC_CURSOR_SENTINEL_PHASE_ROUTER_V1 -->

# ADLC — phase routing (Cursor)

Treat agentic development as phases with machine-checkable gates via
`adlc <tool>` (exit 0 = pass, 1 = operational error, 2 = gate fail).

Prerequisite: `adlc --version` works (`npm i -g @adlc/cli`). Run `/adlc-init`
or `adlc init --harness cursor` once per repo for the `.adlc/` workspace.

## Where am I? → which gate

```
Vague request, no ticket yet? ───────────────→ P0  /adlc-ticket
Have a spec / acceptance criteria? ──────────→ P1  /adlc-spec · /adlc-approve-spec
Have tickets, planning fan-out? ─────────────→ P2  /adlc-decompose
About to build, want to freeze tests? ───────→ P3  rails-guard hooks + CI
Mid-build / verify? ─────────────────────────→ P4  /adlc-verify-build
Change done, pre-merge prosecution? ─────────→ P5  /adlc-prosecute
Repeated review findings to bank? ───────────→ P7  /adlc-distill
Idle-time maintenance? ──────────────────────→ —   /adlc-maintain
```

LLM-backed gates support `--prompt-only`: print the prompt, answer it yourself
in-session (no API keys). Prefer that over wiring providers.

**Enforcement honesty:** Cursor `preToolUse` deny is best-effort. The
unbypassable control is the CI rail-freeze gate (`docs/ci/rails-guard.yml`).

**P5 caveat:** `/adlc-prosecute` runs five lenses sequentially in one context
(weaker independence than Claude Code / OpenCode subagent fan-out). For the
cross-model risk gate run `npx adversarial-review --providers <a,b>`.
