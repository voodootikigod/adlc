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

**Rail-freeze pre-check — do this before choosing anything.** As of 2026-09-10 the
ceremony below HAS ALREADY MERGED: `origin/main`'s `.adlc/config.json` carries
`"version": 1, "securityMode": "unsigned-fallback", "acknowledgedNewRailBypass": true`,
and four consecutive lane PRs passed `rails-guard` clean. So the expected state is
PASSING, and a `rails-guard` failure is a REAL problem to diagnose, not the known
blocker — do not tell lanes to expect it. Confirm in one command rather than running
the probe:

```bash
git show refs/remotes/origin/main:.adlc/config.json | head -5   # expect acknowledgedNewRailBypass: true
```

If that field is ever absent again (a fresh repo, or a reverted config), the required
`rails-guard` CI job fails on EVERY PR and a PR cannot self-acknowledge. Reproduce it in
a scratch worktree:

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
3. **Check tiering per candidate — it is not just `packages/**`.** `packages/prosecute/lib/tier.mjs`
   tiers a change on ANY ticket's declared rail globs, COMPLETED tickets included (issue #905).
   Grep every completed ticket for a rail matching the candidate's exact path before assuming a
   plugin or script is untiered:
   ```bash
   for f in $(grep -l '"rails"' .adlc/tickets/*.json); do node -e '
   (function(){const t=JSON.parse(require("fs").readFileSync(process.argv[1]));
   if(t.completed!==true) return; const rails=(t.rails||[]).join(" ");
   if(/<candidate-path-fragment>/.test(rails)) console.log(t.id,"|",rails);})();' "$f"; done
   ```
   In this repo, `packages/**` and `.github/workflows/**` are ALWAYS tiered (T37/T38), so any
   `packages/*` lane needs the 4b ceremony — but plugin directories vary PER PLUGIN: T37 also
   rails `plugins/{pi,opencode,codex,claude-code}/**` specifically (NOT copilot/cursor/gemini/
   herdr), so a plugin lane may or may not need the ceremony depending on which plugin it is.
   Verified empirically: `adlc-copilot`/`adlc-gemini`/`adlc-herdr` lanes shipped WITHOUT the
   ceremony (`gate` passed clean, 19/19); an `adlc-codex` lane needed it (T37 rails
   `plugins/adlc-codex/**`) despite looking superficially identical to the other three. Do not
   generalize "plugins are untiered" from one or two examples — check every candidate.
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
This writes TWO artifacts, not one. The shard under `.adlc/tickets/` (`.store.json` is
static, so lanes never conflict) **and** a gate-manifest segment — under
`ADLC_RAILS_BYPASS=1` the create is an audited override, so it records a signed
`ticket-mutation` entry. (An older note here claimed a plain create records nothing;
that is false with the bypass set.)

**Know how that segment behaves before you tell a lane what to do with it.**
`.adlc/manifest.d/<branch>-<ulid>.jsonl` is ONE hash-chained file for the WHOLE
branch, not one file per write: every audited write appends, each entry carrying
`seq` and a `prev` hash of the one before. A trust-root lane's segment ends up as
create → coldstart verdict → any `ticket update` → the §4b attestation, all in one
chain. Four consequences:
- **You cannot commit "just the attestation"** — splitting the chain breaks it.
  §4b's `git add .adlc/manifest.d` is correct as written.
- **A trust-root lane MUST commit its segment**; it carries the attestation the
  required `gate` job reads. A non-tiered lane's segment is orphaned once its PR
  merges, and discarding it at cleanup matches repo practice — of 94 segments on
  `main` (93 branch-named), not one carries a `ticket-mutation`/create entry. The
  gates only ever consume `cross-model-review`, `p5-*`, `prosecute`,
  `ticket-update` and `ticket-complete`.
- **Committing the segment does not move the revision digest** — `.adlc/manifest.d`
  is excluded from it, as it must be or attesting would invalidate itself. Re-run
  `tier-check` after the commit to confirm rather than assuming.
- **While untracked it makes the tree dirty**, which blocks `mutation-gate` and
  `review-calibration` (`commit or stash first`). Tell each lane to park it in the
  scratchpad for those runs and restore it after — "don't commit it, don't delete
  it" is not enough guidance on its own.

