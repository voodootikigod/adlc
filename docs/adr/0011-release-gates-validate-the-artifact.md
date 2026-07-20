# ADR 0011: Release gates validate the published artifact, not the source tree

**Status:** **Accepted.** Every release gate must answer "does the thing a user
installs actually work?" — not "is the working tree self-consistent?". Host
manifest discovery is **glob-driven by shape**, never an enumerated list of
integrations.

**Date:** 2026-07-20
**Deciders:** Chris Williams (prompted by a live report that `/plugin` offered
ADLC at 0.2.0 immediately after 1.5.0 shipped).

> Related: [ADR-0003](./0003-adlc-claude-code-plugin.md) ships the Claude Code
> plugin whose manifests drifted; [ADR-0009](./0009-universal-install-via-plugins.md)
> governs the install instruction. This ADR governs what the release pipeline
> must verify before publishing.

---

## Context

`scripts/release.mjs` carried a fail-closed drift gate, `findVersionDrift`, whose
stated purpose was to make "the v1.1.0 drift can't happen again" machine-checkable.
It worked as designed and still let two defects ship, because it validated the
**source tree** rather than the **artifact**.

### Defect A — the Claude Code plugin was stranded at 0.2.0

The bumper grew one hardcoded loop per integration as integrations were added:
`codexPluginManifestPaths`, then `cursorPluginManifestPaths`, then
`cursorMarketplacePath`. Claude Code was the *first* integration and never got
one; antigravity's flat `plugin.json` never got one either.

`findVersionDrift` enumerated **the same list**. A manifest the bumper did not
touch was a manifest the gate did not check, so 1.3.0, 1.4.0 and 1.5.0 each
passed a green gate while `.claude-plugin/marketplace.json` and
`plugins/adlc-claude-code/.claude-plugin/plugin.json` sat at 0.2.0.

The Claude Code marketplace is git-sourced off the default branch, so pushing
main *is* publishing — but `/plugin` compares the **declared version string** to
decide whether an update exists. A frozen string made every release since 1.2.x
invisible to the updater even though main carried current content.

Cursor never drifted because `scripts/cursor-install-smoke.mjs` locksteps
`entry.version`, `metadata.version` and `plugin.json` against the package
version. `scripts/claude-code-plugin-smoke.mjs` asserted only
`if (!plugin.version) fail(...)` — a truthiness check compared against nothing,
which `0.2.0` satisfies forever. The asymmetry existed because
`plugins/adlc-claude-code/` ships no `package.json`, so there was no obvious
lockstep target and the Cursor pattern was never copied.

### Defect B — a tarball missing a file its own code imports

`packages/ticket-sync/package.json` declared `files: [bin/, lib/, schemas/, …]`
while `lib/doctor.mjs` imported `../scripts/gen-schema.mjs` at module load.
`scripts/` was not in the allowlist, so the published tarball omitted it and
`adlc ticket doctor` died with `ERR_MODULE_NOT_FOUND` for every npm-installed
user of 1.5.0.

Both defects were invisible to `npm test`, which runs against the source tree —
where every import resolves and manifest versions are irrelevant.

## Decision

**1. Host manifest discovery is glob-driven by shape.** A directory matching
`/^\.[a-z0-9-]+-plugin$/` is a host packaging directory. `hostPluginManifestPaths`
covers both layouts in use — `plugins/<name>/.<host>-plugin/plugin.json` and the
flat `plugins/<name>/plugin.json` — and `hostMarketplacePaths` covers
`<root>/.<host>-plugin/marketplace.json`. A new integration is drift-protected
the day its directory appears, with no edit to `release.mjs`.

**2. The gate and the bumper share the same discovery functions.** The original
bug was not a missing check; it was a gate that enumerated a *different set* than
the bumper. Sharing the functions eliminates **bumper/gate divergence**.

