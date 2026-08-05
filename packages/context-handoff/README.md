# @adlc/context-handoff

**ADLC phase: P4 continuity (F3)** — absolute context bands, session-terminal
mutation deny (D1–D3), and the operator CLI for write/resume/bypass/repair/unlock.
Binding design:
[`docs/specs/context-rot-handoff.md`](../../docs/specs/context-rot-handoff.md).

```sh
adlc handoff write --session <id> [--ticket <id>] [--write] [--json]
adlc handoff resume --session <consumer> --deny-session <denier> [--write]
adlc handoff bypass --session <id> [--unbound-reason <text>] [--write]
adlc handoff repair --session <id> --ticket <id> --content-hash <h> [--write]
adlc handoff unlock --session <id> --pid <n> --started-at <iso> --host <h> --nonce <n> [--write]
```

Mutating `--write` requires `ADLC_MANIFEST_KEY` (never silent success).

```js
import { WARN_PCT, HANDOFF_PCT, HARD_PCT } from '@adlc/context-handoff/lib/thresholds.mjs';
import { evaluateBands } from '@adlc/context-handoff/lib/bands.mjs';
import { evaluateMutationGate } from '@adlc/context-handoff/lib/mutation-gate.mjs';
```

```sh
node --test packages/context-handoff/test/*.test.mjs
```

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
