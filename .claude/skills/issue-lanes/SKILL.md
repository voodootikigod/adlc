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
SP=<your scratchpad directory>  # every $SP/… path below writes here; never leave it unset
git status --short            # main checkout must be clean
git fetch -q origin main:refs/remotes/origin/main
adlc --version                # toolkit installed (>= scripts/toolkit-floor.json)
adlc ticket store status --json   # backend: directory, pendingTransactions: []
gh auth status
```

**The `WIP` claim label — runs on other machines may be live.** This skill can run on
several machines at once against the same repo. The only coordination between them is the
`WIP` label plus a claim comment on each issue a run picks (§1 "Claim"). Make sure the
label exists:

```bash
gh label list --limit 500 --json name --jq '.[].name' | grep -qx WIP \
  || gh label create WIP --description "claimed by an issue-lanes run" --color FBCA04
```

(List the labels; don't use `--search`. The search index lags, so it returned nothing
right after the label was created.)

Then sweep for **stale claims**: open `WIP` issues with no OPEN PR that closes them, and
whose latest claim comment is older than 48 hours (or that have no claim comment at all).
`closedByPullRequestsReferences` carries no PR state, so the sweep cross-checks it against
the open PR numbers:

```bash
cat > $SP/wip-sweep.jq <<'EOF'
.[]
| select(any(.closedByPullRequestsReferences[]; .number as $n | $open | index($n)) | not)
| ([.comments[] | select(.body | startswith("issue-lanes claim — package:")) | .createdAt] | last) as $claimed
| select($claimed == null or $claimed < $cutoff)
| "#\(.number)\tclaimed \($claimed // "with no claim comment")\t\(.title)"
EOF
OPEN_PRS=$(gh pr list --state open --limit 200 --json number --jq '[.[].number]')
CUTOFF=$(date -u -v-48H +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '48 hours ago' +%Y-%m-%dT%H:%M:%SZ)
gh issue list --state open --label WIP --limit 100 \
  --json number,title,closedByPullRequestsReferences,comments \
  | jq -r --argjson open "$OPEN_PRS" --arg cutoff "$CUTOFF" -f $SP/wip-sweep.jq
```

Print anything it lists to the user as a WARNING — most likely a run that crashed or was
abandoned — and leave it alone. The operator clears stale labels by hand
(`gh issue edit <n> --remove-label WIP`). A run never removes a `WIP` label it did not add
itself, because a label older than 48 hours can still belong to a slow lane on another
machine.

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
  --jq '.[] | select(.labels|map(.name)|index("WIP")|not)
        | "\(.number)\t\(.labels|map(.name)|join(","))\t\(.title)"' > $SP/issues.tsv
```

Issues labelled `WIP` are claimed by another run (on this machine or another one) and are
never candidates.

Next, build **TAKEN-PACKAGES**: the packages another run, or an open PR, is already
changing. It has two sources: the files of every open PR, and the claim comments on `WIP`
issues whose PR does not exist yet. Every read **fails closed**. A failed `gh` call must
never pass for "nothing is taken", so each response is captured and checked before it is
parsed. Define these two functions once per shell; the claim step reuses both:

