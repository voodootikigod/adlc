# `@adlc/init`

Idempotently bootstrap the committable `.adlc/` runtime and the project-scoped
`.codex/agents/` roles used by the native Codex integration.

From the current checkout (before the matching suite release):

```sh
node packages/init/bin/adlc-init.mjs --root /path/to/repo
```

After the matching `@adlc/cli` release:

```sh
adlc init
adlc init --root /path/to/repo --json
```

The initializer preserves existing files, refuses symlink escapes from the
project root, and never edits user-global `~/.codex` implicitly.

## Security modes

Every scaffolded `.adlc/config.json` sets `securityMode: "unsigned-fallback"`.
This is deliberate, not an oversight: the alternative, `"signed"`, requires a
dedicated signed-runner pool (`ADLC_SIGNED_RUNNER_POOL=1`, a pinned runner
binary `sha256`) that cannot be bootstrapped by `adlc init` itself — a repo's
very first `.adlc/` commit is refused in `signed` mode
(`packages/rails-guard/lib/ci/bootstrap.mjs`) and must upgrade into it later
through a protected-base runner ceremony.

What `unsigned-fallback` actually weakens: gate-manifest evidence
(`.adlc/manifest.jsonl` / `manifest.d/`) is accepted without a cryptographic
signature from that runner pool — a P5 review record, a mutation-gate pass,
or a cross-model attestation is trusted at face value rather than verified
against a signed chain. `signed` mode closes that gap once the runner-pool
ceremony has run. Repos with a real trust boundary between the agent and the
CI runner (untrusted contributors, a compliance requirement) should plan the
upgrade; `unsigned-fallback` is the correct starting point for everyone else.