It does **not** eliminate **discovery/reality divergence**, and an earlier draft
of this ADR wrongly claimed it made divergence "structurally impossible". The
shape regex is itself an enumeration: `.Codex-plugin`, `.claude_plugin`, and
`.jetbrains.ai-plugin` match neither side, which reproduces Defect A exactly — a
frozen manifest under a green gate. So `hostDiscoveryNearMisses` reports any
depth-exact dotted directory holding a `plugin.json`/`marketplace.json` whose
name does not match. These are reported by a **pre-bump preflight inside
`releaseMain` (step 0)**, NOT by `findVersionDrift`.

That placement is load-bearing. A near miss names a *directory*, and no re-run of
the bumper can rename a directory — so reporting it post-bump aborted identically
on every invocation with a fully mutated tree. `findVersionDrift` must only ever
return things the bumper is capable of fixing. **Consequence for CI: a job that
calls `findVersionDrift` alone is NOT protected against a near-miss host
directory; it must run the preflight (or `releaseMain`) to get that check.**

The same preflight verifies that every JSON file the bump will rewrite actually
parses, so an unparseable `marketplace.json` aborts with the tree untouched
rather than throwing mid-write.

**2b. The bumper and gate apply the same existence condition to every field.**
Both write/check `metadata.version` and `plugins[].version` only where the key
already exists. An earlier version had the bumper write conditionally while the
gate demanded unconditionally, which made a metadata-less marketplace listing
unreleasable: `releaseMain` mutated the whole tree, aborted, and did so
identically on every re-run because no code path could satisfy the gate.
`.agents/plugins/marketplace.json` is that shape today.

**3. Discovery is depth-exact, never recursive.** Only direct children of the
root and of each plugin directory are read. This repo carries 21 stale
`marketplace.json` copies under `.worktrees/` and `.claude/worktrees/`; a
recursive walk would rewrite unrelated in-flight branches. `.worktrees` and
`node_modules` simply do not match the host-directory shape.

**4. The bumper only ever updates manifests that already exist.** It must never
create one: `claude-code-plugin-smoke.mjs` asserts the nested
`plugins/adlc-claude-code/.claude-plugin/marketplace.json` does **not** exist,
because a second copy causes a dual-resolution failure on live install.

**5. Only an EXISTING `version` is bumped — never an invented one.**
`plugins/adlc-antigravity/plugin.json` also carries `adlcContract`, a protocol
number that is not a release version and must survive untouched. More
importantly, a `plugins/<x>/plugin.json` that declares no `version` is not a
versioned host manifest at all (it may be a tool config or a schema), and
stamping one in is an install-time rejection under an
`additionalProperties: false` host schema. "Only update what exists" governs
fields, not just files.

**6. Packaging completeness is asked of npm, not reimplemented.**
`findPackagingProblems` shells out to `npm pack --dry-run --json` for the
authoritative shipped-file list, then checks that every relative specifier in
every shipped `.mjs`/`.js`/`.cjs` file resolves to a path in that list. `files`
interacts with `.npmignore`, always-included entries and always-excluded ones in
ways a hand-rolled prefix match gets subtly wrong.

**7. Specifier extraction is AST-based, and its coverage is stated, not implied.**
Source is parsed with **acorn** and the AST is walked; there is no pattern
matching and no comment stripping, because comments, string contents and
template contents never enter the AST at all. Checked node types:
`ImportDeclaration`, `ExportNamedDeclaration`, `ExportAllDeclaration`,
`ImportExpression`, and `CallExpression` for `require()` / `require.resolve()`.
A template literal with no interpolations is a compile-time constant and is
treated as a literal specifier.

`require` is not optional — the scan admits `.cjs`/`.js`, and a CommonJS
`require('../scripts/gen-schema.js')` is Defect B in its other spelling. Files
are parsed as ESM first and re-parsed as script on failure (`.cjs` reversed);
where both goals parse, they yield identical specifiers, so the fallback cannot
silently pick a wrong answer.

`node:` builtins and bare specifiers are ignored — they are dependency-resolved,
not shipped. A **computed** `import()`/`require()` specifier remains undecidable
by any parser; the gate says so in its failure output rather than implying
coverage it does not have. Every one of these forms has a fixture in the rail:
an unexercised branch is a promise with nothing behind it. `export * from` in
particular is fixtured because `packages/core/index.mjs` is thirteen consecutive
star re-exports — dropping that branch would make the most-depended-on package's
entire import graph invisible.

