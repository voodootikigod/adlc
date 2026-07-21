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

Scope of the exemption, deliberately narrow:

| dimension | rule |
|---|---|
| eligible files | basename is `package.json`, `plugin.json`, or `marketplace.json` |
| eligible paths | `version` in any of them; `metadata.version` and `plugins[i].version` **only in `marketplace.json`**; `<depField>["@adlc/<name>"]` where the name is a valid npm scoped name |
| eligible values | both sides plain strings matching **strict** semver per semver.org's BNF (versions) or `^`/`~`/exact strict semver (ranges) |
| **lockstep** | every changed range must target the manifest's **own new `version`** |
| everything else | not exempt — reported as an ordinary rail violation |

The lockstep row is an invariant, not a description. Without it, `@adlc/core:
^1.0.0 → ^9.0.0` was exempt *even with no version change at all* — a dependency
redirection through an allowed path, which is exactly what the value-shape checks
were supposed to prevent. Verified against the repo: all 79 `@adlc/*` ranges
across 34 manifests already satisfy it, because that is what `scripts/release.mjs`
writes.

"Strict semver" is load-bearing too. The looser first attempt accepted
`1.2.3-a..b` — an empty prerelease identifier, which npm's `npm-package-arg`
classifies as **type=tag**, so it resolves to whatever that dist-tag points at.
A version-shaped string that is not a version.

`package-lock.json` is **not** eligible. It is not a manifest whose diff can be
reasoned about this cheaply, and no realistic rail targets it.

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

The suite is now calibrated by planting each defect and confirming it is caught:
deleting the shape record fails 5 tests, restoring the `.sort()` fails 1,
dropping the container-kind marker fails 2, and removing the symlink/mode guard
fails 2. A fix that merely weakens the guard cannot pass.

### What CROSS-MODEL prosecution then changed

The above was the same-model pass. Because this is an enforcement package,
ADR-0007 also requires an adversarial approve from a **different provider**. That
review **rejected** the change and found five more issues the first pass had
missed entirely — the strongest available argument that the cross-model tier is
not ceremony:

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

**One reported finding was deliberately not fixed here.** The reviewer noted that
a manifest staged as X but restored to Y in the working tree is committed as X
while the comparator sees Y. That is real, but it is not specific to this
exemption: `changedFiles(base)` is base-vs-worktree for *every* rail check, so it
applies equally to ordinary rail edits. Requiring index and worktree to agree
would reject the normal edit-then-stage flow — attempting it broke the primary
regression test. It is recorded as a guard-wide issue instead of being patched at
the wrong layer.

### Fails closed, everywhere

The exemption is refused — and the edit reported as a violation — on any of:
unparseable JSON on either side; a missing side (file added or deleted); a
non-object document; any container whose key set changed (an added, removed, or
reordered key); any differing path not in the eligible set; any eligible path
whose value is not a plain string of the expected shape.

The key-set comparison is what makes the structural cases visible: without it, an
appended `plugins[]` entry or an added `scripts` block could slip through because
every surviving leaf still matched.

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

**Cost.** The guard now parses JSON for railed manifests instead of comparing
paths alone, so a manifest is trusted to the extent its JSON is well-formed. The
mitigation is the strictness above: a manifest that cannot be parsed is not
exempt, so malformed input can only ever produce a *violation*, never a pass.

**Residual risk, stated plainly.** A version bump can now land on a railed
manifest without the ticket owner noticing. This is intended, and it is bounded:
the only field that can move is a version string of a fixed shape. Nothing that
can execute, redirect a dependency, or change a package's identity is eligible.

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
