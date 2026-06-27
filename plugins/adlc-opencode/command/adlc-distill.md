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
3. Check skill decay: `adlc skill-rot --prompt-only`.
4. Optional `--simplify`: once all tests are green, run a local Simplify pass under
   the completed ticket's still-frozen rails (advisory deviation from strict
   post-merge P7 — warn the user; never edit frozen rails).

## Summarize
Report the defenses created/proposed and any decayed skills flagged.
