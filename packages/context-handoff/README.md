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

## Spec-sanctioned post-consume D3

After a verified other-session consume, that record leaves D3 (status=consumed).
A third session with no other open denies is allowed without resume-auth — that
is contract test 8 / the binding spec, not a silent unlock bug. `consumed_by` /
`consumed_at` are stamped for forensics; denier remains D2.