## 4. Launch the lanes

One `Agent` call per lane, all in ONE message, `subagent_type: "fork"` (inherits the tickets,
gates and lessons you just loaded). Prompt from `references/lane-prompt.md` with the lane's
worktree, branch, ticket id, issue number, package, rails, and new-test filename filled in —
**including the "you are lane N of M, siblings already launched" preamble**: a fork inherits
this whole skill's text (including this very "launch the lanes" step) and can mistake itself
for the parent, attempting to Agent-call the other sibling issues itself. Nested fork calls
fail closed ("Fork is not available inside a forked worker") with no side effect, but cost a
wasted turn — state the preamble explicitly rather than relying on "do not re-delegate" alone.
Then do not touch lane files; work on the relay/skill/memory until the notifications arrive.

**Verify, don't trust, a lane's first report.** A report that arrives within ~2-3 minutes of
4-8 tool calls, describing the OTHER lanes rather than progress on its own issue, is not a
status update — it means the lane spent its whole turn on `ListAgents`/checking siblings and
did zero real work (empty worktree: no test file, no commit). This happened to 3 of 4 lanes in
one batch DESPITE the explicit preamble above. Before believing any early lane report, check
`git -C .worktrees/fix-<n> status --short` and `git log --oneline -1` yourself. If the worktree
has nothing but the ticket shard, resume the lane with a literal, single, immediately-actionable
command (name the exact `cd … && adlc coldstart …` line to run NEXT, explicitly forbid checking
ListAgents/siblings/status again, explicitly forbid sending another message until the PR opens
or a real blocker is hit) — a first redirect may not be enough; re-verify the worktree a few
minutes later and repeat the same literal-command redirect if it still shows no progress.

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

## 4b. The cross-model attestation (key-holder step — for SOME lanes, not all)

**Issue #905 is CLOSED and its fix has landed**: `packages/prosecute/lib/tier.mjs:153` now
does `if (ticket?.completed === true) continue;`, so completed tickets' rails no longer tier
anything. T37/T38's `packages/**` rails are inert. An earlier version of this section said
every `packages/` lane is trust-root tier "until #905 lands" — that is no longer true, and
repeating it costs the user pointless signing round-trips.

**Tier is now decided by two explicit lists in `tier.mjs`, so check the lane against them:**
- `ENFORCEMENT_PREFIXES` — `packages/rails-guard/`, `packages/prosecute/`,
  `packages/gate-manifest/`, `packages/build-gate/` (enforcement), plus
  `packages/ticket-prune/` and `packages/ticket-sync/` (gated-artifact producers).
- `TRUST_ROOT_FILES` — `scripts/rails-guard-ci.mjs`, `docs/ci/rails-guard.yml`,
  `scripts/test/rails-guard-workflow-hashes.json`.

Everything else is untiered. Verified 2026-09-10: of four lanes, only the `ticket-prune`
one needed the ceremony; `adlc-pi`, `review-calibration` and `parallax` all passed `gate`
clean with no attestation. Have each lane run `tier-check` and report the verdict rather
than assuming either way.

When a lane IS tiered, the required `gate` job fails with `NO SIGNATURE-VERIFIED
cross-model attestation for revision git-change:<base>:<digest>` until an attestation is
recorded, and the reviewer's approve is what makes that attestation truthful. The
classifier denies an agent sourcing `ADLC_MANIFEST_KEY`, so hand the user one script
(pattern from AGENTS.md — the key is sourced, never an argument), one call per lane,
using the digest the gate printed:

```bash
set -a; . ./.env.local; set +a
cd .worktrees/fix-<n>
node packages/prosecute/bin/adlc-prosecute.mjs record-cross-model --ticket <T-…> \
  --provider <family> --author-provider anthropic --verdict approve \
  --revision git-change:<base>:<digest> --base origin/main --json
node packages/prosecute/bin/adlc-prosecute.mjs tier-check --author-provider anthropic --base origin/main
git add .adlc/manifest.d && git commit -F <msg> && git push
```

