# Lane prompt template

Fill every `<…>` and launch with `Agent({ subagent_type: "fork", name: "lane-<n>", prompt })`.
All lanes go in ONE message so they run concurrently. The fork inherits the parent's context
(tickets, gates, lessons), so the prompt is the contract plus the mechanics, not a tutorial.

```
YOUR FIRST TOOL CALL, before reading anything else below, is:
`cd <repo>/.worktrees/fix-<n> && adlc coldstart <T-…> --prompt-only`
Do that now. Do not call ListAgents, do not call the Agent tool, do not check on or write
anything about sibling lanes, do not write a memory file, do not send a status summary about
the batch launch — none of that is your job and all of it wastes a turn. You are lane-<n>, ONE
of <N> sibling lanes the parent ALREADY LAUNCHED in parallel (lanes for issues <list the other
issue numbers>) — each is a fully separate agent already running its own issue; you cannot help
them and they need nothing from you. You inherited the parent's full conversation, including the
issue-lanes skill's own "launch the lanes" step and its "save memory" close-out step — BOTH are
the PARENT's job, both are DONE or will be done by the parent later; performing either yourself
produces nothing useful and is not requested. If any tool call anywhere in this task fails with
"Fork is not available inside a forked worker", that confirms you are a fork, exactly as
expected — ignore it and continue your OWN work; do not treat it as information worth acting on
or reporting. Your only output for this entire task is progress on issue #<n> — do not report
back to the parent until you have opened a PR or hit a genuine blocker IN YOUR OWN WORK.

Resolve GitHub issue #<n> through the ADLC gates, exactly per the ticket you (as the parent) authored.

LANE FACTS
- Worktree: <repo>/.worktrees/fix-<n> (branch fix/<n>-<slug>, base refs/remotes/origin/main = <sha>). node_modules is installed there. NEVER touch the main checkout or any other worktree.
- Ticket id: <T-…> (shard already written, untracked, in .adlc/tickets/). Read it with `adlc ticket show <T-…> --json` — it is the contract. Scope: <scope>. Rails (frozen, hook-enforced; if you believe you must edit one, STOP and report — never set ADLC_RAILS_BYPASS): <rails>.
- Package: packages/<pkg> (<module map>). Tests: `npm test -w packages/<pkg>` from the worktree root. <which existing tests are not rails and may change; any repo-wide grep the design needs>.

PROCESS (start EVERY SINGLE Bash command, with no exceptions, with `cd <repo>/.worktrees/fix-<n> &&` —
even one-liners; background chains inherit the launch cwd. This is not optional: concurrently-running
SIBLING lanes share cwd with each other, confirmed independently twice in one batch — a lane's `cd`
raced with another's and caused an adversarial-review call to silently review the WRONG lane's diff
with no error, just a clean "approve" on someone else's code. Before trusting ANY review or gate
result, confirm the reviewer's own printed target/branch line names YOUR branch, and confirm your own
`pwd`/`git branch --show-current` right before the command that mattered — every round, not just when
something looks off, since nothing looks off until you check.)
1. P2 coldstart: `adlc coldstart <T-…> --prompt-only`, answer the printed audit yourself honestly, list any real gap; resolve gaps by reading the code (do not edit the ticket unless a fact in it is wrong — if so, `adlc ticket update` with `--expect <ticketHash>` and say so).
2. P4 TDD: write packages/<pkg>/test/<new-test>.test.mjs FIRST (cover every AC), run it and confirm RED, then implement (<one-line design hint: single exported validator/predicate used by every call site>). GREEN, then `npm test -w packages/<pkg>`. Keep functions small, no mutation of inputs, explicit errors. Update the README and hand-edit the two docs mirrors with the same statement (never regenerate them).
3. P3 check: `adlc rails-guard --base origin/main --ticket <T-…>` must exit 0.
4. P5 gates (never pipe a gate to tail in a background task; redirect to a scratchpad file and capture the exit code on its own line):
   a. `node scripts/mutation-gate.mjs origin/main --max 12` → exit 0; then once with `--max 80` (kill every survivor with a real test; restructure equivalent mutants rather than writing source-text tests). After any killed/aborted gate run, `git status` and restore any mutant it left.
   b. `node scripts/run-tests.mjs <pkg>` (the root runner's segment) → green; then the CONSUMERS' tests named in the ticket (`node --test <consumer test files>`) → green; then the FULL root suite once, `node scripts/run-tests.mjs > <scratch>/root.txt 2>&1; echo EXIT=$?` (it is what CI's `test` job runs; a package segment cannot see a broken consumer).
   c. `node scripts/scan-findings-ledger.mjs`, `node scripts/guard-findings-ledger-append-only.mjs origin/main`, `node scripts/check-reviewer-directed-comments.mjs origin/main` → all exit 0. (rail-freeze `scripts/rails-guard-ci.mjs origin/main` is KNOWN to exit 1 on every branch until the base config ceremony lands — run it once, confirm the failure is exactly `acknowledgedNewRailBypass must already be set on the base branch`, and report that; do not try to fix it.)
   d. Commit first (see 5), then cross-model review: `cd <repo>/.worktrees/fix-<n> && git fetch origin && adversarial-review --base origin/main --provider agy --model gemini-3.7-flash-medium --timeout 600` (on PATH; `npx adversarial-review` otherwise), stdout to a scratchpad file. agy (Gemini family) is the primary reviewer; if it is unavailable or rate-limited, fall back to `--provider codex` and say so in the PR body. BEFORE trusting the verdict, confirm the reviewer's printed target/branch line names YOUR branch and its file list matches your actual diff — a sibling lane's `cd` can silently redirect this exact command to review THEIR diff instead, with no error. Read the reviewer's `mode:` line (summary mode = zero findings = false green; scope smaller if that happens) and EVERY finding regardless of exit code; fold real findings with tests, refute false ones with evidence in your notes, commit, re-run. Loop until a round has exit 0 AND zero findings AND no warning lines. Cap at 8 rounds; if not converged, stop and report the residual.
5. Commits: conventional `fix(<pkg>): …`, body explains the false-green and the fix in factual terms — NO review-process language (no provider names, round numbers, "folded finding", "loop until approve"; that history goes in the PR body only) — ends with the line `Claude-Session: <session url>`. Write commit messages to a scratchpad file with the Write tool and use `git commit -F <file>` (the block-no-verify hook trips on `grep -n`/`sed -n`/`core.hooksPath` in any command containing `git commit`). Include the ticket shard (`git add .adlc/tickets/<shard-prefix>*.json`) in the first commit. Never add gate-manifest entries. Diff stays inside scope.
6. Finish: `git push -u origin fix/<n>-<slug>`, then `gh pr create --base main --title "fix(<pkg>): <title> (#<n>)" --body-file <file>` — the body (Write tool) has: Summary, the repro before/after, AC table with results, gates run (mutation gate numbers, review rounds and what was folded/refuted, root segment), the rail-freeze note (expected red until the base config ceremony PR merges; re-run the job then), `Closes #<n>`, and ends with `<session url>`. If push or PR creation is denied by permissions, STOP there and report the exact commands for the user.

