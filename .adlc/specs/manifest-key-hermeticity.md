# Spec: ADLC_MANIFEST_KEY hermeticity — make the exported key harmless

Status: v8. Review provenance lives in the pull requests that landed this file, not here:
a spec is normative text for builders, and embedded approval or convergence claims would
function as instructions to downstream reviewers — exactly the authority-smuggling this
spec's own verifier contract is designed to reject. Inline finding references below cite
the reasoning that produced a clause, never a verdict about the whole.
Repo: voodootikigod/adlc
Related: #398 (ambient-state hermeticity guard), #370 (record-cross-model fail-closed), PR #399/#400 (first two instances of the ambient-state class)

## 1. Problem statement

`ADLC_MANIFEST_KEY` is the HMAC-SHA256 signing key for the manifest ledger
(`.adlc/manifest.jsonl` plus forest segments), the trust root of the gate system. It plays
three roles with incompatible environmental needs:

| Role | Where | Environmental need |
|---|---|---|
| Sign | `adlc-prosecute record-cross-model`; ticket lifecycle evidence (`adlc ticket complete/update --authorize`) | Key MUST be present AND correct; absence or mismatch must fail loudly, before writing |
| Verify | `tier-check`, `gate-manifest verify`, `ticket doctor` | Key must come only from a trusted channel (CI secret env, operator shell) — never from the tree under verification |
| Absent | Most tests; most local dev | Both key-present and key-absent code branches must be constructible deterministically |

Observed failures (2026-07-29, all measured):

