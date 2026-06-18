# Codex Integration

This repository ships ADLC as deterministic CLIs first and a Codex plugin second.
Codex skills should guide the workflow; ADLC CLIs and `.adlc/manifest.jsonl` decide
whether a phase passes.

The Codex-native integration plan is recorded in
[ADR 0001](./adr/0001-codex-native-adlc-integration.md).

## Local marketplace status

The offline smoke test validates the local marketplace entry, plugin manifest, skill
sentinels, and standalone hook:

```sh
node scripts/codex-install-smoke.mjs .
```

The actual Codex install commands are planned but unsupported until an isolated
`CODEX_HOME` transcript proves Codex accepts the marketplace and plugin schema without
mutating the real `~/.codex`:

```sh
codex plugin marketplace add .
codex plugin add adlc-codex --marketplace adlc
```

Git-backed install is planned but unsupported until sparse payload proof is recorded.

## No-install CLI fallback

Use the dispatcher outside this repository:

```sh
npx @adlc/cli@<ADLC_CLI_VERSION> spec-lint spec.md --json
npx @adlc/cli@<ADLC_CLI_VERSION> rails-guard --ticket T1 --tickets .adlc/tickets.json --record --json
```

Inside this repository, prefer the workspace-linked `adlc <tool>` dispatcher.

## Strict ADLC status

- P0-P4 and P7 have strong deterministic coverage.
- P5 records reviewer-produced evidence; `adlc prosecute` does not run the reviewer.
  Its transcript must name the ticket and reviewed revision that will be recorded, and
  its review packet must hash the prompt and reviewed input artifacts.
- P6 strict mode requires ticket- and revision-scoped P5 completion evidence plus a
  behavior acceptance packet. `adlc accept` carries forward the recorded P5 revision by
  default so behavior artifacts created after P5 do not change the reviewed target.

## Core commands

For normal git worktree use, do not pass `--revision`; P5 and P6 will use the current
content fingerprint and fail closed if reviewed content changes before P6. The transcript
referenced by the P5 input must include the ticket id and the resolved `git-worktree:<hash>`
revision. `adlc prosecute` excludes that transcript path from the fingerprint so the
binding is achievable for in-repo transcripts. The P5 input must also include
`review_packet.prompt`, `review_packet.prompt_hash`, `review_packet.inputs`,
`review_packet.inputs_hash`, and `review_packet.clean_worktree`.

P3, P4, P5, and P6 phase assertions are ticket-scoped. Explicit `--revision` on P5/P6 is
an offline selector for recorded manifest and artifact evidence; it does not compare
against the live git worktree.

```sh
adlc prosecute --input .adlc/p5-passes.json --ticket T1 --dir .adlc --json
adlc run p5 --ticket T1 --dir .adlc --json
adlc accept --ticket T1 --packet .adlc/packet.json --before .adlc/before.json --after .adlc/after.json --dir .adlc --json
adlc run p6 --ticket T1 --dir .adlc --json
```

P6 packet and snapshot paths inside the worktree must live under `.adlc/` or
`.omo/evidence/`, so they cannot be mistaken for reviewed source files.

The bundled `docs/examples/p5-passes.json` fixture is pinned to
`docs-example-revision`; use `--revision docs-example-revision` only when exercising that
static fixture outside the git-worktree staleness check.

## P4 rail hook

The Codex hook is assistive only. It activates only when:

```sh
ADLC_P4_ENFORCEMENT=1
```

It resolves the active ticket from `ADLC_TICKET`, with `.adlc/current-ticket.json` as a
local fallback. The bundled `PreToolUse` hook covers structured edit tools and common
shell write forms; mutating shell payloads fail closed when target paths cannot be
identified, when they change cwd, or when they rely on shell expansion. `adlc rails-guard`
remains the deterministic proof after shell-capable steps.
