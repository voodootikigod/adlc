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
(see [CONVENTIONS.md](./CONVENTIONS.md)) so 20 independently built tools feel like one
product.

## Install

Each package publishes independently under the `@adlc` npm scope. Install only what you
need, or run on demand with `npx`:

```sh
# one tool, global
npm install -g @adlc/spec-lint

# or run without installing
npx @adlc/spec-lint <spec.md>
```

## The toolkit

| Phase | Packages |
| --- | --- |
| **Spec & ticket shaping** | [`parallax`](./packages/parallax) · [`spec-lint`](./packages/spec-lint) · [`premortem`](./packages/premortem) · [`coldstart`](./packages/coldstart) |
| **Execution supervision & rails** | [`preflight`](./packages/preflight) · [`model-router`](./packages/model-router) · [`merge-forecast`](./packages/merge-forecast) · [`rails-guard`](./packages/rails-guard) · [`flail-detector`](./packages/flail-detector) · [`consensus-fix`](./packages/consensus-fix) |
| **Review evidence & calibration** | [`behavior-diff`](./packages/behavior-diff) · [`gate-manifest`](./packages/gate-manifest) · [`hollow-test`](./packages/hollow-test) · [`review-calibration`](./packages/review-calibration) · [`model-ratchet`](./packages/model-ratchet) · [`gate-fuzzing`](./packages/gate-fuzzing) |
| **Compounding defenses** | [`lesson-foundry`](./packages/lesson-foundry) · [`rejection-mining`](./packages/rejection-mining) · [`skill-rot`](./packages/skill-rot) |
| **Shared foundation** | [`@adlc/core`](./packages/core) |

See [docs/package-reference.md](./docs/package-reference.md) for binaries, command forms,
and per-package detail, and [docs/toolkit.md](./docs/toolkit.md) for how the packages fit
the ADLC flow.

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
- [docs/](./docs/README.md) — toolkit guide, package reference, and the narrative essays.
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