- With the key exported in the operator's shell, `node scripts/run-tests.mjs gate-manifest
  tickets` fails 0/2 segments; with the variable deleted, 2/2 pass.
  - `packages/gate-manifest/test/gate-manifest.test.mjs:339` — `repairChain` throws
    "manifest contains 1 unsigned entry; repair would cryptographically attest them"
    on a fixture built for the no-key branch.
  - `packages/tickets/test/doctor.test.mjs:144` — asserts "without a key the checkpoint is
    not authenticated"; the checkpoint WAS authenticated (by the shell's key).
- Historically (pre-#370), a MISSING key during `record-cross-model` produced a
  silently-unsigned, inert manifest entry that reported success and failed only later in CI.
  #370 made that path fail closed on ABSENCE. Two gaps remain:
  - the equivalent absence trap is still open in `packages/tickets/lib/evidence.mjs:106`
    (`if (key) entry.sig = sign(key, entry)` — else writes unsigned, silently), and
  - NO writer anywhere checks the key is CORRECT: a stale or wrong-repo key signs an entry
    that reports success locally and is rejected later by CI under the real secret — the
    same delayed-failure shape as the unsigned trap, through a different door.

## 2. Root cause

Not "the operator exported the key." Four LIBRARY functions read `process.env` ambiently at
depth, so every caller — tests included — inherits an invisible input they cannot override:

- `packages/gate-manifest/lib/repair.mjs:85` — `const key = getKey();`
- `packages/gate-manifest/lib/verify.mjs:227` — `const key = getKey();`
- `packages/gate-manifest/lib/record.mjs:72` — `const key = getKey();`
- `packages/tickets/lib/evidence.mjs:106` — raw `process.env.ADLC_MANIFEST_KEY`

Bins reading env is correct — a CLI's contract is its environment
(`packages/prosecute/bin/adlc-prosecute.mjs:274,386,467` are fine). Libraries doing it is
the defect. The repo already applies the right idiom elsewhere (`defaultBase(env)`,
`isCIEnv(env)`, `loadManifestKeyFromEnvLocal({env})`).

Two asymmetries shape the design:

1. **The leak class is local-only.** CI test jobs never receive the secret — only two steps
   of `.github/workflows/cross-model-gate.yml` (lines 143, 174) get
   `secrets.ADLC_MANIFEST_KEY`. CI stays green while local runs break, landing the whole
   diagnostic cost on the person asking "is my change broken?"
2. **The quiet failures are worse than the loud ones.** A leaked key fails loudly (test
   assertions). A missing key writes inert unsigned evidence; a WRONG key writes
   confidently-signed-but-unverifiable evidence. Both report success and surface later in
   CI pointing at a step that looked complete.

## 3. Design principle and invariants

**Make the exported key harmless rather than policing the shell.** The operator keeps the
key exported in fish — it is what makes signing frictionless. The system guarantees:

- (P1) A set key never changes the outcome of any operation that did not explicitly
  receive it. Libraries have NO ambient fallback; only bins resolve the environment.
- (P2) A signing operation in a signing-required store never succeeds without a key that
  provably authenticates the existing ledger. Refusal happens BEFORE any write.
- (P3) A verifying operation never sources a key from the tree it verifies (already
  enforced by `load-env-local.mjs` rules 0 and 3; this spec must not weaken it — in
  particular, no operator-facing message may instruct shell-sourcing a repository file).

## 4. Layers

### Layer 1 — scrub the key in the test runner

`scripts/run-tests.mjs` DELETES `ADLC_MANIFEST_KEY` from the env passed to every spawned
test segment, and prints a one-line notice when it did:

```
note: ADLC_MANIFEST_KEY was set in your shell — scrubbed for test segments
```

- Delete NON-EMPTY values only; an explicitly-empty `ADLC_MANIFEST_KEY=''` is PRESERVED.
  `load-env-local.mjs` rule 2 makes empty a deliberate fail-closed that beats the file
  loader; deleting it would convert the operator's "never fall back to a file key" into
  absence and re-enable `.env.local` fallback in any spawned bin (round-2 finding 6).
  Deleting a non-empty value reproduces "operator never exported it"; preserving an empty
  one honors "operator explicitly disabled key resolution." Both states are deterministic
  for tests.
- Tests that need a key already set their own inline
  (`prosecute-tier-check-cli.test.mjs:25` sets a literal test key). No migration needed.
- `npm run preflight` drives the same runner → preflight becomes immune.
- Same mechanism carries #398's `RAILS_BASE`/`BASE_REF` scrub.
- Limit: direct `node --test <file>` still inherits the shell → Layer 2.

### Layer 2 — the key is an explicit, required parameter at the library boundary

The four ambient readers change signature: `key` becomes a REQUIRED parameter with NO
default, validated at the shared boundary:

- a NON-EMPTY string → a key;
- `null` → "no key, deterministically";
- `undefined` (omission, or `{ ...opts, key: undefined }`) → programming error, THROWS —
  never falls back to the environment;
- `''` or any non-string → THROWS (round-2 finding 5: an empty string must never reach
  the HMAC — a zero-length key is publicly guessable, and empty already means
  "deliberate fail-closed" everywhere else in this system, so a lib treating it as a
  usable key would invert its meaning).

One validation helper owns this contract and every writer AND verifier goes through it.
Its ownership boundary is publishable AND layering-safe (post-commit diff review, both
rounds): the dependency graph already runs `@adlc/gate-manifest` → `@adlc/core` →
`@adlc/tickets`, and the tickets package deliberately duplicates signature logic today
precisely because importing gate-manifest would close that loop. So the primitive lives
in a LEAF layer that imports neither core nor tickets — a new leaf module/package, or
within tickets itself (which everything above it can already reach) — and a
`@adlc/tickets` → `@adlc/gate-manifest` dependency is FORBIDDEN. Whichever home is
chosen, every consumer DECLARES the dependency in its package manifest (workspace
hoisting is not resolution — a deep sibling import that works in the monorepo fails a
standalone install), and a conformance test resolves the helper through the declared
graph. If duplication is retained instead, both implementations are pinned to shared
conformance vectors so they cannot drift.

- `repairChain({ ..., key })`, the verify path in `verify.mjs`, the record path in
  `record.mjs`, and the evidence writer in `evidence.mjs` (threaded from `doctor.mjs` and
  the ticket lifecycle commands).
- Environment resolution (`getKey()`, `loadManifestKeyFromEnvLocal`) happens ONLY in bins,
  once, at the top; the resolved value is threaded down.
- The four sites are where the AMBIENT READS live; the CALLERS are a wider set (the
  post-commit diff review found production call chains into `record`/`appendManifestEntry`
  from build-gate, coldstart, parallax, premortem, rails-guard, runner, and prosecute/run,
  all currently omitting `key`). The change therefore begins with an INVENTORY of every
  caller of the four functions, recorded in the implementing PR; every chain gets an
  explicitly resolved key threaded from its bin, and every affected package's CLI gains a
  regression test proving its command still records/verifies. Scoping the change to the
  four definitions alone would convert working CLIs into throw sites.
- `cross-model.mjs`'s existing `key = getKey()` default parameters migrate to the same
  required contract in the same change, so one idiom governs the whole surface.
- This is a BREAKING change to the exported package APIs and is released as such (round-2
  finding 7): the implementation ticket audits the actual exported surface of the affected
  packages; anything reachable by an external consumer ships under the project's
  breaking-change release level with migration guidance, and anything that should never
  have been public is removed from exports with the internal boundary documented. A
  changelog entry on a minor bump is NOT sufficient. The bins' CLI contracts are unchanged
  either way.
- Tests construct branches by passing `key: null` or a literal — never by mutating env.

### Layer 3 — signing-required stores fail closed, before writing, on absent OR wrong keys

**Adoption record: an explicit config commitment carrying a key fingerprint.**
`.adlc/config.json` gains:

```json
"signing": {
  "schemaVersion": 1,
  "keyFingerprint": "<sha256(utf8 bytes of key)>",
  "generation": "<generation id>"
}
```

The record is VERSIONED and is also the GENERATION DESCRIPTOR (post-commit diff review):
`generation` names the active immutable forest generation, resolved through a CONFINED
layout — generation id `0` (or the field absent on a legacy record) means the historical
in-place files (`.adlc/manifest.jsonl` + existing segments); any other id resolves to
`.adlc/manifest-generations/<id>/` carrying the same root+segment layout. Ids are
validated (no path separators or traversal — the id is a path COMPONENT, never a path),
symlinks are not followed, and the pending-transaction marker schema is versioned
alongside. Every reader and writer resolves the generation through this one descriptor;
an end-to-end test proves all entrypoints (verify, tier-check, doctor, every writer)
resolve the SAME forest before and after a swap. Without this, "atomic descriptor swap"
would name no mechanism: readers could keep opening the old path while writers publish
to a new one.

The descriptor's consumers are not just the gate tools (post-commit diff review): direct
manifest reads, writes, lock paths, and revision-ignore lists are hard-coded across
model-router, ticket-sync, runner, fleet, and build-gate today. Implementation therefore
BEGINS with an inventory of every direct consumer, and they resolve through ONE shared
descriptor-aware resolver placed in the same leaf layer as the validation helper (the
graph runs gate-manifest → core → tickets, so a resolver above tickets is unreachable
from tickets without a cycle). Regression tests cover each consumer package: after
adoption, none reads stale legacy history, misses new evidence, or folds
active-generation artifacts into a revision identity.

TRACKING CONTRACT (post-commit diff review, verified with `git check-ignore`): the root
`.gitignore` blanket-ignores `.adlc/*`, so without an explicit negation the authoritative
generation directory would be silently unstageable — a transition would work locally
while ordinary `git add` omitted the active ledger, and CI or a fresh clone would see no
manifest at all. The root `.gitignore` gains `!.adlc/manifest-generations/` (and
descendants), every init/scaffold/migration emitter that writes gitignore rules is
updated identically, and a test adopts, rotates, stages normally, and asserts the
committed tree contains the complete active generation.

**Presence of this record IS required-mode — there is no mutable boolean (round-5
finding 4).** An earlier draft carried `"required": true`, which invited the downgrade
that keeps the record and fingerprint but flips the flag, and created an internal
inconsistency between writer (flag-driven) and verifier (presence-driven) behavior.
Eliminated: record present → signing required, for writers and verifiers identically.
Suspension is REMOVAL of the record — a separately authorized transition that the
base-run required-mode assertion fails for this repository. A direct
tamper test flips nothing (there is nothing to flip) and instead deletes the record,
which the gate catches.

Signature presence in the ledger is never consulted for policy — signatures are
strippable by anyone who can rewrite the file (the chain is keyless; `sign.mjs`'s own
header states forgeability without the key). The fingerprint is a one-way commitment to
the adopted key. It gives every writer and verifier a trusted local anchor that exists
FROM THE MOMENT OF ADOPTION — which eliminates the round-2 finding-3 residual entirely:
there is no anchorless branch, because the fingerprint is the anchor. A wrong, stale, or
other-repo key fails the fingerprint check on the FIRST write, before anything is
appended, empty ledger or not. It also makes stripped-signature history harmless to
policy: a tampered ledger cannot un-adopt a store, because adoption never lived in the
ledger.

**The key is GENERATED, never accepted (round-3 finding 2; round-4 finding 2).** A
published fingerprint of a weak key is an offline guessing oracle, and a length check is
not an entropy floor — repeated characters and memorable passphrases pass it. So the
adoption and rotation ceremonies do not take a key at all: an `adlc` subcommand generates
it internally (CSPRNG, 32 random bytes hex-encoded — 64 chars) and hands it off WITHOUT
EVER WRITING IT TO STDOUT, STDERR, OR ANY LOG. This repo has already had this exact
incident — a key echoed into a session transcript (see the
`scripts/block-secret-exposure.mjs` header) — and a ceremony that prints the key would
re-create it as a designed-in step; agent harnesses and CI both capture stdout. The
handoff is a mode-0600 file at an operator-chosen path OUTSIDE the repository (the path
is printed; the contents never are), from which the operator stores the key (secret
manager + GitHub secret) and deletes the file; the custody-checkpoint re-entry reads with
terminal echo disabled. The ceremony then writes the fingerprint.
Caller-supplied keys are refused on the normal path; importing a pre-existing key is an
explicit, audited exception flag whose use the doctor reports. The fingerprint hashes the
exact UTF-8 bytes the generator emitted — the same bytes `createHmac('sha256', key)`
consumes — so there is no canonicalization gap between commitment and use. (Note: any
signed entry was already an equivalent offline oracle for a weak key — HMAC outputs are
public in the ledger — so the fingerprint adds marginal exposure only for the
empty-ledger window; generated keys close both.)

**Anti-rollback: the forest is append-only against the trusted base (round-3 finding 1,
CRITICAL).** A fingerprint commits to the KEY, not to history: restoring the entire forest
to an earlier self-consistent signed revision passes every signature check. The repo
already has the answer for its other ledger — `guard-findings-ledger-append-only`
(preflight gate 5, ADR 0014) enforces that `.adlc/findings.jsonl` is only ever extended
relative to `origin/main`. That exact pattern extends to the manifest forest: in CI (and
in the local preflight gate), the BASE revision's ledger — root and every segment — must
be an exact prefix of the candidate's, and no segment present at base may vanish. A
coherent rollback therefore fails the gate even though every surviving signature
verifies. There is exactly ONE sanctioned non-extension: a key-rotating transition
(below). Every history rewrite ROTATES THE KEY (round-4 finding 1) — same-key repair does
not exist, so no in-tree marker ever needs to authorize its own exception, and the gate's
rule is a two-arm disjunction with no judgment calls:

- candidate forest extends base forest (normal case), OR
- the fingerprint CHANGED, `sha256(CURRENT KEY)` — the parsed FIRST entry of the keyring payload, never a hash of the raw payload — matches the NEW fingerprint, the full
  candidate forest verifies under the new key, AND the candidate is a LOSSLESS SEMANTIC
  TRANSFORMATION of the current base forest (round-5 finding 1; comparator corrected per
  round-6 finding 1 and the post-commit diff review): entry-for-entry, the candidate must
  equal the base sequence under a RECURSIVE SEMANTIC PROJECTION defined by exclusion, not
  enumeration — it PRESERVES every field it does not explicitly name as derived, so an
  unlisted or future top-level payload field is compared, never silently droppable. The
  derived transition fields, recomputed by re-signing and therefore EXCLUDED from
  comparison, are exactly: `sig`, `sigVersion`, `prev`, and `anchor.lineHash`. The rest
  of an anchor — `anchor.segment`, `anchor.seq`, and any other anchor field — IS
  compared: forest topology (which segment anchors where) must survive rotation intact,
  while `anchor.lineHash` cannot, because it hashes the parent entry's exact RAW line and
  re-signing the parent changes that line. `prev` is excluded for the same reason: it
  hashes the previous RAW line including that entry's HMAC, so re-signing entry N
  necessarily changes entry N+1's `prev` — a byte-level "minus sig" comparison would
  reject every legitimate rotation of a multi-entry ledger. Integrity of the rebuilt
  `prev` and `anchor.lineHash` values is not lost by excluding them here: it is enforced
  by the independent full verification of the candidate forest, which recomputes and
  checks the whole chain and every anchor under the new key. SIGNATURE-VERSION HANDLING
  IS MONOTONIC (post-commit diff review): `sigVersion` is excluded from the payload
  comparison but constrained separately — every rebuilt entry is signed as v2 (v2 signs
  every field; the legacy v1 form authenticates only a fixed subset, so a v2→v1 rewrite
  would silently de-authenticate anchors and future metadata). A candidate carrying a v1
  entry where the base entry was v2 FAILS arm 2; v1→v2 upgrade is the only permitted
  version change, and a malicious-downgrade rotation fixture is a required negative test.
  Negative tests prove payload mutation, reordering, topology change (including anchor
  redirection — `anchor.segment`/`anchor.seq` edits), mutation of a non-enumerated
  top-level field, and truncation all fail the projection comparison; positive tests
  cover multi-entry root AND anchored multi-segment forests for both rotation and
  initial adoption.

The lossless-transformation clause is what stops authorization replay: without it, a
second PR could copy a legitimate rotation's newly-signed generation, truncate a valid
suffix, keep the new fingerprint, and pass arm 2 during the window when the base still
carries the old fingerprint. With it, any truncation or entry mutation fails the
entry-for-entry comparison against base, and a stale candidate built against an older
base fails when base advances (rebuild required — also the desired behavior). A coherent
rollback keeps the old fingerprint → fails arm 1 (not an extension) and arm 2
(fingerprint unchanged). Git remains the durability substrate; branch protection on main
is what makes "base" trustworthy, unchanged from today.

**Enforcement does not rely on the tree being honest about itself (round-2 finding 1;
bootstrap per round-3 finding 4).** The config record alone is downgradeable by an
ordinary edit, however visible. Independent controls make a downgrade a failure rather
than an off-switch, and none of them is introduced by the same PR it must judge:

- The trusted anchor is the CI SECRET, not a workflow-pinned fingerprint. The gate
  workflow (already the only holder of `secrets.ADLC_MANIFEST_KEY`, and already executed
  from the BASE checkout, never PR code) checks `sha256(CURRENT KEY)` — the parsed first keyring entry, never the raw secret payload — against the candidate
  tree's `keyFingerprint`. The secret lives entirely outside every PR tree — it IS the
  independent commitment, and no bootstrap paradox arises because the base workflow needs
  no knowledge of the candidate's pin: it compares the candidate against a value only
  admins can set.
- A small required-mode assertion (this repository must carry an adoption record) is added
  to the base-run gate workflow in its OWN PR, BEFORE the adoption PR, and is inert while
  no adoption record exists. The adoption PR is then judged by already-active, already-
  trusted logic (round-3 finding 4: the checker must predate what it checks). A later PR
  deleting the adoption record fails this assertion.
- Verifier-side enforcement (next paragraph) rejects the states a downgrade would try to
  legitimize. Rails freezing of `.adlc/config.json` remains as the local, advisory layer.

**Verifier contract (round-2 finding 2) — writers are not the trust boundary.** Every
verification entrypoint (`gate-manifest verify`, `tier-check`, `ticket doctor`) applies
required-mode when the adoption record is present:

- key `null` in a context that must authenticate → FAIL (not "skip authentication");
- candidate key not matching `keyFingerprint` → FAIL, "wrong key" named explicitly;
- any unsigned, invalid-signature, or gap entry at or after adoption → FAIL;
- unsigned SUFFIX after signed history → FAIL (tampering-indistinguishable, round-2
  finding 4 — a well-formed keyless suffix is neither unreadable nor corrupt and must be
  caught by policy, not by parsing);
- missing, orphaned, truncated, or unreadable forest segments → FAIL;
- adoption record present but fingerprint malformed/absent → FAIL.

Direct-tampering tests (hand-edited ledger, stripped sigs, unsigned suffix, deleted
segment) run against the VERIFIERS, independent of any writer. Old writers and
version-skewed consumers may still append unsigned garbage; the verifiers make that state
loud instead of latent.

**Writer contract** when the adoption record is present (all signing writers — the evidence
writer, `record.mjs`, `record-cross-model` — through one shared helper):

1. `key === null` → REFUSE. Non-zero exit, nothing written. The error names the variable
   and points at the hardened loading paths: the automatic `.env.local` loader on the
   record path (`load-env-local.mjs`, which READS the file — it never executes it), or an
   export from a location the operator already trusts. It must NOT instruct shell-sourcing
   any repository-relative file (P3; round-1 finding 1).
2. `sha256(key) !== keyFingerprint` → REFUSE, nothing written. Error distinguishes "wrong
   key" from "no key" and names the sanctioned rotation path (update the fingerprint and
   re-sign history via `gate-manifest repair-chain` — a rails-tiered, CI-pinned change,
   per the rotation note in Non-goals).
3. Fingerprint matches → run the full required-mode FOREST verification (the verifier
   contract above) inside the critical section. Any failure → REFUSE, nothing written.
   This is what catches an unsigned suffix or orphan branch BEFORE the writer commits new
   signed history on top of unauthenticated state (round-2 finding 4). Ledgers are small
   (~10² entries); a verify pass per signing write is cheap.
4. All checks pass → append.

**Atomicity — the lock covers policy, not just the append (round-3 finding 5).** EVERY
writer — including the keyless legacy path — reads the adoption record inside the same
manifest-lock critical section that guards its append; steps 2–4 (fingerprint check,
forest verification, append) run in that section too. Adoption, suspension, rotation, and
repair acquire the same lock exclusively, so a keyless writer cannot read "unadopted",
lose the CPU to a migration installing the adoption record, and then land a legacy
unsigned append into a now-required store. Tests pin both races: keyed-vs-keyless in a
required store, AND adoption-installation-vs-legacy-writer during the transition.
(The evidence writer already serializes appends through a lock wrapper; implementation
verifies its scope and extends it to the config read if needed.)

**Trust-state transitions are generation-switched transactions (round-3 finding 3;
round-4 findings 1, 3, 4).** `repair-chain` is the one writer authorized to rewrite
history, it always rotates the key (see the gate disjunction above), and it is inside
this contract, not exempt from it.

*Publication model:* forest generations are IMMUTABLE — a transition never edits files of
the live generation in place. It builds a complete new generation off-path, and the
single atomically-replaced adoption record (one file, one rename) is the descriptor that
names the active generation and carries its fingerprint. "Which generation is
authoritative" is therefore answered by one atomic filesystem operation, not by the
relative progress of N file writes. Every reader and writer — verifiers included — checks
for a pending transaction marker under the lock BEFORE observing state, and completes
recovery (roll back to the intact old generation, or roll forward a fully-built,
fully-verified new one; both idempotent) before proceeding. THE LOCK ITSELF MUST SURVIVE
A HARD CRASH (post-commit diff review): an exclusive-created lockfile whose removal lives
in process-local `finally` cleanup makes recovery unreachable after SIGKILL, host death,
or power loss — every later process times out before it can even inspect the marker. The
transition lock is therefore stable and generation-independent, with safe stale-owner
reclamation (owner pid + liveness probe + bounded takeover, or an OS-backed advisory
lock) proven by OUT-OF-PROCESS SIGKILL tests at every commit point: a fresh process must
reclaim, recover, and proceed, and two live owners must be impossible. An exception-based
fault injector that still runs `finally` does NOT satisfy these tests. A crash between marker and
descriptor-swap leaves the old generation authoritative; after the swap, the new one.
Interruption is tested at each commit point; no observable mixed-generation state exists.

*Rotation/repair transition:* under the exclusive lock — validate the OLD generation
under the OLD key (full required-mode verification); generate the NEW key (ceremony
above); **complete the custody checkpoint BEFORE any descriptor swap (round-5
finding 2)**: the operator must re-enter the new key (proving it was captured, not merely
printed) and confirm the secret-manager write; until then the transaction is pending and
recoverable, with the old generation authoritative and the old key still valid — a lost
terminal loses a pending key, never an authoritative generation. Then: build and fully
verify the new generation off-path; marker; swap descriptor.

**Secret cutover is a serialized maintenance window with an explicit rollback (round-5
finding 3)** — the repo has ONE gate secret, so the interval between updating it to K2
and merging the rotation PR fails the fingerprint comparison for main and every other
PR. The rotation protocol therefore is: prepare the PR and get it green on every other
check → update the secret → re-run the gate → merge IMMEDIATELY, with no unrelated merges
inside the window. If the rotation PR cannot merge (conflict, stale base), the rollback
is instant and non-destructive: restore the old secret value — nothing on main referenced
K2 yet, so no state is stranded. For a repository at this scale a minutes-long serialized
window with a one-step rollback is proportionate; a dual-secret grace mechanism is noted
as the escalation path if multi-maintainer concurrency ever makes the freeze impractical,
and is deliberately not built now.

*Rotation must not orphan external observations (post-commit diff review).* The
protected attestation store (`adlc-attestations`) holds K1-signed observed entries, and
the gate's mirror step deliberately throws when any stored signature fails under the
supplied key — so a naive secret cutover bricks the very next gate run, and
rebootstrapping the store would discard the revocation history that closes manifest
truncation. A fingerprint cannot VERIFY anything — it is a hash of a key, not a key — so
retired-signature verification requires the retired KEYS themselves. Therefore:

- The adoption record carries `priorFingerprints`, an APPEND-ONLY list extended by every
  rotation — the TREE-SIDE commitment to which retired keys exist. It never shrinks; a
  candidate that drops or reorders it fails the gate.
- CI retains the retired keys as a KEYRING held in ONE versioned secret payload —
  `secrets.ADLC_MANIFEST_KEY` becomes an ordered list (newline-joined; FIRST entry is
  the current key, followed by the retired keys IN `priorFingerprints` ORDER — one
  canonical order, chronological by rotation, shared by both lists so no clause can
  disagree about position; a bare single key parses as a keyring of one, so every
  existing deployment keeps working unchanged). ONE parser owns this format, and every
  fingerprint comparison anywhere in this spec hashes the PARSED CURRENT KEY — never the
  raw payload. One secret is one atomic update and ONE-STEP rollback: restoring the
  previous payload restores current AND retired keys together — two coupled secrets
  would leave the keyring inconsistent with `priorFingerprints` when only one was rolled
  back. The gate cross-checks the keyring against the tree: `sha256(parsed current key)`
  must equal `keyFingerprint`, and retired keys must match `priorFingerprints`
  pairwise in that shared order — tree and keyring cannot silently diverge. Gate tests
  cover a legacy single-key payload, a multiline keyring, and a K1→K2→K3 double
  rotation. The
  rotation ceremony's custody checkpoint covers retiring the old key INTO the payload,
  not discarding it. Rollback-ordering tests exercise failure after the secret mutation
  and after the merge, proving both base and candidate gates restorable.
- OBSERVATION IDENTITY IS THE SEMANTIC PAYLOAD, NEVER THE SIGNATURE. Truncation
  enforcement and mirror deduplication identify an observed entry by the same RECURSIVE
  SEMANTIC PROJECTION defined for the rotation comparator (all fields except
  {sig, sigVersion, prev, anchor.lineHash}) — one identity primitive for both jobs. An
  identity keyed on `sig` would break at every rotation: re-signing replaces every
  signature, so each K1 observation would read as MISSING (or, if skipped, truncation
  detection would silently reopen). A store entry verifies under the keyring member
  current when it was observed. Which member that is, is recorded EXPLICITLY — new
  observations record the matched fingerprint at mirror time, and store lines predating
  this scheme are resolved by trying EVERY keyring member (order-independent, so no
  positional-inference rule can contradict any list order) with the matched fingerprint
  recorded on first successful verification. NEW writes sign under the current key only.
  The store itself is never rebuilt. The end-to-end test below runs K1→K2→K3 with
  observations created under every generation.

Required end-to-end test: a nonempty K1 store survives a K2 rotation with the mirror
step green, every observed entry still verifiable via the keyring, AND truncation
detection still firing on a rolled-back manifest — run both mirror and tier-check
against the same store across the rotation.

*Evidence paths and revision identity (post-commit diff review).* The change-set
revision (`git-change:<base>:<digest>`) already excludes the legacy manifest path so
that recording evidence does not invalidate the very revision the evidence binds. That
contract MUST follow the descriptor: all active-generation manifest artifacts
(`.adlc/manifest-generations/<id>/**`, per the descriptor) are excluded from the
revision digest and from untracked-file refusals exactly as `.adlc/manifest.jsonl` is
today, while the adoption record/descriptor itself REMAINS review-bound (a change to
policy is a change under review; a change to evidence is not). Required round-trip test:
`record-cross-model` → `tier-check` agree on the revision after adoption AND after
rotation — without this, every trust-root change would self-invalidate its own approval
the moment evidence is appended.

*Initial adoption is a DISTINCT transition (round-4 finding 4)* — there is no old key, so
the universal old-key precondition cannot apply and is not pretended to. Under the
exclusive lock: structurally validate the legacy snapshot under explicit LEGACY rules
(chain hashes intact, no gaps or orphans; signatures permitted to be absent — this is the
one context where unsigned history is being judged as legacy, not as tampering); require
the operator's affirmative unsigned-attestation authorization (`--attest-unsigned`);
generate the key; build the fully-signed generation; verify it under the new key; marker;
swap descriptor + adoption record. From that point the universal rule governs. A legacy
snapshot that fails structural validation cannot be adopted — malformed history is never
cryptographically attested.

**Refusal must be side-effect-free across COMPOUND commands (post-commit diff review).**
The ticket lifecycle commands mutate the ticket store (shards, transaction journal) and
THEN record manifest evidence; a refusal at the evidence step would otherwise strand a
mutated store with no matching evidence — the operator sees a non-zero exit and
reasonably assumes nothing changed. Therefore: in any command that both mutates the
store and records evidence, the FULL manifest-policy preflight — adoption-record read,
key validation, fingerprint check, AND the required-mode forest verification — runs
BEFORE the first store mutation, inside the same lock whose hold spans through the
evidence append, so the verified policy cannot change between preflight and append.
EVERY pre-append refusal is side-effect-free, not only the key-shaped ones: end-to-end
tests assert that on missing-key, wrong-key, AND forest-verification refusals (unsigned
suffix, truncated segment) the ticket shards, transaction journal, AND manifest are all
byte-identical to their pre-command state.

**No escape hatch for signing-required stores.** Round-1 finding 6 stands: an unsigned
write into a signing-required store either fails downstream verification (recreating
success-then-CI-failure) or forces verification to accept unauthenticated suffixes
(making deliberate exceptions indistinguishable from tampering). Neither is acceptable.
`--allow-unsigned` remains only for stores with NO adoption record and is a hard error
("this store requires signing") when the record is present. Suspending signing is an edit
to the adoption record — visible, rails-gated locally, and caught by the CI-side pin,
which is the point: it cannot happen quietly.

Stores with no adoption record: behavior unchanged (unsigned writes permitted),
preserving the general-public keyless path. A nonempty ledger WITHOUT an adoption record
is simply a not-yet-adopted store; adopting it IS the initial-adoption transition below —
one ceremony that validates legacy history, attests it under a generated key, and
activates the record atomically. Adoption of a store whose history fails legacy
validation is refused.

**Migration for this repo — two ordered PRs, checker first (round-3 finding 4).**
PR-A adds the gate-workflow checks (fingerprint-vs-secret comparison, required-mode
assertion, manifest-forest append-only guard) — all inert or trivially satisfied while no
adoption record exists. PR-B, judged by the now-active PR-A logic running from base, runs
the initial-adoption ceremony (a rails-tiered change). This repo adopts WITH a freshly
GENERATED key rather than the legacy-import exception: the current key has floated in
interactive shells and was once echoed into a session transcript (the incident that
produced `scripts/block-secret-exposure.mjs`), so rotating at adoption is hygiene, not
overhead. The admin updates `secrets.ADLC_MANIFEST_KEY` and operator shells to the
generated key; a mistyped fingerprint in PR-B fails PR-A's secret comparison BEFORE
merge, instead of bricking signing after it. `ticket doctor` gains a check: signed
entries present but no adoption record → WARN, recommending adoption. Doctor warns; the
record, the secret comparison, and the append-only guard enforce.

### Layer 4 — hygiene guard (#398)

A repo-shape lint asserting that any test file spawning an ADLC entrypoint either
neutralizes the sensitive set (`RAILS_BASE`, `BASE_REF`, `ADLC_MANIFEST_KEY`) or sets its
own value explicitly (declare-and-neutralize, NOT blanket scrub — the key is legitimately
required by some spawning tests). With Layers 1–2 landed this is a backstop against new
spawn sites, not load-bearing.

## 5. What this deletes

- Operator rule "unset ADLC_MANIFEST_KEY before local tests" — the runner does it and
  says so.
- `env -u ADLC_MANIFEST_KEY` incantations in preflight instructions and PR notes.
- The remaining silent-unsigned writer (evidence.mjs) AND the never-checked wrong-key
  path, closing both quiet-corruption doors: `ticket update --authorize` can no longer
  succeed while appending evidence CI will reject.

## 6. Non-goals

- No change to the signing scheme (HMAC canonical bytes, `sig`/`segment` exclusions,
  forest reads, chain hashing).
- No prohibition on the shell export.
- No change to CI secret handling.
- No key-rotation AUTOMATION: rotation is specified as a manual, admin-authorized
  transaction (Layer 3) — validate old state, rebuild off-path, verify, publish
  atomically, gate re-run passes only after the admin updates the CI secret. What is out
  of scope is scheduling/automating when rotations happen, not their safety contract.

## 7. Sequencing

| # | Ticket | Size | Risk |
|---|---|---|---|
| 1 | Runner scrubs non-empty key (+ notice; + the #398 base-ref set) | ~15 lines | Minimal |
| 2 | Required validated `key` param across the 4 lib sites + `cross-model.mjs` migration + key-validation helper + pin the 2 branch tests | ~6 files + tests | Medium: breaking exported API — released per breaking-change policy after an export audit |
| 3 | Adoption record (bit + fingerprint) + verifier required-mode + shared writer helper + pre-append forest verification + atomicity + CI-side pin + doctor warn + adopt in this repo | The substantive ticket | Behavioral + trust-root; needs the full matrix |
| 4 | Hygiene guard | Independent | Under #398 |

Layer 3 test matrix (writer cases all run the REAL downstream verifier against writer
output; tamper cases run against the verifiers directly, no writer involved):

Writer:
- required + no key → refuses, nothing written, correct error text (no shell-source advice)
- required + wrong key (fingerprint mismatch) → refuses, nothing written, "wrong key"
  error naming the rotation path — INCLUDING on an empty ledger (no anchorless branch)
- required + `key: ''` / `key: undefined` / non-string → throws at the validation boundary,
  nothing written, nothing signed under an empty HMAC key
- required + right key + clean forest → writes; `gate-manifest verify` passes
- required + right key + unsigned SUFFIX present → refuses (pre-append forest verification
  catches it), nothing written
- required + unreadable/truncated/orphaned forest segment → refuses
- no adoption record → unchanged unsigned behavior; verify passes legacy path
- adopting a nonempty unmigrated store → refused until `repair-chain --attest-unsigned`
- concurrent keyed vs keyless writers → consistent adoption view; never
  unsigned-into-required
- `--allow-unsigned` with an adoption record present → hard error naming the record

Verifier (direct tampering, no cooperative writer):
- stripped signatures after adoption → FAIL
- well-formed unsigned suffix appended by hand → FAIL
- deleted/orphaned forest segment → FAIL
- COHERENT ROLLBACK: entire forest restored to an earlier self-consistent signed revision,
  adoption record intact → append-only-vs-base guard FAILS the gate (every local
  signature verifies; the prefix check is what catches it)
- adoption record removed or fingerprint altered in the tree → gate FAILS
  (required-mode assertion / secret-vs-fingerprint comparison)
- verifier given wrong key vs fingerprint → FAIL naming "wrong key"

Transitions:
- caller-supplied key on the normal adoption path → REFUSED (keys are generated; legacy
  import only via the audited exception flag, and doctor reports its use)
- rotation interrupted at each commit point → old generation or complete new generation
  authoritative, never mixed; every reader/writer recovers the pending marker before
  observing state
- rotation PR before the secret update → gate FAILS; after → passes (the admin secret
  update is the authorization; arm 2 of the gate disjunction)
- coherent rollback with UNCHANGED fingerprint → fails arm 1 and arm 2
- initial adoption over structurally invalid legacy history → REFUSED, nothing attested
- adoption-record installation racing a legacy keyless writer → no unsigned entry lands
  in the now-required store (shared lock covers the config read)

Runner (Layer 1):
- non-empty key exported → scrubbed, notice printed once, suite green
- `ADLC_MANIFEST_KEY=''` exported → PRESERVED (explicit fail-closed), suite green
- absent → untouched, no notice

### Acceptance criteria

- **AC1.1** The full suite is immune to a non-empty exported key, and the scrub is
  announced exactly once.
  **VERIFY:** `ADLC_MANIFEST_KEY=leak-test node scripts/run-tests.mjs` reports all
  segments passed and prints the scrub notice exactly once;
  `node scripts/run-tests.mjs` with the var unset passes with no notice line.
- **AC1.2** An explicitly-empty key survives the scrub as the deliberate fail-closed
  state.
  **VERIFY:** `node --test scripts/test/run-tests-hermetic.test.mjs` — asserts the
  runner's child env DELETES a non-empty `ADLC_MANIFEST_KEY`, PRESERVES `''`, and
  leaves an unset var absent.
- **AC2.1** The four library entrypoints are deterministic under any shell environment.
  **VERIFY:** `ADLC_MANIFEST_KEY=x node --test packages/gate-manifest/test/gate-manifest.test.mjs packages/tickets/test/doctor.test.mjs`
  passes, and the same command with the var unset passes — same results both ways.
- **AC2.2** Omitting or malforming the key parameter is a loud programming error, never
  an ambient fallback.
  **VERIFY:** `node --test packages/gate-manifest/test/key-contract.test.mjs` — asserts
  `repairChain`/verify/record/evidence called with `key` omitted, `undefined`, `''`, or
  a non-string THROW, and with `key: null` take the no-key branch even when
  `process.env.ADLC_MANIFEST_KEY` is set.
- **AC3.1** Every writer row of the Layer 3 matrix holds, judged by the real downstream
  verifier.
  **VERIFY:** `node --test packages/gate-manifest/test/required-mode-writers.test.mjs` —
  one named case per writer row of the matrix (no key, wrong key, empty/undefined key,
  clean write, unsigned suffix, truncated segment, unadopted store, adoption of an
  unmigrated store, concurrent writers, `--allow-unsigned` refusal), each asserting
  written-vs-refused AND the subsequent `gate-manifest verify` outcome.
- **AC3.2** Every tamper row of the matrix fails verification with no cooperative writer
  involved.
  **VERIFY:** `node --test packages/gate-manifest/test/required-mode-tamper.test.mjs` —
  hand-tampered fixtures (stripped sigs, unsigned suffix, deleted segment, coherent
  rollback, record removal, wrong verifier key) each fail with the specified error class.
- **AC3.3** Transitions are crash-safe and replay-proof.
  **VERIFY:** `node --test packages/gate-manifest/test/transitions.test.mjs` — the
  Transitions rows: generated-key ceremony refuses caller-supplied keys, custody
  checkpoint precedes descriptor swap, interruption at each commit point recovers to
  old-or-complete-new generation, truncation-replay of a rotation fails the semantic
  projection, initial adoption over invalid legacy history is refused.
- **AC3.5** Every pre-append refusal is side-effect-free across compound ticket commands.
  **VERIFY:** `node --test packages/tickets/test/lifecycle-atomicity.test.mjs` — in an
  adopted store, `ticket complete --write` and `ticket update --authorize --write` under
  each refusal cause (missing key; wrong key; unsigned suffix in the forest; truncated
  segment) exit non-zero AND leave ticket shards, the transaction journal, and the
  manifest byte-identical to their pre-command state.
- **AC3.4** This repository is adopted end-to-end through the two-PR bootstrap.
  **VERIFY:** PR-A's workflow checks are green while inert (no adoption record on main);
  after PR-B merges, `adlc ticket complete <id> --write` on a scratch ticket produces
  evidence that CI's gate job verifies green, and a follow-up PR deleting the adoption
  record fails the required-mode assertion in CI.
- **AC4.1** The hygiene guard catches the class and tolerates the repaired repo.
  **VERIFY:** `node --test scripts/test/env-hermeticity-guard.test.mjs` — fails on a
  planted fixture that spawns an ADLC entrypoint inheriting `...process.env` without
  neutralizing `RAILS_BASE`/`BASE_REF`/`ADLC_MANIFEST_KEY`, and passes against HEAD.
