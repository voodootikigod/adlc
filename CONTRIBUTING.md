# Contributing to ADLC

Thanks for your interest in improving the Agentic Development Lifecycle toolkit. This
guide covers how to set up, build, test, and propose changes. By participating you agree
to abide by our [Code of Conduct](./CODE_OF_CONDUCT.md).

## Ways to contribute

- **Report bugs** — open a [bug report](https://github.com/voodootikigod/adlc/issues/new?template=bug_report.yml).
- **Propose features or new tools** — open a [feature request](https://github.com/voodootikigod/adlc/issues/new?template=feature_request.yml).
- **Improve docs** — the package READMEs are part of each tool; doc-only PRs are welcome.
- **Fix or extend a tool** — see the workflow below.
- **Report a security issue** — do *not* open a public issue; see [SECURITY.md](./SECURITY.md).

Before starting non-trivial work, please open an issue first so we can agree on the
approach. This avoids wasted effort on changes that don't fit the lifecycle's design.

## Project shape

This is an npm workspace monorepo. Each tool lives in `packages/<name>/` and follows a
strict contract documented in **[CONVENTIONS.md](./CONVENTIONS.md)** — read it before
writing any code. The high-level design is in [ADLC.md](./ADLC.md).

```
packages/<name>/
├── package.json        # @adlc/<name>, bin field, test script
├── bin/<name>.mjs      # CLI entry — thin: parse args, call lib, exit
├── lib/*.mjs           # logic — pure functions wherever possible
├── test/*.test.mjs     # node:test — MUST pass offline (no network, no API keys)
└── README.md           # what it does, usage, flags, exit codes, ADLC phase
```

## Development setup

Requires **Node.js 18 or newer** (CI runs the suite on Node 18, 20, and 22).

```sh
git clone https://github.com/voodootikigod/adlc.git
cd adlc
npm install        # installs the workspace
npm test           # runs every package's test suite
```

To run a single package's tests:

```sh
node --test packages/<name>/test/*.test.mjs
```

To run a tool from source:

```sh
node packages/<name>/bin/<name>.mjs --help
```

## The package contract (non-negotiable)

These rules from [CONVENTIONS.md](./CONVENTIONS.md) are what make the toolkit coherent.
PRs that violate them will be asked to change:

1. **Zero runtime dependencies.** Node 18+ built-ins and `@adlc/core` only.
2. **`@adlc/core` is frozen.** Never edit `packages/core/`. If core lacks something,
   implement it locally in your `lib/` and note the gap in your README under "Core gaps".
3. **Scope discipline.** A change to one tool stays inside `packages/<name>/`. Don't
   touch other packages, `ADLC.md`, or root files in the same PR unless that *is* the change.
4. **Exit codes:** `0` = gate passes · `1` = operational error · `2` = gate fails. Use
   `pass`/`gateFail`/`opError` from core. CI gating depends on this.
5. **`--prompt-only`** on every LLM-backed tool — prints the exact prompt and exits 0.
6. **`--json`** on every tool — machine-readable output alongside human-readable.
7. **Tests run offline and leave no trace.** Use fixtures and `mkdtempSync` temp dirs;
   clean up afterward. Never call an LLM provider in a test.
8. **Never mutate the working tree without a flag.** Writers default to dry-run;
   mutation tools restore files in a `finally` block and refuse to run on a dirty tree.
9. **No silent error swallowing.** Surface operational failures and partial data.
10. **Keep files under 400 lines** — split `lib/` by concern.
11. **The README is part of the tool** — document every flag, exit code, and the ADLC
    phase (P0–P7 / D1–D3) it serves.

## Coding style

- ESM only (`.mjs`, `"type": "module"`).
- Prefer pure functions and immutable data — return new objects, don't mutate inputs.
- Small, focused files; clear names; explicit error handling.
- Match the style of the surrounding code in the package you're editing.

## Testing requirements

- Every code change needs a test. We use the built-in `node:test` runner — no test
  framework dependency.
- Tests must pass offline with no API keys and must clean up any temp files they create.
- Run `npm test` before opening a PR; the full suite must be green.

## Adding a new tool

1. Open a feature-request issue describing the model failure mode it defends against —
   this is the bar for inclusion (see the ADLC design rule).
2. Scaffold `packages/<name>/` following the layout and `package.json` template in
   [CONVENTIONS.md](./CONVENTIONS.md).
3. Implement, test offline, and write the README.
4. Add the tool to [docs/package-reference.md](./docs/package-reference.md) and the
   toolkit table in [README.md](./README.md).

## Commit & PR process

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>: <description>

[optional body]
```

Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`.

1. Fork the repo and create a branch (`feat/<name>`, `fix/<name>`, …).
2. Make your change with tests; run `npm test`.
3. Push and open a PR against `main` using the PR template.
4. Keep PRs focused — one logical change per PR.
5. A maintainer will review; address feedback and we'll merge once green.

## Releases

Packages publish together in lockstep under the `@adlc` scope via the
`scripts/release.mjs` flow and the publish GitHub Action. Contributors do **not** need to
bump versions — maintainers handle releases. See [docs/RELEASING.md](./docs/RELEASING.md).

## Questions

Open a [discussion or issue](https://github.com/voodootikigod/adlc/issues) — we're happy
to help you get started.
