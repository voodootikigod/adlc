# ADR 0012 — A version-only manifest edit is not a rail edit

- **Status:** Accepted
- **Date:** 2026-07-21
- **Issue:** [#228](https://github.com/voodootikigod/adlc/issues/228)
- **Supersedes:** nothing
- **Related:** T36 (rails completion lifecycle), ADR 0011 (release gates validate the artifact)

## Context

The `@adlc` suite is a lockstep monorepo. A release rewrites the `version` field in
every versioned `package.json` (34 of them), the root, `package-lock.json`, and
every host plugin manifest, and repins every `@adlc/*` dependency range to match.

rails-guard evaluates changed files by path. A rail glob such as
`packages/build-gate/**` matches `packages/build-gate/package.json`, so **any live
rail covering a versioned path fails on every release**, regardless of whether the
ticket owning that rail has anything to do with the release.

This blocked three consecutive changes (#218/#219, and #226 twice). Each was
cleared by completing stale tickets (#221, #227). That was the right remedy for
the *drift* — those tickets genuinely had shipped — but it is not a remedy for the
*collision*, and treating it as one obscured the real defect.

Staleness was never the cause. Consider a ticket that is correctly in flight with
`rails: ["packages/build-gate/**"]`:

1. Someone cuts a release.
2. `scripts/release.mjs` rewrites `packages/build-gate/package.json` — only `version`.
3. rails-guard fails the release PR.
4. The ticket is live, so completing it would be a lie.

The only exits were bypassing the guard on releases, or blocking releases until
every ticket railing a package directory finished. The first is worse: it
establishes "releases route around rails-guard" as normal practice, which is
precisely the norm a freeze gate exists to prevent.

Rails over package directories are ordinary practice here — 4 of the 11 open
tickets have one.

## Decision

**A change to a manifest file whose only differences are version fields and
lockstep `@adlc/*` dependency repins is not a rail edit.**

A rail exists to stop an agent editing frozen *behaviour* mid-build. A version
bump changes no behaviour: it is a mechanical, tool-generated rewrite of one
field, applied uniformly, and already gated by `scripts/release.mjs`'s own drift
and publish-metadata gates plus the release skill's R4 re-read.

### The design: canonical form, then structural comparison

This was reached the hard way — two implementations were built and both were
rejected by cross-model prosecution, in **mirror-image** ways.

**Walking `JSON.parse` output — parse cannot see fidelity.** The parser is lossy
by design, and every loss is a place where two different documents compare equal:

| what is lost | example |
|---|---|
| duplicate keys | `{"a":1,"a":2}` — last wins, the first is erased |
| float precision | `9007199254740993` → `9007199254740992` |
| `-0`, `Infinity` | `1e400` → `Infinity`, which `JSON.stringify`s as `"null"` |
| key order | behaviour for conditional `exports`, invisible once sorted |
| array vs object | `[x]` and `{"0":x}` walk identically |

**Comparing raw lines — text cannot see structure.** A `"version"` member
indented two spaces inside `scripts` is an npm **lifecycle command**, not the
package version, and a line-level check read it as top-level. Deriving structure
by counting braces is just writing a JSON parser, worse.

Neither approach can be patched into the other's strength. So the design requires
both at once, through one precondition:

> **Each side must be byte-identical to `JSON.stringify(JSON.parse(it), null, 2)`
> plus a trailing newline — its own canonical re-serialisation.**

This is checked in two places, and the split matters. **Byte** fidelity is proved
at the read boundary in `bin/rails-guard.mjs`: file contents are read as raw
buffers and the UTF-8 decode must reproduce the original bytes exactly. That
cannot be done later — UTF-8 decoding is not injective, every invalid byte
becomes U+FFFD, and a string already containing U+FFFD re-encodes to itself
perfectly. By the time the predicate has a string, the information is gone.
**Canonical** form is then proved in `parseCanonical`, on a string already known
to represent its bytes faithfully.

That single check collapses the entire first class: a duplicate key does not
survive a round trip, and neither does a precision-losing number, a reordered
key, a `-0`, or any non-canonical formatting. Each changes the text and denies
before any comparison runs.

What remains — given the byte check above — is a document whose **parse is
provably faithful to its bytes**. On
such a document, comparing by structural path is sound — which closes the second
class. The proof obligation is discharged once, in `parseCanonical`, and every
later step relies on it.

It costs nothing here: all 34 manifests in this repo are already canonical,
because `scripts/release.mjs` writes exactly `JSON.stringify(obj, null, 2)`. A
test asserts this, so a change to the release writer fails in the test suite
rather than mid-release.

| dimension | rule |
|---|---|
| precondition | both sides byte-identical to their own canonical re-serialisation |
| eligible files | basename `package.json`, `plugin.json`, `marketplace.json`. Not `package-lock.json` |
| eligible paths | `version` at the structural top level; `metadata.version` and `plugins[i].version` **only in `marketplace.json`**; `<depField>["@adlc/<name>"]` where the enclosing field is one of the four real dependency fields |
| eligible values | a version npm would actually **parse as a version** — semver grammar plus npm's 256-char and `MAX_SAFE_INTEGER` limits |
| operator style | must be **preserved**; exact → caret widens what resolves |
| **lockstep, both ends** | a repin must move **from the old version to the new one**, and the package version must actually have moved |
| everything else | not exempt — an ordinary rail violation |

**A non-canonical manifest is never exempt.** It fails the precondition and is
reported as an ordinary rail edit. This is the safe direction, and in this repo
it never triggers.

### What P5 prosecution changed

The first implementation was prosecuted before merge and **four confirmed defects
were found**, two of them rail bypasses reproduced end-to-end through the real
binary. They are recorded here because each is a trap the next person to touch
this code could re-introduce:

| defect | why it was exploitable |
|---|---|
| object keys were `.sort()`ed before recording | Node resolves conditional `exports` **first-match-wins**, so reordering `{"node":…,"default":…}` changes which module loads while every leaf value stays identical. Key order in a manifest is behaviour. |
| container kind was not recorded | `[{…}]` and `{"0":{…}}` produced identical records, so an array could be swapped for an object undetected. |
| the resolver used `readFileSync` | It follows symlinks; `git show` returns the blob. A manifest replaced by a symlink to identical text compared equal and was exempted, while git recorded a typechange — and the link target then lives outside the rail. |
| the predicate call sat outside its `try` | A deeply-nested manifest threw out of the walk uncaught, turning a gate decision (exit 2) into an operational crash (exit 1). |

The most instructive finding was not a bypass but a **hollow test**: deleting the
single line that records container shape — the mechanism this design depends on —
failed **zero** of 110 tests. Every structural test passed incidentally via *leaf*
differences and never exercised that path. The gap was empty containers: adding
`"scripts": {}` changes no leaf at all.

That suite has since been replaced twice over, so those specific counts no
longer apply. What survived is the practice: every guard is planted-and-checked,
and the current sweep is recorded below.

### What CROSS-MODEL prosecution then changed — six rejections

Because this is an enforcement package, ADR-0007 also requires an adversarial
approve from a **different provider**. That review rejected the change **six
times**, and the record is kept in full: it is the strongest available evidence
that the cross-model tier is not ceremony. Every finding was independently
reproduced before being acted on, and three of the five rounds found defects that
the same-model pass had declared clean.

**Round one** found six issues the same-model pass had missed entirely:

| defect | why it mattered |
|---|---|
| the range regex accepted `1.2.3-a..b` | an empty prerelease identifier makes npm classify it as a **dist-tag**, so an "exempt" edit could redirect a dependency to an arbitrary published version |
| "lockstep" was never enforced | `^1.0.0 → ^9.0.0` was exempt with no version change at all |
| `startsWith('@adlc/')` | accepted `@adlc/` and `@adlc/foo/bar`, names npm rejects outright |
| `metadata.version` / `plugins[i].version` accepted anywhere | marketplace-only paths were eligible inside any `package.json` |
| `JSON.stringify` leaf collisions | `JSON.parse('1e400')` is `Infinity` and `JSON.stringify(Infinity)` is `'null'`, so `1e400` and `null` compared equal; likewise `0` and `-0` |
| git **clean filters** | `git diff` applies them, `readFileSync` does not — a `.gitattributes` filter rewrote `"main"` into the index while the comparator saw only a version edit |

It also found three mutants the calibrated suite still failed to kill —
caret-only ranges (the e2e fixture used a caret while the repo actually uses 68
exact pins), dropping three of the four dependency fields, and removing
baseline-side validation — plus a portability bug where the e2e fixtures
inherited a global commit signer.

**Round two rejected the fixes.** Three more bypasses were reproduced through the
real binary — `9007199254740992 → 9007199254740993` (same float after parsing), a
duplicate key whose first occurrence changed behind an unchanged second,
`9007199254740992.0.0` (npm reads it as a dist-tag), and `1.0.0 → ^1.0.0` with no
version change (operator style was never compared).

That is the round that ended the JSON-walking design. Two rounds of fixes had
each closed the specific cases found and left the *class* open, which is the
signal that the approach — not the implementation — was wrong. It was replaced by
a line-level text comparison.

**Round three rejected that too**, and this is the rejection the final design
came from. Text has no idea which object encloses a line, so `scripts.version` —
an npm **lifecycle command** — was read as the package version; duplicate
top-level `version` members manufactured a "version changed" while the effective
version was unchanged and a dependency redirected; `config["@adlc/core"]` counted
as a dependency repin; and lockstep was checked only on the new value, letting
`^0.1.0 → ^1.5.1` cross a major boundary during a genuine bump.

Seeing both failures side by side is what produced the canonical-form
precondition described above: parse cannot see fidelity, text cannot see
structure, and requiring canonical form makes both true at once.

**Round four** found the deepest defect of the series, and the first that no
amount of reasoning about JSON would have caught. UTF-8 decoding is not
injective: a baseline holding raw byte `0x80` and a working tree holding raw
`0x81` both decode to U+FFFD, so two genuinely different files compared equal and
the edit was exempted — reproduced end-to-end at exit 0. The first fix attempt
was wrong, adding a re-encode check inside the predicate where the information
had already been lost; it had to move to the byte boundary. The same round found
lockstep was *incremental* rather than complete (only ranges that CHANGED were
inspected, so a package could finish declaring 1.5.1 while still depending on
1.5.0 of a sibling), that `plugins[i]` did not require `plugins` to be an array,
and that this ADR contained a false claim about its own regression test.

**Round five found no production defect** — it confirmed the byte fix complete,
lockstep correct, and the path comparison sound, with all 34 manifests and 79
ranges exempt against the real release function. What it did find was two
*hollow tests*: the baseline-symlink fixture pointed at a non-JSON target, so the
canonical precondition rejected it whether or not the mode guard existed, and the
completeness tests all left the *after* side wrong, so an implementation checking
only `after` passed every one. Both are fixed and now kill their mutants.

That progression — from bypasses, to a bypass class, to an encoding boundary, to
nothing but test quality — is the argument for the tier, and for stopping when
the findings run out rather than when patience does.

**One reported finding was deliberately not fixed here.** The reviewer noted that
a manifest staged as X but restored to Y in the working tree is committed as X
while the comparator sees Y. That is real, but it is not specific to this
exemption: `changedFiles(base)` is base-vs-worktree for *every* rail check, so it
applies equally to ordinary rail edits. Requiring index and worktree to agree
would reject the normal edit-then-stage flow — attempting it broke the primary
regression test. It is recorded as a guard-wide issue instead of being patched at
the wrong layer.

### Fails closed, everywhere

The exemption is refused — and the edit reported as an ordinary violation — on
any of: a side that is not canonical (which covers unparseable JSON, duplicate
keys, precision loss, reordered keys, and non-canonical formatting); a missing
side, meaning the file was added or deleted; a non-object document; any container
whose key set changed; any differing path outside the eligible set; any eligible
path whose value is not a version npm would parse as a version; a repin whose
operator style changed or whose ends do not move from the old version to the new.

At the resolver layer it also refuses a path that is not a regular file at HEAD
and a regular blob at base, a changed file mode, and any path carrying a
content-altering `.gitattributes` filter — because `git diff` applies those
filters and a direct read does not, so the two would disagree.

### Off by default

`checkRailEdits` gains an optional content resolver. **Omitting it disables the
exemption entirely.** Callers that cannot supply real file content — pure unit
contexts, embedded uses — keep the original stricter behaviour rather than
silently exempting anything. A resolver that throws or returns null also fails
closed.

## Consequences

**Good.** Releases stop colliding with unrelated live rails. The ad-hoc
ticket-completion dance before every bump is no longer required, which also
removes the pressure to complete tickets prematurely just to unblock a release —
a pressure that was quietly corrupting the ticket store's meaning.

`scripts/rails-guard-ci.mjs` needed no change: it delegates the rail-glob diff to
`packages/rails-guard/bin/rails-guard.mjs`, so fixing the canonical package fixed
the CI gate. This matters because that script is an immutable trust root and
editing it requires the protected-base admin ceremony.

**Cost.** The guard now reads the content of railed manifests instead of
comparing paths alone, and it requires them to be in canonical form. A manifest
that is not canonical — hand-formatted, minified, CRLF, or carrying a duplicate
key — is never exempt. That is a real behavioural constraint, and it is stated
here rather than discovered mid-release. It does not bite today: all 34 manifests
in this repo are canonical because `release.mjs` writes them that way, and a test
asserts it.

**Residual risk, stated plainly.** A version bump can now land on a railed
manifest without the ticket owner noticing. This is intended, and it is bounded:
the only values that can move are the package's own version and internal ranges
repinned from the old version to the new one. Nothing that can execute, redirect
a dependency elsewhere, or change a package's identity is eligible.

The honest caveat is that this bound is only as good as the review it survived.
It took six cross-model rejections to reach, and each round found something the
previous one had not — including two rounds where the *approach* was wrong rather
than the code. Anyone widening the eligible set should assume the same is true of
their change and get it prosecuted cross-model before merging.

**Not addressed here.** Whether rails *should* be allowed to cover manifest files
at all (option 3 in #228 — reject such globs at ticket-authoring time) is a
separate question, tracked separately. It requires moving glob matching into
`@adlc/tickets` because `@adlc/core` already depends on it, so `tickets` cannot
import `globMatch` from `core` without a cycle. That is a public-surface refactor
and does not belong in this fix.

## Alternatives rejected

**Exempt the release commit** by message convention or shape. Rejected: a
broad exemption keyed on a forgeable signal. Any commit could claim to be a
release.

**Forbid rails over versioned files** (option 3). Not rejected — deferred. It is
complementary hygiene rather than a fix: it prevents new tickets creating the
collision but does nothing for the tickets that already have it, and it is a
breaking change requiring migration of live tickets.

**Leave it.** Rejected. Every release collides and is resolved ad hoc, and the
resolution pressures the ticket store toward dishonesty.

## Mutation calibration

Every guard is planted-and-removed and the suite re-run. My own sweep runs 28
mutants, of which 22 are killed. **That sweep is not exhaustive**: an independent
review with a wider sweep found 11 further single removals that leave the suite
green. Most are redundant, but one — the `ident` attribute — was a genuine gap
with a reproduced exit-0 result, now pinned.

The lesson is the sweep's own coverage: a mutation list I write is bounded by the
guards I remember writing. The surviving six below are each redundant with a
stronger check and commented as such **at their definition**, because a surviving
mutant that is not explained is indistinguishable from one nobody noticed:

| survivor | shadowed by |
|---|---|
| string re-encode guard | canonical equality — `JSON.stringify` escapes a lone surrogate, so the round trip already differs |
| component digit limit | the `MAX_SAFE_INTEGER` check — 17 digits already exceeds it |
| range version validity | lockstep forces a range's version to equal the manifest version, which is itself validated |
| container-shape early return | the path test — no container path is ever an eligible version or range path |
| `versionChanged` guard | the completeness pass, which requires every baseline range to equal the old version |
| repin from/to endpoints | **each other, not the completeness pass** — removing both together opens two dependency-redirect cases, so the pair is load-bearing even though neither half is individually |

**Three separate rounds found hollow tests in this work**, each written
specifically to pin the guard it named:

- the container-shape record: deleting it failed **zero** of 110 tests, because
  every structural case passed incidentally through leaf differences
- the baseline-symlink fixture pointed at a non-JSON target, so the canonical
  precondition rejected it whether or not the mode guard existed
- the HEAD-symlink fixture used a dangling link, so the read threw before the
  regular-file guard was reached; and every completeness fixture left the *after*
  side wrong, so an implementation checking only `after` passed all of them
- the pathspec fixture I wrote passed with **both** guards removed, because
  `git show <base>:<path>` throws for a path absent at base. The working fixture
  came from the reviewer: it stores the *same blob* at the literal path (as a
  symlink) and the interpreted path (as a regular file), which is what makes the
  mode lookup consequential

The lesson is narrow and worth stating: **a test that asserts the right outcome
for the wrong reason is invisible without mutation testing.** Assertions about
what a test pins are claims, and claims about a security gate need evidence.
