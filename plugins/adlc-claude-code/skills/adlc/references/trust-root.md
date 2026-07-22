---
title: Trust-root tier — cross-model gating
description: When a same-model P5 SHIP is not enough, and what to do about it.
---

# Trust-root tier

A same-model P5 pass validates the author's own tests, which encode the
author's blind spot. For most changes that's sufficient. For the
**trust-root tier** it is not.

## When this applies

If the change under prosecution touches any of —

- an enforcement package (`packages/rails-guard|prosecute|gate-manifest|build-gate/`),
- a gated-artifact producer (`packages/ticket-prune|ticket-sync/`),
- a declared rails deny-path of any ticket, or
- a trust-root file (`scripts/rails-guard-ci.mjs`, `docs/ci/rails-guard.yml`,
  `scripts/test/rails-guard-workflow-hashes.json`, `.adlc/tickets.json`)

— then a clean **same-model** P5 is not the end of the story.

## What to do

After reaching a same-model CLEAR verdict, **surface it explicitly**: *"same-model
P5 passed; this tier REQUIRES a cross-model adversarial approve from a DISTINCT
provider before `adlc prosecute --base <ref>` will exit 0."* Do not present the
same-model SHIP as sufficient on its own.

1. Run the cross-model pass: shell to the local `codex` CLI, or
   `npx adversarial-review --base <ref>`.
2. Once it approves, record the attestation so the gate clears:

   ```
   adlc prosecute record-cross-model --ticket <id> \
     --provider codex --author-provider claude --verdict approve \
     --input <passes.json>
   ```

The recorded `revision` is resolved the same way the gate resolves it (pass the
same `--input`/`--revision` you use for the gate run), so the attestation binds
to the revision the gate checks. `--provider` MUST differ from
`--author-provider` — a same-model "review" is refused at record time and
rejected by the gate.

## Mechanically enforced, not advisory

This is **gated**, not just recommended: the P5 prosecute runner (given
`--base <ref>`) exits 2 until the manifest holds a `cross-model-review` approve
from a provider distinct from the author, bound to the reviewed revision. See
ADR-0007 and `packages/prosecute/lib/tier.mjs` for the enforcement mechanism
(T39).
