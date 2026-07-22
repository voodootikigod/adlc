# Trust-root change ceremony: an authorized path CI recognizes, not an admin override

Closes #141.

## Problem

Landing a legitimate change to a trust root means driving a required check red on
purpose and clicking admin-merge. The audit trail records that someone used
`--admin`; it records nothing about *this change having been reviewed and
authorized*. Worse, it trains operators to override a red security gate, which is
the reflex the gate exists to prevent.

### The precise gap

`assertBaseTicketContractsPreserved` (rails-guard-ci.mjs:154-163) denies any field
change to an existing base ticket. There is already one narrow exemption, and it
is deliberately scoped to exclude the case that matters
(rails-guard-ci.mjs:145-152):

```js
function isCompletionAnnotationOnly(baseTicket, headTicket) {
  const baseRails = Array.isArray(baseTicket.rails) ? baseTicket.rails : [];
  if (baseRails.length > 0) return false;  // railed → could unfreeze → not exempt
  ...
```

A **rails-less** ticket may be completed in an ordinary PR, because completing it
grants zero privilege — there is nothing to unfreeze. A **railed** ticket may
not, because completing it expires rails. That reasoning is correct and must not
be relaxed. The consequence is that the completion ceremony — the one operation
that clears rail drift — is structurally impossible on the normal path.

Live instance, 2026-07-22. PR #285 completes twelve shipped railed tickets. Every
check passes except `rails-guard`, reproduced locally:

```
$ node scripts/rails-guard-ci.mjs origin/main
rails-guard-ci: base ticket T-01KXPD8KJ9H6M6DFA83Y82A1Z1 contract cannot change
in .adlc/tickets.json in a PR
```

