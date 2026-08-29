---
name: issue-lanes
description: >-
  Pick N open GitHub issues and resolve each one through the full ADLC gate sequence
  (P0 ticket → P2 coldstart → P3 rails → P4 TDD build → P5 mutation gate + cross-model
  review → PR) in its own git worktree on its own branch, with the lanes running in
  parallel. Encodes this repository's specific gates, ceremony blockers, and the setup
  gotchas that cost time the first time. Triggers on "resolve N issues in parallel",
  "issue lanes", "fix four issues with adlc", "batch of issues through ADLC", "one worktree
  per issue".
user-invocable: true
argument-hint: "[count=4] [--issues 622,712] [--label P1-high] [--exclude area:autopilot]"
---

# Issue lanes — N issues, N worktrees, N branches, every ADLC gate

One **lane** = one issue + one ticket + one worktree + one branch + one fork agent + one PR.
The parent (you) selects, authors the contracts, launches the lanes, and relays; the lanes
build. Nothing is merged by an agent — P6 is the human.

Load `/adlc:adlc` first (the router) and `/adlc:adlc-ticket` (the P0 protocol); this skill
composes them for a batch.

## 0. Preconditions (5 minutes, all mechanical)

```bash
git status --short            # main checkout must be clean
git fetch -q origin main:refs/remotes/origin/main
adlc --version                # toolkit installed (>= scripts/toolkit-floor.json)
adlc ticket store status --json   # backend: directory, pendingTransactions: []
gh auth status
```

**Rail-freeze pre-check — do this before choosing anything.** The required `rails-guard`
CI job fails on EVERY PR whenever the base `.adlc/config.json` lacks the config-integrity
fields; a PR cannot self-acknowledge. Reproduce it in a scratch worktree:

```bash
SP=<scratchpad>; git worktree add --detach $SP/probe refs/remotes/origin/main
cd $SP/probe && ln -s <repo>/node_modules node_modules && echo >> README.md && git commit -qam probe
node scripts/rails-guard-ci.mjs origin/main; echo EXIT=$?
cd <repo> && git worktree remove --force $SP/probe
```

If it prints `acknowledgedNewRailBypass must already be set on the base branch`, the FIRST
deliverable is the ceremony: the user adds `"version": 1, "securityMode": "unsigned-fallback",
"acknowledgedNewRailBypass": true` to `.adlc/config.json` on a branch (`git add -f`), opens a
PR labelled `trust-root-change`, and admin-merges it (the job is red on that PR by design).
The auto-mode permission classifier denies an agent that edit — hand the user the exact
lines; do not work around it. Lanes can still be built and opened in the meantime; re-run
their failed `rails-guard` jobs after the ceremony merges (no new commit needed).

## 1. Select the issues

```bash
gh issue list --state open --limit 400 --json number,title,labels \
  --jq '.[] | "\(.number)\t\(.labels|map(.name)|join(","))\t\(.title)"' > $SP/issues.tsv
```

