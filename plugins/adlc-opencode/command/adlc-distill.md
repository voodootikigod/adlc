---
description: Distill repeated review findings and PR rejections into permanent, deterministic defenses (P7).
---

# /adlc-distill — turn findings into defenses (P7)

Mine repeated prosecution findings and PR rejections into reusable, deterministic
defenses (lint rules, skills, review lenses) so the same class of defect can't
recur. Target scope: **$ARGUMENTS** (default to recent history).

## Steps
1. Gather repeated findings: `adlc rejection-mining --prompt-only` and
   `adlc lesson-foundry --prompt-only` (answer the printed prompts yourself).
2. For each recurring class, propose the cheapest deterministic defense: a lint
   rule, a new prosecution lens, a skill update, or a test.
3. Check skill decay: `adlc skill-rot .opencode/skills --json` (deterministic —
   it has no `--prompt-only`; exit 2 = stale validation metadata, exit 1
   `nothing to verify` = no metadata, informational).
4. Optional `--simplify`: once all tests are green, run a local Simplify pass under
   the completed ticket's still-frozen rails (advisory deviation from strict
   post-merge P7 — warn the user; never edit frozen rails).

## Close the loop — the lesson-foundry gate must be green

Distillation is done only when no recurring finding cluster is left undefended.
After writing and refining the defenses above (only *materialized* lessons count),
run the gate as the closing check:

```
adlc lesson-foundry --gate
```

It must exit `0`. A non-zero exit names each cluster in `.adlc/findings.jsonl`
that recurs but still has no banked lesson — write or refine its lesson and re-run
until the gate is green. In an advisory or headless run where nothing was
materialized, expect the gate to stay red: report the named unbanked clusters as
the outstanding P7 work rather than treating red as complete.

## Summarize
Report the defenses created/proposed and any decayed skills flagged.
