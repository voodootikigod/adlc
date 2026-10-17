# Spec — a ticket's own new rails do not tier its own change (T-01M4RWNRXG0KKR6ZNXJ4G4X59J)

**Phase:** P1 contract for GitHub issue #1180, describing the change as built
on `2a22c51a`. Package: `@adlc/prosecute` (trust-root tier).

## Problem

`classifyTrustRootTier` (`packages/prosecute/lib/tier.mjs`) ORs the `rails` of
every ticket whose `completed !== true` over the changed files, and
`loadTicketsForTier` (`packages/prosecute/bin/adlc-prosecute.mjs`) unions the
base tip's tickets with the worktree's. A bounded ticket that adds its own RED
test as a rail, on the same branch as the change, therefore tiers its own diff
as trust-root, and the P5 recorder demands a distinct-provider cross-model
approve for a change that touches no trust-root surface.

Reproduction on `origin/main` (`498a54d3`): the base has ticket `T1` with no
rails; a branch adds ticket `T2` with rail `test/own/**` and writes
`test/own/a.test.mjs`. Then
`adlc-prosecute tier-check --base main --author-provider anthropic --ticket T2 --json`
reports `trustRootTier: true` with reason
`touches rails deny-path of ticket T2: test/own/**` and exits 2.

## Intent

A rail that the change itself adds to the ticket under prosecution applies
after merge, not to that change. This is the add-vs-alter rule the rail-freeze
gate (`scripts/rails-guard-ci.mjs`) already applies to the ticket store: a PR
may add a ticket, and adding it grants no privilege over rails already on the
base. Everything else keeps failing closed.

## Design

1. `classifyTrustRootTier({ changedFiles, tickets, ownTicket })` takes an
   optional `ownTicket = { id: string, baseRails: string[] }`. A matching rail
   of the ticket whose `id === ownTicket.id` that is not in
   `ownTicket.baseRails` adds no reason and is listed once in the new return
   field `skippedOwnRails`. The return value is
   `{ isTrustRootTier, reasons, skippedOwnRails }`.
2. An `ownTicket` without a non-blank string `id` or without a `baseRails`
   array skips nothing. Omitting `ownTicket` gives today's result, with
   `skippedOwnRails: []`.
3. The bin builds `baseRails` from the base tip only: the canonical store and
   the in-repo `--dir` table as git holds them at the base. The `--dir` table
   is located with `realpath`, so a symlinked or case-variant `--dir` finds
   the same base copy the worktree read finds. A table outside the
   repository, or absent at the base, contributes no base rails. A base store
   or table that exists but cannot be parsed exits 1.
4. The P5 recorder always passes its `--ticket` as `ownTicket`. `tier-check`
   passes it only when `--ticket` is given. Both print one stderr line per
   skipped rail, `tier: skipped own new rail of ticket <id>: <glob> (not on base <base>)`,
   and every `tier-check --json` output carries `skippedOwnRails`.

## Acceptance criteria

- The four issue cases hold on the pure classifier: an own new rail does not tier and is listed in `skippedOwnRails`; an own rail on the base tiers; another ticket's rail tiers, also when it shares the glob; a completed ticket does not tier. verify: `node --test packages/prosecute/test/tier-own-ticket.test.mjs`
- A malformed `ownTicket` skips nothing, even when a ticket carries the same id, and omitting `ownTicket` reproduces the previous result on the full positive-surface matrix. verify: `node --test packages/prosecute/test/tier-own-ticket.test.mjs`
- At the process boundary, `tier-check --ticket T2` on the reproduction exits 0 with `skippedOwnRails: ['test/own/**']` and the stderr line; without `--ticket` it exits 2; `--ticket T1` still tiers. verify: `node --test packages/prosecute/test/tier-own-ticket-cli.test.mjs`
- Base rails come from the base only: base rail `a` tiers while new rail `b` is skipped; a HEAD narrowing of base rails still tiers; another base ticket with the same glob still tiers. verify: `node --test packages/prosecute/test/tier-own-ticket-cli.test.mjs`
- The in-repo `--dir` table is read at the base, including through a symlinked or case-variant `--dir`; a table new on the branch or outside the repository adds no base rails; a malformed base table exits 1 for both `tier-check` and the recorder. verify: `node --test packages/prosecute/test/tier-own-ticket-cli.test.mjs`
- Every `tier-check --json` branch, the no-key one included, carries `skippedOwnRails`. verify: `node --test packages/prosecute/test/tier-own-ticket-cli.test.mjs packages/prosecute/test/prosecute-tier-check-cli.test.mjs`
- The recorder on an own-new-rail change with a dry panel and no attestation exits 0 and writes no `p5-cross-model-missing`; under another ticket it exits 2. verify: `node --test packages/prosecute/test/tier-own-ticket-cli.test.mjs`
- The existing prosecute suite and the toolkit floor stay green. verify: `node --test packages/prosecute/test/*.test.mjs scripts/test/toolkit-floor.test.mjs`
- The changed lines have tests that notice them breaking. verify: `node scripts/mutation-gate.mjs origin/main --max 12` exits 0 (exit code 0)
- No frozen rail or existing ticket is edited. verify: `node scripts/rails-guard-ci.mjs origin/main` exits 0 (exit code 0)

## Out of scope

- **The CI form without `--ticket`.** `.github/workflows/cross-model-gate.yml`
  runs `tier-check` without `--ticket`, and that form keeps today's behaviour:
  every active ticket's rails tier, the new ticket's own included. A change
  whose only trust-root reason is its own new rail therefore passes the local
  recorder without a cross-model approve, and CI's `gate` still asks for one.
  This fails closed. Teaching the CI form the add-vs-alter rule would change
  the workflow and is a separate change.
- **Recording the skip in the manifest.** The recorder's `p5-complete` entry
  does not list `skippedOwnRails`; the stderr line is the only trace that a
  rail was skipped. Adding it to the entry is a separate change.
- **A stale `--base`.** `baseRails` and the base ticket set come from the same
  `--base` ref, which is the caller's to keep fresh. With a local `main`
  behind the remote, a rail frozen upstream can read as new. CI passes the PR
  base SHA, and `npm run preflight` fetches the base first.
- **Freezing the RED test inside the branch.** The tier decision is not the
  freeze. Protecting a rail-covered file during the build stays with
  `adlc rails-guard` and the P4 hooks. This change removes the cross-model
  escalation that used to fire, as a side effect, on every edit to an own new
  rail.
- `packages/rails-guard`: its CI gate already reads rails from the base tip.
- The list of trust-root surfaces in `tier.mjs`, and every non-rail reason.
- Rail glob equivalence: `baseRails` is compared by exact glob string. A HEAD
  copy that rewrites a base glob into an equivalent form still tiers, because
  the base copy's rails stay in the union.
