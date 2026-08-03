# @adlc/context-handoff

**ADLC phase: P4 continuity (F3)** — pure helpers for absolute context bands and
session-terminal mutation deny (D1–D3). Binding design:
[`docs/specs/context-rot-handoff.md`](../../docs/specs/context-rot-handoff.md).

Slice 1: thresholds, bands, mutation gate, deny lifecycle, deny-marker
fail-closed semantics. Harness adapters and build-gate migration are later slices.

```js
import { WARN_PCT, HANDOFF_PCT, HARD_PCT } from '@adlc/context-handoff/lib/thresholds.mjs';
import { evaluateBands } from '@adlc/context-handoff/lib/bands.mjs';
import { evaluateMutationGate } from '@adlc/context-handoff/lib/mutation-gate.mjs';
```

```sh
node --test packages/context-handoff/test/*.test.mjs
```

## Deferred past slice-1

Signed deny-manifest ledger anchoring (every deny creation recorded in the
hash-chained manifest) is deferred past this pure-helpers slice; slice-1
contracts the filesystem marker + gate predicates only. Until that ledger
exists, callers must thread process-local `processStickyDeny` /
`denyEverWritten` into the gate and `evaluateMarkerOnReentry` so a deleted
marker cannot silently clear a deny the process already wrote.

## Post-consume D3

After a verified other-session consume, that record leaves D3 (`status=consumed`).
Contract test 8 / the binding spec allow a third session when no other open
denies remain; `consumed_by` / `consumed_at` are stamped for forensics, and the
denier remains D2.

## Deny-store expectation

`loadDenyRecords` treats a missing `denies/` as unavailable only when
`.adlc/.deny-store` exists (JSON `{schema,sessions}` written by `ensureDenyMarker`
after a verified marker; sessions[] makes selective marker delete fail closed). The sentinel is a sibling of `handoffs/` so deleting `handoffs/` alone
cannot clear expectation; full signed per-deny ledger is still deferred.
Ticket-store presence alone does not expect denies. A legacy
`.adlc/handoffs/.deny-store` is treated as expected and self-healed to the new
path. `evaluateMarkerOnReentry` does **not** use the global sentinel for
per-session `marker_vanished` — callers thread `denyEverWritten`. Unbound operator bypass may clear `D0:deny_store_unavailable` and
`D3:invalid_record`.

Advisory nags (`nagSuppression`) are suppressed when remaining-to-hard is below
`MIN_REMAINING_TO_HARD` (near-hard / handoff zone) so deny/handoff owns the
signal; this never affects mutation deny.
