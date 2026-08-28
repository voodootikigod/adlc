# ADLC — Agentic Development Lifecycle Toolkit

[![CI](https://github.com/voodootikigod/adlc/actions/workflows/ci.yml/badge.svg)](https://github.com/voodootikigod/adlc/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)

A workspace of **zero-dependency, gate-shaped Node.js CLIs** for running software
development the way frontier models actually behave — not the way humans do.

The SDLC is 60 years of defenses against *human* failure modes (forgetfulness, ego,
fatigue). Models have a different flaw profile: premature satisfaction, sycophancy,
context rot, confident hallucination, reward hacking. The **Agentic Development
Lifecycle (ADLC)** redesigns every phase, gate, and loop around those flaws. Read the
full thesis in [ADLC.md](./ADLC.md).

---

## Why this exists

> Every phase, gate, and loop in this lifecycle must trace to a specific model failure
> mode it defends against, or a specific model property it exploits. If it traces to a
> human failure mode instead, cut it.

Each tool is a small CLI that enforces one machine-checkable gate. They share a runtime
convention (`.adlc/` for tickets, ledgers, and gate evidence) and a common contract
(see [CONVENTIONS.md](./CONVENTIONS.md)) so 22 independently built tools feel like one
product.

## Install

One command installs the gate toolkit **and** the native ADLC integration for
every agent harness it finds on your machine:

```sh
curl -fsSL https://www.agenticlifecycle.ai/install.sh | sh
```

Then `cd` into a repo and run `adlc init`.

Requires **macOS or Linux** and **Node.js 18+** — the installer checks Node and
stops if it is missing rather than installing a runtime for you. Harnesses you
do not have are left alone.

Automated: Claude Code, Codex, GitHub Copilot, pi, Google Antigravity, herdr.
Two need a step the installer cannot take for you, and it prints them:
**Cursor** installs plugins through its in-app marketplace, and **OpenCode**
scaffolds the current directory, so it must be run inside your repo rather than
from wherever you invoked the installer. pi is also skipped below Node 22.19,
which is its own floor.

**Windows is not supported yet.** A `windows-latest` run of the core gate suites
passed 6 of 28: the shared bin-resolution path builds `D:\D:\…` from an
already-absolute Windows path, and most gates die on it. Use WSL until that is
fixed. (`adlc fleet` is POSIX-only by design regardless.)

Piping a remote script to a shell is a real tradeoff — see
[ADR-0010](./docs/adr/0010-first-party-curl-installer.md) for why we serve one
and what controls sit behind it.

**For CI, or to read it first**, fetch and run as separate steps:

```sh
tmp=$(mktemp -d) \
  && curl -fsSL https://www.agenticlifecycle.ai/install.sh -o "$tmp/install.sh" \
  && [ -s "$tmp/install.sh" ] \
  && sh "$tmp/install.sh"
```

Every link matters, including the first: if `mktemp` fails, `$tmp` is empty and
an unchained `curl -o "$tmp/install.sh"` resolves to `/install.sh` — a write to
the filesystem root. Without the non-empty check, a failed download still runs
`sh` on an empty file and reports success anyway.

In the piped one-liner the exit status is `sh`'s, not `curl`'s — a failed or
empty download makes `sh` read nothing and exit 0, reporting success having
installed nothing. Two steps make a failed download fail.

### Just the toolkit

Each package publishes independently under the `@adlc` npm scope. For normal use,
install the dispatcher and run tools through the stable `adlc <tool>` surface:

```sh
npm install -g @adlc/cli
adlc spec-lint <spec.md>

# or run without installing
npx @adlc/cli spec-lint <spec.md>
```

Individual packages can still be installed for package development, but Codex skills,
hooks, CI, and lifecycle docs should use the dispatcher.

## The toolkit

| Phase | Packages |
| --- | --- |
| **Spec & ticket shaping** | [`parallax`](./packages/parallax) · [`spec-lint`](./packages/spec-lint) · [`premortem`](./packages/premortem) · [`coldstart`](./packages/coldstart) · [`ticket-prune`](./packages/ticket-prune) · [`tickets`](./packages/tickets) · [`ticket-sync`](./packages/ticket-sync) |
| **Execution supervision & rails** | [`preflight`](./packages/preflight) · [`model-router`](./packages/model-router) · [`merge-forecast`](./packages/merge-forecast) · [`rails-guard`](./packages/rails-guard) · [`build-gate`](./packages/build-gate) · [`flail-detector`](./packages/flail-detector) · [`consensus-fix`](./packages/consensus-fix) · [`context-handoff`](./packages/context-handoff) · [`fleet`](./packages/fleet) · [`autopilot`](./packages/autopilot) · [`runner`](./packages/runner) |
| **Review evidence & calibration** | [`behavior-diff`](./packages/behavior-diff) · [`gate-manifest`](./packages/gate-manifest) · [`hollow-test`](./packages/hollow-test) · [`prosecute`](./packages/prosecute) · [`review-calibration`](./packages/review-calibration) · [`model-ratchet`](./packages/model-ratchet) · [`gate-fuzzing`](./packages/gate-fuzzing) |
| **Compounding defenses** | [`lesson-foundry`](./packages/lesson-foundry) · [`rejection-mining`](./packages/rejection-mining) · [`skill-rot`](./packages/skill-rot) |
| **Shared foundation** | [`@adlc/cli`](./packages/cli) · [`@adlc/core`](./packages/core) · [`init`](./packages/init) · [`quartermaster`](./packages/quartermaster) |

See [docs/package-reference.md](./docs/package-reference.md) for binaries, command forms,
and per-package detail, and [docs/toolkit.md](./docs/toolkit.md) for how the packages fit
the ADLC flow.

## Use it in Claude Code

This repo is also a Claude Code plugin — it makes the whole lifecycle usable from
inside the editor (phase-routing skill, ticket/distill/maintain commands, a
prosecutor subagent, and hooks that fire the gates automatically), with no API
keys (Claude is the model via `--prompt-only`).

**Recommended:** install with [`plugins`](https://www.npmjs.com/package/plugins), the
vendor-neutral installer that auto-detects your agent tools and installs the plugin
into each (Claude Code today; other harnesses as their plugin packages publish — each
has a native install path below; see [ADR-0009](./docs/adr/0009-universal-install-via-plugins.md)
for why this is the preferred path):

```sh
npx plugins add voodootikigod/adlc   # install the plugin into your agent tool(s)
npm install -g @adlc/cli             # the gate toolkit the plugin shells out to
/adlc:adlc-init                      # bootstrap .adlc/ in your repo (once)
```

Already using Claude Code's native plugin marketplace? That path still works:

```sh
npm install -g @adlc/cli
/plugin marketplace add voodootikigod/adlc
/plugin install adlc@adlc
/adlc:adlc-init
```

See **[docs/integrations/claude-code.md](./docs/integrations/claude-code.md)** for the full adoption guide.

## Use it in other editors

Each agent tool has its own native integration. See the guides:

- **[Codex](./docs/integrations/codex.md)** — hooks-based integration.
- **[Cursor](./docs/integrations/cursor.md)** — preToolUse rails dispatcher, hook parity, command suite + prosecutor loop, rules.
- **[Google Gemini](./docs/integrations/gemini.md)** — native plugin system.
- **[OpenCode](./docs/integrations/opencode.md)** — full phase-router coverage.
- **[Pi](./docs/integrations/pi.md)** — TypeScript Extension integration.

## Use it in any other agent

For the ~70 harnesses that support [skills.sh](https://skills.sh) but have no
native ADLC plugin, the harness-neutral skill catalog is one command:

```sh
npx skills add voodootikigod/adlc   # the harness-neutral skill catalog
npm install -g @adlc/cli            # the gate toolkit the skills shell out to
adlc init                           # bootstrap .adlc/ in your repo (once)
```

This channel installs **skills only** — the phase router, the bootstrap guide,
and the P5 prosecution workflow, all driven through the `adlc` CLI. It does
**not** install hooks, MCP tools, agents, or in-session rail enforcement. If
your agent is one of the seven with a native plugin above, install that
instead: it is a strictly stronger integration. With the skills catalog, the CI
`rails-guard` job in [docs/ci/rails-guard.yml](./docs/ci/rails-guard.yml) is
your only rail control — wire it and make it a required check.

## Project layout

| Directory | Contents |
|---|---|
| `packages/` | The toolkit: 22 zero-dependency, gate-shaped CLIs |
| `plugins/adlc-claude-code/` | Claude Code integration (skill, commands, hooks, subagent) |
| `plugins/adlc-codex/` | Codex integration (hooks and skills; no TypeScript package) |
| `plugins/adlc-gemini/` | Google Gemini integration — Antigravity and JetSki (native plugin system, skills, hooks) |
| `plugins/adlc-pi/` | Pi harness integration package (TypeScript, skills, tests) |
| `docs/` | Lifecycle thesis, integration guides, ADRs, CI templates |
| `.claude/commands/` | Maintainer commands for this repo (release workflow) |
| `scripts/` | Release, smoke test, and CI helper scripts (not published; run by `npm test` and CI) |
| `.adlc/` | Runtime data directory (tickets, gate evidence — gitignored except example) |
| `.claude-plugin/` | Repo-root marketplace manifest (`marketplace.json`) — the index `npx plugins add voodootikigod/adlc` (and the native `/plugin marketplace add voodootikigod/adlc`) read to resolve the plugin. See [ADR 0003](./docs/adr/0003-adlc-claude-code-plugin.md) for the subdirectory-source assumption and Pre-GA checklist. |

## Design principles

Every tool follows the same contract ([CONVENTIONS.md](./CONVENTIONS.md)):

- **Zero runtime dependencies** — Node 18+ built-ins and `@adlc/core` only.
- **`--prompt-only`** on every LLM-backed tool — print the exact prompt and exit, so the
  tool is usable with zero API keys (paste into any harness).
- **`--json`** on every tool — machine-readable output for orchestrators.
- **Exit codes are the gate**: `0` = gate passes · `1` = operational error · `2` = gate fails.
- **Never mutate the working tree without a flag** — writers default to dry-run.
- **Tests run offline** — no network, no API keys, no trace left behind.

## Quick start (from source)

```sh
git clone https://github.com/voodootikigod/adlc.git
cd adlc
npm install
npm test
```

Requires **Node.js 18 or newer**.

## Documentation

- [ADLC.md](./ADLC.md) — the full lifecycle thesis and flaw inventory.
- [docs/integrations/claude-code.md](./docs/integrations/claude-code.md) — adopt the ADLC inside Claude Code (plugin).
- [docs/integrations/codex.md](./docs/integrations/codex.md) — native Codex integration guide.
- [docs/integrations/pi.md](./docs/integrations/pi.md) — pi coding-agent harness integration guide.
- [docs/](./docs/README.md) — toolkit guide, package reference, ADRs, and narrative essays.
- [CONVENTIONS.md](./CONVENTIONS.md) — the contract every package follows.

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](./CONTRIBUTING.md) for the dev
setup, the package contract, the testing requirements, and the PR process. By
participating you agree to our [Code of Conduct](./CODE_OF_CONDUCT.md).

- 🐛 [Report a bug](https://github.com/voodootikigod/adlc/issues/new?template=bug_report.yml)
- 💡 [Request a feature](https://github.com/voodootikigod/adlc/issues/new?template=feature_request.yml)
- 🔒 [Report a vulnerability](./SECURITY.md)

## License

[MIT](./LICENSE) © Chris Williams
