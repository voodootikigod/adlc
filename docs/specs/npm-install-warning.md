# Spec — npm install warning: `Unknown user config "min-release-age"` (issue #58)

**Phase:** P1-lite record for a small bug fix. Not a build ticket — this is the lightweight
spec note requested alongside the fix commit.

## Issue

`gh issue view 58`: users following the documented Claude Code install steps in
`docs/integrations/claude-code.md` sometimes see:

```
npm warn Unknown user config "min-release-age". This will stop working in the next major version of npm.
```

and assumed `@adlc/core` (or its install step) was the cause.

## Investigation (reproduced, not guessed)

Grepped the entire repo, git history (`git log --all -S"min-release-age"`), the root
`package.json`, every `packages/*/package.json` `config`/`engines` field, every
`plugins/*` install script, and every `.md` doc for `min-release-age` and `.npmrc` — zero
hits anywhere in this repo, ever.

Reproduced the documented install commands for real, from a clean `$HOME` and global
prefix, against the live npm registry:

```sh
npx plugins add voodootikigod/adlc --yes   # the recommended one-liner
npm install -g @adlc/cli                   # the toolkit install
npm install                                # workspace install (root)
```

None of these emit the warning under any npm version tested (10.8.2, 11.0.0, 11.5.0,
11.9.0, 11.11.0). The `plugins` npm package (vercel-labs/plugins) writes no `.npmrc` and
sets no npm config either.

**Actual root cause, confirmed empirically:** `min-release-age` is a genuine npm config
(the "install cooldown" supply-chain-safety feature). Diffing npm's own
`@npmcli/config` definitions across released versions shows npm only added
`min-release-age` to its recognized-config schema in **npm 11.10.0**. Any npm in the
11.x line *before* 11.10.0 (confirmed by installing 11.0.0 through 11.9.0 and running
`npm install -g` with a `~/.npmrc` containing `min-release-age=3`) reproduces the exact
warning text on **every** `npm install`/`npm install -g` command, regardless of what is
being installed. npm 10.x (Node 20's bundled default) predates the unknown-config
warning check entirely (no warning); npm >= 11.10.0 recognizes the key (no warning).
Only the narrow 11.x-pre-11.10.0 window, combined with the user's *own* `~/.npmrc`
already setting `min-release-age`, produces the warning — and it would fire on any npm
install command in that environment, not specifically ours.

There is nothing in this repo to delete or rename — no misconfigured `.npmrc`, no bad
flag piped into npm. The fix is to make the true cause discoverable so a future reporter
can self-diagnose instead of filing it against `@adlc/core`.

## Fix

Added a Troubleshooting entry to `docs/integrations/claude-code.md` naming the exact
warning text, the real cause (npm version vs. the user's own `min-release-age`
userconfig), and the concrete remedy (`npm install -g npm@latest`, which crosses the
11.10.0 boundary where npm learns the key).

## Acceptance criteria

- `docs/integrations/claude-code.md` names `min-release-age`, cites the `11.10.0` npm
  version boundary, gives the `npm install -g npm@latest` remedy, and states the warning
  is not caused by `@adlc`.
- A regression test asserts all of the above are present in the doc.

## Verification

```sh
node --test scripts/test/npm-install-warning.test.mjs
npm test
```

Both pass as of this fix.
