# Spec note — ticket-prune (closes #39)

**Phase:** lightweight P1 record for a shipped P2/maintenance tool, not a full design spec.

> **Superseded (#104):** The original `--write` semantics below (move stale
> tickets into a gitignored `.adlc/tickets.archive.json` and remove them from
> `.adlc/tickets.json`) produced a diff the rails-guard CI gate hard-denies (it
> forbids removing/mutating a base ticket). `--write` now **tombstones in
> place**: it adds `completed: true` to a rails-less stale ticket and changes
> nothing else — the exact annotation the gate accepts (`--archive` flag and
> the archive file are gone). Rails-freezing stale tickets are reported under
> `needsCeremony` for the protected-base admin ceremony instead of being
> auto-completed. AC4 and the archive references in the Decision are historical;
> see `docs/tools/ticket-prune.md` and `packages/ticket-prune/README.md` for the
> current behavior.

## Issue

[#39](https://github.com/voodootikigod/adlc/issues/39): `.adlc/tickets.json` is a
mutable working scratchpad that nothing prunes after a ticket's work ships, so
completed tickets accumulate and masquerade as an open backlog (surfaced concretely by
OpenCode tickets T1–T5 still listed on `main` after merging via #27–#34). Related
context: [#35](https://github.com/voodootikigod/adlc/issues/35) section B ("stale
completed tickets on main; consider a lifecycle/archive").

## Decision

Source of truth for "done": prefer an explicit `status` field on the ticket when
present (`done`/`closed`/`complete`/`completed`/`archived`/`shipped`, case-insensitive);
otherwise infer from every declared `scope` glob resolving to a file tracked at
`--base-ref` (default `HEAD`). PR-reference inference was rejected — this repo's
ticket schema has no PR-number field, and a `git log` survey shows ticket ids are
referenced inconsistently in shipping commits (some name the id, e.g. `(T13/T14)`;
the T1–T5 shipping PRs #27–#31 never do), so grepping history would miss exactly the
stale tickets the issue's own worked example was written to catch. Archive, don't
delete: stale tickets move to a gitignored `.adlc/tickets.archive.json`. See
`packages/ticket-prune/README.md` for the full reasoning.

## Acceptance criteria

- AC1: A new `adlc ticket-prune` CLI verb exists (`packages/ticket-prune`, registered
  in `packages/cli/lib/registry.mjs`), dry-run by default.
- AC2: A ticket is detected stale given a mocked done signal (explicit `status: done`,
  or every declared `scope` glob present on the base ref) — not stale otherwise.
- AC3: The default (dry-run) invocation reports stale tickets without mutating
  `.adlc/tickets.json` or creating an archive file.
- AC4: `--write` moves stale ticket entries into `.adlc/tickets.archive.json`
  (upserted by id, preserved across repeated runs) and removes them from
  `.adlc/tickets.json`, leaving active tickets untouched.
- AC5: `/adlc-maintain` documents `adlc ticket-prune --json` as a decay-driven,
  keyless maintenance check alongside `skill-rot` and `model-ratchet`.

## Verification commands

```bash
# Package unit + integration tests (detection, dry-run, --write, CLI exit codes)
cd packages/ticket-prune && npm test

# CLI dispatcher wiring (registry, resolveBin, --help, tool count)
cd packages/cli && npm test

# Consolidated phase-router content stays byte-identical to the generator.
# NOTE: this ticket did NOT edit scripts/router/router-model.mjs — the six
# generated phase-router files still list only skill-rot/model-ratchet/
# gate-fuzzing under "Maintenance" and do not mention ticket-prune (unlike
# README.md, docs/toolkit.md, docs/package-reference.md, and
# adlc-maintain.md, which were updated). Adding ticket-prune to the shared
# router model is tracked as follow-up work, not part of this ticket; running
# this test here only confirms the (unrelated) generator itself has not
# drifted from its committed output.
node --test scripts/test/router-drift.test.mjs

# Manual smoke, dry-run then archive
adlc ticket-prune --json
adlc ticket-prune --write --json
```
