---
name: adlc-distill
description: Run ADLC P7 distillation and maintenance workflows in Pi, including lesson-foundry, rejection-mining, skill-mining, scheduled maintenance, skill-rot, model-ratchet, review-calibration, and gate-fuzzing.
---

# ADLC Distill (Pi Integration)

P7 converts repeated findings into deterministic defenses and keeps cached guidance fresh.

Commands:

```sh
adlc lesson-foundry --json
adlc rejection-mining --json
adlc skill-rot .agents/skills plugins/adlc-pi/skills --json
adlc model-ratchet --json
adlc review-calibration --review-cmd "npx adversarial-review --base {base}" --json
adlc gate-fuzzing --json
```

Scheduled or automated P7 maintenance should invoke this skill and the external `$skill-mining` workflow when available, with CI cron as the deterministic fallback.
Record a no-op manifest entry when there is nothing to distill so the runner can distinguish "checked and empty" from "skipped."

## Close the loop — the lesson-foundry gate (P7)

Whether you just distilled findings or ran the maintenance commands above, finish on
the ledger's own gate — it must exit `0`:

```sh
adlc lesson-foundry --gate
```

A non-zero exit names each cluster in `.adlc/findings.jsonl` that recurs but still
has no banked lesson; each is an undefended cluster. Bank or refine its lesson and
re-run until the gate is green. It is deterministic, keyless, and portable:
`.adlc/findings.jsonl` is tracked in git (ADR 0014), so the cluster set travels with
the repo and the gate returns the same verdict anywhere it is checked out. It is not
yet wired into the maintenance cron.