`<family>` MUST match the provider that actually reviewed the revision: `gemini` if agy
reviewed it (the reviewer of record), `openai` if codex did — this is a truthfulness
record, not a formality. Derive `--revision` with `tier-check` run IN the lane's own
worktree right before attesting (its stderr already prints the exact `git-change:<base>:
<digest>` string the gate expects) rather than trusting an older CI log — a lane rebase
changes the digest, so always re-derive it fresh.

**When attesting multiple lanes, derive each digest as its OWN command with an explicit `cd`
AND a visible `pwd && git rev-parse HEAD` in the SAME command** — do not fire off several
digest-derivation commands back to back and read the outputs by position. A `cd`-less command
silently inherits the previous call's leftover cwd (a real near-miss: one digest came back
belonging to the wrong lane, caught only by cross-checking `pwd`/HEAD before trusting it).
Confirm the printed path and HEAD sha match the lane you intend BEFORE recording, never after.

Record AFTER the lane's final commit (a rebase changes the digest; recording does not). Use
provider FAMILY tokens, not CLI names. Do not re-run the reviewer after attesting — it flags
its own attestation shard as a pre-approval (known false positive; see the ceremony memory
for the forgery table if a reviewer must be answered). Small, single-purpose commands work
better than one chained script here — verified twice: a multi-step chain (record + verify +
commit + push in one invocation) got blocked even under explicit user authorization to sign,
while the identical steps run one at a time each succeeded.

