# Cursor live `permission: deny` proof (T68)

Maintainer-run harness. Manual / `workflow_dispatch` only — not a required CI
gate. Results are dated in `docs/adr/0006-adlc-cursor-integration.md` with the
Cursor version under test. **Never** flip `failClosed` to `true` based on
outcome.

## Binding ordering (false-confidence guard)

1. **Pristine baseline** — choose a frozen rail path declared by the active
   ticket. Record content hash. Confirm a unique sentinel string is **absent**.
2. **Enforcement-on attempt** — with `ADLC_P4_ENFORCEMENT=1` and a resolved
   active ticket that declares that rail, perform a structured Write/Edit of
   the rail with the unique sentinel payload in a real Cursor Agent session.
3. **Prove deny** — record tool deny/allow observation + Cursor version /
   platform. Re-hash the rail file: bytes **unchanged**, sentinel still
   **absent**.
4. **Only then** — enforcement-off control (`ADLC_P4_ENFORCEMENT=0`) proves the
   same edit mutates (sentinel appears / hash changes). Reversing order can make
   an executed deny look like a no-op.

A run that only logs a deny without this ordering is **not** a proof. A fixture
that omits enforcement or never edits a rail is **not** a proof.

## P5 Task canary (AC12 companion)

With a fresh session-matching P5 marker:

- Rejected unrelated Task (`subagent_type` not on prosecutor allowlist) must
  leave a unique filesystem canary **absent**.
- Allow / enforcement-off control must create the canary.
- If `subagentStart` deny is not honored, `preToolUse` remains the control;
  record that degradation in the ADR.

Nested-Task canary is required only after a lineage channel is pinned.

## Quick start

```sh
# From repo root, with Cursor installed and this plugin loaded:
node scripts/cursor-deny-proof/run.mjs --help
# Follow the printed checklist; paste observations into ADR-0006.
```

Link from `docs/integrations/cursor.md` Gaps (this directory).
