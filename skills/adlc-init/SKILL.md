---
name: adlc-init
description: Bootstrap the ADLC runtime in a repository — install the gate toolkit, create the .adlc/ workspace, and wire the CI rails-guard control. Use when adopting the Agentic Development Lifecycle in a repo for the first time, when `adlc --version` fails, when `.adlc/` is missing, or on requests like "set up ADLC here", "install ADLC", "initialize the lifecycle".
---

# ADLC — bootstrap a repository

Get a repository from nothing to a working Agentic Development Lifecycle: the
toolkit on PATH, the `.adlc/` runtime present, and the one control that is
actually unbypassable wired into CI.

## 1. Check what is already there

```sh
adlc --version          # toolkit on PATH?
ls .adlc                # runtime already bootstrapped?
```

If `adlc --version` prints a version and `.adlc/` exists, this repo is already
initialized — stop and report that rather than re-running anything.

## 2. Install the toolkit

The toolkit is Node ≥ 18 and zero-dependency.

```sh
npm install -g @adlc/cli
```

**Do not proceed if Node is older than 18.** Report the version and stop; do not
install or upgrade Node on the user's behalf without asking.

One command can install the toolkit *and* every harness integration present on
the machine:

```sh
curl -fsSL https://www.agenticlifecycle.ai/install.sh | sh
```

Confirm with the user before piping a remote script to a shell. If they prefer
to read it first, fetch it and show it to them.

## 3. Create the runtime

```sh
adlc init --root /absolute/path/to/repo
```

This idempotently creates the committable `.adlc/` runtime. Flags worth knowing:

- `--harness <codex|cursor|copilot>` — records `harnesses.<name>` in a fresh
  config. `cursor` and `copilot` each imply `--no-codex-agents`; `copilot` also
  scaffolds a `.github/copilot-instructions.md` block and a
  `copilot-setup-steps.yml` snippet.
- `--no-codex-agents` — skip the project-scoped Codex agent templates.
- `--json` — machine-readable output.

Writes are confined to `--root`. `adlc init` never edits user-global harness
configuration implicitly.

**Careful:** if the repo already freezes `.adlc/config.json` as a rail, do not
commit a newly generated one over it.

## 4. Wire the CI control

In-session rail enforcement is best-effort and harness-dependent. The
**commit-time diff gate is the real control** — wire it and make it a required
check.

`docs/ci/rails-guard.yml` lives in the ADLC **source repository**. It is not
shipped inside `@adlc/cli` (that package publishes only `bin/`, `lib/`,
`README.md`, and `LICENSE`) and `adlc init` does not create it, so a normal
downstream repo has no local copy to `cp`. Fetch it:

```sh
mkdir -p .github/workflows
curl -fsSL https://raw.githubusercontent.com/voodootikigod/adlc/main/docs/ci/rails-guard.yml \
  -o .github/workflows/rails-guard.yml
```

Then mark it required in the repository's branch-protection settings. Without
that, frozen rails are advisory.

Optionally add the maintenance cron from `docs/ci/adlc-maintenance.yml`.

## 5. Verify

```sh
adlc preflight            # baseline environment readiness
adlc ticket list          # store reachable, exit 0
adlc gate-manifest show   # evidence surface reachable
```

Report the three results. If `adlc preflight` gate-fails (exit 2), surface what
it flagged rather than working around it.

## 6. Hand off

Tell the user which phase to start at — for most repos that is P0: author the
first ticket with `adlc ticket create --input <path|-> --write`. The `adlc`
phase-routing skill covers the rest of the lifecycle.

If their agent has a **native ADLC plugin** (Claude Code, Codex, Cursor,
OpenCode, Pi, Google Antigravity, GitHub Copilot), recommend installing it —
it adds in-session rail hooks, MCP tools, and prosecutor subagents that the CLI
alone does not provide. See https://www.agenticlifecycle.ai/integrations.
