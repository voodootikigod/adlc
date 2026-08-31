# Lane prompt template

Fill every `<…>` and launch with `Agent({ subagent_type: "fork", name: "lane-<n>", prompt })`.
All lanes go in ONE message so they run concurrently. The fork inherits the parent's context
(tickets, gates, lessons), so the prompt is the contract plus the mechanics, not a tutorial.

```
You are lane-<n>, ONE of <N> sibling lanes the parent ALREADY LAUNCHED in parallel (lanes for
issues <list the other issue numbers>). You inherited the parent's full conversation, including
the issue-lanes skill's own "launch the lanes" step — that step is the PARENT's job and it is
DONE; the other lanes already exist as separate forked agents. Never call the Agent tool
yourself, for any reason, in this task — a nested fork call fails ("Fork is not available inside
a forked worker") and, more importantly, is not your job. Resolve ONLY issue #<n>.

Resolve GitHub issue #<n> through the ADLC gates, exactly per the ticket you (as the parent) authored.

LANE FACTS
- Worktree: <repo>/.worktrees/fix-<n> (branch fix/<n>-<slug>, base refs/remotes/origin/main = <sha>). node_modules is installed there. NEVER touch the main checkout or any other worktree.
- Ticket id: <T-…> (shard already written, untracked, in .adlc/tickets/). Read it with `adlc ticket show <T-…> --json` — it is the contract. Scope: <scope>. Rails (frozen, hook-enforced; if you believe you must edit one, STOP and report — never set ADLC_RAILS_BYPASS): <rails>.
- Package: packages/<pkg> (<module map>). Tests: `npm test -w packages/<pkg>` from the worktree root. <which existing tests are not rails and may change; any repo-wide grep the design needs>.

PROCESS (run every command from the worktree: start EVERY Bash command with `cd <repo>/.worktrees/fix-<n> &&`; background chains inherit the launch cwd)
1. P2 coldstart: `adlc coldstart <T-…> --prompt-only`, answer the printed audit yourself honestly, list any real gap; resolve gaps by reading the code (do not edit the ticket unless a fact in it is wrong — if so, `adlc ticket update` with `--expect <ticketHash>` and say so).
2. P4 TDD: write packages/<pkg>/test/<new-test>.test.mjs FIRST (cover every AC), run it and confirm RED, then implement (<one-line design hint: single exported validator/predicate used by every call site>). GREEN, then `npm test -w packages/<pkg>`. Keep functions small, no mutation of inputs, explicit errors. Update the README and hand-edit the two docs mirrors with the same statement (never regenerate them).
3. P3 check: `adlc rails-guard --base origin/main --ticket <T-…>` must exit 0.
4. P5 gates (never pipe a gate to tail in a background task; redirect to a scratchpad file and capture the exit code on its own line):
   a. `node scripts/mutation-gate.mjs origin/main --max 12` → exit 0; then once with `--max 80` (kill every survivor with a real test; restructure equivalent mutants rather than writing source-text tests). After any killed/aborted gate run, `git status` and restore any mutant it left.
   b. `node scripts/run-tests.mjs <pkg>` (the root runner's segment) → green; then the CONSUMERS' tests named in the ticket (`node --test <consumer test files>`) → green; then the FULL root suite once, `node scripts/run-tests.mjs > <scratch>/root.txt 2>&1; echo EXIT=$?` (it is what CI's `test` job runs; a package segment cannot see a broken consumer).
   c. `node scripts/scan-findings-ledger.mjs`, `node scripts/guard-findings-ledger-append-only.mjs origin/main`, `node scripts/check-reviewer-directed-comments.mjs origin/main` → all exit 0. (rail-freeze `scripts/rails-guard-ci.mjs origin/main` is KNOWN to exit 1 on every branch until the base config ceremony lands — run it once, confirm the failure is exactly `acknowledgedNewRailBypass must already be set on the base branch`, and report that; do not try to fix it.)
   d. Commit first (see 5), then cross-model review: `git fetch origin` and `adversarial-review --base origin/main --provider agy --model gemini-3.7-flash-medium --timeout 600` (on PATH; `npx adversarial-review` otherwise), stdout to a scratchpad file. agy (Gemini family) is the primary reviewer; if it is unavailable or rate-limited, fall back to `--provider codex` and say so in the PR body. Read the reviewer's `mode:` line (summary mode = zero findings = false green; scope smaller if that happens) and EVERY finding regardless of exit code; fold real findings with tests, refute false ones with evidence in your notes, commit, re-run. Loop until a round has exit 0 AND zero findings AND no warning lines. Cap at 8 rounds; if not converged, stop and report the residual.
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
