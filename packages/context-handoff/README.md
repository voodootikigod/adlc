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

`--dir` names the ledger directory and its final path segment must be `.adlc`:
artifacts and manifest evidence share that tree, and any other name is refused
rather than splitting them. `repair` binds a deny that already exists and is
still open — it never creates one. `unlock` reclaims only a lock minted on this
host, so a dead-looking PID from another machine cannot evict a live session.
A `bypass` grant on stdout is scoped to the calling adapter invocation; the
durable proof is the `context-handoff-bypass` manifest entry; an explicitly
empty `--unbound-reason` is refused rather than degraded to a bound grant.

`write`, `resume`, and `repair` all read-modify-write a deny marker, so each
holds that session's `.adlc/handoffs/<id>.lock` (O_EXCL, released on exit) and
exits 2 when a live session on this host holds it. `write` rebinds the marker
onto the final it writes — `ensureDenyMarker` is idempotent, so without that a
refreshed hash would wedge every later resume — and refuses to unbind or to
refresh a consumed deny. When the manifest append fails, the run's file
mutations are rolled back so no bind survives that nothing attests.

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
