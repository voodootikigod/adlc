# Codex Integration

This page is the landing doc for the Codex-native ADLC surface. It explains how to
install it, how to use it, and where the current implementation still falls short of the
formal ADLC doctrine.

The integration is described in more detail in [ADR 0001](./adr/0001-codex-native-adlc-integration.md).
The canonical ticket schema all gates read is in [ticket-authoring.md](./ticket-authoring.md).

## Install

Local verification:

```sh
node scripts/codex-install-smoke.mjs .
```

That smoke test validates the local marketplace entry, plugin manifest, bundled hooks,
and skill sentinels. It does not run `codex` or exercise the rail hook.

Maintainer-only install path:

> Run this only in a disposable environment. It uses `ADLC_CODEX_LIVE_INSTALL=1` to
> exercise the isolated install path and verify the plugin, hooks, and skills.

```sh
ADLC_CODEX_LIVE_INSTALL=1 node scripts/codex-install-smoke.mjs .
```

There is no published-package fallback in this checkout yet.
Out-of-repo invocation is currently unsupported in this doc.

Git-backed marketplace install is not yet supported.

## Usage

Use `adlc` as the stable public prefix. The dispatcher routes to the tool packages and
keeps the command surface consistent across Codex skills, hooks, CI, and humans.

In this checkout, bare `adlc` resolves to `node packages/cli/bin/adlc.mjs`. Outside this
checkout, there is no supported invocation path documented yet.

Example usage in this checkout:

```sh
node packages/cli/bin/adlc.mjs --help
node packages/cli/bin/adlc.mjs spec-lint spec.md --json
node packages/cli/bin/adlc.mjs run p5 --ticket T1 --dir .adlc --json
node packages/cli/bin/adlc.mjs accept --ticket T1 --packet .adlc/packet.json --before .adlc/before.json --after .adlc/after.json --dir .adlc --json
node packages/cli/bin/adlc.mjs rails-guard --ticket T1 --tickets .adlc/tickets.json --record --json
```

These are templates. They require an existing `spec.md`, a populated `.adlc/` ticket set,
and recorded evidence for the `T1` examples.

Typical flow:

1. Run `adlc preflight` before fan-out.
2. Shape the work with `adlc spec-lint`, `adlc premortem`, and `adlc parallax`.
3. Decompose with `adlc coldstart`, `adlc merge-forecast`, and `adlc model-router`.
4. Build rails with `adlc hollow-test`, `adlc rails-guard`, and `adlc flail-detector`.
5. Prosecute with `adlc prosecute`, then record behavior evidence with `adlc accept`.
6. Distill repeated findings with `adlc lesson-foundry`, `adlc rejection-mining`, and
   `adlc skill-rot`.

Phase-scoped assertions that matter for the formal lifecycle:

```sh
adlc run p3 --ticket T1 --dir .adlc --json
adlc run p4 --ticket T1 --dir .adlc --json
adlc run p5 --ticket T1 --dir .adlc --json
adlc run p6 --ticket T1 --dir .adlc --json
```

Notes:

- `p3`, `p4`, `p5`, and `p6` require `--ticket`.
- `p5` and `p6` use the current git worktree fingerprint unless `--revision` is supplied.
- Without `--revision`, `p5` and `p6` fail closed if reviewed content changes before
  `p6` completes.
- Explicit `--revision` is an offline selector for recorded evidence, not a live worktree
  comparison.
- `adlc prosecute` records reviewer-produced evidence; it does not run the reviewer.
- `adlc accept` records the behavior-diff packet and snapshot evidence for P6.

Bundled P5 fixture:

- `docs/examples/p5-passes.json` is pinned to `docs-example-revision`.
- When you use that fixture, keep `--revision docs-example-revision` on the prosecution
  command so the recorded evidence matches the fixture's reviewed revision.
- Requires a `.adlc/tickets.json` that defines ticket `T1`.
- Example:

