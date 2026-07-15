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

3. **Bump versions:** run `node scripts/release.mjs <NEW_VERSION>` (no `--publish`). This sets the new version across `@adlc/core` + all 19 phase CLIs + the `@adlc/cli` umbrella, **every versioned `plugins/*` package** (e.g. `@adlc/pi`), and the root; repins **every** `"@adlc/*"` dependency to match (preserving each one's existing `^`/`~`/exact range style); and **regenerates `package-lock.json`** so the lockfile tracks the new versions. Do NOT hand-edit package.json or package-lock.json.
   - The script then runs a **drift gate**: if any versioned `package.json`, the root, or `package-lock.json` is not at `<NEW_VERSION>`, it prints the offenders and exits non-zero. A non-zero exit means the release is incomplete — fix it before continuing, do not commit a partial bump. (This gate exists because v1.1.0 once shipped with `package-lock.json` stranded at 1.0.2 and `plugins/adlc-pi` missed entirely.)
   - It also runs a **publish-metadata gate**: every non-private publish target must carry a `repository.url` that references the source repo, or the script exits non-zero. (This gate exists because v1.4.0 stranded a partial publish — `@adlc/tickets` had no `repository` field, so npm's provenance check 422'd mid-publish after 27 of 34 packages had already shipped.)

4. **Update the changelog:** run `node scripts/changelog.mjs <NEW_VERSION>`. This derives a new `## [X.Y.Z] - <date>` section in `CHANGELOG.md` from the conventional-commit subjects since the previous tag (grouping `feat`/`fix`/`perf`/`refactor`, omitting `chore`/`test`/`ci`/`docs` noise) and prepends it under the header. The generated section is a **starting point** — open `CHANGELOG.md` and hand-edit it into a curated, user-facing summary (merge related bullets, lead with the headline features, drop internal churn) before continuing.

5. **Commit the version bump** — stage everything the bump touched (`package-lock.json` and every `package.json`, packages *and* plugins) **plus `CHANGELOG.md`**:
   ```
   chore: bump version to X.Y.Z
   ```
   Sanity check before committing: `git status --porcelain` should show `package-lock.json` and `CHANGELOG.md` among the changes, and `npm ci` (or `node scripts/release.mjs X.Y.Z` re-run, which is idempotent) must report no drift.

6. **Create the version tag:** `vX.Y.Z`

7. **Push commit and tag:**
   ```
   git push origin main
   git push origin vX.Y.Z
   ```

8. **Confirm completion.** Print a summary of:
   - Previous version → new version
   - Tag created
   - The `CHANGELOG.md` entry that will ship with the release
   - Remind the user that the GitHub Actions publish workflow (`.github/workflows/publish.yml`, triggered on `v*` tags) publishes all 21 packages to npm automatically — `@adlc/core` first, then the phase CLIs, and the `@adlc/cli` umbrella last (it depends on every other CLI), each with `--provenance --access public`.

## Notes

- **First release / bootstrap:** the `NPM_TOKEN` repo secret must be set. After the first successful run, configure trusted publishing per package on npmjs.com and delete `NPM_TOKEN` so future releases publish tokenless via OIDC. See `docs/RELEASING.md`.
- Pushing the tag publishes 21 public packages immediately and is effectively irreversible — confirm the version is right before pushing.
