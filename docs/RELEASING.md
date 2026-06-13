# Releasing the `@adlc` suite

All 20 packages (`@adlc/core` + 19 CLIs) ship under the `@adlc` npm scope on a
**single lockstep version** — one tag releases the whole suite.

## One-time setup

1. **Create the npm org** named `adlc` (the `@adlc` scope requires an org of
   that exact name). Free org = unlimited public packages.
   `https://www.npmjs.com/org/create`
2. **Bootstrap publish.** Trusted publishing can only be configured on packages
   that already exist, so the first release uses a token:
   - Create a granular **automation** token on npm with publish rights to the
     `adlc` scope.
   - Add it as the repo secret **`NPM_TOKEN`** (Settings → Secrets → Actions).
3. **First release** — see *Cutting a release* below. The workflow publishes all
   20 packages using `NPM_TOKEN`.
4. **Switch to OIDC.** On npmjs.com, configure each package's *Trusted Publisher*
   to this repo + the `Publish @adlc to npm` workflow (or set it at the org
   level). Then **delete the `NPM_TOKEN` secret** — the workflow's
   `NODE_AUTH_TOKEN` becomes empty and npm publishes via OIDC provenance with no
   stored credential.

## Cutting a release

Lockstep: bump every package to the same version, tag, push.

```bash
# 1. set the version across all 20 manifests (also repins @adlc/core deps)
node scripts/release.mjs 1.1.0

# 2. commit + tag + push — the tag triggers the publish workflow
git commit -am "release: v1.1.0"
git tag v1.1.0
git push && git push --tags
```

The `.github/workflows/publish.yml` workflow then installs, tests, and runs
`scripts/release.mjs <version> --publish`, which publishes **`@adlc/core` first**
(its consumers resolve it) followed by the 19 CLIs — each with
`--provenance` and `publishConfig.access=public`.

You can also trigger manually via **Actions → Publish @adlc to npm →
Run workflow** with an explicit version.

## How the wiring works

- Every CLI declares `"@adlc/core": "<exact version>"`. `scripts/release.mjs`
  repins this on each bump, so a published `@adlc/foo@1.1.0` always requires
  `@adlc/core@1.1.0`.
- Inside the repo, npm **workspaces** symlink `@adlc/core` into `node_modules`,
  so source imports (`import { pass } from '@adlc/core'`) resolve in dev/test
  exactly as they will once published.
- `files` allowlists ship only `bin/`, `lib/` (or `index.mjs`), `README.md`,
  and `LICENSE` — never `test/`.