**After pushing a fix to a skill/docs PR of your own (not a lane's), confirm it is still
open** (`gh pr view <n> --json state`) before assuming the push will land in it — a PR can
merge between your push attempts (the user merges on their own schedule), and a commit pushed
to an already-merged PR's branch is stranded (never reaches `main`) with no error. Recover by
`git cherry-pick <sha>` onto a fresh branch off current `main` and open it as its own PR.

**After ANY failed `git pull --ff-only`, do not proceed until it has actually succeeded** —
stash/resolve whatever blocked it, then re-run the pull and confirm `git log --oneline -1`
shows the expected remote tip. A pull that failed once and was "set aside to handle later"
leaves every subsequent command (including `adlc ticket complete`) silently operating on the
STALE local HEAD — a real incident this session cost ~10 minutes chasing a misleading
`TICKET_NOT_FOUND` error that was actually just "you're behind, the ticket exists on the
remote you haven't fetched into HEAD yet." If a command's error looks confusing given what
you just did, check `git merge-base --is-ancestor <expected-remote-sha> HEAD` before assuming
the tool is wrong.

## 5. Relay and close out

**A lane is not done when its PR opens — it is done when CI on that PR is actually
green.** A lane's own local suite/gate runs are necessary but not sufficient; report a
lane as "complete" only after `gh pr checks <n>` shows every check `pass` except the
known, explained exceptions below. Do not relay a lane's own "nothing left undone" as the
final word — verify.

- After each lane reports its PR, poll `gh pr checks <n>` until every check has settled
  (no `pending`), not just once. A `test`/`mutation-gate`/`ticket-store-platform`/etc.
  check failing in CI when the lane's local runs were clean is a REAL discrepancy — dig
  into the actual CI log (`gh run view <id> --log-failed`), do not assume it's the known
  attestation gap or wave it off as flaky. **`gh pr checks` can report a job as `pending`
  that has already FAILED** — confirm against the run itself (`gh run list --branch <b>`,
  then `gh api …/runs/<id>/jobs`) before concluding a PR is merely still building.
  Exactly ONE failure is now expected and explained, never anything else:
  - `gate` (cross-model-review) failing with `NO SIGNATURE-VERIFIED cross-model
    attestation`, and ONLY for a lane the §4b lists actually tier. Resolved by the
    ceremony, not a lane bug. An untiered lane's `gate` must pass on its own.
  - `rails-guard` is NO LONGER an expected failure — the base-config ceremony has merged
    (§0). A `rails-guard` failure is now a real problem: rebase the lane onto the current
    main tip and re-check, and if it persists, diagnose it rather than attributing it to
    the old blocker.
- **A flaky-looking suite failure may be a real bug the flake is masking.** This batch hit
  three autopilot failures with three different causes: a genuine fake-timer flake (AC9),
  a nested-`gate-deps` clone race (#990), and an unguarded `records.update` that turns a
  clean `init-failed` return into an unhandled rejection (#992 — a real defect). Read each
  failure's actual error and stack before re-running; re-running is how the third one had
  been staying invisible.
- Relay each lane's report verbatim in substance: coldstart verdict, RED→GREEN, test
  counts, mutation-gate numbers, review rounds folded/refuted, commit SHAs, PR URL,
  AND the polled CI status — not just the lane's own local claim of it.
- If push/PR was denied by permissions, give the user the exact commands per lane.
- Save a `project` memory: lanes, ticket ids, blockers, anything non-obvious.
- After the human merges: `adlc ticket complete <id>` is a base-branch admin act — rails-guard's
  contract-preservation check refuses `completed: true` on an existing ticket inside ANY PR, so
  this can only land as a DIRECT PUSH TO MAIN (`git push origin main`; expect and accept
  GitHub's "Bypassed rule violations" notice if this repo has a ruleset). It also creates a new
  `.adlc/manifest.d/` segment. Ask before doing this — it is a different, more privileged action
  than the signing ceremony above, which still goes through a normal PR. Once pushed, any OTHER
  open PR branched from an OLDER main is now BEHIND a new manifest segment; rails-guard reads
  that as `… exists at base but is absent at HEAD — committed segments cannot be removed or
  renamed in a PR` (a false positive from staleness, not a real violation) — rebase that PR
  onto the new main tip and re-push to clear it. Then the worktree cleanup checklist in
  `~/.claude/rules/common/worktrees.md`.

## Gotchas that are not in the ticket bodies

- Never run a gate or suite as `… | tail` in a background task — the exit you read is
  tail's. Redirect to a file and `echo EXIT=$?` on its own line.
- **EVERY command, with NO exceptions, starts with `cd /abs/worktree &&` — including
  single simple commands, not just multi-step chains.** This is not just a parent→lane
  gotcha: concurrently-running SIBLING lanes share cwd with EACH OTHER too, confirmed
  independently by two different lanes in one batch — one lane's `cd` raced with another's
  and caused an `adversarial-review` call to silently review a SIBLING lane's diff instead
  of its own, with no error, no warning, just a clean-looking "approve" on the wrong code.
  Both lanes only caught it by checking `pwd`/`git branch --show-current`/HEAD AFTER an
  unusual review result and re-running from an explicit `cd`. **Never trust a cross-model
  review or a gate result you did not launch from an explicit `cd` in the SAME command** —
  a review verdict on the wrong diff is a false "approve" with no visible symptom until you
  go looking. For any review, additionally confirm the reviewer's own printed target/branch
  line (e.g. `Target: branch fix/<n>-... vs origin/main`) names YOUR branch before trusting
  the verdict — do this every round, not only when something looks off, since nothing looks
  off until you check.
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
- **`mergeStateStatus: BEHIND` ALWAYS blocks a merge here — rebase onto the current
  main tip.** The `main protection` ruleset sets `strict_required_status_checks_policy:
  true` (GitHub's "require branches to be up to date"), so `gh pr merge` refuses with
  *"To have the pull request merged after all the requirements have been met"* until the
  branch is current. An earlier version of this line said the opposite — do not
  reflex-rebase — which was wrong and cost a confusing refused merge. **Rebase LAST**:
  for a trust-root lane a rebase moves the revision digest, so an attestation recorded
  before it is invalidated and has to be re-signed by the key holder. Get CI green,
  rebase, re-derive, then attest.
- **Only `test (18)`, `test (20)` and `test (22)` are REQUIRED checks.** `gate`,
  `rails-guard` and `mutation-gate` run and report but do not gate the merge button —
  they are enforced by convention and review here, not by the ruleset. Two consequences:
  do not describe them to the user as blocking; and a flaky test suite blocks EVERY merge
  in the repo, so a flake in those three is throughput work, not test hygiene.
- **`gh pr checks` can report a job as `pending` that has already FAILED.** Confirm
  against the run itself (`gh run list --branch <b>`, then `gh api …/runs/<id>/jobs`)
  before concluding a PR is merely still building. Observed twice in one session.
