Release a new lockstep version of the `@adlc` suite (all 21 packages publish together).

## Arguments

- $ARGUMENTS: Version bump type — "patch", "minor", or "major". Defaults to "minor" if not specified.

## Steps

1. **Determine the new version.** Read the current version from `packages/core/package.json` (all packages are lockstep, so any is authoritative). Apply the requested semver bump ($ARGUMENTS, default "minor") to compute the new version number.

2. **Verify preconditions:**
   - Working tree is clean (`git status --porcelain` is empty)
   - On the `main` branch
   - Up to date with remote (`git pull --dry-run` shows no changes)
   - Tests pass (`npm test`)

3. **Bump versions:** run `node scripts/release.mjs <NEW_VERSION>` (no `--publish`). This sets the new version across `@adlc/core` + all 19 phase CLIs + the `@adlc/cli` umbrella, **every versioned `plugins/*` package** (e.g. `@adlc/pi-package`), and the root; repins **every** `"@adlc/*"` dependency to match (preserving each one's existing `^`/`~`/exact range style); and **regenerates `package-lock.json`** so the lockfile tracks the new versions. Do NOT hand-edit package.json or package-lock.json.
   - The script then runs a **drift gate**: if any versioned `package.json`, the root, or `package-lock.json` is not at `<NEW_VERSION>`, it prints the offenders and exits non-zero. A non-zero exit means the release is incomplete — fix it before continuing, do not commit a partial bump. (This gate exists because v1.1.0 once shipped with `package-lock.json` stranded at 1.0.2 and `plugins/adlc-pi` missed entirely.)

4. **Commit the version bump** — stage everything the script touched, including `package-lock.json` and every `package.json` (packages *and* plugins):
   ```
   chore: bump version to X.Y.Z
   ```
   Sanity check before committing: `git status --porcelain` should show `package-lock.json` among the changes, and `npm ci` (or `node scripts/release.mjs X.Y.Z` re-run, which is idempotent) must report no drift.

5. **Create the version tag:** `vX.Y.Z`

6. **Push commit and tag:**
   ```
   git push origin main
   git push origin vX.Y.Z
   ```

7. **Confirm completion.** Print a summary of:
   - Previous version → new version
   - Tag created
   - Remind the user that the GitHub Actions publish workflow (`.github/workflows/publish.yml`, triggered on `v*` tags) publishes all 21 packages to npm automatically — `@adlc/core` first, then the phase CLIs, and the `@adlc/cli` umbrella last (it depends on every other CLI), each with `--provenance --access public`.

## Notes

- **First release / bootstrap:** the `NPM_TOKEN` repo secret must be set. After the first successful run, configure trusted publishing per package on npmjs.com and delete `NPM_TOKEN` so future releases publish tokenless via OIDC. See `docs/RELEASING.md`.
- Pushing the tag publishes 21 public packages immediately and is effectively irreversible — confirm the version is right before pushing.
