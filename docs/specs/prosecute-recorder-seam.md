# Spec — Make the prosecute recorder/reviewer seam explicit (closes #65)

**Phase:** P1 lightweight record for a docs + small-dispatcher-addition ticket.

## Issue

`packages/prosecute` (bin `adlc-prosecute`) makes zero model calls — it is a P5
evidence recorder/ledger, not a reviewer. The actual adversarial engine is the separate
`adversarial-review` CLI (`npx adversarial-review`), which was not registered as a verb
in `packages/cli/lib/registry.mjs`. This is a defensible design (control flow is code,
judgment is models) but was previously a surprise: nothing in the dispatcher, the
toolkit guide, or the top of the prosecute README said so up front.

## Acceptance criteria

1. `adlc review` is registered as a dispatcher verb in `packages/cli/lib/registry.mjs`
   and shells out to `npx adversarial-review` with full argument passthrough, following
   the existing thin-passthrough pattern used by other registered verbs.
2. A test exists that confirms the verb is registered and that dispatching it passes
   arguments through to the underlying command, using a mocked/injected child-process
   spawn function — no real process is spawned and no network call is made.
3. `docs/toolkit.md`'s P5 material states, as a headline design decision (not a buried
   caveat), that `adlc prosecute` records evidence and does not itself review, and that
   `adlc review` / `npx adversarial-review` is the tool that actually judges code.
4. `packages/prosecute/README.md`'s top-level summary leads with the same design
   decision, ahead of the mechanical description of what the tool records.
5. The full `@adlc/cli` test suite passes after the change, with no regressions.

## Verification

```sh
cd packages/cli
node --test test/*.test.mjs
```

All 20 tests pass, including the 5 new tests in `test/review-dispatch.test.mjs` that
cover verb registration, help-text listing, argument passthrough, exit-code
propagation, and spawn-error surfacing for `adlc review`.

```sh
node -e "import('./packages/cli/lib/registry.mjs').then(m => console.log(m.getTool('review')))"
```

confirms the registered tool shape: `{ name: 'review', packageName: 'adversarial-review', external: true, ... }`.
