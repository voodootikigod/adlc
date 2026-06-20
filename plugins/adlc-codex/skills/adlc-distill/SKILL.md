---
name: adlc-distill
description: Run ADLC P7 distillation and maintenance workflows in Codex, including lesson-foundry, rejection-mining, skill-mining, scheduled maintenance, skill-rot, model-ratchet, review-calibration, and gate-fuzzing.
---

ADLC_CODEX_SENTINEL_DISTILL_V1

# ADLC Distill

P7 converts repeated findings into deterministic defenses and keeps cached guidance fresh.

Commands:

```sh
adlc lesson-foundry --json
adlc rejection-mining --json
adlc skill-rot .agents/skills plugins/adlc-codex/skills --json
adlc model-ratchet --json
adlc review-calibration --review-cmd "npx adversarial-review --base {base}" --json
adlc gate-fuzzing --json
```

Scheduled or automated P7 maintenance should invoke this skill and the external
`$skill-mining` workflow when available, with CI cron as the deterministic fallback.
Record a no-op manifest entry when there is nothing to distill so the runner can distinguish
"checked and empty" from "skipped."