**8. "No problems" is never reported without a denominator.**
`findPackagingProblems` returns `{ problems, consulted, unconsultable }`, because
an empty problem list is also what a scan that inspected *nothing* produces. The
earlier version collapsed every npm failure into `null` and silently skipped the
package — so an npm hiccup removed all coverage for exactly the package about to
be published. `npm pack` returning no `files` array was quieter still: it yielded
an empty set and passed as verified.

**9. Unconsultable is fatal for `--publish`, a warning for a bare bump.** If
`npm pack` fails in a directory, `npm publish` is about to run in that same
directory — the failure is a signal about the very next command, so publishing
refuses. A bare version bump ships nothing, so blocking it would add friction
with no safety benefit and would make preparing a release offline impossible.

## Consequences

- Adding a new harness integration requires no release-script change to stay in
  lockstep. Forgetting to add one is no longer a silent, multi-release failure.
- The release aborts before any tag or publish if a tarball would fail on import,
  in the same fail-closed position as the existing provenance check — so the
  whole suite ships or none of it does.
- `findPackagingProblems` costs one `npm pack --dry-run` per publish target
  (~0.16s each, ~5s for the suite). That is paid once per release and once per
  test run; it is worth it to never again publish a package that cannot import
  itself.
- A package npm cannot be consulted about is reported, never treated as clean. A
  bare bump warns and proceeds; `--publish` refuses. A broken local npm therefore
  costs you the ability to publish, not the ability to prepare a release.
- A computed dynamic import that escapes the allowlist would still ship broken.
  Accepted: no static analysis can decide it, and no such import exists in the
  suite today.
- `releaseMain` takes an injectable `packImpl` alongside `regenerateLockfile` and
  `publishImpl`, preserving release.test.mjs's "no real npm, offline, leaves no
  trace" contract and making step 5's fail-closed behavior testable at all.

## Verification

`scripts/test/release-artifact.test.mjs` is a **frozen rail** for this decision.
It pins the bump across every manifest shape, the drift gate's coverage of each,
the decoy exclusions, every declared specifier form, the three-state packaging
result, and — critically — that **`releaseMain` itself aborts and publishes
nothing** when the gate trips. Testing only the helper would let the entire
fail-closed wiring be deleted with the suite still green.

Two properties are asserted against the **real repo** rather than a fixture, and
both carry a **denominator**: the packaging scan asserts it consulted every
publish target before asserting zero problems, and the lockstep check asserts the
Claude Code and antigravity manifests were actually discovered before asserting
zero drift. An emptiness assertion against a scanner whose failure mode is also
emptiness verifies nothing.

`AC5 end-to-end` packs the real `@adlc/ticket-sync`, extracts it, and imports
`lib/doctor.mjs` from the extracted tree — the only assertion in the suite that
is independent of the analyzer being audited.

**10. Entrypoint existence is checked for every declaration, not just imports.**
`bin`, `main`, `module` and every string leaf of `exports` must be present in the
tarball. VERIFIED npm behaviour: npm force-includes `bin` and `main` regardless
of `files`, but does **not** force-include `exports` targets — so a documented
subpath can resolve for the author and 404 for everyone who installs it. Only
`.mjs`/`.js`/`.cjs` and extensionless entrypoints are then PARSED: `exports`
legitimately points at `index.d.ts` and `./package.json`, and treating those as
parse failures marked three core packages unverifiable.

## Provenance of this decision

Sections 2, 2b, 5, 7, 8 and 9 exist because the first implementation was
prosecuted (P5) and found wanting: the packaging gate failed open, the
release-time wiring was untested, the real-repo assertions were vacuous, the
bumper and gate disagreed about metadata, the flat-manifest branch stamped
versions into non-manifests, `require()` was unscanned despite `.cjs` being in
scope, and comments were not stripped. Recorded here so the reasoning is not
rediscovered the hard way.