This is the gate working as designed. There is no way to express "authorized" to
it, so the only exit is admin-merge — the fourth time (#199, #221, #227, #285).

### Why the drift is not self-limiting

The active rail union on `main` at 1.6.0 is 30 paths, and all 30 belong to
already-shipped tickets. Rails can only be cleared through a ceremony that can
only land by overriding a red check, so the friction on clearing drift is
strictly higher than the friction on creating it. The union ratchets upward.
That is the structural reason this matters beyond audit-trail hygiene.

## Build

The authorization signal must satisfy four properties. Each rules out an
otherwise-obvious design:

1. **Unforgeable by the PR.** For `pull_request`, the workflow definition comes
   from the PR head, so a PR can rewrite its own authorizer. This is why
   `docs/ci/rails-guard.yml` is hash-pinned in
   `scripts/test/rails-guard-workflow-hashes.json`.
2. **Not self-applicable — where that is achievable.** The PR author must not be
   able to authorize their own trust-root change *whenever another eligible owner
   exists*. On a single-owner repository this property is unreachable (see B1:
   GitHub forbids self-approval outright), so it is enforced conditionally rather
   than assumed. Writing it as an absolute is what made the first draft of this
   spec authorize nothing.
3. **Bound to a revision.** Approve → CI green → push must not stay authorized.
4. **No signing key in PR CI.** Manifest-signature approaches were rejected for
   exactly this reason in the #104/T36 discussion; do not reintroduce them.

### Design

**A. A separate authorizer workflow.** Add `.github/workflows/trust-root-auth.yml`
on `pull_request_target` (types `labeled`, `unlabeled`, `synchronize`,
`reopened`) plus `pull_request_review`. `pull_request_target` runs the **base
branch's** definition, satisfying property 1 without a second hash fixture.

It **must not check out or execute PR code** — API calls only. That is the one
rule that makes `pull_request_target` safe, and it should be stated in the
workflow header the way the `persist-credentials: false` rationale is in
`ceremony-drift.yml`. Permissions: `pull-requests: read`, `checks: write`,
nothing else.

It asserts all of:

- the `trust-root-change` label is present;
- the actor who applied it (issue timeline API, `labeled` event) is a CODEOWNER
  for the changed trust-root path;
- the label event's SHA is the current head SHA — re-applied on every push, so
  authorization cannot survive a `synchronize` (property 3);
- **in multi-owner mode only** (see B2): the applier is not the PR author, and an
  `APPROVED` review exists from a CODEOWNER who is not the author, whose
  `commit_id` equals the current head SHA (property 2).

then publishes a check run `trust-root-authorized` against that head SHA —
`success` when all hold, `failure` otherwise, with the reason in the summary.

**B. Teach `rails-guard-ci.mjs` the authorized path — re-deriving, not trusting
a flag.** Where it would `deny()` for a trust-root reason, it authorizes only if
it can itself confirm the underlying facts.

> **This is the load-bearing decision, and the obvious design is wrong.** The
> tempting version — "look for a `success` check run named
> `trust-root-authorized` on this SHA" — is forgeable. For a same-repo PR,
> `GITHUB_TOKEN` carries `checks: write` by default, so a PR can add a workflow
> step that creates a check run with that exact name on its own head SHA and
> authorize itself. A check-run name is not an authorization; it is a string any
> writer can produce.
>
> So the check run is a **cache, never the authority**. `rails-guard-ci.mjs`
> re-queries the label applier and the approving reviewer through the API and
> re-derives the decision. If it also reads the check run, it must additionally
> pin the producing `app.id` **and** the originating workflow path — and even
> then the re-derivation is what authorizes.

Found and re-derived → record to the gate manifest and exit 0. Absent, failed,
bound to a different SHA, or contradicted by re-derivation → deny exactly as
today. Fail closed on any API error: an unreachable API is not authorization.

**B0. CODEOWNERS defines the eligible set.** Added by this work, covering
`scripts/rails-guard-ci.mjs`, `scripts/test/rails-guard-ci.test.mjs`,
`docs/ci/rails-guard.yml`, `scripts/test/rails-guard-workflow-hashes.json`, and
`.adlc/tickets.json`. It documents the trust surface independently of whether the
ceremony is built — an unowned trust root is a gap either way.

**B1. Separation of duties is NOT available here, and the spec must not pretend
otherwise.** This repository has exactly one collaborator
(`gh api repos/voodootikigod/adlc/collaborators` → `voodootikigod`, admin; 192 of
the last 200 commits by one author). Two clauses in the original draft of this
spec were therefore unsatisfiable:

- *"the label applier is not the PR author"* — there is nobody else to apply it.
- *"an `APPROVED` review from a user who is not the author"* — **GitHub
  structurally forbids approving your own pull request.** Not a policy toggle;
  it cannot be done.

As drafted, this ceremony would authorize nothing, leaving a red check with *no*
path through it — strictly worse than the admin override it replaces. The
requirement must scale with the size of the eligible set, not assume it.

What separation of duties would have bought is genuinely unavailable, and no
design recovers it; a second identity the same person controls is theatre, not a
control. What remains available, and is the actual justification for building
this:

- the required check stays **green**, so operators are not trained to override a
  red gate — the primary harm in #141;
- authorization is **revision-bound** — it names a SHA, and pushing invalidates
  it, which an admin click has no notion of;
- it is **recorded** with actor, SHA and reason, rather than an opaque
  "someone used `--admin`";
- it is **narrowly scoped** to one trust-root change, not "bypass the gate".

**B2. Authorization is CODEOWNERS, and its strictness is derived from the
eligible-owner count.** `write` covers every contributor with push access; a trust
root warrants the narrower bar #141 asked for. Beyond that, the gate computes the
number of distinct CODEOWNERS eligible for the changed path and selects a mode:

- **Single-owner mode (one eligible owner).** The owner may authorize their own
  change by applying the label. No approving review is required, because none can
  exist. The manifest entry MUST record `mode: single-owner` so the evidence never
  overstates what was verified — this is the difference between an honest audit
  trail and a misleading one.
- **Multi-owner mode (two or more).** The full rule engages automatically: the
  label applier and the approving reviewer must both be CODEOWNERS, and neither
  may be the PR author.

Mode is derived at evaluation time from the CODEOWNERS file, so adding a second
owner turns separation of duties on with no code change, no config flag, and no
migration. There is no way to select the weaker mode while a stronger one is
available — which is the property that keeps this from becoming a permanent
loophole.

**B3. Same-repo branches only.** A fork PR's head SHA does not exist in the base
repository, so a check run cannot bind to it and the review/label state cannot be
tied to a revision the base repo can resolve. A trust-root PR from a fork is
denied with an explicit "open this from a branch in this repository" message
rather than failing obscurely.

**C. Record it.** `adlc gate-manifest record trust-root-change` with the
authorizing actors, the label applier, the approving reviewer, and the SHA — so
the ceremony produces *better* evidence than the admin click it replaces, which
is the point.

**D. Require stale-review dismissal.** Property 3 depends on
`dismiss_stale_reviews` being on for `main`. Document it as a prerequisite and
assert the SHA binding in tests regardless, so the gate does not silently depend
on a setting nobody re-checks.

### Rejected alternatives

- **Signed manifest entries** — needs a key in PR CI (property 4).
- **Trusting the manifest directly** — rails-guard-ci.mjs:318-320 already
  explains why it cannot: no signing key, and append-only does not stop a two-PR
  forged append.
- **A label alone, read from the `pull_request` event payload** — self-applicable
  by any author with write access, and the payload is not re-validated against
  who applied it.
- **Widening `isCompletionAnnotationOnly` to railed tickets** — this is the hole
  the exemption was carefully written to avoid; it would let any PR unfreeze any
  rail.

## Acceptance criteria

- **AC1 — authorized railed completion passes.** A fixture PR whose only change
  adds `completed: true` to a railed base ticket, with a `trust-root-authorized`
  success check bound to its head SHA, exits 0. VERIFY: `node --test
  scripts/test/rails-guard-ci.test.mjs --test-name-pattern='authorized trust-root'`
  exits 0, and fails against the pre-fix gate.

- **AC2 — the same PR without authorization stays denied.** Identical fixture,
  no check run, exits 2 with the current message. VERIFY:
  `--test-name-pattern='unauthorized trust-root'`.

- **AC3 — authorization does not transfer across revisions.** A success check
  bound to SHA `A` does not authorize head SHA `B`. VERIFY:
  `--test-name-pattern='authorization is revision-bound'`.

- **AC4 — a failed or neutral check is not authorization.** Check runs with
  conclusion `failure`, `neutral`, `cancelled`, `skipped`, and `action_required`
  each leave the PR denied. VERIFY:
  `--test-name-pattern='only success authorizes'`.

- **AC5 — API failure fails closed.** With the check-run lookup erroring or
  timing out, the gate denies rather than allowing. VERIFY:
  `--test-name-pattern='authorization lookup fails closed'`.

- **AC6 — in multi-owner mode the author cannot authorize themselves.** With two
  or more eligible CODEOWNERS, a label applied by the PR author, or an approval
  whose reviewer is the author, emits `failure`. Both variants needed — they are
  separate checks. VERIFY: `node --test scripts/test/trust-root-auth.test.mjs
  --test-name-pattern='self-authorization'` exits 0.

- **AC7 — an actor outside CODEOWNERS cannot authorize.** Label applied, or
  approval given, by a user with `read` or even `write` permission who matches no
  CODEOWNERS entry for the changed path → `failure`. VERIFY:
  `--test-name-pattern='requires code ownership'`.

- **AC18 — mode is derived from the eligible-owner count, and only ever
  ratchets up.** With one eligible CODEOWNER the owner may self-authorize by
  label and no review is required; with a second owner added to CODEOWNERS and
  nothing else changed, the identical PR now requires a distinct applier and an
  approving review. No flag, env var, or ticket field can select single-owner
  mode while two or more owners are eligible — that would make the weaker mode a
  permanent loophole. VERIFY: `node --test scripts/test/trust-root-auth.test.mjs
  --test-name-pattern='owner-count mode'` exits 0, with a case per direction and
  a case asserting the weaker mode is unselectable.

- **AC19 — single-owner authorization is recorded as such.** The manifest entry
  for an authorization granted in single-owner mode carries `mode: single-owner`
  and no reviewer field, so the evidence never implies a second pair of eyes that
  did not exist. An entry claiming a reviewer in single-owner mode is a defect.
  VERIFY: `--test-name-pattern='single-owner evidence is honest'`.

- **AC8 — the authorizer never executes PR code.** `trust-root-auth.yml`
  contains no `actions/checkout`, no `run:` step that executes anything from the
  PR, and requests only `pull-requests: read` and `checks: write`. This is the
  `pull_request_target` safety property and must be asserted statically, not
  reviewed by eye. VERIFY: `node --test scripts/test/trust-root-auth.test.mjs
  --test-name-pattern='authorizer takes no PR code'` exits 0.

- **AC9 — the ceremony is recorded.** After an authorized run, `adlc
  gate-manifest show` contains a `trust-root-change` entry naming the label
  applier, the approving reviewer, and the SHA. VERIFY:
  `--test-name-pattern='ceremony recorded'`.

- **AC10 — the live instance, end to end.** PR #285's exact diff passes under the
  ceremony with authorization and fails without it. This is the change that
  motivated the work; a fixture that resembles it is not sufficient. VERIFY: a
  test replaying #285's ticket-store diff against both states, asserted in
  `scripts/test/rails-guard-ci.test.mjs`.

- **AC13 — a forged check run does not authorize (premortem F5).** A
  `trust-root-authorized` success check run created by an actor other than the
  authorizer workflow — same name, same SHA, correct conclusion, but no
  underlying CODEOWNERS label/approval — leaves the PR denied. This is the
  headline attack; without this case the feature is a self-service unfreeze.
  VERIFY: `node --test scripts/test/rails-guard-ci.test.mjs
  --test-name-pattern='forged authorization check'` exits 0.

- **AC14 — authorization is re-derived, not read.** With the check run absent but
  a valid CODEOWNERS label and approval present, the gate still authorizes;
  with the check run present but the label applier no longer a CODEOWNER, it
  denies. Together these prove the check run is a cache and not the authority.
  VERIFY: `--test-name-pattern='authorization is re-derived'`.

- **AC17 — CODEOWNERS exists and covers every trust root (B0).** A
  `CODEOWNERS` file exists and every trust-root path this ceremony can authorize
  is matched by an entry; a trust root with no owner is a configuration error the
  gate reports rather than silently treating as unauthorizable. VERIFY:
  `node --test scripts/test/trust-root-auth.test.mjs
  --test-name-pattern='every trust root has an owner'` exits 0.

- **AC15 — CODEOWNERS, not write (premortem F6).** A label applier or approver
  with `write` permission who matches no CODEOWNERS entry for the changed path
  does not authorize. VERIFY: `node --test scripts/test/trust-root-auth.test.mjs
  --test-name-pattern='codeowners required'` exits 0.

- **AC16 — fork PRs are refused explicitly (premortem F7).** A trust-root change
  proposed from a fork exits 2 with a message naming the same-repo requirement,
  not with an internal error. VERIFY:
  `--test-name-pattern='fork trust-root refused'`.

- **AC11 — no regression in the existing deny paths.** Every current
  `assertBaseTicketContractsPreserved` denial (removal, field change, rails
  change, non-`true` completion) still denies with no authorization present.
  VERIFY: existing cases in `scripts/test/rails-guard-ci.test.mjs` continue to
  pass; `npm test` exits 0.

- **AC12 — decision recorded.** An ADR under `docs/adr/` states the four
  properties, why `pull_request_target` is used and why it takes no PR code, and
  the rejected alternatives. VERIFY: the ADR exists and is referenced from
  `trust-root-auth.yml`'s header.

## Out of scope

- Replacing `ADLC_RAILS_BYPASS`. The in-session audited bypass stays; this adds
  a reviewer-gated CI path alongside it.
- Applying the ceremony to trust roots beyond the ticket-store contract
  (`rails-guard-ci.mjs` itself, `docs/ci/rails-guard.yml`, the hash fixture).
  The mechanism is built to generalize, but each additional root needs its own
  threat argument and should land separately.
- Branch-protection configuration itself, which is a repo setting rather than
  code. Documented as a prerequisite (design D) and asserted only indirectly.
