# Releasing the `@adlc` suite

All 23 packages (`@adlc/core` + 22 CLIs) ship under the `@adlc` npm scope on a
**single lockstep version** — one tag releases the whole suite.

## One-time setup

1. **Create the npm org** named `adlc` (the `@adlc` scope requires an org of
   that exact name). Free org = unlimited public packages.
   `https://www.npmjs.com/org/create`
2. **Create the protected environment.** Run `docs/github-rulesets/apply.sh`
   (or Settings → Environments) to create **`npm-publish`** with required
   reviewers and a `v*` deployment-tag policy. The publish job is pinned to it.
3. **Bootstrap publish.** Trusted publishing can only be configured on packages
   that already exist, so the first release uses a token:
   - Create a granular **automation** token on npm with publish rights to the
     `adlc` scope.
   - Add it as an **environment secret** named **`NPM_TOKEN`** on the
     `npm-publish` environment (Settings → Environments → npm-publish →
     Environment secrets) — **not** a repository or organization Actions secret.
     An environment secret is unreadable from any job that does not run under
     `npm-publish`, so it cannot be exfiltrated by a modified workflow on a branch.
   - If a repo- or org-level `NPM_TOKEN` already exists, **delete it** (an org
     secret scoped to this repo also resolves in `${{ secrets.NPM_TOKEN }}` and
     would survive outside the environment). Verify all three scopes:
     ```bash
     gh secret list                          # repo: must NOT list NPM_TOKEN
     gh secret list --org <github-org>        # org: must NOT list NPM_TOKEN
                                              #   (or it must not be scoped to this repo)
     gh secret list --env npm-publish         # environment: MUST list NPM_TOKEN
     ```
4. **First release** — see *Cutting a release* below. The workflow publishes all
   23 packages using the environment-scoped `NPM_TOKEN`.
5. **Switch to OIDC.** On npmjs.com, configure each package's *Trusted Publisher*
   to this repo + the `Publish @adlc to npm` workflow, **and set the Environment
   field to `npm-publish`.** This binding is mandatory: if the environment field
   is left blank, npm will accept an OIDC publish from *any* run of `publish.yml`
   on this repo — including a `v*` tag pointing at an older commit whose workflow
   predates the `environment:` gate and ancestry guard — bypassing the required
   reviewer and deployment-ref layers. With the binding set, npm rejects any OIDC
   identity that did not run under `npm-publish`.
   - Verify before removing the token: cut a release from a throwaway branch run
     that is *not* environment-bound (or temporarily blank the env binding on one
     scratch package) and confirm npm **rejects** the OIDC publish. Restore the
     binding.
   - Then **delete the `NPM_TOKEN` environment secret** — the workflow's
     `NODE_AUTH_TOKEN` becomes empty and npm publishes via OIDC provenance with no
     stored credential.

## Cutting a release

Lockstep: bump every package to the same version, tag, push.

```bash
# 1. set the version across all package manifests and repin internal @adlc/* deps
node scripts/release.mjs X.Y.Z

# 2. commit + tag + push — the tag triggers the publish workflow
git commit -m "chore: bump version to X.Y.Z"
git tag vX.Y.Z
git push && git push --tags
```

The `.github/workflows/publish.yml` workflow then installs, tests, and runs
`scripts/release.mjs <version> --publish`, which publishes **`@adlc/core` first**
(its consumers resolve it), then the routed tools, and **`@adlc/cli` last**
because it depends on the dispatcher targets. Each package publishes with
`--provenance` and `publishConfig.access=public`.

There is no manual trigger: the workflow has no `workflow_dispatch`, so the only
way to publish is to push a `v*` tag (tag creation is restricted to admins by the
release-tag ruleset). To re-publish, push a new tag. Each publish still requires
approval on the `npm-publish` environment.

## How the wiring works

- Every internal dependency declared as `"@adlc/*": "<exact version>"` is
  repinned by `scripts/release.mjs` on each bump, so a published
  `@adlc/foo@1.1.0` always depends on the matching lockstep `@adlc` packages.
- Inside the repo, npm **workspaces** symlink `@adlc/core` into `node_modules`,
  so source imports (`import { pass } from '@adlc/core'`) resolve in dev/test
  exactly as they will once published.
- `files` allowlists ship only `bin/`, `lib/` (or `index.mjs`), `README.md`,
  and `LICENSE` — never `test/`.
