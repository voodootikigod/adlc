---
name: adlc-self-orchestrate
description: How an Antigravity session decomposes a large build-out into a ticket DAG and drives the agb fleet itself (recursive orchestration). Use when asked to "build X in parallel", "run a fleet", "orchestrate this with agb", or when a task is too large for one session.
---

# Self-Orchestration with agb

You can multiply yourself: decompose the work into a ticket DAG, then run
`agb` so parallel agy workers build it while you supervise. Control flow
belongs to agb (deterministic); you supply the decomposition and the
escalation judgment.

## When

Use this only for substantial work (3+ independently-buildable parts).
Single bounded tasks: just do them.

## Procedure

0. **Prefer compiling an existing plan.** Planning belongs to Antigravity's
   plan phase, not to you ad hoc: if this work was planned in a planning
   conversation (this session or the desktop app), a brain artifact
   (`implementation_plan.md`) already exists. Compile it instead of
   decomposing by hand — `npx agb brains` to find it, then
   `npx agb plan <id> <repo>`, which converts, gates (overlap, coldstart,
   parallax, premortem), and writes a provenance-stamped `plan.json`.
   If gates report blocking findings, refine the plan (the markdown, not
   the JSON) and recompile. Steps 1–3 below are the fallback for when no
   brain artifact exists.
1. **Foundation first.** Identify shared surface (schemas, types, shared
   utilities). Build and commit it to main BEFORE the fan-out — parallel
   workers consume the foundation, never invent it. Foundation paths go
   into every ticket's `rails` (read-only).
2. **Decompose into tickets** (adlc schema). Each ticket must be
   executable by a fresh agent from its `body` alone — full file paths,
   exact acceptance criteria, named gate commands. Partition scopes so no
   two tickets share files; shared needs = a foundation item or an edge.
3. **Write the plan file** `plan.json`:

```json
{
  "repo": "/abs/path/to/repo",
  "base": "main",
  "gate": { "build": "npm run typecheck", "test": "npm test" },
  "tickets": [
    { "id": "T1", "title": "...", "body": "self-contained spec",
      "scope": ["src/feature-a/**"], "rails": ["test/contracts/**"],
      "edges": [{ "to": "T3" }], "tier": "cheap|mid|frontier",
      "pool_hint": "auto" }
  ]
}
```

   Tier by escape cost, not prestige: cheap (Gemini Flash) where gates
   catch everything; mid (Claude Sonnet / Gemini Pro) default; frontier
   only for contracts/migrations with thin rails.
4. **Validate, then run:**

```
npx agb validate plan.json
npx agb run plan.json        # exit 0 all merged, 2 some failed
npx agb status /abs/path     # live dashboard from another terminal
```

5. **Supervise, don't babysit.** agb already does two-strike regeneration,
   cross-model prosecution, and gate-blocked merges. Your job is only the
   escalations: tickets that fail twice mean the ticket is wrong — rewrite
   the ticket (smaller scope, more explicit body), don't coach the agent.
6. **Report** from `.booster/report.json`: merged, failed (with reasons),
   requests per quota pool.

## Quota safety

- Width is capped per pool by agb; do not raise caps above the calibrated
  ceilings without re-probing (`npx agb probe`).
- A run of N tickets costs roughly 2N–4N requests (build + prosecution +
  retries). Check that against your weekly budget before launching.