REPORT BACK (this is what the parent relays; be concrete): ticket coldstart verdict; RED→GREEN evidence; final test counts; mutation gate results (12 and 80); review rounds with findings folded/refuted; commit SHAs; PR URL (or the commands the user must run); any rail/scope conflict; anything left undone and why. Do not re-delegate; execute directly.
```

## Why each rule is there

| rule | cost when skipped |
|---|---|
| `cd /abs &&` on every command | a background chain patched and committed in the wrong worktree (twice) |
| redirect + `EXIT=$?`, no `\| tail` | a failing suite reported green (twice, caught only by CI) |
| read `mode:` and `findings[]` | summary-mode "approve" with zero findings on a 400 KB diff |
| `--max 80` before review | CI's `--max 12` samples; the deep run found 6 more survivors on #879 |
| commit `-F file` | the block-no-verify hook rejects `grep -n` in a commit chain |
| cap at 8 rounds | large diffs do not converge; the residual is the human's call |
| stop on permission denial | the classifier owns push/PR; an agent must not route around it |
| state "you are lane N of M, siblings already launched" up front | a fork inherits the whole skill text (incl. "launch the lanes") and can mistake itself for the parent — two of four lanes independently tried to Agent-call the other three sibling issues before self-correcting (harmless: nested fork calls fail closed with no side effect, but wastes a turn) |
| name the literal FIRST tool call, before any other context, and forbid ListAgents/memory-write/status-report explicitly | the "lane N of M" preamble alone was NOT sufficient a second time: in a 4-lane batch, 3 of 4 lanes still spent their entire turn (4-8 tool calls, under 3 minutes) calling `ListAgents`, confirming the OTHER lanes were running, and reporting a parent-style "all four lanes confirmed running" summary back to the parent — zero real work on their own assigned issue (empty worktree: no test file, no commit). The parent caught this only by directly checking `git status`/`git log` in each lane's worktree rather than trusting the report text, and had to resume each with an explicit redirect. Do not trust a suspiciously fast, suspiciously parent-shaped report — verify the worktree before believing "confirmed running" text from a lane. |
