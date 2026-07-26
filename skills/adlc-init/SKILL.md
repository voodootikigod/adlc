---
name: adlc-init
description: Bootstrap the ADLC runtime in a repository — install the gate toolkit, create the .adlc/ workspace, and wire the CI rails-guard control. Use when adopting the Agentic Development Lifecycle in a repo for the first time, when `adlc --version` fails, when `.adlc/` is missing, or on requests like "set up ADLC here", "install ADLC", "initialize the lifecycle".
---

# ADLC — bootstrap a repository

Get a repository from nothing to a working Agentic Development Lifecycle: the
toolkit on PATH, the `.adlc/` runtime present, and the one control that is
actually unbypassable wired into CI.

## 1. Check what is already there

There are **four** controls, installed by different steps. Probe each one
independently and report which are present:

```sh
adlc --version                                  # 1. gate toolkit on PATH?
ls .adlc                                        # 2. repo runtime bootstrapped?
ls .github/workflows/adlc-rails-guard.yml       # 4. CI backstop wired?
```

Control 3 is the harness integration — check whether your own agent has the
ADLC plugin loaded (skills alone are not the plugin).

**Do not treat "toolkit + `.adlc/` exist" as "already set up" and stop.** That
is the common *partial* state — a CLI-only install, a skills.sh adopter, or a
repo initialized before CI was wired — and stopping there reports success while
the native plugin and the only unbypassable control are both missing. Skip only
what is genuinely present, do the rest, and call it complete when all four check
out.

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

**macOS and Linux only.** Native Windows is not supported — the toolkit passes
6 of 28 core gate suites there. Use WSL. The installer refuses to run under
Git Bash / MSYS / Cygwin rather than installing a broken toolkit.

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

Fetch it to **this exact filename** — the workflow protects itself by name, and
any other name leaves it editable by the PRs it is meant to gate:

```sh
mkdir -p .github/workflows
test -e .github/workflows/adlc-rails-guard.yml \
  && echo "REFUSING: a workflow already exists — diff before replacing it" \
  || curl -fsSL https://raw.githubusercontent.com/voodootikigod/adlc/main/docs/ci/rails-guard.yml \
       -o .github/workflows/adlc-rails-guard.yml
```

The existence check is not ceremony. `curl -o` truncates without asking, and
this destination is a **protected trust root** — a repo with a customized or
newer workflow would have it silently replaced by whatever `main` serves today.
If it already exists, diff the two and let the human decide.

**This file is fetched from a mutable branch and will become a required CI check
with repo-wide authority. Review the whole thing before committing it** — not
just the header. It is workflow code that will run on every pull request; `main`
is not a fixed revision, and nothing here verifies its integrity. If the human
wants a stronger guarantee, have them pin the URL to a tag or commit SHA rather
than `main`.

**Then follow its header before marking the check required.** It documents a
multi-stage bootstrap: the bootstrap commit merges first, the base branch needs
`trustedCodeownersAttested` in `.adlc/config.json` (which `adlc init`
deliberately does not set), and `.adlc/manifest.jsonl` must be absent or empty
until reviewed. Marking it required early **fails every subsequent PR**.

Only once that ceremony is complete does marking it required in branch
protection make sense. Without it, frozen rails are advisory; with it enabled
too early, every PR fails.

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
