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
adlc init --root /path/to/repo --json [--no-codex-agents] [--harness <codex|cursor|copilot|claude-code|pi|opencode|gemini>]
```

The initializer preserves existing project-owned files (the only existing files
it edits are `.gitignore`, where a whole-directory `.adlc` / `.adlc/` / `/.adlc`
ignore is normalized in place to `.adlc/*` so the negations can take effect, and
`.adlc/config.json` when registering a `--harness`), refuses symlink escapes
from the project root, and never edits user-global `~/.codex` implicitly.
`--no-codex-agents` skips scaffolding `.codex/agents/*.toml`; any non-`codex`
`--harness` (`cursor`, `copilot`, `claude-code`, `pi`, `opencode`, `gemini`)
implies `--no-codex-agents` and records `harnesses.<name>` in `.adlc/config.json`,
and `--harness copilot` additionally writes `.github/copilot-instructions.md` and
`.github/workflows/copilot-setup-steps.yml`. The `harnesses.<name>` entry is a
record of which harness scaffolded the repository, and its `railEnforcement:
"auto"` field is currently advisory metadata — actual rail enforcement comes
from the harness plugin's `preToolUse` hook and the `rails-guard-ci` backstop.

When `.adlc/config.json` is present but is not readable JSON, `adlc init` records a warning and exits 1 without overwriting the broken file. The same holds when `--harness` is passed and the config's `harnesses` field is present but not an object: the harness cannot be registered, so the run fails instead of reporting success.

When `.gitignore` contains mis-ordered rules that cause required committable paths to be ignored, `adlc init` records a warning and exits 1 without reporting the file unchanged. If the file has no `.adlc/*` anchor yet, `adlc init` appends the whole ADLC stanza and moves any stanza line found above it into place, so its own append never leaves a negation dead. The rules are checked with `git check-ignore`: in the repository when git can open it, otherwise in a throwaway repository holding only the `.gitignore` (for example before `git init`). Only without a git binary does a built-in matcher decide, and it follows git's rule that nothing under an ignored directory can be re-included.

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

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | Initialization succeeded (or `--help`) |
| `1` | Operational or configuration error (unknown option, unreadable `.adlc/config.json`, invalid `harnesses` shape, mis-ordered `.gitignore` rules, or symlink escape) |
| `2` | Reserved (not emitted by `adlc init`) |
