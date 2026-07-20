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

**2. The gate and the bumper share the same discovery functions.** This is the
load-bearing part. The original bug was not a missing check; it was a gate that
enumerated a *different set* than the bumper. Sharing the functions makes that
divergence structurally impossible.

**3. Discovery is depth-exact, never recursive.** Only direct children of the
root and of each plugin directory are read. This repo carries 21 stale
`marketplace.json` copies under `.worktrees/` and `.claude/worktrees/`; a
recursive walk would rewrite unrelated in-flight branches. `.worktrees` and
`node_modules` simply do not match the host-directory shape.

**4. The bumper only ever updates manifests that already exist.** It must never
create one: `claude-code-plugin-smoke.mjs` asserts the nested
`plugins/adlc-claude-code/.claude-plugin/marketplace.json` does **not** exist,
because a second copy causes a dual-resolution failure on live install.

**5. Only `version` is bumped.** `plugins/adlc-antigravity/plugin.json` also
carries `adlcContract`, a protocol number that is not a release version and must
survive untouched.

**6. Packaging completeness is asked of npm, not reimplemented.**
`findPackagingProblems` shells out to `npm pack --dry-run --json` for the
authoritative shipped-file list, then checks that every relative specifier in
every shipped `.mjs`/`.js`/`.cjs` file resolves to a path in that list. `files`
interacts with `.npmignore`, always-included entries and always-excluded ones in
ways a hand-rolled prefix match gets subtly wrong.

**7. The packaging gate's coverage is stated, not implied.** Static `import` /
`export … from` / side-effect `import` and *literal* `import()` are checked.
`node:` builtins and bare specifiers are ignored — they are dependency-resolved,
not shipped. A **computed** `import()` specifier is undecidable by static
analysis; the gate says so in its failure output rather than implying coverage
it does not have.

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
- `findPackagingProblems` returns `[]` when npm cannot be consulted, so a tooling
  hiccup does not fail a release on a signal it could not actually gather.
- A computed dynamic import that escapes the allowlist would still ship broken.
  Accepted: no static analysis can decide it, and no such import exists in the
  suite today.

## Verification

`scripts/test/release-artifact.test.mjs` is a **frozen rail** for this decision.
It pins the bump across every manifest shape, the drift gate's coverage of each,
the worktree-decoy exclusion, the packaging gate's true/false positives, and two
assertions against the **real repo** rather than a fixture.