Selection rules, in order:
1. `bug` + `P1-high` (or the user's `--label`), class **false-green** first — that is the
   product's signature risk.
2. **One lane per package.** Two issues in the same package go in ONE lane or wait.
3. **Skip the trust-root tier** unless the user explicitly wants the cross-model ceremony:
   `packages/{rails-guard,prosecute,gate-manifest,build-gate,ticket-prune,ticket-sync}`,
   `scripts/rails-guard-ci.mjs`, `docs/ci/rails-guard.yml`, root `package.json`/lockfile,
   `.adlc/tickets.json`, `scripts/preflight.mjs` (see `packages/prosecute/lib/tier.mjs`).
4. Skip packages under an active rail (`.adlc/tickets/*.json` with `rails` and no
   `completed: true`) and areas with an in-flight program (e.g. `area:autopilot`).
5. **Re-verify the premise at HEAD** for every candidate: `grep -n` the cited line in the
   issue. Issues filed from an audit go stale — #582 was already fixed on main while still
   open. Close those instead of building them.

Read the full body of each finalist (`gh issue view N --json body`). The audit-filed issues
carry a `Recommendation` paragraph — that is the design seed for the ticket.

## 2. Worktrees (explicit commands — the tool shell is zsh)

```bash
git worktree add -q .worktrees/fix-<n> -b fix/<n>-<slug> refs/remotes/origin/main
cd .worktrees/fix-<n> && npm ci --ignore-scripts --no-audit --no-fund   # ~1 min, 1.5 GB each
```

- Never `set -- $var` in a loop: zsh does not word-split, and the result was a worktree with a
  space in its path plus a LOCAL branch named `origin/main` (`refname is ambiguous`). Write
  the four commands out, or use `for n in a:b c:d; do ${n%%:*} ${n#*:}; done`.
- Always spell the start point `refs/remotes/origin/main`.
- Never symlink `node_modules` into a lane: the root `node_modules/@adlc/*` entries are
  RELATIVE symlinks, so the lane would import MAIN's packages, not its own.
- `.worktrees/` is gitignored; disk is the only cost.

## 3. Tickets (P0) — one per lane, written IN the lane

Author the ticket JSON from `references/ticket-template.json`. The body must let a fresh
agent build without asking anything: source + re-verified location, package layout, the
NORMATIVE decisions (exit codes, messages, where the single validator lives, which docs to
hand-edit), ACs each with a `verify:` command, and OUT OF SCOPE.

**Keep review-process language OUT of the ticket body and OUT of commit messages.** The
shard is committed repo content; a codex round on #712 raised a CRITICAL (injection) on a
"loop adversarial-review until zero findings" paragraph in the ticket, and a needs-attention
on a commit message that named providers and rounds. Process instructions live in the lane
prompt (not committed); review history lives in the PR body only.

Rules that follow from the gates:
- **Find the consumers before deciding behaviour.** `grep -rln "<pkg-name>\|<bin-name>" packages/*/lib plugins/*/` —
  a package's exit codes are a contract other packages parse. #622's ticket added an
  exit-1 reason (scope given, no extractable paths) that turned every fleet consult into a
  fail-open, because fleet passes `--scope` on every call; CI's root suite caught it, the
  lane's package segment could not. Name the consumers' test files in the ACs.
- **scope** = `packages/<pkg>/**` + the three docs (`packages/<pkg>/README.md`,
  `docs/tools/<pkg>.md`, `apps/docs/content/docs/toolkit/<pkg>.mdx` — hand-maintained
  mirrors, never regenerated).
- **rails** = EXISTING files the fix has no reason to touch (sibling libs, tests that pin
  other behaviour). Never a file the fix must edit (a test that pins the bug), never the new
  red-test file: CI sanctions a rail's first addition, but the in-session hook denies Write
  to it. Red tests go in a NEW, unrailed file named in the ACs.
- **category** `bugfix`, `duration` 1, `edges` `[]`.

Write it through the service, in the lane, and take the id from the `id` FIELD (uppercase):
```bash
cd .worktrees/fix-<n> && ADLC_RAILS_BYPASS=1 adlc ticket create --input $SP/ticket-<n>.json --write --json
```
The only artifact is the shard under `.adlc/tickets/` (`.store.json` is static, so lanes
never conflict; a plain create records no manifest entry — by design).

## 4. Launch the lanes

One `Agent` call per lane, all in ONE message, `subagent_type: "fork"` (inherits the tickets,
gates and lessons you just loaded). Prompt from `references/lane-prompt.md` with the lane's
worktree, branch, ticket id, issue number, package, rails, and new-test filename filled in.
Then do not touch lane files; work on the relay/skill/memory until the notifications arrive.

The lane sequence the prompt enforces: P2 `adlc coldstart <id> --prompt-only` (self-audit) →
P4 red test file first, RED, implement, GREEN, package suite, docs → P3 `adlc rails-guard
--base origin/main --ticket <id>` → P5 `scripts/mutation-gate.mjs origin/main --max 12` then
`--max 80`, `scripts/run-tests.mjs <pkg>`, the three ledger/comment guards, then the
cross-model loop `adversarial-review --base origin/main --provider agy --model
gemini-3.7-flash-medium --timeout 600` until a round has exit 0 AND zero findings AND no
warnings (cap 8) → commit (`-F file`) → push → `gh pr create` with `Closes #n`.

**Reviewer of record: `agy` (Antigravity, Gemini family) on `gemini-3.7-flash-medium`;
codex is the fallback.** The model is also pinned globally in
`~/.config/adversarial-review/config.json` (`defaults.models["cli:agy"]`), so a bare
`--provider agy` picks it up; `agy models` lists the ids. Attest an agy review with
`--provider gemini` (family token) — distinct from the `anthropic` author.

## 4b. The cross-model attestation (key-holder step — expect it)

`packages/prosecute/lib/tier.mjs` tiers a change on any ticket's rails deny-path — including
COMPLETED tickets (issue #905; rail-freeze skips them, tier-check does not). Completed
tickets **T37/T38 declare `packages/**`**, so until #905 lands every lane touching
`packages/` is trust-root tier and the required `gate` job fails with `NO SIGNATURE-VERIFIED
cross-model attestation for revision git-change:<base>:<digest>` until an attestation is
recorded. Each lane's codex approve makes that attestation truthful. The classifier denies an
agent sourcing `ADLC_MANIFEST_KEY`, so hand the user one script (pattern from AGENTS.md —
the key is sourced, never an argument), one call per lane, using the digest the gate printed:

```bash
set -a; . ./.env.local; set +a
cd .worktrees/fix-<n>
node packages/prosecute/bin/adlc-prosecute.mjs record-cross-model --ticket <T-…> \
  --provider openai --author-provider anthropic --verdict approve \
  --revision git-change:<base>:<digest> --base origin/main --json
node packages/prosecute/bin/adlc-prosecute.mjs tier-check --author-provider anthropic --base origin/main
git add .adlc/manifest.d && git commit -F <msg> && git push
```

Record AFTER the lane's final commit (a rebase changes the digest; recording does not). Use
provider FAMILY tokens (`openai`/`anthropic`), not CLI names. Do not re-run the reviewer
after attesting — it flags its own attestation shard as a pre-approval (known false
positive; see the ceremony memory for the forgery table if a reviewer must be answered).

## 5. Relay and close out

- Relay each lane's report verbatim in substance: coldstart verdict, RED→GREEN, test
  counts, mutation-gate numbers, review rounds folded/refuted, commit SHAs, PR URL, residuals.
- If push/PR was denied by permissions, give the user the exact commands per lane.
- Check the PRs: `gh pr checks <n>`; `rails-guard` red with the base-config message is
  expected until the ceremony merges.
- Save a `project` memory: lanes, ticket ids, blockers, anything non-obvious.
- After the human merges: `adlc ticket complete <id>` is a base-branch admin act (rails
  auto-expire on `completed: true`); then the worktree cleanup checklist in
  `~/.claude/rules/common/worktrees.md`.

## Gotchas that are not in the ticket bodies

- Never run a gate or suite as `… | tail` in a background task — the exit you read is
  tail's. Redirect to a file and `echo EXIT=$?` on its own line.
- Every command starts with `cd /abs/worktree &&` — fork agents SHARE the parent's
  persistent shell cwd, so a parent `cd` moves every lane (one codex round reviewed the
  wrong tree this way; check `pwd` and the reviewer's file list before trusting a round).
- Provider quotas are shared with every other session on the machine; on a `usage limit`
  from agy, fall back to codex (a different family) and retry agy after the reset it prints. Kill
  orphaned `codex-linux-sandbox` processes (ppid 1) left by earlier runs — they are hung
  `npm test` children — never a live session's.
- The permission classifier blocks compound commands that mix inline node scripts with
  `ADLC_RAILS_BYPASS=1`: write the script to a file, run store commands standalone. zsh
  also rejects `[ a \> b ]` — use `[[ ]]` or node.
- `grep -n` / `sed -n` / the words `core.hooksPath` in the same command as `git commit`
  trip the block-no-verify hook — write messages with the Write tool, commit with `-F`.
- Read the reviewer's `mode:` line: summary mode (diff over the byte cap) = zero findings =
  false green. Read `findings[]` every round; exit 0 alone is not the ship signal.
- After a killed mutation-gate run, `git status` and `git checkout --` the mutant it left.
- `mergeStateStatus: BEHIND` is not blocking here; do not reflex-rebase.