```sh
adlc prosecute --input docs/examples/p5-passes.json --ticket T1 --revision docs-example-revision --dir .adlc --json
```

Evidence boundaries that stay part of the formal map:

- P6 packet and snapshot artifacts must live under `.adlc/` or `.omo/evidence/`, so
  they are not confused with reviewed source files.
- `review_packet` requires `prompt`, `prompt_hash`, `inputs`, `inputs_hash`, and
  `clean_worktree` fields when prosecution evidence is asserted.
- The P4 rail hook fails closed on mutating shell payloads; it is an enforcement aid, not
  a replacement for `rails-guard`.

> Warning: The maintainer-only live path gated by `ADLC_CODEX_LIVE_INSTALL=1` runs in
> throwaway `CODEX_HOME`, `HOME`, and XDG roots under `/tmp`. Use it as a maintainer
> verification step in a disposable environment.

There is no user-facing end-to-end install verification users can trust yet. The default
`node scripts/codex-install-smoke.mjs .` path does not mutate `~/.codex` or exercise the
rail hook. The same script has a maintainer-only live path gated by
`ADLC_CODEX_LIVE_INSTALL=1`.

## Formal ADLC Coverage

| Phase | Status | Notes |
| --- | --- | --- |
| P0 | Strong | `adlc preflight` and the router skill provide the deterministic startup gate. |
| P1 | Strong | `adlc spec-lint` and `adlc premortem` force executable acceptance criteria. |
| P2 | Strong | `adlc coldstart`, `adlc merge-forecast`, and `adlc model-router` cover ticket shaping. |
| P3 | Strong | `adlc rails-guard`, `adlc hollow-test`, and the rail hook protect frozen rails. |
| P4 | Strong | Ticket-scoped rail assertions and the hook give deterministic build supervision. |
| P5 | Partial | Review evidence is machine-checkable, but there is still no first-party deterministic prosecution orchestrator that fans out lenses and loops until dry automatically. |
| P6 | Conditional | P6 is strong when backed by valid P5 evidence and a matching acceptance packet. |
| P7 | Strong | `adlc lesson-foundry`, `adlc rejection-mining`, `adlc skill-rot`, and `adlc model-ratchet` support maintenance. |

## Gaps

Current gaps relative to the formal ADLC doctrine:

1. P5 is still not fully automated. The repo can record and assert prosecution evidence, but
   the formal orchestration loop for fan-out, finding verification, and dry-pass convergence
   is not yet a single deterministic first-party gate.
2. Git-backed sparse marketplace install remains unsupported until payload proof is
   recorded.
3. Codex hooks assist P4 rail protection, but they do not replace `rails-guard` or the
   repository's other deterministic checks.

For Claude Code–specific gaps (in-session Bash enforcement, P5 formal assertion on the CC
path), see [`claude-code.md` — Gaps](./claude-code.md#gaps).

## Using with Claude Code

The Codex plugin and the Claude Code plugin are designed to coexist. A common
setup uses Codex for CI workers (skill invocations, phase-assertion hooks) and
Claude Code for interactive sessions (commands, hooks, skill routing). Both write
to the same `.adlc/` workspace and read the same tickets.

The ticket schema that all gates and both integrations read is documented in
[`ticket-authoring.md`](./ticket-authoring.md).

Command separation:
- `adlc <tool>` — gate dispatcher; used by both harnesses.
- `adlc-runner <verb>` — phase-assertion runner; used by this Codex path.

See [`claude-code.md`](./claude-code.md) for the Claude Code integration and
[ADR 0002](./adr/0002-adlc-command-reconciliation.md) for the full command
reconciliation rationale.

## Boundary

- `.adlc/` is the runtime state area for tickets, manifests, and gate evidence.
- `.omo/` is for Codex planning and operator artifacts.
- The docs in this directory are the canonical high-level map; package READMEs remain the
  source of truth for exact flags, schemas, and exit codes.