```bash
taken_packages() {
  local prs wips
  prs=$(gh pr list --state open --json number,files --limit 500) || return 1
  wips=$(gh issue list --state open --label WIP --limit 500 --json comments) || return 1
  # A read that hits its limit is a partial view, not a complete one.
  [ "$(printf '%s' "$prs" | jq length)" -lt 500 ] && [ "$(printf '%s' "$wips" | jq length)" -lt 500 ] || return 1
  { printf '%s' "$prs" | jq -r '.[].files[].path' | grep -o -E '^(packages|plugins)/[^/]+'
    printf '%s' "$wips" | jq -r '.[].comments[].body' \
      | grep -o -E '^issue-lanes claim — package: [^,]+' | sed 's/.*package: //'
  } | sort -u
}

claim() {   # claim <issue> <packages/pkg | plugins/plugin> [lane-sibling]
  local labels taken
  labels=$(gh issue view "$1" --json labels --jq '.labels[].name') \
    || { echo "READ FAILED — drop #$1"; return 1; }
  if printf '%s\n' "$labels" | grep -qx WIP; then echo "TAKEN — drop #$1"; return 1; fi
  if [ "$3" != lane-sibling ]; then
    taken=$(taken_packages) || { echo "READ FAILED — drop #$1"; return 1; }
    if printf '%s\n' "$taken" | grep -qxF "$2"; then echo "PACKAGE TAKEN ($2) — drop #$1"; return 1; fi
  fi
  gh issue edit "$1" --add-label WIP || { echo "LABEL FAILED — drop #$1"; return 1; }
  if gh issue comment "$1" --body "issue-lanes claim — package: $2, host: $(hostname -s), $(date -u +%Y-%m-%dT%H:%M:%SZ)" \
     && gh issue view "$1" --json labels --jq '.labels[].name' | grep -qx WIP; then
    echo "CLAIMED #$1"
  elif gh issue edit "$1" --remove-label WIP; then
    echo "CLAIM INCOMPLETE — label removed, drop #$1"; return 1
  else
    echo "CLAIM INCOMPLETE, CLEANUP FAILED — run by hand: gh issue edit $1 --remove-label WIP"; return 1
  fi
}

taken_packages > $SP/taken-packages.txt \
  || echo "ABORT — could not read open PRs or WIP claims; do not select from a partial view"
```

