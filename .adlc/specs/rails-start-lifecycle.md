# Rails need a START lifecycle: freeze from build-start, not from authoring

Closes #159.

## Problem

A ticket's rails freeze their paths for **every** PR from the moment the ticket
exists in the store. `scripts/rails-guard-ci.mjs:329-335` builds the union from
every base ticket that is not completed:

```js
const rails = [];
for (const t of baseTickets) {
  if (t.completed === true) continue; // done → auto-expire (T36)
  for (const r of t.rails ?? []) rails.push(r);
}
```

There is no notion of *when the build began*. T36 (#130) gave rails an END —
`completed: true` expires them. Nothing gives them a START. The window is
therefore `[authoring, completion]` when it should be `[build-start, completion]`.

(#159's "Relationship" section says the completion side is #141. That is a stale
cross-reference: the completion side shipped as **T36 / #130**. #141 is the
trust-root ceremony, which is the *mechanism* problem, not the lifecycle mirror.
Worth correcting on the issue.)

### Harm A — a ticket cannot author its own rails

Declaring a test file as a rail blocks writing that test file. The rail is
supposed to freeze a test *once it exists*; instead it freezes the path before
anything is there.

Observed building **T58** (the ceremony-drift bot-author fix) on 2026-07-22. The
ticket declared `rails: ["scripts/test/ceremony-drift.test.mjs"]` at authoring,
and the first attempt to write that test was denied:

```
scripts/test/ceremony-drift.test.mjs is a frozen rail declared by ticket T58
(rails: "scripts/test/ceremony-drift.test.mjs"). Edits to frozen rails are
blocked during build.
```

The workaround was to narrow the rails to `[]`, author the test, then re-freeze
— and to repeat that cycle on **every review round** that added a test (an
adversarial-review finding, then two surviving mutants). Three narrow/re-freeze
cycles for one ticket, each requiring `--authorize` on a `rail-narrowing`.

Nothing was bypassed and every cycle is recorded, so this is friction rather than
a hole. But the recorded history now shows a ticket that repeatedly un-froze its
own rails, which is indistinguishable in the log from the thing rails exist to
prevent. The audit trail is *noisier for having followed the rules*.

### Harm B — the honest response is to declare no rails

#159 reports that T39 and T40 both shipped with `rails: []` and a note to
"declare at P3", because declaring up front would freeze those paths for
unrelated PRs before the build started. That defeats the point of authoring
rails with the ticket, and it is the *documented* workaround, not a mistake.

The in-session hook states the current behavior plainly
(`plugins/adlc-claude-code/hooks/adlc-hook.mjs:250`):

```js
const status = ticket.completed === true ? 'completed'
  : rails.length > 0 ? 'rail protection auto-active' : 'no rails declared';
```

`auto-active` — on declaration.

### Why this is worth fixing now

Measured against the store on `main` at 1.6.0: the active rail union is **30
paths**, and **every one of them belongs to a ticket that has already shipped**
(the twelve in PR #285). Not one frozen path corresponds to a build in flight.

That is the steady state this design produces. Rails accumulate from authoring,
expire only through an admin ceremony, and the union therefore trends toward
"everything ever declared" rather than "what is being built right now." #159 and
#141 are the two ends of the same lifecycle, and the union is broken at both.

## Build

1. **Add a `started` field and gate the union on it.** In the
   `rails-guard-ci.mjs` union, skip tickets that have not started:

   ```js
   if (t.completed === true) continue; // T36 — window closed
   if (t.started !== true) continue;   // NEW  — window not open
   ```

   Strict boolean `true` only, matching T36's fail-closed treatment of
   `completed` (not `"true"`, not truthy).

2. **Make `started` self-service, and irreversible.** This is the trust
   asymmetry that makes the change safe, and it must be argued explicitly in the
   code comment the way T36's trust anchor is:

   - `started: true` only ever **adds** freeze. Granting it takes privilege away
     from the setter, so an ordinary PR may set it — via a new narrow exemption
     `isStartAnnotationOnly`, built exactly like `isCompletionAnnotationOnly`
     (add-only on a pristine field, strict `=== true`, everything else
     byte-identical).
   - **Un-starting is already denied.** Removing the field or setting it `false`
     is a field change to an existing base ticket, which
     `assertBaseTicketContractsPreserved` denies. So the transition is one-way
     without an admin, for free.
   - **No new unfreeze privilege is created.** The union only shrinks for tickets
     that never started, and a never-started ticket is *exactly equivalent to
     today's `rails: []`* — which any author may already write. The guard's floor
     is unchanged. This argument is the crux of the review; state it in the spec
     comment, not just the PR.

   Note the asymmetry with `isCompletionAnnotationOnly`, which bails when
   `baseRails.length > 0` (rails-guard-ci.mjs:147) because completing a railed
   ticket *unfreezes*. Starting one *freezes*, so the railed case is the case
   that must be allowed. Getting this backwards inverts the security property.

3. **Close the honesty gap the change opens.** With opt-in start, a ticket could
   declare rails, never start, build to completion, and read in the store as
   protected while having frozen nothing. Require that a ticket with non-empty
   rails may only be completed if it was started — enforced both in
   `adlc ticket complete` and in the completion path — so "declared rails" and
   "rails that bound something" cannot diverge silently.

4. **Add `adlc ticket start <id> --write`,** mirroring `adlc ticket complete`, as
   the sanctioned P3 transition. Dry-run by default like every other writer.

5. **Teach the in-session hook the same window.** `adlc-hook.mjs` must not freeze
   an un-started ticket's rails, and must permit the start annotation to reach
   the store even when rails exist (today the hook freezes the ticket store
   itself once any rail is declared, which would block the very transition).
   Harm A is a hook-level failure; fixing only CI leaves it in place.

6. **Grandfather every ticket that predates the field (premortem F2 — blocking).**
   Absent `started` must NOT mean "never started" for tickets authored before this
   change, or merging it silently expires the entire existing rail union in one
   step. Measured on `main` at 1.6.0 that is **all 30 frozen paths at once** — a
   mass unfreeze arriving as a side effect of a lifecycle change rather than as a
   reviewed ceremony, and one that would quietly moot PR #285.

   Bump the store `formatVersion` and treat tickets written under the old version
   as started. Only tickets authored after the bump participate in the opt-in
   window. **Sequencing:** if #285 lands first the union is already empty and the
   hazard is moot — but the grandfather clause is required regardless, because
   correctness must not depend on merge order.

   **The obvious bump collides with existing code (coldstart gap).**
   `rails-guard-ci.mjs` already treats `formatVersion` as a two-value migration
   signal:

   ```js
   const isMigration = baseSnapshot.formatVersion === 0 && headSnapshot.formatVersion === 1;  // :348
   } else if (baseSnapshot.formatVersion !== headSnapshot.formatVersion) {                     // :377
   ```

   A bump to `2` falls into the second branch and is treated as an illegal
   version change, so the grandfather mechanism as stated would deny every PR.
   Resolve explicitly: either extend the migration handling to a version
   *ladder* rather than a hardcoded 0→1 pair, or carry the grandfather signal
   per-ticket (e.g. a provenance field written at authoring) and leave
   `formatVersion` alone. Prefer the per-ticket signal — it keeps the store
   version meaning "layout", not "policy epoch".

7. **Make start automatic at P3, not a remembered step (premortem F4).** An
   opt-in flag that is only enforced at completion (AC7) fails at the worst
   possible moment: the work is done and the fix needs a ticket-store change. The
   build-gate/hook path that already knows a build is beginning should perform the
   transition, leaving `adlc ticket start` as the explicit escape hatch rather
   than the primary interface.

8. **Support recovery in one PR (premortem F1).** A ticket that reaches
   completion without having started must be fixable on the ordinary path. As
   specified, a PR adding both `started: true` and `completed: true` matches
   *neither* narrow exemption and is denied — so the recovery for forgetting to
   start is an admin ceremony, which is exactly the trap #141 describes. Either
   admit an explicit `isStartThenCompleteAnnotationOnly` (add-only on both
   pristine fields, strict `=== true`, nothing else changed) or state plainly
   that recovery requires two sequential PRs. Do not leave it unstated.

9. **Never emit `started` at authoring (premortem F3).** If `adlc ticket create`
   writes the field, the window collapses back to `[authoring, completion]` and
   this whole change is a no-op with extra steps.

10. **Record an ADR** covering the full `[start, completion]` window, the
    argument in step 2, and the grandfather rule in step 6.

## Acceptance criteria

- **AC1 — an un-started ticket freezes nothing.** With a base store containing a
  ticket that declares `rails: ["a/b.test.mjs"]` and no `started` field, a PR
  editing `a/b.test.mjs` passes. VERIFY: `node --test
  scripts/test/rails-guard-ci.test.mjs --test-name-pattern='un-started'` exits 0,
  and the same test fails against the pre-fix `rails-guard-ci.mjs`.

- **AC2 — a started ticket freezes exactly as today.** Same fixture with
  `started: true` in base denies the same edit with exit 2. VERIFY: as AC1, with
  `--test-name-pattern='started freezes'`.

- **AC3 — start is strict and fail-closed.** `started` values `"true"`, `1`,
  `{}`, and `null` all leave the ticket un-started rather than starting it, and
  none crashes the gate. VERIFY: table-driven case in the same file,
  `--test-name-pattern='started strictness'`.

- **AC4 — a PR may start a ticket, including a railed one.** A PR whose only
  ticket-store change adds `started: true` to an existing railed base ticket
  passes `assertBaseTicketContractsPreserved`. VERIFY:
  `--test-name-pattern='start annotation exempt'`.

- **AC5 — a PR may not un-start, and may not smuggle.** Removing `started`,
  setting it `false`, or adding `started: true` *together with any other field
  change* (including a rails change) is denied. This is the security boundary;
  it must have a case per variant. VERIFY:
  `--test-name-pattern='start annotation bounded'`.

- **AC6 — starting cannot unfreeze another ticket's path.** With ticket A started
  and freezing `x.mjs`, a PR that starts ticket B still cannot edit `x.mjs`.
  VERIFY: `--test-name-pattern='start does not unfreeze'`.

- **AC7 — a railed ticket cannot be completed without having started.**
  `adlc ticket complete <id>` on a ticket with non-empty rails and no `started`
  fails with a distinct exit code and message; with `started: true` it succeeds.
  VERIFY: `node --test packages/tickets/test/*.test.mjs
  --test-name-pattern='complete requires start'` exits 0.

- **AC8 — `adlc ticket start` exists and is dry-run by default.** `adlc ticket
  start T1` reports the change and writes nothing; `--write` applies it; starting
  an already-started ticket is a no-op rather than an error. VERIFY:
  `--test-name-pattern='ticket start'` in the same suite.

- **AC9 — the hook lets a ticket author its own rails (Harm A, end to end).**
  Driving `adlc-hook.mjs` with a PreToolUse Write to a declared-but-un-started
  rail path returns allow; after `started: true`, the identical call returns
  deny. This is the T58 scenario and must be asserted as such. VERIFY:
  `node --test plugins/adlc-claude-code/test/*.test.mjs
  --test-name-pattern='un-started rail is writable'` exits 0.

- **AC10 — the hook permits the start transition itself.** With rails declared,
  `adlc ticket start --write` succeeds in-session — the store freeze does not
  block the annotation. VERIFY: `--test-name-pattern='start transition allowed'`.

- **AC13 — pre-existing tickets keep freezing (premortem F2, blocking).** Loading
  a store written under the previous `formatVersion`, every ticket with rails and
  no `started` field still freezes its paths. Asserted against a fixture built
  from the real 1.6.0 store, so the 30-path union cannot silently evaporate.
  VERIFY: `node --test scripts/test/rails-guard-ci.test.mjs
  --test-name-pattern='grandfathered tickets still freeze'` exits 0, and the test
  fails if the grandfather clause is removed.

- **AC14 — start+complete recovery is decided, not accidental (premortem F1).**
  A PR adding both `started: true` and `completed: true` to a pristine railed
  ticket either passes (if the composite exemption is implemented) or is denied
  with a message naming the two-PR recovery. Whichever is chosen, it is asserted
  — the failure mode is this case being undefined. VERIFY:
  `--test-name-pattern='start then complete'`.

- **AC16 — the P3 transition is automatic (Build step 7).** Beginning a build
  against a ticket with declared rails and no `started` field performs the start
  transition without the operator invoking `adlc ticket start`. Build step 7 was
  a requirement with no acceptance criterion until this was added — the gap that
  would have shipped the flag while leaving it a remembered step. VERIFY:
  `node --test packages/build-gate/test/*.test.mjs
  --test-name-pattern='build start performs the rail start transition'` exits 0.

- **AC17 — the version ladder still admits the legacy migration.** With the
  grandfather mechanism in place, the existing 0→1 directory-store migration path
  still passes and a genuine unexpected version change is still denied. VERIFY:
  `node --test scripts/test/rails-guard-ci.test.mjs
  --test-name-pattern='formatVersion'` exits 0.

- **AC15 — authoring never starts (premortem F3).** `adlc ticket create` output
  contains no `started` field for any input, including one that supplies it.
  VERIFY: `node --test packages/tickets/test/*.test.mjs
  --test-name-pattern='create never starts'` exits 0.

- **AC11 — no regression, and the real union shrinks correctly.** `npm test`
  exits 0, and the computed rail union on this repo is unchanged for started
  tickets. VERIFY: `npm test` exits 0.

- **AC12 — decision recorded.** An ADR under `docs/adr/` states the
  `[start, completion]` window and the "no new unfreeze privilege" argument, and
  is referenced from the union comment in `rails-guard-ci.mjs`. VERIFY: the ADR
  file exists and `grep` finds its number in `scripts/rails-guard-ci.mjs`.

## Out of scope

- Migrating existing tickets. Every ticket in the store today predates `started`;
  they are handled by the completion ceremony (#141 / PR #285), not by
  backfilling a start flag onto shipped work.
- Deriving start from the gate-manifest. The manifest is explicitly not trusted
  by this gate (rails-guard-ci.mjs:318-320 — no signing key, and append-only does
  not stop a two-PR forged append). Start must live in the ticket store, where
  `assertBaseTicketContractsPreserved` already protects it.
- Deriving start from the diff (rails bind once a PR touches the ticket's
  `scope`). Rejected: the rail file is normally *inside* scope, so this
  reintroduces Harm A exactly.
