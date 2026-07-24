# Working in this repo (agents)

Harness-agnostic on purpose: this repo ships plugins for seven agent harnesses,
so the guidance lives here rather than in a tool-specific file.

Read [CONTRIBUTING.md](./CONTRIBUTING.md) and [CONVENTIONS.md](./CONVENTIONS.md)
first — they carry the package contract and coding rules. This file only records
things that are **not derivable** from the code, and that have actually gone
wrong.

## Before you push: `npm run preflight`

Not `npm test`. CI blocks a PR on three gates, and the suite is only one:

| gate | what it asks |
| --- | --- |
| tests | does the workspace suite pass |
| rail-freeze | did the diff edit a frozen rail, **or change an existing ticket** |
| mutation-gate | do the changed lines have tests that notice them breaking |

`npm run preflight` runs all three, in CI's order, against a freshly fetched
base.

**`adlc rails-guard` is not the CI check.** They sound interchangeable and are
not: `scripts/rails-guard-ci.mjs` additionally forbids any change to an existing
ticket's contract in `.adlc/tickets.json`. A clean `adlc rails-guard` has
already been reported as "ready to merge" on a branch CI then rejected. The
weaker check is the more discoverable one — prefer `npm run preflight`.

## `.adlc/tickets.json` is the rail trust root

Anything that can rewrite the ticket store can weaken its own rails, so CI
freezes it: a PR may **add** a ticket, never alter an existing one.

The practical consequence is about ticket **ids**. They are claimed by whoever
writes first, including a concurrent session in another worktree:

```sh
git fetch origin main          # immediately before, not at task start
adlc ticket list --json        # re-read; the id you scouted may be taken
gh pr list --json number       # ...and ids claimed by OPEN PRs are not on main yet
adlc ticket create --input <file> --write
```

Checking `main` alone is not enough: an id added by an open PR is invisible
there until it merges, including a PR you opened yourself earlier in the same
session. Choosing an id from a snapshot taken earlier silently **overwrites
someone else's ticket**, which is exactly what the gate rejects. Re-read shared
mutable state at the moment you use it, not when you start.

### Resolving a `.adlc/tickets.json` conflict during a rebase

`--ours` and `--theirs` are **inverted in a rebase**: `--ours` is upstream, and
`--theirs` is the commit being replayed. `git checkout --theirs` therefore keeps
*your* stale store and silently drops tickets that landed on the base — which
the rail-freeze gate then rejects as removals. Name the ref explicitly instead
of relying on the side words, then re-add your ticket:

```sh
git checkout origin/main -- .adlc/tickets.json
adlc ticket create --input <file> --write
```

## Undoing an experiment: copy, don't `git checkout`

Mutation testing and gate-bite checks mean deliberately breaking a file and
reverting it. `git checkout -- <file>` reverts to **HEAD**, discarding
uncommitted work in that file — which has already destroyed in-progress edits
here.

```sh
cp packages/x/lib/y.mjs /tmp/y.bak    # then mutate, test
cp /tmp/y.bak packages/x/lib/y.mjs    # restore exactly what you had
```

`git stash` has a sharper edge: this repo carries **long-lived stashes from other
branches**. `git stash push` on a clean tree saves nothing, so a later
`git stash pop` silently pops *someone else's* entry. Never pair a bare
push/pop around a checkout. If you already did, the entry is recoverable:

```sh
git fsck --unreachable | grep commit | awk '{print $3}' \
  | xargs -n1 git log -1 --format='%H %s' | grep 'On <branch>'
git stash store -m "<original message>" <sha>
```

## Check whether the checkout is already busy

Other agent sessions and `mutation-gate` runs mutate tracked files in place, so
a dirty tree may not be the user's edit and may change under you mid-task:

```sh
ps -Ao pid,etime,command | grep -E "hollow-test|mutation-gate" | grep -v grep
```

If something is running, work in a worktree (`.worktrees/<name>`, see
[rules on worktrees](https://github.com/voodootikigod/adlc)) and leave the main
checkout alone. Note the Bash tool's working directory can reset between calls —
confirm `pwd` before trusting a `git status`.

## Stacking a PR

PRs here are **squash-merged**, so a base branch disappears and its commits are
rewritten into one. Before building on another PR, check it is still open
(`gh pr view <n> --json state`). If it merged, rebuilding is a cherry-pick of
your own unique commits onto fresh `main`, not a rebase — a rebase replays the
pre-squash commits and conflicts throughout.

## The ADLC gates apply to this repo too

This repo is the toolkit, and it uses it: author a ticket (P0), check
executability (`adlc coldstart <id> --prompt-only`, P2), and prosecute before
merge (`/adlc:adlc-prosecute`, P5). Three rules that carry real weight:

- **Fail-open vs fail-closed is a deliberate choice, never an accident.** Several
  gates fail open on purpose so an unverifiable signal cannot kill real work.
  When you touch one, assert the direction in a test so it cannot drift.
- **A mock cannot catch drift in the thing it imitates.** #284 shipped because
  every fixture mocked a tool's output in a shape that tool has never produced.
  For contract tests, drive the real binary, and export the production adapter
  so tests use *it* rather than a copy of it.
- **An unused parameter that every caller passes is a missing check, not dead
  code.** `completeTicketOnIntegration` accepted `integrationBranch`, ignored it,
  and committed to whatever happened to be checked out. A lint cleanup read
  "declared but never read" and deleted the parameter; review later found the
  real defect underneath — a concurrent checkout switch could land a lifecycle
  commit on the wrong branch. When every call site faithfully supplies a value
  the callee ignores, the fix is to make it load-bearing (verify against it),
  not to delete it. Deleting it removes the evidence of the missing guard.

Changes under `packages/rails-guard`, `prosecute`, `gate-manifest`, or
`build-gate` are trust-root tier: a same-model P5 is not sufficient, and a
cross-model review must be recorded before merge.
