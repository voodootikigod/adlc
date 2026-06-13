Release a new lockstep version of the `@adlc` suite (all 20 packages publish together).

## Arguments

- $ARGUMENTS: Version bump type — "patch", "minor", or "major". Defaults to "minor" if not specified.

## Steps

1. **Determine the new version.** Read the current version from `packages/core/package.json` (all packages are lockstep, so any is authoritative). Apply the requested semver bump ($ARGUMENTS, default "minor") to compute the new version number.

2. **Verify preconditions:**
   - Working tree is clean (`git status --porcelain` is empty)
   - On the `main` branch
   - Up to date with remote (`git pull --dry-run` shows no changes)
   - Tests pass (`npm test`)

3. **Bump versions:** run `node scripts/release.mjs <NEW_VERSION>` (no `--publish`). This sets the new version across `@adlc/core` + all 19 CLIs + the root, and repins each CLI's `"@adlc/core"` dependency to match. Do NOT hand-edit package.json files.

4. **Commit the version bump:**
   ```
   chore: bump version to X.Y.Z
   ```

5. **Create the version tag:** `vX.Y.Z`

6. **Push commit and tag:**
   ```
   git push origin main
   git push origin vX.Y.Z
   ```

7. **Confirm completion.** Print a summary of:
   - Previous version → new version
   - Tag created
   - Remind the user that the GitHub Actions publish workflow (`.github/workflows/publish.yml`, triggered on `v*` tags) publishes all 20 packages to npm automatically — `@adlc/core` first, then the CLIs, each with `--provenance --access public`.

## Notes

- **First release / bootstrap:** the `NPM_TOKEN` repo secret must be set. After the first successful run, configure trusted publishing per package on npmjs.com and delete `NPM_TOKEN` so future releases publish tokenless via OIDC. See `docs/RELEASING.md`.
- Pushing the tag publishes 20 public packages immediately and is effectively irreversible — confirm the version is right before pushing.