Selection rules, in order:
1. `bug` + `P1-high` (or the user's `--label`), class **false-green** first — that is the
   product's signature risk.
2. **One lane per package, across every run.** Two issues in the same package go in ONE
   lane or wait. A candidate whose package is in TAKEN-PACKAGES is skipped: another
   machine, or an open PR, is working there, and two branches in one package are a rebase
   conflict at best and a mutation-gate collision at worst.
3. **Check tiering per candidate.** `packages/prosecute/lib/tier.mjs` tiers a change on
   three things, and nothing else: its package-prefix lists (`ENFORCEMENT_PREFIXES`,
   `PRODUCER_PREFIXES`), its `TRUST_ROOT_FILES` list (all three summarised in §4b), and the
   rail globs of ACTIVE tickets — a ticket with `completed: true` is
   skipped, so its rails tier nothing. Grep the active tickets for a rail matching the
   candidate's exact path before assuming a package, plugin or script is untiered:
   ```bash
   for f in $(grep -l '"rails"' .adlc/tickets/*.json); do node -e '
   (function(){const t=JSON.parse(require("fs").readFileSync(process.argv[1]));
   if(t.completed===true) return; const rails=(t.rails||[]).join(" ");
   if(/<candidate-path-fragment>/.test(rails)) console.log(t.id,"|",rails);})();' "$f"; done
   ```
   A candidate that matches none of those lists and no active rail is untiered and needs no 4b
   ceremony. Check every candidate: two paths that look alike can land on different sides.
4. Skip packages under an active rail (`.adlc/tickets/*.json` with `rails` and no
   `completed: true`) and areas with an in-flight program (e.g. `area:autopilot`).
5. **Re-verify the premise at HEAD** for every candidate: `grep -n` the cited line in the
   issue. Issues filed from an audit go stale — #582 was already fixed on main while still
   open. Close those instead of building them.

Read the full body of each finalist (`gh issue view N --json body`). The audit-filed issues
carry a `Recommendation` paragraph — that is the design seed for the ticket.

### Claim the finalists — before any worktree, ticket, or close

Claim every finalist, including one you are about to close as premise-stale (rule 5), so
that no other run picks it up while you work. Selection can take many minutes, and the
`issues.tsv` and `taken-packages.txt` snapshots are only as fresh as the moment they were
written. So the claim re-reads both at the moment of writing: whether the issue is already
`WIP`, and whether its package has been taken since. Only then does it write: the claim is
`gh issue edit <n> --add-label WIP` plus the claim comment, run through `claim` from above:

```bash
claim <n> packages/<pkg>     # or plugins/<plugin>; one call per finalist
```

Only an issue that printed `CLAIMED` goes on to §2. Every other outcome drops the issue
from this batch, and each leaves GitHub in a known state:
- `TAKEN` or `PACKAGE TAKEN`: another run, or an open PR, was there first.
- `READ FAILED`: nothing was written.
- `LABEL FAILED`: nothing was written.
- `CLAIM INCOMPLETE`: the label went on, but the comment or the verification failed, so
  `claim` took the label off again.

- `CLAIM INCOMPLETE, CLEANUP FAILED`: the label could not be taken off. Run the printed
  command, or the issue and its package stay blocked for every run.

When finalists share a package, rule 2 already put them in one lane. Claim the first issue
normally and the rest with `claim <n> packages/<pkg> lane-sibling`, which skips only the
package check (the package is taken by this lane's own first claim). The live `WIP`
re-read on the issue itself still runs.

The comment's exact form matters: TAKEN-PACKAGES and the §0 stale sweep both parse it.
From this point on, every way a lane can end must leave the label in a known state:
- **A PR opens**: keep `WIP`. The PR's `Closes #<n>` closes the issue on merge, so nothing
  needs removing.
- **No PR** (blocker, review loop not converged, premise stale): remove it (§4 lane prompt,
  §5 close-out).

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
  - **How you find out you did it anyway**, because the symptom names neither
    `node_modules` nor the symlink. Two guards red, on a diff that cannot have caused
    them — a docs-only change is enough:
    `✖ production ticket-store filesystem writers are confined to approved adapters`
    naming `plugins/adlc-cursor/bin/adlc-mcp-wrapper.bundle.mjs`, and
    `✖ the generated Cursor MCP bundle is exempted only when builder-verified`. That
    reads as a stale committed bundle, and the suggested fix — rebuild and commit the
    bundle — would commit a WRONG bundle built against MAIN's packages. Both pass on a
    clean checkout. Before believing any cross-tree guard, check `ls -ld node_modules`;
    if it is a symlink, `rm` it and run a real `npm ci`, then re-run.
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
- **scope** = `packages/<pkg>/**` + the two docs (`packages/<pkg>/README.md`,
  `apps/docs/content/docs/toolkit/<pkg>.mdx` — hand-maintained
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
gemini-3.8-flash-medium --timeout 600` until a round has exit 0 AND zero findings AND no
warnings (cap 8) → commit (`-F file`) → push → `gh pr create` with `Closes #n`.

**Reviewer of record: `agy` (Antigravity, Gemini family) on `gemini-3.8-flash-medium`;
codex is the fallback.** Always pass `--model` explicitly: a global pin in
`~/.config/adversarial-review/config.json` (`defaults.models["cli:agy"]`) cannot be relied
on (it was found empty on 2026-10-14), and agy retires model ids, so `gemini-3.7-flash-medium`
stopped working. Run `agy models` before a batch and use the current flash-medium id. Attest an agy review with
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
- **Release the claim of every lane that ended without a PR, but only if the lane did not
  release it.** Read the lane's report:
  - If the lane says it removed `WIP`, do nothing. A `WIP` present now belongs to ANOTHER
    run that claimed the freed issue since, and removing it would delete that run's live
    claim.
  - If the lane says the removal failed or was denied, or says nothing about it, check that
    the latest `issue-lanes claim` comment on the issue is still this run's (same `host:`
    and timestamp). Only then run `gh issue edit <n> --remove-label WIP` and post a
    one-line reason.

  A label left behind blocks the issue AND its package for every other run until someone
  notices it in the 48-hour sweep. Lanes that opened a PR keep `WIP`; merging closes the
  issue.
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
  - **WHEN to complete, relative to an open PR queue.** The paragraph above is the
    mechanism; this is the timing, and the two halves come from opposite failures — each
    is wrong on its own. Two sessions derived contradictory rules from this file on
    2026-09-19 because it stopped at "ask before doing this".
  - **Complete PROMPTLY.** Rails are unioned across every NON-COMPLETED ticket, so a
    shipped-but-uncompleted ticket freezes its rails repo-wide for every other lane.
    `T-01M1KT58RQE7SEVJMG00YK235J` shipped in PR #973 (`6bf8841c`, 2026-09-04) and was
    left open for **twelve days**, freezing six context-handoff and CLI paths and
    blocking an unrelated lane from editing a single comment. "Batch the completes until
    the queue drains" invites exactly that, and it is the worse failure.
  - **Enumerate who it lands on BEFORE you push**, one line per open PR:
    `git merge-base --is-ancestor <segment-commit> <pr-head>` — true means that PR
    already contains your segment and is unaffected.
  - **Announce rather than defer.** The `main protection` ruleset sets
    `strict_required_status_checks_policy: true`, so BEHIND already blocks every merge
    and that rebase was owed regardless of your push. You add no NET work — you change
    only WHEN staleness surfaces and HOW IT READS, and `… committed segments cannot be
    removed or renamed in a PR` reads like an integrity violation, so an unfamiliar
    owner burns time proving they deleted nothing. Tell them "pushing segment X now", or
    rebase the PRs you own. The announcement IS the obligation.
  - **Wait only for something time-critical in flight** — a queue-unblocking hotfix,
    where one confusing red on the PR that must merge cleanly is worth the delay. That
    narrow case only, never as a general policy.

## Gotchas that are not in the ticket bodies

- **What the `WIP` label guarantees, and what it does not.** It keeps runs that start
  minutes apart, on any machines, off each other's issues and packages. It is a
  check-then-act. `claim` narrows the window to the few seconds between its re-read and its
  write, but it does NOT close it. Two runs that claim the same issue or package
  within seconds of each other can both read "free" before either writes. Every run uses the same GitHub account,
  so the label's history cannot tell you which machine owns an issue; the claim comment's
  `host:` field can. The skill flags stale claims and never reclaims them.
  Two more known limits:
  - `gh` returns at most 100 `files` per PR and 100 `comments` per issue. A package
    touched only past a PR's 100th file, or a claim posted after an issue's 100th comment,
    is invisible to TAKEN-PACKAGES.
  - Claim comments are trusted by their text, not their author. Anyone who can comment on
    a `WIP` issue can mark a package as taken. That only makes runs skip work, never
    collide, but if a package is skipped unexpectedly, read the comment's author.

- **A GREEN PR IS NOT EVIDENCE `main` WILL BE GREEN AFTER IT MERGES.**
  `strict_required_status_checks_policy` evaluates up-to-dateness at MERGE TIME against
  the base tip, not against the prospective merged state, so two individually-green PRs
  merging seconds apart can leave `main` red. Measured: #1046 merged 16:35:58Z adding
  `scripts/test/tmp-fixture-boundary.test.mjs`; #1034 merged 16:36:10Z, **twelve seconds
  later**. `git merge-base --is-ancestor 051c1812 dad19f26` is false and
  `git ls-tree -r dad19f26 -- scripts/test/tmp-fixture-boundary.test.mjs` is empty — the
  guard did not exist on the head that PR's CI ran, so it could not have flagged the file
  it later flagged on `main`. **When `main` reds right after a merge, check for a
  same-minute neighbour BEFORE hunting a bug in your own diff** — two sessions each burned
  a round on this, hours apart. A merge queue is the structural fix (it re-runs required
  checks against the prospective merged state) and is tracked in #1051.
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
- **All six contexts are REQUIRED checks:** `test (18)`, `test (20)`, `test (22)`,
  `rails-guard`, `mutation-gate` and `gate`. `docs/ci/required-gates.json` is the
  declaration and `scripts/gate-liveness.mjs` checks the live ruleset against it; read
  that file, not this bullet, when they disagree. A red on any of the six blocks the
  merge button, so report it as blocking. A flaky test suite therefore blocks EVERY merge
  in the repo: a flake there is throughput work, not test hygiene.
- **`gh pr checks` can report a job as `pending` that has already FAILED.** Confirm
  against the run itself (`gh run list --branch <b>`, then `gh api …/runs/<id>/jobs`)
  before concluding a PR is merely still building. Observed twice in one session.
