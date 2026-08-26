# Issue Autopilot (local substrate) — `@adlc/autopilot`

Evidence: `adlc run p1 --ticket T-01M0Z3FN7SAS4HAH7CS63YQ0DH --dir .adlc`
(manifest segment `spec-autopilot-local-01M0Z3K7…`).
Ticket: T-01M0Z3FN7SAS4HAH7CS63YQ0DH (build; carries the five review residuals as
AC2–AC6), prerequisite fleet-extensions ticket minted alongside it with a DAG
edge — see §14/§15 R3. (The original T55 id was reclaimed by another ticket and
is not reused.)
Supersedes: the GitHub-Actions substrate half of issue #237 / ADR "0011
issue-autopilot-substrate" (never landed). The gate composition, triage
contract, protected-path denylist and PR-upsert rule from #237 are kept
verbatim; only the substrate (where the loop runs, what pays for it) changes.
Inputs: issue #237 (design + grooming), `docs/specs/fleet-orchestration.md`
(§4 adapters, §7 permissions/sandbox, §8 gates, §9 merge policy),
`packages/fleet/lib/{review-runner,scheduler,charters,config}.mjs`,
`packages/ticket-sync/README.md`, `packages/prosecute/README.md`
(`record-cross-model`, `--carry-forward`), `packages/rails-guard/lib/ci/
trust-roots.mjs`, `AGENTS.md`, the `/adlc:adlc` router skill, and the eleven
user decisions recorded in §0 (grill-me session 2026-08-26).

## 0. Operator decisions recorded at P0

These are product decisions the operator made in the grill-me interview.
They are inputs to the design below and are themselves reviewable.

1. **Substrate: compose `@adlc/fleet`.** New package `packages/autopilot`
   (`@adlc/autopilot`, bin `adlc-autopilot`) plus a plugin command
   `/adlc:adlc-autopilot`. The autopilot adds **no new gate logic**: it is an
   issue picker + quota gate + rest loop that dispatches
   `fleet run --tickets <id>` **one ticket per run**, so each issue gets its
   own branch and PR. Sandbox, worker permissions, deterministic gates, the
   blocking cross-model review loop and worktree hygiene are fleet's.
2. **Quota gate (literal):** a run starts only when BOTH the 5-hour window and
   the 7-day window report `< 50` utilization (i.e. more than half remaining),
   read from `GET https://api.anthropic.com/api/oauth/usage`. Any model-scoped
   weekly window for the worker model must also be `< 50`. Unknown quota =
   no run (fail closed). **Accepted residual:** this is a best-effort
   START gate. The windows are shared with the operator's interactive
   sessions and there is no reservation API, so a step that started below
   the threshold can end above it (bounded per §3.4); the autopilot cannot
   prevent that, only make it visible (`overshoot` in the status file and
   digest) and stop starting new steps.
3. **Models:** worker `--model opus`; reviewer `adversarial-review --provider
   codex`. Distinct providers satisfy ADR-0007 cross-model and keep the fix
   loop off the Claude quota.
4. **Selection: auto-score + hard exclusions + label overrides** (§4).
5. **ADLC depth:** the worker follows `/adlc:adlc` for P3–P5 inside its
   headless session (rails, hollow-test/behavior-diff, `/adlc:adlc-prosecute`
   before `TICKET-DONE`); fleet's Codex `adversarial-review` fix loop is the
   blocking OUTER gate. P0 shaping is done once by the orchestrator (§5) —
   the sandboxed worker never holds the manifest key.
6. **Fix loop cap: 15 review rounds inside a 90-minute wall clock** per issue.
   Exhaustion → label `adlc:autopilot-blocked`, findings comment, move on;
   never auto-retried until the label is removed by a human.
7. **Triage writes to GitHub:** on CLARIFY, one idempotent sentinel-keyed
   comment (failed gates verbatim + fix template) and label
   `adlc:needs-clarification`. Re-running on an unchanged issue makes zero
   mutating calls.
8. **PR backpressure: cap 5 open autopilot PRs; auto-rebase + re-attest.**
   Clean rebase → `record-cross-model --carry-forward` + force-with-lease
   push, no model call. Conflict → exactly one worker conflict-fix round +
   fresh Codex review + fresh attestation; failure → label
   `adlc:autopilot-stale`, PR left as-is and no longer counted toward the cap.
9. **Deployment: `systemd --user` service** running `adlc-autopilot loop
   --rest 10m` (single-instance lock, `Restart=on-failure`), plus
   `adlc-autopilot once [--issue N] [--dry-run]` for manual/canary runs.
10. **Observability:** gitignored `.adlc/autopilot-status.json`,
    `adlc-autopilot status [--json]`, and one rolling GitHub "autopilot log"
    issue (label `adlc:autopilot-log`) that receives one comment per run.
11. **CI follow-up:** after the PR opens, poll `gh pr checks` for up to 30
    minutes; `test (18|20|22)` AND `rails-guard`, `mutation-gate`,
    `cross-model-gate`, `ticket-store-platform` are all treated as blocking.
    Red → one worker fix round + Codex re-review + push, max 2 rounds on a
    separate 30-minute budget; still red → label `adlc:autopilot-ci-red`,
    comment naming the failing job, move on.
12. **`.adlc/config.json` lands via a one-time admin trust-root commit** (PR
    labeled `trust-root-change`, merged deliberately by the admin CODEOWNER;
    the #141 non-author-CODEOWNER ceremony is unsatisfiable with a single
    CODEOWNER and this is recorded as the accepted residual).
13. **Plan gate before build (as decided 2026-08-26):** this spec passes
    `adlc spec-lint`, and an `adversarial-review --input <this file>
    --provider codex` fix loop is run with a finite budget (artifact
    `--input` mode exists from adversarial-review 2.9.1; the gate first
    checks `adversarial-review --help` lists `--input` and records the
    binary's `--version` in the digest — if absent, the diff-mode loop
    over the committed spec is the fallback, which is also what this
    branch's PR gate ran); the loop ends either by convergence or by the
    operator closing it with the remaining findings carried into the
    build ticket as acceptance criteria. The binding cross-model verdict
    for this program is required on the CODE: the build PR must carry a
    `record-cross-model` entry whose `verdict` is the reviewer tool's
    `"approve"` value, from a diff-mode `adversarial-review --base
    <BASE_OID> --provider codex` run (exit 0), bound to its revision
    before merge. A spec-level gate record never substitutes for that.
14. **P6 (merge) stays human, always.** The autopilot never merges, never
    pushes to `main`, never deletes a branch it did not create.

## 1. Goals / non-goals

Goals

- Turn the open backlog into a stream of evidence-bearing PRs while the
  operator is away, never STARTING a Claude-consuming step when either
  window is at or past 50% used. This is a start-gate, not an invariant on
  the final reading: one in-flight step (bounded by fleet's per-dispatch
  `timeoutMinutes`) can carry a window past 50% by at most that step's
  spend; §3.4 states the overshoot bound and the reconciliation that makes
  it observable.
- Every phase transition is an existing ADLC gate; every outcome (PR,
  CLARIFY, blocked, stale, ci-red) is visible on GitHub and in a local status
  file.
- Zero third-party runtime dependencies (CONVENTIONS.md); `@adlc/core`,
  `@adlc/fleet`, `@adlc/tickets` only.

Non-goals (v1)

- No automatic P6 merge. No multi-issue batching (one ticket per fleet run).
- No forked-repo / untrusted-contributor issues: the repo is the operator's
  own; the label overrides are the authorization surface.
- No trust-root-tier changes (§4.2 excludes them); no edits to base tickets.
- No per-model quota pools beyond the single worker model's scoped window.
- No Windows support (fleet is POSIX-only; `bwrap` is required).

## 2. Loop

```
loop:
  acquire single-instance lock       # §2.2 — atomic, owner-checked
  preflight()                        # §9 — fail closed on any red item
  BASE_OID = fetch_base()            # §6.0 — pinned OID; fetch failure → sleep 10m; continue
  recover()                          # §2.1 — resume/finish/retire orphaned runs BEFORE selection
  if !quota().ok                     → sleep 10m; continue         # §3
  maintain_open_prs()                # §8 — every fix round re-checks quota (§3.2)
  if active_autopilot_prs >= 5       → sleep 10m; continue
  issue = select()                   # §4 — null → sleep 10m; continue
  verdict = triage(issue)            # §5 — shaping re-checks quota first (§3.2)
  if CLARIFY                         → comment+label; sleep 10m; continue
  if !quota().ok                     → cache the PROCEED ticket (§3.2); sleep 10m; continue
  outcome = run(issue, verdict.ticket)   # §6–§7 (fleet re-checks quota before every strike)
  digest(outcome)                    # §10
  sleep 10m                          # the "rest" — unconditional after a run, success or not
```

`once` executes exactly one iteration and exits 0/1/2 per the toolkit
contract. `--issue N` pins the candidate: it bypasses SCORING only — every
§4.2 hard exclusion, the open-PR/branch duplicate checks, triage, the quota
gate, the PR cap and recovery all still apply, and a pinned issue that is
excluded exits 2 naming the rule. `--force` (only with `--issue`) lifts
exactly the autopilot-owned STOP labels (`adlc:autopilot-blocked`, `-stale`,
`-ci-red`, `adlc:needs-clarification`, `adlc:autopilot-skip`) after retiring
that issue's prior run (§2.1); it never lifts the protected-path denylist,
the `trust-root-change`/`question`/`wontfix`/`duplicate`/`invalid` labels,
the `Programs` milestone rule, or the open-PR duplicate check. `--dry-run`
prints the full plan (selected issue, shaped ticket, fleet argv, PR
title/body) and performs zero mutations of any kind: no lock directory,
no `.git/info/exclude` write, no `git fetch` (the baseline OID comes from
`git ls-remote` alone and objects are not downloaded), no worktree, no
ownership marker, no run record, no status-file write, no `gh` mutation,
and no manifest append; the shaping call is replaced by a deterministic
placeholder unless `--dry-run-shape` is also passed (which spends the one
gated Claude call and nothing else). The spawn recorder in AC 10 rejects
any argv that is not in the read-only set (`git ls-remote`, `git
rev-parse`, `git cat-file`, `gh … view|list|api GET`, `adlc … --json`
without `--write`/`--record`).

### 2.1 Recovery state machine (runs before selection, every iteration)

Every run has a record `.adlc/autopilot-runs/<issue>.json` (gitignored)
with `state ∈ {creating, clarify, shaped, dispatched, quota-paused, built,
attested, pushed, pr-open, ci-watch, oid-mismatch, blocked, stale, ci-red,
done, remote-pending, orphan}`, `runId`,
`ticketId`, `baseOid`, `branch`, `fleetRunId`, `prNumber`,
`roundsUsed`, `wallClockUsedMs`, `ciRoundsUsed`, and timestamps. The
label↔state mapping is fixed: `adlc:needs-clarification`↔`clarify`,
`adlc:autopilot-blocked`↔`blocked`, `adlc:autopilot-stale`↔`stale`,
`adlc:autopilot-ci-red`↔`ci-red`.
State is written BEFORE the world-effect it names is attempted and confirmed
after, so a crash between the two leaves a record the next iteration can
disambiguate by inspecting git/`gh`.

| Found | Action |
|---|---|
| `creating` (record persisted; `creationPhase` names the step that may have half-happened) | crash-safe repair keyed on `creationPhase` and touching ONLY artifacts the record names whose ownership is provable — a staging branch/path whose NAME embeds the token, or the final branch/path carrying the marker with the record's token: `recorded`/`staged` → staging branch present at `baseOid` → continue (marker → rename → move); staging tip moved → `orphan`; nothing present → delete the record; `marked` → same, marker already there; `renamed` → the final branch exists WITH the marker (git renames the config section) and the staging path may still exist → finish the move; `moved` → set `shaped`. The record is NEVER deleted while any token-owned artifact (staging or marker-bearing final branch/worktree) exists. A final branch that exists WITHOUT the marker is never claimed and never deleted: `orphan` until the operator runs `reset` |
| `shaped` (ticket cached, not dispatched) | reuse the cached ticket if the issue's `updatedAt` is unchanged, else re-shape |
| `dispatched` with fleet's run lock free | re-invoke fleet EXACTLY as in §6.4 (same cwd `ISSUE_WT`, same `--tickets <ULID>`, same flags) when quota is ok: fleet has no `--resume` flag — on startup it reads its persisted `<ISSUE_WT>/.adlc/fleet-status.json` and `reconcileRun` (fleet §6.4) either resumes (`resuming run <fleetRunId> on <integrationBranch>` on stderr, and the same `fleetRunId` in `--json`) or refuses (`cannot resume: <reason>`, exit 1). The orchestrator asserts the reported `fleetRunId` equals the record's; a refusal or a mismatch → the run is `blocked` with reason `resume-refused` (never silently restarted, because a fresh run would re-cut the integration branch) |
| `quota-paused` | same as `dispatched`, gated on quota |
| `built` (ff done, not attested) | attest + push + PR (steps §6.7–§6.8) |
| `attested`/`pushed` (no PR, or `gh` said pushed but no PR) | `gh pr list --head <branch>`; upsert PR; enter `ci-watch` |
| `ci-watch` past its 30-minute budget | evaluate checks once; label per §0.11 |
| `blocked`/`clarify` (no PR exists) whose mapped label a human REMOVED | **retire** the run (§2.1a) → the issue re-enters selection and reruns from scratch (never resumed: the human changed the premise) |
| `stale`/`ci-red`/`oid-mismatch` (an open PR exists) whose mapped label a human REMOVED | **re-arm** the run: keep the branch and PR, reset `roundsUsed`, `wallClockUsedMs`, `ciRoundsUsed` and the watch clock to 0, set state `pr-open`; the next `maintain_open_prs()` (§8) or CI watch (§6.9) then performs a full retry round (fresh review + attestation). The PR is never closed by the autopilot; the issue does NOT re-enter selection while its PR is open |
| `oid-mismatch` (label `adlc:autopilot-blocked` with reason `oid-mismatch` in the comment) | quarantined: branch and PR (if any) preserved untouched; excluded from selection and from maintenance until a human removes the label (row above) or runs `reset --issue N --confirm-delete <OID>` (§2.1a) |
| branch `adlc/autopilot/issue-<n>` with no record, or with a record whose `token` does not match the branch's ownership marker | mark `orphan` in status with the branch OID; excluded from selection; **never deleted automatically**. `adlc-autopilot reset --issue N --confirm-delete <OID>` deletes LOCAL artifacts only, and only if the branch carries an ownership marker in the LOCAL git config (any token — proof the autopilot created it on this machine), `<OID>` equals the branch tip, and no open PR has that head; for a recordless branch `--delete-remote` is refused (exit 2) because the marker alone is not proof for a remote ref, and `reset` prints the exact `git push` command the operator may run by hand; a branch with NO marker is not the autopilot's and `reset` refuses entirely (exit 2) |
| record whose local branch and PR are both gone | **canonical deletion rule** (the only path that deletes a record anywhere in this spec): delete the record iff `git ls-remote origin refs/heads/adlc/autopilot/issue-<n>` is empty AND no local branch exists AND no worktree exists; if the remote ref exists → `remote-pending`; if a local branch or worktree exists → retire per §2.1a first. Deletion is not atomic with the remote check, so it leaves a **tombstone** `.adlc/autopilot-runs/<issue>.tombstone.json` `{lastPushedOid, deletedAt}` (kept 30 days) and selection independently runs `git ls-remote` for the issue's branch name: an existing remote ref excludes the issue with rule `remote-ref-exists` whether or not any record or tombstone exists, so a ref that reappears between check and delete can never be collided with. Server-side ownership of `adlc/autopilot/**` (R12 ruleset) is the intended long-term guard. Every other row and §2.1a defer to this rule for the final record deletion |

### 2.1a Retiring a run — ownership-checked deletion

Deletion of a branch or worktree requires ALL of: (a) a run record for the
issue with a `token`; (b) `git config --get
branch.adlc/autopilot/issue-<n>.adlcAutopilotToken` equal to that token
(the marker written at creation, §6.1, in the repo's LOCAL config — a name
alone is never authorization); (c) no open PR whose head is that branch
(`gh pr list --head`); (d) the branch's merge-base with its recorded
`baseOid` equals `baseOid` (the branch still descends from what the
autopilot created); (e) re-validated immediately before each destructive
command, under the lock: `git rev-parse adlc/autopilot/issue-<n>` equals
the record's `localHead` (updated after every commit the orchestrator
makes) and, if `ISSUE_WT` exists, `git -C <ISSUE_WT> status --porcelain`
is empty — a moved tip or a dirty worktree means another session (a
human, a Remote Control session) touched it, so nothing is force-removed
and the run is `orphan`. The worktree removal is therefore never forced
on a dirty tree. The loop NEVER deletes a remote ref on its own: automatic retirement
performs Step L only. If `git ls-remote` shows the run's remote ref still
present, the run record is NOT deleted — it moves to state
`remote-pending` (terminal; the issue is excluded from selection with rule
`remote-ref-pending`, because a fresh run would collide with that ref on
its first push), status lists the ref under `remoteRefsLeft` with the
exact deletion command, and a later iteration whose `ls-remote` is empty
(the operator deleted the ref by hand or via `reset --delete-remote`)
deletes the record and re-admits the issue. The record is deleted
immediately only when no remote ref exists. Step R
runs only when the operator invokes `reset --issue N --confirm-delete
<OID> --delete-remote`. When both steps run, order is remote-first so a
remote failure leaves every local artifact in place for the next attempt
(nothing local is destroyed before the remote outcome is known). Step R
(remote, operator-invoked only; eligible whenever the record preserves a
`lastPushedOid` — including records in `remote-pending`, `blocked`,
`stale`, `ci-red`, `oid-mismatch` or `done` — the lifecycle state never
makes a pushed ref undeletable by the operator; `lastPushedOid` is
preserved in the record for as long as the record exists and is copied
into the status file's `remoteRefsLeft` entry when the record is
deleted, so the deletion command stays available): (c)
is re-evaluated IMMEDIATELY before the push (`gh pr list --repo <repo>
--head adlc/autopilot/issue-<n> --state open --json number` must be
empty — a PR that appeared since the earlier check aborts with `orphan`)
AND `git ls-remote origin refs/heads/adlc/autopilot/issue-<n>` must
equal the record's last pushed OID; then the remote ref is deleted
with a lease so a tip that moves between the check and the delete is
protected: `git push
--force-with-lease=refs/heads/adlc/autopilot/issue-<n>:<lastPushedOid>
origin :refs/heads/adlc/autopilot/issue-<n>`. A lease failure → `orphan`,
remote AND local untouched, stop. After a successful delete, `gh pr list
--head` is queried once more; a PR that was created against the ref in
the window is reported (`pr-after-delete: <number>`) so the operator can
restore the ref from the recorded OID — the deletion itself is
lease-bounded, so the OID is always known. Step L (local; in automatic
retirement always, in `reset` only after R succeeded or the record says
never pushed), cwd `REPO_ROOT`, transactional so that no artifact is
permanently removed before the conditional ref delete has succeeded:
L1 re-check (e) and, if `ISSUE_WT` exists, verify `git -C <ISSUE_WT>
rev-parse HEAD` equals the record's `localHead` AND `git -C <ISSUE_WT>
symbolic-ref HEAD` is exactly `refs/heads/adlc/autopilot/issue-<n>` —
any mismatch → `orphan`, nothing moved; L2 `git worktree move <ISSUE_WT>
<ISSUE_WT>.retiring-<token>` (a rename — reversible), then `git -C
<ISSUE_WT>.retiring-<token> checkout --detach <localHead>` so the branch
ref is checked out nowhere when it is deleted and the quarantined
worktree's HEAD stays resolvable at the expected OID; L3 `git update-ref -d
refs/heads/adlc/autopilot/issue-<n> <localHead>` (the conditional form:
it fails if the ref moved since (e)) — on failure `git worktree move` it
back, mark `orphan`, stop, nothing removed; L4 only after L3 succeeded and after re-verifying that the quarantined
worktree is detached at exactly `localHead` (`git rev-parse HEAD` equals
it; `git symbolic-ref -q HEAD` fails, as a detached HEAD must):
`git worktree remove <ISSUE_WT>.retiring-<token>` (clean by (e), never
forced; a failure here leaves a quarantined directory the status file
names and is not an integrity problem), `git config --unset
branch.…adlcAutopilotToken`; L5 apply the canonical deletion rule of
§2.1 to the record (remote ref present → `remote-pending`, else delete). Any check failing → the run is marked `orphan` (row
above) and nothing further is deleted. `git branch -D` is never used. A
remote ref is never deleted on the strength of the local token and
ancestry alone.

Terminal labels applied by the autopilot are therefore the ONLY thing a human
has to touch to unblock an issue; retiring/re-arming is automatic on the
next iteration — but only when the removal is **authorized**: recovery
reads the issue timeline (`gh api repos/{o}/{r}/issues/<n>/timeline`),
finds the most recent `unlabeled` event for that label, and requires its
actor's repository permission to be `admin` or `maintain` (§4.2 predicate).
The event id is stored in the record as `unlabeledEventId` so the same
event is never acted on twice. An unlabel by any other actor is ignored:
the run stays in its terminal state, status reports
`unauthorized-unlabel` with the actor login, and the autopilot re-applies
the label (idempotent add) so the quarantine remains visible.

### 2.2 Single-instance lock

`.adlc/autopilot.lock/` is created with `mkdir` (atomic on POSIX; the same
primitive `@adlc/fleet` uses for `.adlc/fleet.lock/`). Inside:
`owner.json = { pid, pidStartTime (from /proc/<pid>/stat field 22),
token (32 random bytes hex), heartbeatAt }`. The holder rewrites
`heartbeatAt` every 60 s (write-to-temp + `rename`). Another starter may
reclaim only when `heartbeatAt` is older than 10 minutes AND (the pid is not
alive OR its `/proc` start time differs from `pidStartTime`); reclaim is
`rename(lockdir → lockdir.stale-<token>)` then `rmdir`, then a fresh `mkdir`
— a losing racer's `rename` fails and it exits 1 `lock-held`. Release checks
`token` before removing. `fleet.lock` is separate and still honored by fleet
(a held fleet lock is a visible `skipped: "lock-held"` outcome, never a
silent success).

## 3. Quota gate

### 3.1 Source of truth

- Source of truth: `GET https://api.anthropic.com/api/oauth/usage` with
  `Authorization: Bearer <claudeAiOauth.accessToken>` from
  `~/.claude/.credentials.json` and `anthropic-beta: oauth-2025-04-20`.
  Fields: `five_hour.utilization`, `seven_day.utilization` (0–100 used),
  `limits[]` entries with `scope.model` for model-scoped windows.
- **Strict response schema (fail closed):** HTTP status must be 200; the
  body must parse as a JSON object; `five_hour` and `seven_day` must each
  be objects whose `utilization` is a finite number in `[0, 100]` and whose
  `resets_at` is an ISO-8601 string; `limits`, if present, must be an
  array; EVERY entry must be a plain object with string `kind`, finite
  `percent` in `[0, 100]`, and either no `scope` key at all or a `scope`
  that is a plain object whose `model` is a plain object whose
  `display_name` is a non-empty string (an entry whose `scope` is present
  but `null`, a scalar, an array, an object without `model`, or a `model`
  without a string `display_name` is MALFORMED). One malformed entry
  anywhere in `limits` — whether or not it concerns the effective model —
  → `ok:false, reason:"quota-unknown"`; the gate never skips an entry it
  cannot classify. Any other shape — missing key, `null` where an object
  is required, NaN, out-of-range, non-array `limits`, duplicate scoped
  entries for the same family with different `percent` — likewise →
  `quota-unknown`. "No scoped limit for the effective
  model" is signalled ONLY by: no `limits[]` entry whose
  `scope.model.display_name` matches AND `seven_day_<family>` is `null`
  or absent; a scoped entry that matches but fails the per-entry schema
  is `quota-unknown`, never "no limit".
- **Effective model binding:** `effectiveModel = --model > ADLC_AUTOPILOT_MODEL
  > "opus"`, resolved once at preflight. Its family is derived from the
  alias or full id (`fable|opus|sonnet|haiku`, or a full id containing one
  of those tokens); a model whose family cannot be derived → preflight
  `model-unknown`, exit 1. The gate evaluates every scoped entry whose
  `display_name` equals the family case-insensitively, and the same
  `effectiveModel` string is what is passed to fleet as `--model` (AC 47).
  v1 supports `--adapter claude-code` only; any other adapter → preflight
  `adapter-unsupported`, exit 1 (other harnesses meter different quota
  pools the gate cannot read).
- Gate: `five_hour < T && seven_day < T && every(scoped entry for the
  effective model).percent < T` where `T` is `--quota-threshold` (default
  50, max 50 — §13).
- Bounds: the HTTP request has a 10-second timeout and one retry; the
  `/usage` fallback subprocess has a 60-second timeout in its own process
  group. Either bound exceeded → that source is "unavailable" and the next
  source (or `quota-unknown`) applies.
- `resets_at` for the binding window is written to the status file so
  `status` can say when the next attempt could succeed.

### 3.2 Where the gate is evaluated

The gate is re-evaluated immediately before EVERY Claude-consuming step,
not once per iteration; a result is valid for 60 seconds and never reused
across steps beyond that:

| Step | On refusal |
|---|---|
| loop head | sleep 10m |
| shaping call (§5.2) | sleep 10m; nothing written |
| coldstart answer call (§6.3 — the `--prompt-only` prompt is answered by a `claude -p` call, so it is Claude-consuming and gated + reconciled exactly like shaping; exactly one per ticket hash) | sleep 10m; the run stays `shaped` with the ticket persisted, resumed next iteration |
| final review + attestation (§6.7) | not Claude-consuming (Codex); never gated |
| after PROCEED, before dispatch | cache the shaped ticket in the run record (`state: shaped`, keyed by issue `updatedAt`); sleep 10m; next iteration reuses it via §2.1 |
| every fleet strike | fleet runs `--pre-strike-argv <json-array>` = `[<pinned absolute adlc path, §9.1>,"autopilot","quota","--json","--model",<effectiveModel>,"--quota-threshold",<T>,"--quota-reserve",<R>]` (the resolved values are passed explicitly as separate argv elements — never a shell string — so the helper cannot re-resolve them differently and no metacharacter can split an argument; the helper runs with a MINIMAL environment — `PATH` = the sanitized list of §9.1, `HOME`, `ADLC_AUTOPILOT_STATUS_FILE`, `ADLC_AUTOPILOT_LOCK_TOKEN` and nothing else, so no orchestrator secret (the manifest key, `gh`/`claude` tokens, `*_KEY`/`*_TOKEN`) is inherited; its executable is the pinned `adlc` path; the array also carries `"--iteration", <iterationId>` and `"--start-ordinal", "auto"`: the helper reads and atomically increments `startsThisIteration` in `.adlc/autopilot-status.json` under the autopilot lock, so the FIRST start of an iteration is gated at the threshold and every later start — including every fleet strike — at threshold minus reserve, exactly as §3.4 requires; a helper invoked without a lock-holding parent refuses with exit 1); non-zero exit → fleet stops cleanly with `reason: "quota-paused"`, exit 2, run resumable; the record becomes `quota-paused` |
| each maintenance conflict-fix round (§8) | skip that PR this iteration; no label |
| each CI fix round (§0.11) | pause the CI watch; the 30-minute CI budget does not advance while paused |

The Codex reviewer, `gh`, git, `npm ci`, and `preflight.mjs` are not
Claude-consuming and are never gated. A step already executing is never
killed by the gate; the wall clocks bound it.

### 3.3 Fallback grammar (versioned: `usage-text/v1`)

When the endpoint returns 401 or is unreachable: `claude -p "/usage"
--output-format json`, take `.result`, and require ALL of these
line-anchored matches (case-sensitive, `m` flag):

```
^Current session: (\d{1,3})% used
^Current week \(all models\): (\d{1,3})% used
```

plus zero or more `^Current week \(([A-Za-z0-9 .-]+)\): (\d{1,3})% used`
scoped lines. Mapping: line 1 → `five_hour`, line 2 → `seven_day`, scoped
line → the scoped window for `familyOf(name)`. ONE normalization
function `familyOf(x)` (lower-case, strip non-alphanumerics, take the
first of `fable|opus|sonnet|haiku` that occurs as a token; otherwise
`unknown`) is applied to the endpoint's `scope.model.display_name`, to
the fallback's parenthesized name, and to `effectiveModel` — so both
sources are compared in the same family space. Two scoped lines that
normalize to the same family with different values → `quota-unknown`; a
scoped line whose family is `unknown` is ignored only if it cannot be the
effective model's family. Absence of a scoped line for the effective
model's family means "no scoped limit" — the same semantics as the
endpoint's `seven_day_<family>: null`. A missing mandatory line, a value > 100, a
duplicate mandatory line with different values, or a `.result` that does
not contain the literal `subscription` → `ok:false, reason:"quota-unknown"`.
The parser is a pure function with a fixture per case (AC 2).

### 3.4 Overshoot bound, reservation, and reconciliation

- The gate is a START gate. The autopilot cannot meter a step while it
  runs; the endpoint is the only usage source and it lags. So the guarantee
  offered is: **no Claude-consuming step starts after a quota SAMPLE that
  reads ≥ threshold**, where a sample is a point-in-time read at most 60 s
  old; the read-to-start race with concurrent consumers (the operator's
  own sessions, which share the windows and cannot be coordinated) is an
  accepted residual — it is detected after the fact by reconciliation and
  reported as `overshoot`, never prevented. A single step's spend is
  bounded by fleet's `timeoutMinutes` (one dispatch) or the shaping call's
  `--max-turns 1`.
- **Reservation:** `--quota-reserve <pct>` (default 5) is subtracted from
  the threshold for every start after the first in an iteration, i.e. a
  fleet strike starts only when both windows are `< threshold − reserve`,
  so the last step before the boundary cannot itself begin above 45%.
  "First" is defined by a persisted counter `startsThisIteration` in the
  status file, reset to 0 at the top of each loop iteration and
  incremented atomically (write-to-temp + `rename` under the autopilot
  lock) by every start — the loop's own steps and the pre-strike helper
  alike — so the ordinal is a fact of record, not an argument a caller
  could get wrong.
- **Concurrent consumers** (the operator's interactive sessions share the
  same windows): the autopilot has no way to see them ahead of time; it
  re-reads the endpoint before every start (§3.2), which is the only
  coordination possible. The status file publishes `quota.before`/`after`
  per step so an operator can see the autopilot's share.
- **Reconciliation:** after every Claude-consuming step the endpoint is
  re-read and `{step, before, after, delta}` is appended to the run record
  and to `.adlc/autopilot-status.json`. If `after` is ≥ threshold, the loop
  records `overshoot: true` for that step and the next start is refused by
  the ordinary gate.

## 4. Selection

Input grammar (normative before ANY filesystem, git or GitHub operation):
an issue number is accepted only if it matches `^[1-9][0-9]{0,9}$` and is
≤ `Number.MAX_SAFE_INTEGER`; every OID is accepted only if it matches
`^[0-9a-f]{40}$` (or `^[0-9a-f]{64}$` on a SHA-256 repository); a ticket
id only if it matches `^T-[0-9A-HJKMNP-TV-Z]{26}$`; a branch name is
never taken from input — it is always constructed as
`adlc/autopilot/issue-<validated number>`; a path is always constructed
by joining `REPO_ROOT`/`ISSUE_WT` with validated components and then
verified with `realpath` to still lie under the expected root. Anything
else → exit 1 `bad-input:<field>` with no side effect (AC 73).

### 4.1 Candidate set

one page per call, never `--paginate`: `gh api --repo <owner/repo>
"repos/{owner}/{repo}/issues?state=open&per_page=100&page=<k>"` for
`k = 1, 2, …`, each call a separate child with the §12.1 deadline and a
4 MiB stdout cap (exceeding the cap kills the child and is a page
failure); the loop stops when a page has fewer than 100 elements, and it
NEVER requests page 51 — reaching 50 full pages → `candidate-set-
truncated`. Each page must parse as a JSON array of objects with an
integer `number`; entries carrying a `pull_request` key are dropped (the
issues API interleaves PRs). A non-zero `gh` exit, a non-array page, a
malformed element, or the 50-page bound → `candidate-set-truncated`: no
selection this iteration, status records the page count reached and the
reason. Memory is bounded by pages × 4 MiB before parsing and by the
flattened candidate list after. `gh issue list --limit N` is never
used for enumeration (it truncates silently).

### 4.2 Hard exclusions (applied before scoring; each is logged with the
issue number and the rule name)

- **authorization** — ONE predicate, `eligibleAuthor(issue, mode)`, used
  by selection, revalidation (§6.0a), triage (§5.1) and the threat model
  (§11) alike; `mode = autopilot.dispatchApproval`:
  - `"owner-or-label"` (default): `authorAssociation == "OWNER"`, OR the
    **labeled clause**: `adlc:autopilot` is CURRENTLY on the issue (`gh
    issue view --json labels`) AND, among the issue's timeline events for
    that label, the LATEST one (by `created_at`, ties broken by event id)
    is a `labeled` event whose actor's repository permission is `admin` or
    `maintain` — a later `unlabeled` event, by anyone, revokes eligibility
    until an authorized actor labels again; the same clause is evaluated
    identically at selection, revalidation (§6.0a) and triage;
  - `"label-only"`: the labeled clause only;
  - `"trusted-authors"` (opt-in): `authorAssociation ∈ {OWNER, MEMBER,
    COLLABORATOR}`, OR the labeled clause.
  Anything else — including `MEMBER`/`COLLABORATOR` authors under the
  default, an `adlc:autopilot` label applied by a `write` actor, a label
  that was removed and re-added by a non-authorized actor, or a timeline
  the autopilot cannot read — is excluded with rule `not-authorized` and
  is never shaped or dispatched.
  An unknown mode value → preflight exit 1 `bad-config`.
- label in {`trust-root-change`, `question`, `wontfix`, `duplicate`,
  `invalid`, `adlc:autopilot-skip`, `adlc:autopilot-blocked`,
  `adlc:autopilot-stale`, `adlc:autopilot-ci-red`, `adlc:needs-clarification`,
  `adlc:autopilot-log`}
- milestone title starts with `Programs` (multi-slice work)
- an open PR exists whose head is `adlc/autopilot/issue-<n>` or whose body
  contains `Closes #<n>` / `Fixes #<n>`
- a local branch `adlc/autopilot/issue-<n>` exists (a run is or was in flight)
- the issue's `<!-- adlc:begin -->` scope, or the scope produced at shaping
  (§5), intersects the **protected-path denylist** — non-shrinkable, config
  may only extend it:
  `.adlc/**`, `.github/**`, `scripts/rails-guard-ci.mjs`, `docs/ci/**`,
  `CODEOWNERS`, `.github/CODEOWNERS`, `docs/CODEOWNERS`, `package.json`,
  `.npmrc`, plus the **trust-root tier** packages
  `packages/rails-guard/**`, `packages/prosecute/**`,
  `packages/gate-manifest/**`, `packages/build-gate/**`,
  `packages/ticket-prune/**`, `packages/ticket-sync/**`, and
  `packages/core/**` (frozen by CONVENTIONS.md).
  Exception: `.adlc/tickets/<new-shard>.json` and `.adlc/manifest.d/*.jsonl`
  appends are produced by the pipeline itself, not by the worker, and are not
  part of the ticket scope.

### 4.3 Score (higher first; ties → lower issue number)

| Signal | Points |
|---|---|
| `adlc:autopilot` label (operator override) | +1000 |
| `P0-critical` / `P1-high` / `P2-medium` / `P3-low` | 400 / 300 / 200 / 100 |
| `bug` / `documentation` / `enhancement` | +30 / +20 / +10 |
| `security` | +15 |
| single `area:*` label (one package family) | +10 |
| age: +1 per 7 days open, capped at +20 | |

Rationale: "next likely best" = highest priority × highest probability of
autonomous success. Docs and single-area bugs are cheap and self-verifying;
enhancements are less specified and rank lower at equal priority.

`adlc-autopilot select [--json] [--top N]` prints the ranked list with the
per-issue score breakdown and exclusion reasons; it is the operator's window
into "what will it do next".

## 5. Triage / P0 shaping

For the selected issue, the orchestrator (NOT the worker) produces an ADLC
ticket. Every issue body is untrusted input; the gate chain in step 3 runs
for every issue regardless of how the ticket fields were obtained. Only
the issue BODY and title are ever read — issue comments, reactions,
linked PR text and timeline text are never part of any model-bound
input — so under the default dispatch policy (§4.2, `owner-or-label`)
the only text that can drive the worker without a maintainer label is
text the repository OWNER wrote.

1. If the issue body carries a `<!-- adlc:begin -->` block AND the issue
   satisfies `eligibleAuthor(issue, mode)` (§4.2 — under the default that
   means an `OWNER` author or an `admin`/`maintain` label event; a block
   authored by anyone else is ignored and the issue is shaped in full,
   which under the default it cannot be either, so it is simply not
   eligible), the ticket is assembled deterministically with NO model
   call:
   - `scope`, `rails`, `edges`, `duration`, `category` ← the block (the
     `@adlc/ticket-sync` grammar: fenced JSON between `<!-- adlc:begin … -->`
     and `<!-- adlc:end -->`; `category` must be in the ticket-sync set);
   - `title` ← the issue title, prefixed `#<n>: `;
   - `body` ← `GitHub issue: <url>` + newline + the issue body with the
     block removed;
   - acceptance criteria ← the issue body MUST contain a heading matching
     `spec-lint`'s criteria-heading regex (`/acceptance|criteria|…/i`) with
     a list beneath it; that section is what `adlc spec-lint` in step 3
     lints. If the section is absent, the block is kept for
     scope/rails/edges/duration/category but the shaping call (step 2)
     still runs, constrained to produce ONLY `body` (with the criteria
     section) — it may not alter the block's fields.
   The block never bypasses step 3; a block with a protected-path scope is
   a CLARIFY like any other.
2. Otherwise run ONE shaping call: `claude -p --model <effectiveModel>
   --output-format
   json --permission-mode plan --max-turns 1`, spawned in its own process
   group with a 5-minute timeout (SIGTERM, then SIGKILL after 15 s, to the
   whole group), stdout capped at 64 KiB (a longer response is discarded
   as malformed), stdin closed, env scrubbed of `ADLC_MANIFEST_KEY`. A
   timeout or malformed response is an operational failure: `lastError`
   is set, no run record is created, no GitHub write, and the issue is
   retried on a later iteration (at most 3 shaping attempts per issue per
   24 h, then rule `shaping-failed` excludes it until the operator resets).
   The attempt ledger is durable: `.adlc/autopilot-runs/<issue>.attempts.json`
   (array of `{ts, kind: "shaping"|"coldstart", outcome}`) is appended via
   write-to-temp + `rename` BEFORE the call is spawned with
   `outcome:"started"` and updated after it returns; an entry left at
   `started` by a crash counts as a failed attempt; entries older than 7
   days are pruned on read.
   The prompt is a fixed prompt (in
   `lib/shaping-prompt.mjs`) that returns a JSON ticket
   `{title, body, scope[], rails[], category, duration}` whose body begins
   `GitHub issue: <url>` and ends with an `=== ACCEPTANCE CRITERIA ===`
   section where every criterion carries a `VERIFY:` clause. The issue body
   enters the prompt fenced (`@adlc/core` `fence()`, 8000-char cap) as
   authored content AFTER the fail-closed redactor of §6.6 has run over
   it (an issue body that trips redaction failure is shaped from the
   withheld sentinel and therefore lands in CLARIFY); the same redaction
   applies to a trusted `adlc:begin` block's assembled body (§5.1) and to
   the coldstart prompt input (§6.3) — no model-bound byte skips it; the
   constraints prose is authoritative over it.
3. Gate chain (each fails closed, findings collected verbatim):
   - ticket schema (`adlc ticket create --input - --json`, dry run)
   - scope present, non-empty, no wildcard `**` at root, no protected-path
     intersection (§4.2), every glob resolves to ≥1 existing path or a path
     under an existing `packages/<x>/` or `plugins/<x>/` — with ONE bounded
     bootstrap exception: a ticket whose `category` is `feature` may name
     at most one NEW top-level `packages/<name>/**` or `plugins/<name>/**`
     that does not exist at `BASE_OID`, provided `<name>` matches
     `^[a-z][a-z0-9-]{1,40}$` and the same ticket also scopes the registry
     files the bijective/dispatcher guards require (§14). A second new
     directory, or a new directory anywhere else, → CLARIFY.
   - `adlc spec-lint <ticket-body.md>` exit 0
   - spec-lint at triage is a LINT ONLY (no `--record`, no ticket needed):
     the criteria section is written to `<REPO_ROOT>/.adlc/autopilot-runs/
     <issue>-ac.md` (gitignored) and `adlc spec-lint <that file>` must
     exit 0; the recorded run happens in §6.3 against the persisted ticket.
   - coldstart is NOT run at triage: it needs the ticket in a store, which
     exists only after §6.2. It runs exactly ONCE per ticket hash, in §6.3;
     a non-empty `gaps` there is a CLARIFY (§5.4) that additionally retires
     the just-created worktree/branch (§2.1a, nothing pushed yet). There
     is therefore one shaping call and one coldstart-answer call per
     issue before dispatch, both gated (§3.2).
4. Verdict **PROCEED** (ticket + verdict evidence) or **CLARIFY**: one
   comment keyed by the sentinel `<!-- adlc-autopilot:clarify sha256(findings) -->`
   listing every failed gate's findings verbatim plus the fix template (the
   `adlc:begin` block skeleton), label `adlc:needs-clarification`. The two
   effects are reconciled INDEPENDENTLY and idempotently: the comment is
   posted only if no comment with that sentinel exists; the label is added
   with `gh issue edit --add-label` only if `gh issue view --json labels`
   does not already show it. The run record `{state:"clarify", sentinel,
   issueUpdatedAt, commentPosted, labelApplied}` is written BEFORE each
   effect is attempted and updated after it succeeds, so a crash or `gh`
   failure between the two leaves a record that the next iteration
   completes (it re-checks GitHub, never the record alone, before writing).
   "Zero writes on an unchanged issue" therefore means: both effects
   already observed on GitHub → no mutating call. There is no branch or
   worktree to retire — when a human removes the label, recovery deletes
   the record and the issue re-enters selection.

The shaping call is the only Claude-quota spend before dispatch and is
bounded by `--max-turns 1`.

## 6. Run — one issue, one ticket, one branch, one PR

Path contract (AC 25): `REPO_ROOT` is the absolute path of the primary
checkout — the systemd `WorkingDirectory`, or `git rev-parse
--show-toplevel` of the cwd for `once`; it must be the main worktree
(`git worktree list` first entry), never a linked worktree. `ISSUE_WT =
<REPO_ROOT>/.worktrees/autopilot-issue-<n>` (absolute). `git fetch` and
`git worktree add` run with cwd = `REPO_ROOT`; every command from step 1
onward runs with cwd = `ISSUE_WT`; every command that accepts `--dir`
(`ticket`, `spec-lint`, `prosecute`, `gate-manifest`) receives the
absolute `<ISSUE_WT>/.adlc`, and the one that does not (`coldstart`)
receives `--tickets <ISSUE_WT>/.adlc/tickets` and relies on cwd. Fleet, invoked with cwd = `ISSUE_WT`, creates
its own nested worktrees under `<ISSUE_WT>/.worktrees/` and its integration
worktree `<ISSUE_WT>/.worktrees/fleet-integration`; both are removed by
fleet at run end. The primary checkout's working tree is never written
(AGENTS.md); the only writes under `REPO_ROOT` outside `ISSUE_WT` are the
gitignored `.adlc/autopilot-*` files.

0. **Pinned baseline.** `BASE_OID = git ls-remote --exit-code origin
   refs/heads/main` (first column; exit ≠ 0 → exit 1 / sleep, no dispatch),
   then `git fetch --no-tags origin <BASE_OID>` (fetch BY OID — GitHub
   serves reachable commits by SHA — so a concurrent `git fetch` in another
   session cannot move what this run resolved; `FETCH_HEAD` is never read),
   then `git cat-file -e <BASE_OID>^{commit}` must succeed. The OID is
   recorded in the run record and the status file. Every later
   reference to the base in this run uses that OID, never the name
   `origin/main` or local `main`: worktree creation, fleet `--base`,
   `preflight.mjs --base`, `record-cross-model --base`, the rebase target in
   §8, and the PR body's `base-oid:` line. Two different things are both
   called "base" and must not be confused: `BASE_OID` is the **evidence
   baseline** (what the build, gates and attestation were computed
   against); the **PR base** is the branch NAME `main`, because GitHub PRs
   target a branch, not a commit — `gh pr create --base main` is therefore
   correct and not a contradiction. If `main` has moved past `BASE_OID` by
   the time the PR is opened, the PR is simply `BEHIND`; CI's `strict`
   policy prevents merging it as-is and §8 rebases it onto a new
   `BASE_OID` with a fresh or carried-forward attestation. The evidence
   always describes the tree that was actually reviewed.
0a. **Revalidation.** Immediately before step 1 and again immediately
   before the fleet dispatch of step 4 (and before every retry dispatch),
   the issue is re-fetched (`gh issue view <n> --repo <repo> --json
   updatedAt,labels,milestone,state,authorAssociation,body`) and every
   selection input is re-evaluated: `state == "OPEN"`, `updatedAt`
   unchanged since selection, the same hard-exclusion verdict (§4.2,
   including `eligibleAuthor` re-evaluated from the timeline), no
   new open PR or branch for the issue, and — when the body changed — the
   shaped ticket is discarded. Any change → the candidate is dropped
   (`revalidation-changed`, nothing written or, if a worktree already
   exists, retired per §2.1a) and selection restarts on the next
   iteration.
1. (cwd `REPO_ROOT`) `ISSUE_WT` must NOT exist and the final branch
   `adlc/autopilot/issue-<n>` must NOT exist (either → `orphan-dir` /
   `orphan-branch`, nothing touched, the issue excluded until `reset`).
   Ownership is established on token-named STAGING artifacts before the
   final names ever exist, and every transition is journaled: the run
   record carries `creationPhase ∈ {recorded, staged, marked, renamed,
   moved}` together with BOTH name pairs (`stagingBranch`,
   `stagingPath`, `finalBranch`, `finalPath`), and the record is
   rewritten (write-to-temp + `rename`) with the NEXT phase value
   immediately BEFORE each git operation below is attempted, so recovery
   always knows which step may have half-happened. FIRST persist the run
   record with `state: "creating"`, `creationPhase: "recorded"`, the
   generated `token` (32 random bytes hex), `baseOid` and the constructed
   names; THEN `git
   worktree add <ISSUE_WT>.creating-<token> -b
   adlc/autopilot/staging-<token> <BASE_OID>` (both the path and the
   BRANCH embed the token — no human branch can share the name); THEN
   write the **ownership marker** `git config
   branch.adlc/autopilot/staging-<token>.adlcAutopilotToken <token>`;
   THEN `git branch -m adlc/autopilot/staging-<token>
   adlc/autopilot/issue-<n>` (git refuses if the final name appeared
   meanwhile → retire the staging artifacts, which are provably ours, and
   mark `orphan-branch`; the marker config section is renamed by git with
   the branch); THEN `git worktree move <ISSUE_WT>.creating-<token>
   <ISSUE_WT>` and the record moves to `shaped`. The marker lives in the
   repo's local git config (never pushed) and is the only authorization
   recovery accepts for deleting a branch or worktree (§2.1).
   Then (cwd `ISSUE_WT`) `npm ci --ignore-scripts`.
2. (cwd `ISSUE_WT`) Write the ticket: `adlc ticket create --input - --write
   --dir <ISSUE_WT>/.adlc` (id omitted → ULID). This is a signed
   `ticket-mutation` because the store is a frozen trust root; the
   orchestrator holds `ADLC_MANIFEST_KEY` (§9.3). Commit
   `chore(ticket): <ULID> <title> (#<n>)`. Record `ticketSnapshotSha256` =
   sha256 of the shard file with the `completed` key removed and keys
   sorted — the **authorizing ticket snapshot** against which every later
   round is checked (§6.5a).
3. (cwd `ISSUE_WT`) Record P0/P1 evidence bound to the ticket, using the
   real CLI contracts:
   - **coldstart**: `--record-verdict` is accepted only together with
     `--prompt-only`, and the verdict must carry the CURRENT `ticketHash`
     (from `adlc ticket show <ULID> --json`). The orchestrator obtains the
     prompt with `adlc coldstart <ULID> --tickets <ISSUE_WT>/.adlc/tickets
     --prompt-only` run with cwd = `ISSUE_WT` (coldstart has NO `--dir`
     option: it resolves `.adlc/` from cwd and takes the ticket store via
     `--tickets`; the path contract of §6 already makes cwd = `ISSUE_WT`
     for every command from step 1 on), answers it with the gated
     `claude -p` call of §5.3,
     validates the answer as `{"gaps": [...]}` (schema-checked: an object
     whose only keys are `gaps` — an array of `{what, why_blocking}`
     strings — re-serialized by the orchestrator, never forwarded
     verbatim), adds `"ticketHash"`, and delivers it as bytes on the
     child's stdin: the pinned `adlc` executable is spawned with
     `shell:false`, cwd `ISSUE_WT`, and argv `["coldstart", "<ULID>",
     "--tickets", "<ISSUE_WT>/.adlc/tickets", "--prompt-only",
     "--record-verdict", "-"]`, the
     serialized JSON is written to `stdin` and the stream is then ended.
     No shell ever sees the JSON. The PROMPT of both `claude -p` calls
     (§5.2 shaping, this coldstart answer) is likewise delivered on stdin
     through the shared wrapper's `stdinBytes` — never as an argv element
     or a temp file. A non-empty `gaps` is a CLARIFY (§5.4),
     never recorded as a pass.
   - **spec-lint**: the orchestrator first derives the criteria document
     — the ticket body from its `=== ACCEPTANCE CRITERIA ===` heading to
     the next `===` heading (or end), written atomically (temp file +
     `rename`) to `<ISSUE_WT>/.adlc/specs/<ULID>-ac.md` with a `##
     Acceptance criteria` heading prepended so spec-lint's criteria
     extractor finds the list — then runs `node
     <REPO_ROOT>/packages/spec-lint/bin/spec-lint.mjs
     <ISSUE_WT>/.adlc/specs/<ULID>-ac.md --record --ticket <ULID> --dir
     <ISSUE_WT>/.adlc` (the in-repo bin; the globally installed `adlc
     spec-lint` does not accept `--record`). `.adlc/specs/` is a
     TRACKED directory: the criteria document is committed with the ticket
     shard in §6.2's commit (`chore(ticket): …`), so the spec-lint record
     binds a durable, reviewable artifact — its hash is verifiable from
     the PR, not from a temp file that no longer exists.
   Both records are manifest appends committed with the ticket. If either
   ticket hash changes later in the run (reopen/complete, §6.6/§6.6a) the
   coldstart verdict is re-recorded against the new hash before
   attestation, because the runner binds evidence to the ticket hash.
4. Dispatch fleet **from inside that worktree** so fleet reads the plan that
   contains the new shard and cuts its integration branch from the issue
   branch:
   ```
   adlc fleet run --tickets <ULID> --base adlc/autopilot/issue-<n> \
     --adapter claude-code --model <effectiveModel> --concurrency 1 \
     --max-strikes <15 − roundsUsed> --wall-clock-minutes <remaining> \
     --no-pr --no-complete \
     --pre-strike-argv '["<pinned adlc path>","autopilot","quota","--json","--model","<effectiveModel>","--quota-threshold","<T>","--quota-reserve","<R>","--iteration","<iterationId>","--start-ordinal","auto"]' \
     --pre-strike-env '{"PATH":"<sanitized PATH>","HOME":"<HOME>","ADLC_AUTOPILOT_STATUS_FILE":"<REPO_ROOT>/.adlc/autopilot-status.json","ADLC_AUTOPILOT_LOCK_TOKEN":"<token>"}' \
     --charter-file <autopilot>/lib/charter-adlc.md --json
   ```
   plus `--model-plane-read bounded --model-plane-read-only <READ_SET>
   --model-plane-git mirror --model-plane-git-mirror <MIRROR>`
   (fleet-extensions items 11–12, §14). **Sandbox contract (normative,
   one statement):**
   - WRITABLE roots (granted by fleet, never listed in `READ_SET`):
     (a) the worker's nested worktree `<ISSUE_WT>/.worktrees/<ticket>`;
     (b) `MIRROR` = `<REPO_ROOT>/.adlc/autopilot-runs/<issue>/mirror.git`,
     this run's disposable bare repository — created before dispatch with
     `git clone --bare --no-local --single-branch --branch
     adlc/autopilot/issue-<n> <REPO_ROOT> <MIRROR>` followed by `git -C
     <MIRROR> remote remove origin` and `git -C <MIRROR> config
     --unset-all` of every non-`core.*` key, so it holds only objects
     reachable from `BASE_OID` and the issue branch (no remote URL,
     credential helper, hook, other branch, reflog, stash or unreachable
     object); the worker's commits write objects, refs and worktree
     metadata INTO it and nowhere else; (c) a private empty tmpfs at `/tmp`
     with `TMPDIR`/`TMP`/`TEMP` inside it (item 11).
   - READ-ONLY binds (`READ_SET`, comma-joined absolute paths): the
     `realpath` of each pinned executable of §9.1 as a single FILE bind
     (never its parent directory), plus `<node prefix>/lib/node_modules/npm`
     and `<node prefix>/lib/node_modules/corepack`, plus `/usr`, `/lib`,
     `/lib64`, `/etc/ssl`, `/etc/resolv.conf`, `/etc/hosts`, plus the
     adapter's synthetic home (fleet §7.3 `homeState`, which necessarily
     holds the harness's own credentials).
   - INVARIANT (checked by the orchestrator before dispatch and asserted
     by fleet's `--json` echo): no `READ_SET` entry is an ancestor of, or
     equal to, a writable root or a pinned executable's parent; and none of
     `<REPO_ROOT>`, `<REPO_ROOT>/.git`, `<ISSUE_WT>`, `$HOME`, host `/tmp`
     appears in either set — so `.env.local`, the operator's other
     checkouts, the orchestrator's state, the shared git database and the
     mirror's parent directory are invisible to the worker.
   - After the worker exits, fleet synchronizes the worker branch back
     with an explicit sequence (a bare `git fetch <MIRROR> <branch>` only
     updates `FETCH_HEAD` and is NOT sufficient): `git -C <ISSUE_WT> fetch
     <MIRROR> +refs/heads/<workerBranch>:refs/autopilot/fetched/<workerBranch>`
     into a temporary ref; `git merge-base --is-ancestor <cutTip>
     refs/autopilot/fetched/<workerBranch>` must succeed (the worker's tip
     descends from the tip fleet cut); then `git update-ref
     refs/heads/<workerBranch> refs/autopilot/fetched/<workerBranch>
     <cutTip>` (compare-and-swap on the old value) — the worker branch is
     never checked out in `ISSUE_WT`'s repository, so the ref can be
     advanced directly; then the temporary ref is deleted. Any step
     failing → `mirror-fetch-failed`, ref untouched. From that point the
     worker branch lives in the CALLER repository (the shared git database
     reached through `ISSUE_WT`), which is where fleet's integration
     worktree `<ISSUE_WT>/.worktrees/fleet-integration` and its
     integration branch `fleet/run-<id>` also live — so fleet's existing
     deterministic gates, prosecution and merge operate unchanged on the
     fetched-back branch, and the `fleet/run-<id>` tip that §6.5
     fast-forwards `adlc/autopilot/issue-<n>` to contains the worker's
     commits. The mirror is never read by any gate; the mirror is `rm -rf`'d and recreated
     before every dispatch (under the lock) and removed at retirement
     Step L with the run directory, so a stale mirror is never read by any
     gate. What the worker can read of the repository is exactly the
     history already published at `BASE_OID` plus the issue branch.
   Fleet: sandboxed worker (`bwrap`, `--permission-mode
   acceptEdits`, allowlist from `fleet.allowedCommands`), deterministic gates
   (`fleet.gate.build/test`), blocking `adversarial-review --provider codex
   --json --fail-on medium` (binary resolved off the ORCHESTRATOR's PATH,
   never `npx` from the worktree; `ADLC_MANIFEST_KEY` scrubbed from worker
   and reviewer), fix strikes on findings, sequential merge into
   `fleet/run-<id>`. `--no-complete` suppresses fleet's `adlc ticket
   complete` on the integration branch: the ticket stays open until §6.6a so
   that every retry (§6.6, §8, §6.9) can re-dispatch the SAME ticket and the
   completion is the last content commit before attestation.
   The charter addendum instructs the worker to follow `/adlc:adlc` P3–P5
   (respect rails, run `adlc hollow-test`/`behavior-diff`, run
   `/adlc:adlc-prosecute` and fix surviving findings) before `TICKET-DONE`.
5. On fleet exit 0: fast-forward `adlc/autopilot/issue-<n>` to
   `fleet/run-<id>` (the integration branch was cut from it, so ff always
   succeeds; a non-ff is an invariant violation → exit 1, nothing pushed).
5b. **Outer-gate environment integrity.** The worker never had write
   access to `ISSUE_WT`: fleet's sandbox grants the worker writes only to
   its own nested worktree and the model plane (fleet spec §7.3), so
   `ISSUE_WT/node_modules` and every ignored file in `ISSUE_WT` are as the
   orchestrator left them. Nevertheless, after the ff and before any outer
   gate: (i) `git status --porcelain --ignored` in `ISSUE_WT` must list no
   ignored paths outside `node_modules/`, `.worktrees/`, `.adlc/tmp/` and
   the fleet status/log paths — anything else → round failure
   `ignored-file-drift`; (ii) **dependency-diff check**: for every
   `package.json` in `git diff --name-only <BASE_OID>...HEAD`, the parsed
   `dependencies`/`devDependencies`/`optionalDependencies`/`peerDependencies`
   may differ from base only by ADDING keys from the exact set the ticket
   names (for this program: `@adlc/core`, `@adlc/fleet`, `@adlc/tickets`;
   `autopilot.allowedWorkspaceDeps` in config may narrow but not widen
   it) whose value is a workspace range (`*`, `workspace:*` or the
   lockstep version), and `scripts` may not change — otherwise round
   failure `third-party-dep`; a changed `package-lock.json` is compared
   canonically (both sides parsed, `packages` map): every entry present
   on both sides must have identical `resolved`, `integrity`, `version`,
   `dependencies`, `optional`, `dev`, `link` fields; entries added may
   only be `packages/<x>` (the new workspace itself) or
   `node_modules/@adlc/<x>` for an `<x>` in the allowed set above, and
   each such `node_modules/@adlc/<x>` entry must be a workspace LINK
   (`link: true`, `resolved: "packages/<x>"`); an added entry with a
   registry `resolved` URL of any scope — `@adlc/` included — is
   `lockfile-drift`; no entry may be removed; any other difference →
   `lockfile-drift`. Because the only admissible additions are workspace
   links, `npm ci --ignore-scripts --no-audit --no-fund` never fetches a
   new tarball of any kind; (iii) that command is then re-run in `ISSUE_WT` so the
   install matches the lock the gates will test. All outer gates (5a,
   preflight, final review, attestation) run in `ISSUE_WT`, never in the
   worker's worktree.
5a. **Actual-diff check** (deterministic, orchestrator-side, independent of
   fleet's rails gate and of what the worker declared): `git diff
   --name-only <BASE_OID>...HEAD` in `ISSUE_WT` must satisfy (i) every path
   matches the ticket `scope` OR is one of the pipeline-produced paths
   `.adlc/specs/<ulid>-ac.md` (exactly one, the run's own criteria
   document, byte-identical to the one the orchestrator derived — hash
   recorded in the run record) and `.adlc/tickets/<ulid>--*.json` (exactly one, the run's own ticket,
   whose content at HEAD — with `completed` removed and keys sorted —
   must hash to `ticketSnapshotSha256`, so a worker cannot widen its own
   scope, drop a rail, or alter the acceptance criteria; the only
   permitted difference is the orchestrator-owned `completed` toggle) and
   `.adlc/manifest.d/*.jsonl` (append-only vs `BASE_OID`, verified with
   `git diff <BASE_OID> -- <file>` containing no `-` lines, AND every
   appended line must be one the ORCHESTRATOR wrote this run — it keeps
   the sha256 of each entry it appends in the run record and any added
   line outside that set is a violation `foreign-manifest-line` — AND
   `adlc gate-manifest verify --dir <ISSUE_WT>/.adlc` must exit 0, which
   rejects any line not signed with the key the worker never holds; a
   diff to
   `.adlc/findings.jsonl` is a violation — neither the worker nor fleet's
   inner review may write it, and fleet's inner review runs without
   `--findings-ledger`); (ii) no path
   matches the protected-path denylist (§4.2) other than those two
   exceptions; (iii) no path is a symlink at HEAD whose target escapes the
   scope; (iv) **secret scan, fail closed**: the full text of `git diff
   <BASE_OID>...HEAD` (added lines, all files including tests, docs and
   the ticket shard) is scanned with the same pattern set
   `adversarial-review` uses for its own payload scan (`src/secrets.js`
   `SECRET_PATTERNS` — provider API keys, OAuth/bearer tokens, private-key
   blocks, `ADLC_MANIFEST_KEY`-shaped values, `.env`-style assignments of
   `*_KEY|*_TOKEN|*_SECRET`) plus the literal value of every environment
   variable in the orchestrator's key-bearing set; ANY hit → outcome
   `secret-in-diff`: the run is `blocked` immediately (no retry round —
   the same content must not be re-reviewed or re-dispatched), the
   issue comment names only the file and line and the pattern NAME,
   never the matched text, and the branch is never pushed. A violation
   of (i)–(iii) is recorded as a round failure with the offending paths
   as dead-end material (the retry protocol of §6.6 applies) and is never
   attested or pushed. The same check runs again immediately before
   step 7 and before every push in §6.8/§8/§6.9 — a diff that passed once
   is not trusted after any later write.
6. Final local gate in the issue worktree: `node scripts/preflight.mjs --base
   <BASE_OID>` (tests + rail-freeze + mutation-gate + ledger + comment
   gates, CI order). Failure consumes one round of the SAME budget (§7):
   the run record's `roundsUsed` is incremented and steps 4–6 repeat with
   `--max-strikes <15 − roundsUsed>` and `--wall-clock-minutes <remaining>`;
   if either remaining budget is 0 the run is `blocked` exactly as a fleet
   exit 2 would be.
   **Retry protocol** (identical for a preflight failure here, a
   final-review failure in §6.7a, a CI red in §6.9, and a rebase conflict
   in §8). Step 0 — **reopen if completed**: if the run has passed §6.6a
   in a previous round, the shard is `completed:true` and fleet would not
   plan it. `adlc ticket update` REPLACES the whole document (a document
   that omits `completed` removes the key, which the service also treats
   as a lifecycle change), so the orchestrator: (i) reads the current
   document and hash with `adlc ticket show <ULID> --json --dir
   <ISSUE_WT>/.adlc`; (ii) sets `completed` to `false` on that full
   document and changes nothing else; (iii) runs `adlc ticket update
   <ULID> --input - --expect <ticketHash> --authorize --write --dir
   <ISSUE_WT>/.adlc` with the document on stdin — `--authorize` is
   REQUIRED because the service classifies a completion toggle as
   `lifecycle-change` (verified against the real CLI: without it the call
   exits 2 `AUTHORIZATION_REQUIRED`); the authorized write appends a
   signed `ticket-update` audit entry (key-bearing, §9.3); (iv) re-reads
   the hash (it changes on every write) for the coldstart re-record of
   §6.3; and commits `chore(ticket): reopen <ULID> for retry round <k>`.
   This
   is legal under rails-guard-ci because the shard does not exist on the
   base ref — only tickets present on base are contract-frozen — and the
   PR's final state is always `completed:true` after the last successful
   §6.6a. Then: the issue branch already contains the previous round's
   merged work, and fleet is invoked again exactly as in step 4 — cutting a
   NEW `fleet/run-<id>` from the current tip of `adlc/autopilot/issue-<n>`
   — with the failure output (preflight log / CI job log / conflict
   markers) supplied as dead-end material for fleet's `fixPrompt`, AFTER
   **redaction**: every byte that will enter a model-bound prompt
   (`--dead-end-file`, the charter addendum, shaping and coldstart inputs,
   fleet's own captured logs handed back as dead-ends) passes through one
   redactor that replaces matches of the §6.5a(iv) pattern set and every
   key-bearing environment value with `[REDACTED:<pattern>]`, truncates to
   the fence cap, and FAILS CLOSED — if the redactor throws, times out, or
   its output still matches any pattern on a second pass, the material is
   replaced by the fixed string `[dead-end material withheld: redaction
   failed]` and the round proceeds without it (never with the raw text).
   CI job logs are fetched with `gh run view --log-failed` through the
   shared spawn wrapper with a hard 4 MiB stdout cap (the child is killed
   on overflow and the capture marked `truncated`), streamed through the
   redactor in 64 KiB chunks with pattern-boundary overlap, and only the
   redacted LAST 64 KiB is retained as dead-end material; the raw log is
   never written to disk anywhere. Each
   retry then repeats steps 5–8 in full: ff, preflight, completion,
   attestation, push. No manifest entry from a superseded round is ever
   removed (append-only); the new attestation is bound to the new revision
   and the PR body's evidence block names the latest one.
6a. (cwd `ISSUE_WT`) `adlc ticket complete <ULID> --dir <ISSUE_WT>/.adlc
   --write` (signed; orchestrator key) and commit `chore(ticket): complete
   <ULID>`. This is the last content commit of the round.
7. **Final review, then attest — on the exact tree that is pushed.** Fleet's
   inner Codex review approved the worker's diff at fleet's review SHA, but
   steps 5–6a have since added the preflight-verified tree and the
   completion commit, and the ticket shard is NOT revision-ignored, so that
   inner approve does not describe HEAD. Therefore:
   7a. (cwd `ISSUE_WT`, clean tree asserted with `git status --porcelain`
   empty) **size gate first**: `git diff <BASE_OID>...HEAD | wc -c` must be
   ≤ `autopilot.reviewMaxBytes` (default 262144, the reviewer's grounding
   limit — above it findings are silently dropped as ungrounded); an
   oversize diff is a round failure `diff-too-large` with the byte count
   and the largest paths as dead-end material, and two consecutive
   `diff-too-large` failures on one run → `blocked`. Then run the
   orchestrator's own `adversarial-review --base <BASE_OID> --provider codex
   --json --fail-on medium --max-bytes <reviewMaxBytes> --findings-ledger
   <REPO_ROOT>/.adlc/autopilot-runs/<issue>.findings.jsonl` over the whole
   issue-branch diff (the ledger path is OUTSIDE `ISSUE_WT` and gitignored
   via `.git/info/exclude`, so the reviewed tree stays clean between 7a
   and 7b; the tracked `.adlc/findings.jsonl` is never written by the
   autopilot — feeding run ledgers into P7 is a follow-up)
   (binary resolved off the orchestrator's PATH; key scrubbed;
   `--allow-summary-review` is never passed). The same `--max-bytes` is
   given to fleet's inner reviewer via `fleet.reviewMaxBytes`. Record
   `reviewedHead = git rev-parse HEAD`. A `needs-attention` verdict is a
   round failure (retry protocol §6.6, findings as dead-end material).
   7b. With HEAD still equal to `reviewedHead` and the tree still clean
   (asserted again), `adlc prosecute record-cross-model --ticket <ULID>
   --provider codex --author-provider anthropic --verdict approve --base
   <BASE_OID> --dir <ISSUE_WT>/.adlc`. The command derives the change-set
   revision from the working tree at that instant; because nothing may
   write between 7a and 7b (single-threaded orchestrator, lock held, fleet
   finished), the attested revision IS the reviewed revision.
   7c. Commit the manifest append; assert `git diff --name-only HEAD~1
   HEAD` lists only `.adlc/manifest.d/*.jsonl` paths (these are
   revision-ignored, so `revision(HEAD) == revision(reviewedHead)` by
   construction). Record `attestedHead = git rev-parse HEAD`. Any
   assertion failing in 7a–7c → state `oid-mismatch` (§6.8), nothing
   pushed.
8. **Verify, then push, then verify.** Before pushing: `git rev-parse HEAD`
   in `ISSUE_WT` must equal `attestedHead` (the HEAD recorded alongside the
   step-7 attestation in the run record), the actual-diff check (§6.5a)
   must pass again, and the working tree must be clean. Push with `git push
   --force-with-lease=refs/heads/adlc/autopilot/issue-<n>:<expectedRemoteOid>
   origin adlc/autopilot/issue-<n>` where `expectedRemoteOid` is the OID
   recorded at the previous push (or the empty-ref form for a first push);
   a lease failure means someone else pushed to the autopilot's branch →
   state `oid-mismatch`, no PR upsert, comment on the PR if one exists.
   After pushing: `git ls-remote origin refs/heads/adlc/autopilot/issue-<n>`
   must equal `attestedHead`; otherwise state `oid-mismatch`. Only after
   the post-push verification does the autopilot **upsert** the PR keyed by
   head branch (never a body sentinel), and the upsert is itself bound:
   immediately before `gh pr create`/`gh pr edit` the `ls-remote` check is
   repeated, and immediately after, `gh pr view --json headRefOid` must
   equal `attestedHead` — otherwise `oid-mismatch` (a PR that was created
   in between is left as-is and named in the comment). Branch-level write
   isolation is recommended, not assumed: pre-implementation item R12 adds
   a GitHub ruleset restricting pushes to `adlc/autopilot/**` to the
   operator identity; until it exists, "another writer on the autopilot
   branch" is detected (lease + head checks), not prevented.

   **`oid-mismatch` transition (one rule for every case):** the run is
   quarantined with the branch preserved locally and, if pushed, remotely;
   the comment goes on the PR when one exists, otherwise on the ISSUE, and
   the label `adlc:autopilot-blocked` is applied with reason
   `oid-mismatch` and the expected/observed OIDs. Recovery never resumes
   it automatically. Exit paths: (a) the operator removes the label → if
   a PR exists, **re-arm** (§2.1: full retry round with fresh review +
   attestation on the current branch tip, which the operator has
   implicitly accepted by removing the label); if no PR exists, **retire**
   (§2.1a: local branch, its remote copy if pushed and marker-owned, and
   worktree are deleted, the issue re-enters selection); (b) `reset
   --issue N --confirm-delete <OID>` → retire regardless of PR presence,
   never touching an open PR's remote branch (exit 2 if one exists).
   `gh pr create --base main --head adlc/autopilot/issue-<n> --title
   "<type>(<area>): <title> (#<n>)" --body-file <evidence.md>`; if a PR for
   that head already exists, `gh pr edit --body-file`. Body: `Closes #<n>`,
   ticket id, gate-manifest evidence summary (`adlc gate-manifest attest
   --ticket <ULID>`), review verdict + round count, quota snapshot at start.
9. CI follow-up per §0.11, with this normative check-state table applied
   to `gh pr checks <prNumber> --repo <repo> --json name,state,bucket,workflow`
   every 60 s for up to the 30-minute watch clock (paused while the quota
   gate refuses, §3.2). Normalization is ONE function over the raw rows:
   `bucket` is primary (`pass` → pass, `fail` → red, `pending` → wait,
   `skipping` → skipped, `cancel` → red, anything else → red) and `state`
   is consulted only to disambiguate `skipping` (`SKIPPED` vs `NEUTRAL`)
   and for the comment text; a row whose `bucket` is missing or not a
   string → red. Blocking jobs are matched by NAME PREFIX on the raw
   `name` (e.g. `test (18)`, `ticket-store-platform (` — the platform
   matrix names its jobs `ticket-store-platform (<os>, <node>)`), so a
   matrix expansion cannot hide a job. Contract fixtures for this
   function are captured from the real `gh` output (AC 66).

   | Job | `state` | Meaning |
   |---|---|---|
   | any BLOCKING job (name prefix in `test (18)`, `test (20)`, `test (22)`, `rails-guard`, `mutation-gate`, `cross-model-gate`, `ticket-store-platform (`) | normalized `pass` | pass |
   | any BLOCKING job | normalized `red` | **red** |
   | any BLOCKING job | normalized `wait` | wait |
   | any BLOCKING job | normalized `skipped` | red for `test (N)` (required checks must run); pass for the others (they skip by design on some events) |
   | a blocking job absent from the list | — | wait until the watch clock expires, then red (`missing: <job>`) |
   | non-blocking job (anything else, e.g. `pre-ga-gate`, canaries) | any | ignored |

   **Head binding, every poll:** before evaluating the table, `gh pr view
   --json headRefOid` must equal the run record's `attestedHead`; a
   mismatch (someone pushed to the autopilot's branch, or a re-push the
   orchestrator did not record) → state `oid-mismatch` immediately, no CI
   fix round, no `done`. `done` is reached only when all blocking jobs pass
   AND `headRefOid == attestedHead` in the same poll.

   Precedence: any **red** → a CI fix round immediately (even if other jobs
   are still pending), provided `ciRoundsUsed < 2` and quota permits. A CI
   fix round IS the retry protocol of §6.6 (fleet re-dispatch with
   `--max-strikes 2 --wall-clock-minutes 15` and the failing job's log as
   dead-end material → ff → actual-diff check → `preflight.mjs` → ticket
   completion → final review + fresh attestation (§6.7) → verify-push-verify
   (§6.8)), charged to `ciRoundsUsed` and its own fleet allowance (§7),
   never to `roundsUsed`; after the push the watch clock restarts. All
   blocking jobs pass → `done`.
   Watch clock expired with jobs still waiting → record stays `ci-watch`
   and is re-evaluated once per later iteration, at most 3 times, then
   `adlc:autopilot-ci-red` with reason `ci-incomplete`. `ciRoundsUsed == 2`
   and still red → `adlc:autopilot-ci-red` + comment naming the failing
   job(s).
10. Fleet outcome mapping — the `--json` result's `reason` is authoritative
    over the numeric exit code:

    | fleet exit | `reason` | run state | GitHub effect |
    |---|---|---|---|
    | 0 | — | `built` (continue at §6.5) | none yet |
    | 2 | `quota-paused` | `quota-paused` (resumable by re-invocation, §2.1) | none — never a label |
    | 2 | `lock-held` | unchanged (`skipped`) | none |
    | 2 | `mirror-fetch-failed` | `blocked` (reason preserved; the worker branch is left in the mirror for forensics) | findings comment + `adlc:autopilot-blocked` |
    | 2 | `wall-clock`, `strikes-exhausted`, `ticket-blocked`, `flail`, `review-unavailable` | `blocked` | findings comment (REDACTED per §6.6 — the same fail-closed redactor as dead-end material — fenced, capped 12 000 chars) + `adlc:autopilot-blocked`; branch and worktree kept for forensics; no PR |
    | 1 | any | unchanged; `lastError` set | none; the loop sleeps |
    | 2 | any `reason` outside the closed enum of §14, or missing | operational error: unchanged state, `lastError` set, NO GitHub mutation (the enum is validated before any side effect) | none |
    | other / unparseable JSON | — | treated as exit 1 | none |
11. Worktree cleanup: (cwd `REPO_ROOT` — never from inside the worktree
    being removed) `git worktree remove <ISSUE_WT>` only after the PR is
    opened (state `ci-watch`/`done`); on `blocked` the worktree is kept for
    forensics. Fleet's own `<ISSUE_WT>/.worktrees/<ticket>` and
    `<ISSUE_WT>/.worktrees/fleet-integration` are removed by fleet.

## 7. Fix-loop accounting

- "Round" = one fleet strike (dispatch → gates → Codex review) OR one
  `preflight.mjs` failure (§6.6) OR one conflict-fix dispatch (§8). There is
  ONE counter per run, `roundsUsed`, persisted in the run record before
  each round starts. Every fleet invocation for the run — first dispatch,
  `--resume` after `quota-paused`, or a repeat after preflight — receives
  `--max-strikes <15 − roundsUsed>`; fleet's `--json` result reports strikes
  consumed and the orchestrator adds them to `roundsUsed`. An invocation
  whose remaining budget is 0 is never made: the run is `blocked`.
  Fleet's `TICKET-BLOCKED` and flail-detector short-circuits still apply.
- Wall clock = 90 minutes of accumulated `wallClockUsedMs` across every
  dispatch of the run (paused time does not count); each fleet invocation
  receives `--wall-clock-minutes <remaining>`; the orchestrator also
  enforces it (kills the fleet process group, records `wall-clock`).
- The CI-fix budget (§0.11) is a separate counter `ciRoundsUsed` (max 2)
  with its OWN fleet allowance: each CI fix round invokes fleet with
  `--max-strikes 2 --wall-clock-minutes 15` drawn from `ciRoundsUsed`, NOT
  from `roundsUsed`/`wallClockUsedMs`, so a run that exhausted its build
  budget still gets its two CI rounds. The 30-minute watch clock is separate
  from both. Neither CI budget ever refills the build budget.
- Every final-review round's findings are appended to the gitignored run
  ledger `<REPO_ROOT>/.adlc/autopilot-runs/<issue>.findings.jsonl` via
  `adversarial-review --findings-ledger` (ADR-0014 format), linked from
  the digest; the tracked `.adlc/findings.jsonl` is not written by the
  autopilot (ingesting run ledgers into P7 is a follow-up ticket).

## 8. Open-PR maintenance (each iteration, before selection)

Maintenance iterates over RUN RECORDS, never over branches or PRs found on
GitHub: only records in state `pr-open` or `ci-watch` are candidates;
every other state (`clarify`, `shaped`, `dispatched`, `quota-paused`,
`built`, `attested`, `pushed`, `oid-mismatch`, `blocked`, `stale`,
`ci-red`, `done`, `orphan`) is skipped by construction, so a quarantined
run is never rebased, dispatched, attested or pushed until recovery (§2.1)
has explicitly moved it back to `pr-open`. For each candidate, the PR is read FIRST: `gh pr view <prNumber>
--repo <repo> --json headRefName,headRefOid,state,baseRefName`. Provenance
(applies to every state): the record's `token` must equal the local
ownership marker for the branch (§6.1) and `headRefName` must equal
`adlc/autopilot/issue-<n>` — otherwise `orphan`, nothing mutated. If
`state` is `MERGED` or `CLOSED`, the PR-lifecycle table below applies and
the mutation preconditions are skipped (those transitions only retire
local artifacts and never push). Only for `state == "OPEN"` must ALL of
the following **mutation preconditions** additionally hold before any
rebase/dispatch/push; a failure marks the run `orphan` (nothing mutated)
and is reported in status:

- `baseRefName == main`;
- `headRefOid` equals the record's `attestedHead` (the PR head is the tree
  the autopilot last attested and pushed) — a mismatch is `oid-mismatch`
  (§6.8), not `orphan`;
- `git ls-remote origin refs/heads/adlc/autopilot/issue-<n>` equals the
  record's last pushed OID.

Then:

- `gh pr view --json mergeStateStatus,headRefOid`. `BEHIND`/`DIRTY` →
  rebase in the issue worktree (recreated at `ISSUE_WT` if missing) onto
  this iteration's `BASE_OID` (§6.0); on success the run record's `baseOid`
  is updated to it.
  - clean → **equivalence check first**: `git diff <oldBaseOid>...<oldHead>
    | git patch-id --stable` must equal `git diff <BASE_OID>...HEAD | git
    patch-id --stable` (the rebase changed no hunk); the actual-diff check
    (§6.5a) must pass on the new base; only then `record-cross-model
    --ticket <ULID> --carry-forward <prior-revision> --base <BASE_OID>
    --dir <ISSUE_WT>/.adlc` (the tool independently recomputes and
    compares the change-set digests and refuses on inequality — a second,
    authoritative gate). Then verify-push-verify (§6.8) and re-enter
    `ci-watch` so CI re-validates the patch against the new base; no
    model call; digest "rebased". A patch-id mismatch on a "clean" rebase
    (e.g. context drift changed a hunk) → full retry round (fresh review,
    preflight, attestation) charged to `roundsUsed`.
  - conflict → one conflict-fix round (counts against the run's
    `roundsUsed`; refused as `stale` if the budget is exhausted): fleet
    `fixPrompt` with the conflict markers as the dead-end material + Codex
    review + `preflight.mjs --base <BASE_OID>` + fresh `record-cross-model
    --base <BASE_OID>` + push. Failure → `adlc:autopilot-stale` + comment.
- Counting toward the cap of 5: run records in state `pr-open`, `ci-watch`
  or `oid-mismatch` whose PR is `OPEN` (stale/ci-red are excluded; a
  quarantined open PR still counts because it still needs the operator).
- The autopilot never closes a PR. **PR lifecycle observed by maintenance
  (every candidate record, plus every record in `stale`/`ci-red`/
  `oid-mismatch` with a `prNumber`):**

  | `gh pr view` result | Transition |
  |---|---|
| `state == "MERGED"` | run → `done`; retire LOCAL artifacts (worktree, local branch, marker); the remote branch is left to GitHub's delete-on-merge setting; the record is deleted only once `ls-remote` shows the ref gone, otherwise it stays `remote-pending` (§2.1a); the issue is closed by `Closes #<n>` |
| `state == "CLOSED"` (not merged) | the operator rejected the PR: retire local artifacts under §2.1a (Step L only; the remote ref is never deleted automatically, so the record becomes `remote-pending` until the operator removes the ref); add `adlc:autopilot-skip` to the issue with a comment naming the closed PR and the exact remote-deletion command |
  | `headRefName` no longer matches, or PR not found | `orphan`; no mutation |

## 9. Preflight (fail closed, printed by `adlc-autopilot status`)

9.1 Toolchain: `adlc` (the key-bearing CLI — its pinned path is also
asserted by the key-hygiene test, AC 12), `bwrap`, `claude`, `codex`,
`adversarial-review`, `gh`, `git`, `npm`, `node >= 18` are resolved ONCE
at preflight to absolute paths from
a sanitized search list — the orchestrator's PATH entries that are
absolute, exist, and are not under `REPO_ROOT`, any `.worktrees/`, or any
`node_modules/` — and those absolute paths are pinned in the status file
and used for every spawn thereafter. Each pinned executable is
additionally checked after `realpath` resolution (symlinks followed): the
file and every ancestor directory up to `/` must be owned by the
invoking user or by root and must not be group- or world-writable; a
tool whose resolved path or any ancestor fails that check, or that
resolves under a rejected directory → exit 1 `untrusted-tool:<name>`.
The operator may narrow further with `--trusted-bin-dirs <abs,abs,…>`
(operator-local): when given, only those directories are searched. The
key-bearing `adlc` is always verified this way before the key is ever
placed in a child environment. Children receive
`PATH` = that sanitized list (the same rule fleet's `review-runner`
applies), never the raw inherited PATH. `gh auth status` ok; `claude auth
status --json` `loggedIn:true`.

9.1a Repository and principal binding: `autopilot.repo` (repo-committed,
e.g. `"voodootikigod/adlc"`) is the canonical identity. Preflight requires
`git remote get-url origin` AND `git remote get-url --push origin` to
resolve (after normalizing `git@github.com:` / `https://github.com/` /
trailing `.git`) to exactly that repo; `gh repo view <repo> --json
nameWithOwner,defaultBranchRef` must return that name and default branch
`main`; `gh api user` must return a login whose `gh api
repos/<repo>/collaborators/<login>/permission` is `admin`, `maintain` or
`write`. Any mismatch → exit 1 (`repo-mismatch` / `principal-unauthorized`)
before any issue, PR or git write. Every `gh` invocation thereafter passes
`--repo <repo>` explicitly (never relies on cwd inference). The verified
fetch and push URLs are PINNED for the iteration (stored in the status
file and copied into each run record as `remoteFetchUrl` /
`remotePushUrl`), and every network git operation — `ls-remote`, `fetch`,
`push`, including the lease-guarded deletes — is invoked with that URL
literal as the remote argument, never with the mutable name `origin`;
immediately before each such operation `git remote get-url [--push]
origin` is re-read and must still normalize to the pinned value,
otherwise the run is `orphan` (`remote-url-changed`) and nothing is
pushed.

9.2 Plugin parity: the installed `adlc@adlc` plugin version
(`~/.claude/plugins/installed_plugins.json`) equals the `version` in
`git show <BASE_OID>:plugins/adlc-claude-code/.claude-plugin/plugin.json`
— read from the pinned baseline of THIS iteration (§6.0), never from a
possibly stale local `origin/main` ref. Mismatch → refuse to dispatch (the headless worker would load
stale hooks/skills). Today: installed 1.7.0 vs repo 1.11.0.

9.3 Key: `ADLC_MANIFEST_KEY` present in the orchestrator env (systemd
`EnvironmentFile=<abs repo root>/.env.local`). Preflight — and `init
--service` — verify the key file BEFORE any key-bearing spawn and fail
closed (`key-file-insecure`, exit 1, no dispatch) unless
`<REPO_ROOT>/.env.local` is a regular file (not a symlink), owned by the
invoking uid, with mode exactly `0600`, and its parent `<REPO_ROOT>` is
not group- or world-writable; the env value itself must be non-empty. A
`systemctl --user start` therefore cannot bring the service up on a
permissive key file. Never an argument, never logged. The key is passed to exactly these children and scrubbed
from every other spawn (the **key-bearing allowlist**, asserted by AC 12):
`adlc ticket create --write`, `adlc ticket complete --write`, `adlc ticket
update --write` (reopen-for-retry only, §6.6), `adlc coldstart
--record-verdict`, `adlc spec-lint --record`, `adlc prosecute
record-cross-model`. Fleet, the shaping/coldstart `claude -p` calls, both
`adversarial-review` invocations, `gh`, `git`, `npm`, and `preflight.mjs`
never receive it.

9.3a systemd unit (generated by `adlc-autopilot init --service`): `[Service]`
carries an absolute `WorkingDirectory=<repo root>` (validated at generation
and at start: the directory must contain `.git` and `.adlc/config.json`,
else exit 1 `bad-working-directory`), an absolute `ExecStart=<abs path to
node> <abs path to packages/autopilot/bin/adlc-autopilot.mjs> loop --rest
10m`, `EnvironmentFile=<abs repo root>/.env.local`, `Restart=on-failure`,
`RestartSec=60`, `KillMode=control-group`, and `TimeoutStopSec=120` (the
loop traps SIGTERM: finishes the current git/gh step, writes the run record,
releases the lock, exits 0; an in-flight fleet run is left resumable per
§2.1). No `%h` expansion is used for paths the tests must assert
byte-for-byte.

9.4 Repo: `.adlc/config.json` exists on `origin/main` with a `fleet` block
(`gate.build`, `gate.test`, `init`, `allowedCommands`, `reviewProvider:
"codex"`, `prosecuteFailOn`, `timeoutMinutes`) and a `ticketSync` block
that validates against
`packages/ticket-sync/schemas/adlc-config.schema.json` (`provider` is
required; `query` is omitted or a string, never `null`) — §0.12. The R1
ticket's AC1 runs that schema validation.

9.5 Labels exist: `adlc:autopilot`, `adlc:autopilot-skip`,
`adlc:needs-clarification`, `adlc:autopilot-blocked`, `adlc:autopilot-stale`,
`adlc:autopilot-ci-red`, `adlc:autopilot-log` (`adlc-autopilot init
--labels` creates them idempotently).

9.6 Fleet dry-run: `adlc fleet run --dry-run --json` from the primary
checkout exits 0.

## 10. Observability

**Redaction on every outward path.** Every string the autopilot writes
outside its own process — issue/PR comments (CLARIFY, blocked, stale,
ci-red, oid-mismatch, pr-closed, findings), labels' reasons, the digest
body, the status file, run records, and the systemd journal — passes
through the single fail-closed redactor of §6.6 (secret pattern set +
every key-bearing environment value). For FREE-TEXT outputs (comments,
digest bodies, journal lines) a redaction failure replaces the entire
body with `[withheld: redaction failed — see local status]` and the
label is still applied, so a quarantine is never silent and never leaks.
For STRUCTURED documents (the status file, run records, tombstones,
attempt ledgers) only the free-text fields (`lastError`, `reason`
strings, captured excerpts, comment drafts) are redacted; identifiers and
state (`state`, `token`, OIDs, ticket ids, hashes, counters, timestamps)
are never passed through the redactor because they are validated by
grammar (§4) and cannot carry a secret; a redaction failure on a
free-text field withholds THAT field (`"<field>": null,
"redactionFailed": ["<field>"]`) and the document keeps its schema, so
recovery is never broken by redaction.

- `.adlc/autopilot-status.json` (local-only: `adlc-autopilot init` writes
  the entries `.adlc/autopilot-status.json`, `.adlc/autopilot.lock/`,
  `.adlc/autopilot-runs/` (run records, attempt ledgers, per-issue
  findings ledgers, and each run's bare git mirror under
  `.adlc/autopilot-runs/<issue>/mirror.git` — outside `ISSUE_WT`, so the
  reviewed worktree's `git status --porcelain` never sees it) and
  `.worktrees/autopilot-issue-*` to
  `<REPO_ROOT>/.git/info/exclude` ONCE, idempotently, under the lock; the
  runtime never touches `.gitignore` or any tracked file in the primary
  checkout, and refuses to start (`preflight: exclude-missing`) if those
  entries are absent): `{ state, since, lastRun:{issue, ticket, outcome,
  rounds, minutes}, quota:{fiveHour, sevenDay, scoped, checkedAt, ok,
  reason, nextResetAt}, openPrs:[...], blocked:[...], lastError }`.
- `adlc-autopilot status [--json]` renders it plus preflight.
- Digest: one comment per run on the rolling issue labeled
  `adlc:autopilot-log`: issue, ticket, outcome, PR link, rounds, minutes,
  quota before/after. Protocol: the rolling issue is located by `gh issue
  list --repo <repo> --label adlc:autopilot-log --state open --json
  number` (exactly one expected; none → create it; more than one → use
  the lowest number and report `digest-issue-ambiguous`; the located
  number is cached in the status file but re-validated as OPEN before
  every post — a closed one is replaced by a new issue, never reopened).
  Each comment starts with the sentinel `<!-- adlc-autopilot:run <runId>
  -->`; before posting, the record's `digestPosted:false` intent is
  persisted, the issue's comments are searched for the sentinel, the
  comment is posted only if absent, and `digestPosted:true` is written
  only after `gh` confirms. A failure leaves the intent for the next
  iteration; the digest is never a reason to block or re-run work.
- Every fleet run's `--json` result is stored under
  `.adlc/autopilot-runs/<runId>.json` (gitignored).

### 10.1 Human in the mobile loop

v1's human channel is GitHub itself: every escalation is a label the
operator can flip from GitHub mobile (remove `adlc:needs-clarification` /
`-blocked` / `-stale` / `-ci-red` → recovery retires and re-queues the
issue; add `adlc:autopilot` → jumps the queue; add `adlc:autopilot-skip` →
excluded), and every PR is an ordinary PR review. GitHub's own mobile
notifications on the digest issue and the PRs are the push channel.

Claude Code **Remote Control** (`claude remote-control --spawn worktree
--name adlc-autopilot`) is a companion PULL channel, not a v1 dependency:
it lets the operator open a Claude session on this machine from the mobile
app and run `/adlc:adlc-autopilot status`, inspect a blocked worktree, or
answer a CLARIFY by editing the issue — but it cannot initiate a question
to the operator, so it cannot replace the label channel. If adopted, the
hub runs as a second `systemd --user` unit, never inside the autopilot
process, and any session it spawns is subject to the same lock and
worktree rules as a human session (§11). Deferred to a follow-up ticket.

## 11. Threat model (delta over fleet §13)

- **Hostile issue body** → enters the shaping prompt fenced; scope is
  mechanically checked against the denylist; the worker's charter declares
  constraints authoritative over the spec. A body that tries to widen scope
  is a CLARIFY, not a build. **Exfiltration through the model plane** —
  a hostile issue that gets shaped and dispatched drives a worker whose
  context is sent to the model API. Controls, in order of strength:
  (1) the worker's READ scope is bounded (§6.4 `READ_SET`): it cannot read
  `<REPO_ROOT>/.env.local`, `$HOME`, the orchestrator's state, or other
  checkouts — only its worktree, a per-run git MIRROR holding nothing
  but objects reachable from the pinned public baseline and the issue
  branch (no other refs, no unreachable objects, no remote URLs,
  credential helpers or hooks; the host `.git` is never mounted), system
  libraries and its synthetic home (which necessarily holds the harness's
  own credentials, because the worker IS the harness); (2) only issues satisfying the single authorization predicate
  `eligibleAuthor` of §4.2 are ever shaped, and
  the default `autopilot.dispatchApproval: "owner-or-label"` (§13)
  dispatches without further approval ONLY issues authored by the repo
  `OWNER` (the operator's own backlog); any other author's issue needs the
  `adlc:autopilot` label from an `admin`/`maintain` actor — an explicit
  human authorization boundary before non-owner-authored content ever
  drives the worker (`"label-only"` extends that to every issue;
  `"trusted-authors"` relaxes it to `MEMBER`/`COLLABORATOR` authors and is
  opt-in); (3) the orchestrator's manifest key never enters the worker's
  environment; (4) the worker's harness credentials (its OAuth token in
  the synthetic home) are the ONE secret it must hold — the harness
  cannot authenticate without them and there is no external auth broker
  for the CLI — which is why (1) and (2) exist. **Accepted residuals:** network
  egress from the model plane is not filtered in v1 (fleet K2; a
  destination-allowlisting proxy inside the network namespace is the v2
  item, tracked in the fleet ticket's NOT-IN-SCOPE), so anything within
  `READ_SET` — the published baseline, the issue branch, and the worker's
  own harness credentials — can in principle leave through model
  traffic; the credential exposure is inherent to running the harness
  at all (the CLI has no external auth broker and a scoped
  non-exportable credential does not exist for it) and is bounded — not
  eliminated — by the authorization boundary above together with §5's
  rule that only OWNER-authored body text drives an unlabeled dispatch;
  and the diff
  secret scan of §6.5a(iv) protects only what reaches GitHub — it is NOT
  a mitigation for content exposed in model requests and is not claimed
  as one.
- **Worker forging its own review/attestation** → the reviewer binary and the
  key live only on the orchestrator; fleet scrubs `ADLC_MANIFEST_KEY` and
  resolves `adversarial-review` off the orchestrator PATH. The attestation is
  recorded by the orchestrator from the reviewer's exit status, never from
  worker output.
- **Quota exhaustion of the operator** → the gate is evaluated before every
  dispatch with the literal 50/50 rule; the reviewer runs on a different
  provider's quota.
- **Runaway loop** → atomic single-instance lock (§2.2), 90-minute wall
  clock, 15-round cap, 5-PR cap, 10-minute rest, quota re-checked before
  every Claude-consuming step (§3.2), and every label in §4.2 is a stop for
  that issue that only a human can lift (§2.1).
- **Two orchestrators / a human session on the same repo** → the lock plus
  the rule that the autopilot only ever writes inside
  `.worktrees/autopilot-issue-*`, `.adlc/autopilot-*` (gitignored) and its
  own branches; a human `adlc fleet run` is serialized by `fleet.lock`.
- **Trust-root drift** → the denylist is non-shrinkable in config; any diff
  touching a trust root is a CLARIFY at triage and a rails-guard failure in
  CI, and CI red is treated as blocking (§0.11).
- **Stale plugin** → parity check (§9.2) refuses to dispatch.

## 12. Failure policy

| Condition | Effect |
|---|---|
| quota unknown / gated | sleep 10m, status `waiting-quota`, no GitHub write |
| preflight red | exit 1 (`once`) / sleep 10m with `lastError` (`loop`); no dispatch |
| CLARIFY | comment + label, sleep 10m |
| fleet exit 2 | per the reason-keyed mapping of §6.10 (the SOLE normative rule): `quota-paused` → resumable, `lock-held` → skipped, otherwise `blocked` + redacted findings comment + `adlc:autopilot-blocked`, branch kept |
| fleet exit 1 | no GitHub write, `lastError`, sleep 10m |
| preflight.mjs red after fleet | counts as a fix round within the 90-min clock |
| CI red after 2 fix rounds | `adlc:autopilot-ci-red` + comment |
| rebase conflict unresolved | `adlc:autopilot-stale` + comment |
| `gh`/network failure mid-PR | retry 3× with backoff; then `lastError`, branch pushed state recorded so the next iteration upserts |

### 12.1 Execution deadlines (every external command)

Every child is spawned with `shell:false` and an argv array, in its own
process group, with a deadline, and with stdin CLOSED — except the
enumerated **stdin-bearing commands**, whose stdin receives exactly the
orchestrator-serialized bytes and is then ended: `adlc ticket create
--input -`, `adlc ticket update --input -`, `adlc coldstart
--record-verdict -`, and the two `claude -p` calls (shaping, §5.2, and
the coldstart answer, §6.3) — their PROMPT is the stdin payload (`claude
-p` with no positional prompt reads it from stdin), never an argv element
(argv is visible to every process on the host via `/proc`) and never a
file; both are also subject to the 5-minute deadline of §12.1. The shared spawn wrapper takes an explicit
`stdinBytes` option; every other spawn passes none and gets a closed
stream; on expiry SIGTERM is sent to the group, SIGKILL 15 s later, and
the step fails with `reason:"timeout:<command>"`. The orchestrator's own
SIGTERM handler forwards to the current child's group and exits within
`TimeoutStopSec` (§9.3a).

| Command | Deadline | Retry |
|---|---|---|
| `git ls-remote`, `git fetch <oid>`, `git push` | 120 s | 3× (5 s, 15 s, 45 s backoff) — fetch/ls-remote only; push is never retried after a lease failure |
| other `git` (worktree add/remove, rebase, diff, rev-parse) | 60 s | none |
| `gh` (any) | 60 s | 3× (5 s, 15 s, 45 s); a 4xx other than 429 is not retried |
| `npm ci --ignore-scripts` | 15 min | none → `lastError`, run stays `shaped` |
| `scripts/preflight.mjs` | 30 min | none → counts as a round failure |
| fleet | `--wall-clock-minutes` + 5 min grace | none → `blocked` (`wall-clock`) |
| `adversarial-review` (final) | 15 min | none → round failure `review-unavailable` |
| `adlc` recorders (ticket, coldstart record, spec-lint record, record-cross-model) | 60 s | none → `oid-mismatch` if after §6.7a, else round failure |
| quota HTTP / `/usage` fallback | 10 s / 60 s | 1× / none (§3.1) |
| `claude -p` shaping / coldstart | 5 min | none (§5.2) |
| CI poll (`gh pr checks`) | 60 s per poll, 30-min watch | per §6.9 |

## 13. Configuration

Repo-committed (`.adlc/config.json`, trust root):

```json
{
  "fleet": {
    "gate": { "build": "npm run build --workspaces --if-present", "test": "npm test" },
    "init": "npm ci --ignore-scripts",
    "concurrency": 1,
    "base": "main",
    "timeoutMinutes": 30,
    "prosecuteFailOn": "medium",
    "reviewProvider": "codex",
    "reviewMaxBytes": 262144,
    "allowedCommands": ["npm test", "npm run build:*", "node --test *", "node scripts/*", "adlc *"]
  },
  "autopilot": {
    "restMinutes": 10,
    "maxOpenPrs": 5,
    "maxRounds": 15,
    "wallClockMinutes": 90,
    "ciFixRounds": 2,
    "ciWatchMinutes": 30,
    "reviewMaxBytes": 262144,
    "repo": "voodootikigod/adlc",
    "dispatchApproval": "owner-or-label",
    "protectedPathsExtra": []
  },
  "ticketSync": { "provider": "github", "select": { "state": "open", "labels": [] } }
}
```

Operator-local only — the quota is the OPERATOR's, so its policy never comes
from repo-committed config (same rule as fleet's `adapter`/`model`):
`--quota-threshold` (default 50, integer 1–50 — values above 50 are
rejected with exit 1 so the operator's "more than half remaining" rule can
be tightened but never loosened), `--quota-reserve` (default 5, integer
0–49, must be `< threshold`), `--model`, `--adapter`, `--issue`,
`--force`, `--dry-run`. Precedence for every operator-local value: CLI flag
> environment variable `ADLC_AUTOPILOT_<UPPER_SNAKE>` > built-in default. A
repo config that names `quotaThreshold` or `quotaReserve` is warned and
ignored (AC 28). Repo-config keys (`restMinutes`, `maxOpenPrs`,
`maxRounds`, `wallClockMinutes`, `ciFixRounds`, `ciWatchMinutes`,
`protectedPathsExtra`) may be lowered but not raised by CLI (`--max-rounds
20` against a config of 15 exits 1).

## 14. Required changes outside `packages/autopilot`

None is trust-root tier; each is a small, separately testable diff.

- `@adlc/fleet`: CLI flags `--model-plane-read host|bounded` and
  `--model-plane-read-only <abs,abs,…>` (operator-local; `bounded`
  selects the sandbox module's existing `READ_POLICY.BOUNDED` for the
  MODEL plane — worktree + synthetic home + the allowlist — instead of the
  current `READ_POLICY.HOST`; the adapter's `homeState` still provides
  the harness's own config/credentials inside the synthetic home; default
  unchanged = `host`), `--model-plane-git mirror` (item 12 of the fleet ticket: the worker's
  worktree is cut from a caller-supplied bare mirror holding only the
  pinned baseline and the issue branch, and the worker branch is fetched
  back into the caller's repository before gates/merge; real-bwrap
  containment test proves the worker cannot enumerate any other ref or
  reach the host `.git`), `--no-pr`,
  `--no-complete` (skip
  `completeTicketOnIntegration`; the caller owns completion),
  `--dead-end-file <path>` (initial dead-end material for strike 1, so a
  retry can hand fleet the previous round's failure), `--max-strikes N`,
  `--wall-clock-minutes M`, `--charter-file <path>`, `--pre-strike-argv
  <json-array>` (operator-local; a JSON array of strings executed with
  `execFile`-style argv and NO shell, with a caller-supplied minimal env
  (`--pre-strike-env <json-object>`; fleet passes exactly those variables
  plus nothing — not its own env, not the worker's), the executable
  resolved from `argv[0]` as an absolute path only, before every strike; non-zero → stop with
  `reason:"quota-paused"`, exit 2, run left resumable through fleet's
  EXISTING status reconciliation on the next identical invocation — there
  is no `--resume` flag and none is added; `reconcileRun`'s "resuming run
  <id>" / "cannot resume" contract is what the orchestrator keys on);
  `advanceTicket` takes
  `maxStrikes` from config; `run` accepts an external wall-clock deadline;
  charter addendum appended after the Constraints block; config key
  `fleet.reviewMaxBytes` forwarded as `--max-bytes` to the inner reviewer;
  `--json` result includes the review's `{provider, verdict, revision,
  rounds}`, the `fleetRunId`, and a machine-readable `reason` from the
  fixed set in §6.10 — `quota-paused`, `lock-held`, `wall-clock`,
  `strikes-exhausted`, `ticket-blocked`, `flail`, `review-unavailable`,
  `mirror-fetch-failed` — for every non-zero exit.
  Also verify (and test) that `fleet run` invoked with cwd = a git worktree
  reads that worktree's `.adlc/tickets/` and cuts nested worktrees correctly.
- `plugins/adlc-claude-code/commands/adlc-autopilot.md`: thin command that
  runs `adlc autopilot status|once --dry-run|select` and explains
  `systemctl --user {start,stop,status} adlc-autopilot`.
- This spec itself is NOT in the build ticket's scope: the run
  record stores `specBlob = git rev-parse <BASE_OID>:docs/specs/issue-autopilot-local.md`
  and the actual-diff check (§6.5a) rejects any change to that path; spec
  changes go through their own reviewed PR. Before dispatching the build
  ticket, preflight reads the newest `spec-approval` entry bound to the
  ticket from the manifest and requires its recorded `spec_hash` to
  equal the sha256 of the blob at `specBlob` AND `adlc run p1 --ticket
  <build ticket> --json` to exit 0 (spec-lint + premortem + spec-approval
  all present, ordered and bound) AND a **human-identity binding** the
  manifest alone cannot forge: the commit that introduced `specBlob` on
  `main` is resolved to its pull request (`gh api
  repos/<repo>/commits/<sha>/pulls`), that PR must be `merged` with a
  `merged_by.login` whose repository permission is `admin` or `maintain`
  (GitHub's own authenticated identity, checked live), and the
  `spec-approval` record's `approver` must name that same login or the
  e-mail GitHub reports for it; any mismatch → exit 1
  `spec-approval-unbound`. Otherwise → exit 1 `spec-approval-stale`, no
  dispatch. The record's `spec_hash` states WHAT was gated; GitHub's
  merge identity states WHO — the manifest is data the preflight checks,
  never a claim it trusts.
- Registry/docs: `packages/cli/lib/registry.mjs`,
  `apps/docs/lib/toolkit-packages.mjs`,
  `apps/docs/content/docs/toolkit/autopilot.mdx` + `meta.json`,
  `docs/package-reference.md`, README toolkit table.
- `docs/systemd/adlc-autopilot.service` template (installed by
  `adlc-autopilot init --service`, which prints the unit and the
  `systemctl --user enable --now` line; it never writes outside the repo
  unless `--write` is passed).
- Issue #237: comment recording the substrate change and linking this spec;
  ADR `docs/adr/0016-issue-autopilot-local-substrate.md`.

## 15. Pre-implementation resolutions (must be green before P4)

| # | Item | Owner | Status |
|---|---|---|---|
| R1 | Land `.adlc/config.json` (§13) via the admin trust-root commit — tracked as prerequisite ticket `T-01M0ZHZA1E2JHS0KZPA8J7HPBJ` (see the ticket DAG: edge → build ticket), whose ACs include R4 | operator | ticketed |
| R2 | Update the installed `adlc` plugin from 1.7.0 to 1.11.0 (`/plugin` marketplace update). Machine-local, so not a ticket: it is enforced deterministically by preflight §9.2, which refuses to dispatch on mismatch | operator | preflight-gated |
| R3 | Fleet extensions (§14) built and tested first, as their own ticket/PR | build | open |
| R4 | Fleet has never run live in this repo: `fleet run --dry-run --json` exit 0 is an AC of the R1 ticket; the live canary on a docs issue is build-ticket AC10 | operator | ticketed |
| R5 | Weekly window is at 70% used at authoring time; the first autonomous run cannot start until it resets (today 09:59 ET) | — | informational |
| R6 | Verify `claude -p` subagent fan-out (`/adlc:adlc-prosecute`) works under `bwrap` + `acceptEdits`; if not, the charter degrades to `adlc hollow-test`/`behavior-diff` only and the outer Codex loop remains the P5 | build canary | open |
| R7 | Verify OAuth token refresh and `gh` auth work under `systemd --user` (no TTY, no keyring) | operator | open |
| R8 | Create labels + the rolling digest issue (`adlc-autopilot init --labels`) | build | open |
| R9 | Mint the ULID ticket for this spec (T55 is taken); record spec-lint + coldstart against it — DONE 2026-08-26 (`T-01M0Z3FN7SAS4HAH7CS63YQ0DH`, manifest segment `spec-autopilot-local-01M0Z3K7…`). The code-level Codex approve (§0.13) is a build-PR merge prerequisite, not a spec step | this session | done |
| R10 | Confirm rails-guard-ci accepts a PR that ADDS a ticket shard which is `completed:true` on arrival (fleet completes on the integration branch) — otherwise the completion commit moves to a post-merge step | build canary | open |
| R11 | Keep PR diffs under adversarial-review's 256 KB grounding limit: deterministic size gate before every review (§6.7a), `--max-bytes` from `reviewMaxBytes` on both reviewers, fleet gains a `reviewMaxBytes` config key (§14) | build | open |
| R12 | GitHub ruleset restricting pushes to `refs/heads/adlc/autopilot/**` to the operator identity (branch-level write isolation; §6.8 detects intrusion without it but cannot prevent it) | operator | recommended |

## 16. Acceptance criteria

1. **Offline unit tests green**: `node --test packages/autopilot/test/` exits 0
   with injected `gh`, `claude`, fleet and quota fakes; no network, no
   subprocess outside the fakes (verify: the test harness asserts the spawn
   recorder saw only whitelisted argv). **Coverage is not a name match:**
   `packages/autopilot/test/ac-registry.mjs` exports an explicit map from
   every criterion number in this section to one or more exported test
   functions; `spec-coverage.test.mjs` parses this section at the pinned
   blob, fails on any number missing from the registry or any registered
   function that is not defined, and statically checks that each
   registered test imports at least one module from `packages/autopilot/lib/`
   and contains at least one `assert` call whose argument references
   that import (a test with no production seam is rejected); in addition
   `node scripts/mutation-gate.mjs origin/<base> --max 12` must pass on
   the package (CI already runs it) and, for the security- and
   lifecycle-critical criteria (quota, authorization, redaction,
   retirement, attestation), `adlc hollow-test --test-cmd "node --test
   packages/autopilot/test/"` must report no hollow test — verify: all
   three commands exit code 0.
2. **Quota gate matrix** (`packages/autopilot/test/quota.test.mjs`): 5h 49 /
   7d 49 → ok; 5h 50 → refused; 7d 50 → refused; scoped worker-model window
   50 → refused; endpoint 401 + `/usage` fallback parse → ok/refused per
   text; both sources failing → refused with `reason:"quota-unknown"`.
   Assert the endpoint fake is called with exactly the two headers and that
   the token value never appears in any log line.
3. **Selection** (`select.test.mjs`): every §4.2 exclusion rule has a fixture
   that is excluded with that rule name in `--json`; the scoring table
   produces the documented order on a 12-issue fixture; `adlc:autopilot`
   outranks `P0-critical`; the denylist cannot be shrunk by config (assert a
   config that omits `.adlc/**` still excludes it).
4. **Triage** (`triage.test.mjs`): schema fail, wildcard scope, protected
   path, spec-lint WISH → CLARIFY with findings verbatim and the fix
   template, with zero coldstart calls; a coldstart gap in §6.3 → CLARIFY
   plus retirement of the fresh worktree/branch, with exactly one
   coldstart-answer `claude` call per ticket hash in a full sequence; all-pass → PROCEED with a ticket whose body's first line
   is `GitHub issue: <url>`; second unchanged run → zero mutating `gh` calls
   (recording fake asserts); a `gh` fake that fails AFTER the comment and
   BEFORE the label → the record shows `commentPosted:true,
   labelApplied:false`, and the next iteration adds only the label (one
   `--add-label` call, zero comment calls); a label already present on
   GitHub but absent from the record → zero `--add-label` calls.
5. **Dispatch** (`run.test.mjs`): captured argv asserts exactly one ticket id,
   `--no-pr`, `--max-strikes 15`, `--wall-clock-minutes 90`, `--model opus`,
   and cwd = the issue worktree; fleet outcomes are asserted
   table-driven over the §6.10 mapping: exit 2 + `quota-paused` → state
   `quota-paused`, zero `gh` calls; exit 2 + `lock-held` → unchanged,
   zero `gh` calls; exit 2 + each blocking reason → label + redacted
   comment, no `pr create`; exit 2 + an unknown reason → no state change
   and zero `gh` calls; exit 1 → no `gh` write; exit 0 → ff, actual-diff
   check, preflight, completion, final review, attest, push, PR upsert
   in that order (spawn recorder asserts ordering).
6. **PR upsert** (`pr.test.mjs`): a second successful run for the same issue
   performs `gh pr edit`, never a second `gh pr create`; body contains
   `Closes #<n>`, the ticket id, and the evidence block.
7. **Rebase** (`maintain.test.mjs`): BEHIND + clean → `--carry-forward` argv
   + `--force-with-lease` push, zero worker dispatches; DIRTY → exactly one
   conflict-fix dispatch, then fresh `record-cross-model` (no
   `--carry-forward`); failure → `adlc:autopilot-stale`; stale PRs are not
   counted toward the cap (assert cap 5 with 5 stale + 0 active → dispatch
   proceeds).
8. **CI follow-up** (`ci.test.mjs`): one fixture per row of the §6.9 table
   asserts pass/red/wait/ignored; `rails-guard` = `FAILURE` → fix round;
   `test (20)` = `SKIPPED` → red; `pre-ga-gate` = `FAILURE` → ignored; a
   red with other jobs pending → fix round without waiting; third red →
   `adlc:autopilot-ci-red` + comment naming the job; assert `ciRoundsUsed`
   and the watch clock are independent of `roundsUsed` and the 90-minute
   build clock (a run with `roundsUsed == 15` still gets 2 CI rounds).
9. **Wall clock**: a fleet fake that never returns is killed at 90 minutes
   (fake timers), outcome `wall-clock`, label applied (`run.test.mjs`).
10. **Dry-run honesty**: `adlc-autopilot once --dry-run --issue N` exits 0,
    prints the full plan, and the spawn recorder shows only argv from the
    read-only set of §2 (assert: no `git fetch`, `git worktree`, `git
    config`, `git push`, `mkdir` of the lock, `.git/info/exclude` write,
    `gh` mutation, or `--write`/`--record` flag), the filesystem fixture
    is byte-identical before and after, and no manifest line was
    appended.
11. **Preflight**: each §9 item has a red fixture that makes `once` exit 1
    with the item named; plugin-parity mismatch (1.7.0 vs 1.11.0 fixture) is
    one of them, and so are a `.env.local` that is a symlink, mode `0640`,
    owned by another uid (injected `stat`), or an empty
    `ADLC_MANIFEST_KEY` — each → `key-file-insecure` with zero key-bearing
    spawns (`preflight.test.mjs`).
12. **Key hygiene** (`keys.test.mjs`): the spawn recorder asserts
    `ADLC_MANIFEST_KEY` is present in the env of exactly the six
    key-bearing commands of §9.3 (`ticket create --write`, `ticket complete
    --write`, `ticket update --write`, `coldstart --record-verdict`,
    `spec-lint --record`, `record-cross-model`) and absent from every other
    spawn in a full
    `once` sequence (fleet, shaping, coldstart answer, both
    `adversarial-review` calls, `gh`, `git`, `npm`, `preflight.mjs`); the
    assertion is table-driven over the complete recorded spawn list so a
    new spawn added later fails the test until classified; every
    key-bearing spawn's argv[0] equals the `adlc` path pinned at preflight
    (§9.1).
13. **systemd unit**: `init --service` output parses as a unit file, contains
    `EnvironmentFile=`, `Restart=on-failure`, and no inline key; test asserts
    with a line-anchored regex.
14. **Registry guards**: root `npm test` green including
    `apps/docs/test/toolkit-packages.test.mjs` (bijective) and
    `toolkit-usage-dispatcher.test.mjs` for the new `autopilot` slug.
15. **Dependency discipline** (`packages/autopilot/test/deps.test.mjs`):
    asserts every key of `packages/autopilot/package.json` `dependencies`
    starts with `@adlc/` and `devDependencies` is absent or empty; verify:
    `node --test packages/autopilot/test/deps.test.mjs` exit code 0.
16. **Gate record + code-level cross-model approve**: this file passes
    `adlc spec-lint` (exit code 0) and the manifest segment bound to the
    build ticket holds the `spec-lint` and `coldstart` records (verify:
    `adlc gate-manifest show --ticket T-01M0Z3FN7SAS4HAH7CS63YQ0DH`
    lists both). Before the build PR merges, a diff-mode
    `adversarial-review --base <BASE_OID> --provider codex` over the
    build branch ends at `verdict:"approve"` (exit code 0) and is recorded
    via `adlc prosecute record-cross-model --ticket
    T-01M0Z3FN7SAS4HAH7CS63YQ0DH --provider codex --author-provider
    anthropic --verdict approve`; verify: `adlc prosecute tier-check`
    exit code 0 on that PR.
17. **Live canary** (manual, recorded in the PR body): `adlc-autopilot once
    --issue <docs issue>` produces one PR whose CI is green and whose
    manifest carries coldstart, spec-lint, cross-model-review entries bound
    to the ULID; verify: `adlc run p5 --ticket <ULID>` exits 0 in that
    worktree.
18. **Quota re-check points** (`quota.test.mjs`): a quota fake that flips to
    refused after the shaping call asserts zero fleet dispatches and a run
    record in state `shaped`; a fake that flips during a maintenance round
    asserts that PR is skipped without a label; the fleet argv assertion in
    AC 5 also asserts `--pre-strike-argv`; a 61-second-old quota result is
    never reused (fake timers).
19. **Pinned issue honors exclusions** (`select.test.mjs`): for EVERY §4.2
    rule, `once --issue N` on an excluded fixture exits 2 naming the rule;
    `--force` lifts only the five autopilot-owned labels (table-driven
    assert over the full label list), and never the protected-path,
    `trust-root-change`, milestone, or open-PR rules.
20. **Pinned baseline** (`run.test.mjs`): fetch-fake failure → exit 1 and
    zero worktree/dispatch calls; on success the recorded `baseOid` appears
    verbatim in the `git worktree add`, fleet `--base`, `preflight.mjs
    --base`, and `record-cross-model --base` argv even when the fake moves
    `origin/main` between steps.
21. **Recovery state machine** (`recover.test.mjs`): one fixture per row of
    the §2.1 table asserts the named action and the resulting state; a
    retire whose `ls-remote` still shows the ref → state `remote-pending`,
    record kept, issue excluded with `remote-ref-pending`; a later
    iteration with an empty `ls-remote` deletes the record and the issue
    is selectable; the
    "human removed the label" row asserts worktree removal + branch delete +
    record deletion and that the issue is then selectable; the "open PR has
    that head" guard asserts the branch is NOT deleted; `orphan` is excluded
    from selection until `reset --issue N`.
22. **Lock** (`lock.test.mjs`): two concurrent starters against the same
    dir → exactly one acquires (the other exits 1 `lock-held`); a lock with
    a dead pid and a 11-minute-old heartbeat is reclaimed; a lock with a
    live pid and stale heartbeat is NOT reclaimed; a lock with a reused pid
    but different start time is reclaimed; release with the wrong token is
    refused.
23. **Fallback grammar** (`quota.test.mjs`): fixtures for the current
    `/usage` text, a text with the scoped line absent, a text missing the
    weekly line, a value of 101, and a text without the word `subscription`
    map to ok / ok(no scoped) / quota-unknown / quota-unknown /
    quota-unknown respectively.
24. **Path resolution** (`paths.test.mjs`): with a fake `REPO_ROOT`, the
    spawn recorder asserts `git worktree add` runs with cwd = `REPO_ROOT`
    and an absolute `ISSUE_WT` target; every later spawn has cwd =
    `ISSUE_WT` and every `--dir` is `<ISSUE_WT>/.adlc`; invoking `once` from
    inside a linked worktree exits 1 `not-main-worktree`.
25. **Round budget is global** (`run.test.mjs`): preflight-fail → the next
    fleet argv carries `--max-strikes 14`; a resumed run after
    `quota-paused` carries `--max-strikes <15 − roundsUsed>`; `roundsUsed
    == 15` → no fleet spawn and state `blocked`; a conflict-fix round
    increments the same counter.
26. **Shaping trust** (`triage.test.mjs`): an `adlc:begin` block on an issue
    that fails `eligibleAuthor` is never reached (the issue is
    `not-authorized` at selection); with an `"OWNER"` author under the
    default the shaping fake is NOT called but every §5.3 gate still runs
    (a block with a protected-path scope → CLARIFY).
27. **Quota overshoot bookkeeping** (`quota.test.mjs`): a step whose
    post-reconciliation reading is ≥ threshold records `overshoot: true`
    and the next start is refused; the reserve makes a strike refused at
    46% when the threshold is 50 and the reserve 5.
28. **Operator-local precedence** (`config.test.mjs`): a repo config with
    `quotaThreshold: 80` is warned and ignored (gate uses 50); env
    `ADLC_AUTOPILOT_QUOTA_THRESHOLD=40` + `--quota-threshold 30` → 30;
    `--quota-reserve 50` with threshold 50 exits 1; `--max-rounds 20`
    against config 15 exits 1 and `--max-rounds 10` is honored.
29. **Ownership-checked deletion** (`recover.test.mjs`, against a REAL
    temporary git repository, not argv fakes): a branch created by the
    autopilot (marker + record + descends from `baseOid`) is deleted on
    retire; the same branch with the marker removed, with a mismatched
    token, with an open-PR fake for its head, or whose history no longer
    contains `baseOid` is NOT deleted and is reported `orphan`;
    `reset --issue N` without `--confirm-delete <OID>` or with the wrong
    OID deletes nothing and exits 2.
30. **Executable command sequence** (`sequence.test.mjs`, real temporary
    git repository with a fake `origin`, fake `adlc`/fleet/`gh`/`claude`
    on PATH that record argv and create the files the real tools would):
    a full `once --issue N` run produces the worktree at `ISSUE_WT`, the
    ticket shard under `<ISSUE_WT>/.adlc/tickets/`, the ownership marker in
    the repo's local config, a branch whose merge-base with `origin/main`
    is `baseOid`, and a pushed head equal to the OID passed to the
    `record-cross-model` fake; a preflight-fake failure on the first pass
    yields a second fleet invocation carrying `--dead-end-file` and
    `--max-strikes 14`, with `adlc ticket complete` invoked exactly once,
    after the last successful preflight.
31. **Pinned baseline by OID** (`run.test.mjs`): the fetch fake asserts
    `git fetch --no-tags origin <40-hex>` (never `main`, never
    `FETCH_HEAD`); an `ls-remote` fake returning a different OID on a second
    call does not change the run's recorded `baseOid`.
32. **Trusted block assembly** (`triage.test.mjs`): an OWNER issue whose
    body has a block and an `## Acceptance criteria` list → ticket fields as
    §5.1 with zero shaping calls; the same issue without the criteria
    section → one shaping call whose recorded output leaves the block
    fields byte-identical.
33. **One authorization predicate** (`select.test.mjs`, table-driven
    over mode × authorAssociation × label-actor permission): under the
    default an `OWNER` author is eligible with no label; `MEMBER` and
    `COLLABORATOR` authors are `not-authorized` until an `admin`/`maintain`
    actor labels them; a `write`-actor label never authorizes; under
    `label-only` even `OWNER` needs the label; under `trusted-authors`
    `MEMBER`/`COLLABORATOR` are eligible unlabeled; the same table drives
    triage's trusted-block acceptance and revalidation (the shaping fake
    and fleet fake are never invoked for a `not-authorized` issue).
34. **Actual-diff check** (`diffcheck.test.mjs`, real temporary git
    repository): a worker fake that edits `scripts/rails-guard-ci.mjs`
    despite a `packages/foo/**` scope → round failure naming that path, no
    attestation, no push; a diff that removes a line from a
    `.adlc/manifest.d/*.jsonl` segment → failure; a diff limited to scope +
    exactly one new ticket shard + appended manifest lines → pass; a
    symlink inside scope pointing outside it → failure.
35. **Shaping bounds** (`triage.test.mjs`): a shaping fake that never
    exits is killed at 5 minutes (fake timers) with the whole process
    group signalled, no run record and no GitHub write; a 65 KiB response
    is rejected as malformed; the fourth failed shaping attempt within
    24 h excludes the issue with rule `shaping-failed`; the quota HTTP
    fake that stalls is abandoned at 10 s and the `/usage` fallback is
    consulted.
36. **Verify-then-push** (`run.test.mjs` + `sequence.test.mjs`): the
    `git push` argv carries `--force-with-lease=refs/heads/…:<OID>` with
    the previously recorded remote OID; a HEAD ≠ `attestedHead` before
    push → no push, state `oid-mismatch`; a lease failure → no PR upsert,
    state `oid-mismatch`; a post-push `ls-remote` mismatch → no PR upsert;
    recovery never auto-resumes an `oid-mismatch` run.
37. **Threshold ceiling** (`config.test.mjs`): `--quota-threshold 51`
    exits 1; `ADLC_AUTOPILOT_QUOTA_THRESHOLD=60` exits 1; `50` and `20`
    are accepted.
38. **Reviewed = attested = pushed** (`run.test.mjs` +
    `sequence.test.mjs`): the final `adversarial-review` fake is invoked
    with `--base <baseOid>` in `ISSUE_WT` AFTER the completion commit; the
    `record-cross-model` fake runs while `git rev-parse HEAD ==
    reviewedHead` and the tree is clean; the manifest commit's diff names
    only `.adlc/manifest.d/*.jsonl`; a fake that writes a source file
    between 7a and 7b → state `oid-mismatch`, no push; the pushed OID
    equals `attestedHead`. A `needs-attention` from the final review →
    retry round with the findings as `--dead-end-file` content.
39. **Coldstart is gated** (`quota.test.mjs`): a quota fake that refuses
    between shaping and coldstart → zero coldstart `claude` calls, ticket
    cached (`state: shaped`); the coldstart fake that stalls is killed at
    5 minutes with no run record change.
40. **CI budget is independent of build budget** (`ci.test.mjs`): with
    `roundsUsed == 15` and `wallClockUsedMs == 90 min`, a CI red still
    produces a fleet argv with `--max-strikes 2 --wall-clock-minutes 15`;
    the third CI red produces no fleet call and the `adlc:autopilot-ci-red`
    label.
41. **Fleet outcome mapping** (`run.test.mjs`): one fixture per row of the
    §6.10 table; in particular exit 2 + `reason:"quota-paused"` → state
    `quota-paused`, zero label calls, and a later iteration with quota ok
    re-invokes fleet with an argv identical to the first dispatch (no
    `--resume` token anywhere), asserts the `fleetRunId` fleet reports
    equals the record's, and a fleet fake that prints `cannot resume`
    (exit 1) → `blocked` with reason `resume-refused`; exit 2 +
    `reason:"lock-held"`
    → no state change; unparseable JSON → treated as exit 1.
42. **Remote-pending is resettable** (`recover.test.mjs`, real temporary
    git repository with a bare `origin`): CLOSED → `remote-pending`, then
    `reset --issue N --confirm-delete <tip> --delete-remote` deletes the
    remote ref with the lease form using the preserved `lastPushedOid`,
    the record is then deleted and the issue is selectable; the same for
    MERGED → `remote-pending` and for `blocked` with a pushed branch; a
    record without `lastPushedOid` refuses `--delete-remote` (exit 2).
43. **Re-arm vs retire** (`recover.test.mjs`): removing
    `adlc:autopilot-stale` from a run with an open PR → counters reset,
    state `pr-open`, branch and PR untouched, issue NOT selectable, and
    the next maintenance pass performs a retry round; removing
    `adlc:autopilot-blocked` from a run with no PR → retire per §2.1a and
    the issue becomes selectable; an `oid-mismatch` run is skipped by
    maintenance until its label is removed.
44. **Diff size gate** (`run.test.mjs`): a branch whose diff is
    `reviewMaxBytes + 1` bytes → round failure `diff-too-large`, zero
    `adversarial-review` calls; two consecutive → `blocked`; both
    reviewer argvs carry `--max-bytes 262144` and never
    `--allow-summary-review`.
45. **Orphan reset authorization** (`recover.test.mjs`, real temporary
    git repository): `reset --issue N --confirm-delete <tip>` deletes a
    marker-bearing recordless branch; the same command refuses (exit 2,
    nothing deleted) when the marker is absent, when the OID is not the
    tip, or when an open-PR fake has that head.
46. **Reopen for retry** (`sequence.test.mjs` + `reopen-cli.test.mjs`):
    a final-review-fake `needs-attention` after the completion commit →
    one `adlc ticket update <ULID> --input - --expect <hash> --authorize
    --write --dir <ISSUE_WT>/.adlc` call whose stdin is the FULL document
    from the preceding `show` with only `completed` changed to `false`,
    then a commit `chore(ticket): reopen …` BEFORE the second fleet
    invocation; the PR's final shard is `completed:true`; a CI-red retry
    and a rebase-conflict retry exercise the same path; the reopen call
    is in the key-bearing set of AC 12. `reopen-cli.test.mjs` runs the
    REAL `adlc ticket` binary against a temporary sharded store
    (`.adlc/tickets/.store.json`): create → complete → reopen as above
    asserts exit 0 and `completed:false`, and the same update without
    `--authorize` asserts exit 2 with code `AUTHORIZATION_REQUIRED`.
47. **Effective model binding + strict schema** (`quota.test.mjs`):
    `--model sonnet` makes the gate read the `Sonnet` scoped entry and
    passes `--model sonnet` to fleet; `--model gpt-5` → preflight
    `model-unknown`; `--adapter codex` → `adapter-unsupported`; endpoint
    fixtures with HTTP 500, a non-object body, `five_hour: null`,
    `utilization: "70"`, `utilization: 101`, `limits: {}`, a matching
    scoped entry lacking `percent`, and — for a NON-matching entry —
    `scope: null`, `scope: "opus"`, `scope: []`, `scope: {}`, `scope:
    {model: {}}` and `scope: {model: {display_name: ""}}` all yield
    `quota-unknown` (no entry is skipped as irrelevant); the canonical
    no-scoped-limit predicate is `noScopedLimit(body, family) :=
    (body["seven_day_" + family] === null || !(("seven_day_" + family) in
    body)) && !body.limits?.some(e => familyOf(e?.scope?.model?.display_name)
    === family)` — a fixture with `seven_day_opus: null` and a `limits`
    array with no Opus entry yields "no scoped limit"; the same body with
    an Opus entry present but malformed yields `quota-unknown`; a body
    where `seven_day_opus` is an object but `limits` has no Opus entry
    uses the object's `utilization` (both shapes are read; disagreement
    between them → `quota-unknown`).
48. **Carry-forward equivalence** (`maintain.test.mjs`, real temporary git
    repository): a clean rebase whose patch-id is unchanged → one
    `--carry-forward` call and re-entry to `ci-watch`; a clean rebase
    whose patch-id changed (fixture: context drift in the same hunk) →
    zero `--carry-forward` calls and a full retry round.
49. **Deadlines** (`deadline.test.mjs`, fake timers + a child fake that
    ignores SIGTERM): every row of §12.1 has a fixture; expiry sends
    SIGTERM to the process group, SIGKILL after 15 s, and the step fails
    with `timeout:<command>`; SIGTERM to the orchestrator during a stalled
    `npm ci` releases the lock and exits within 120 s; `.gitignore` in the
    primary checkout is byte-identical before and after a full `once`
    sequence, while `.git/info/exclude` carries the four entries after
    `init`.
50. **Effective model propagates** (`quota.test.mjs` + `run.test.mjs`):
    with `--model sonnet`, the shaping `claude` argv, the coldstart-answer
    `claude` argv and the fleet argv all carry `--model sonnet`, and the
    gate reads the `Sonnet` scoped window; with no override all three
    carry `--model opus`.
51. **Head binding during CI** (`ci.test.mjs`): a `headRefOid` that differs
    from `attestedHead` on any poll → `oid-mismatch`, zero fix rounds, and
    `done` is never reached even with all jobs green; equal head + all
    green → `done`.
52. **Outer-gate integrity** (`sequence.test.mjs`, real temporary git
    repository): a worker fake that adds `"left-pad"` to a
    `packages/foo/package.json` → `third-party-dep` round failure before
    preflight; one that adds `"@adlc/core"` → passes the check; one that
    changes `scripts.test` → failure; an unexpected ignored file planted in
    `ISSUE_WT` → `ignored-file-drift`; `npm ci --ignore-scripts` is
    observed in `ISSUE_WT` after every ff.
53. **Repo/principal binding** (`preflight.test.mjs`): an `origin` URL for
    a different repo (each of the three URL forms) → `repo-mismatch`; a
    push URL differing from the fetch URL → `repo-mismatch`; a principal
    with `read` permission → `principal-unauthorized`; every recorded `gh`
    argv in a full `once` sequence carries `--repo voodootikigod/adlc`.
54. **Paginated enumeration** (`select.test.mjs`): a `gh api` fake serving
    1,250 issues across 13 pages yields 1,250 candidates with PR entries
    dropped; a fake whose third page fails → `candidate-set-truncated`,
    zero selections, status `pagesReached: 2`.
55. **Ticket snapshot** (`diffcheck.test.mjs`): a worker fake that adds a
    glob to the shard's `scope`, removes a rail, or edits the body → round
    failure naming the shard; a shard differing only by
    `completed: true|false` → pass; the recorded `ticketSnapshotSha256`
    equals sha256 of the canonicalized shard written at §6.2.
56. **Lockfile canonical comparison** (`sequence.test.mjs`): a
    `package-lock.json` change that adds `node_modules/left-pad`, changes
    an existing entry's `resolved` or `integrity`, or removes an entry →
    `lockfile-drift`; one that adds a `packages/autopilot` workspace link
    and `node_modules/@adlc/autopilot` with `link: true` → pass; `npm ci`
    argv carries `--ignore-scripts --no-audit --no-fund`.
57. **Upsert head binding** (`pr.test.mjs`): an `ls-remote` fake that
    changes between the post-push check and the upsert → zero `gh pr`
    mutating calls and `oid-mismatch`; a `gh pr view` fake returning a
    different `headRefOid` right after `gh pr create` → `oid-mismatch`
    with the PR number named in the comment.
58. **`oid-mismatch` without a PR** (`recover.test.mjs`): a pre-push
    mismatch → comment on the ISSUE + `adlc:autopilot-blocked`, branch
    kept; label removed → retire per §2.1a Step L only (zero `git push`
    argv of any kind; a pushed run becomes `remote-pending` and its ref is
    listed under `remoteRefsLeft`); a pushed-but-no-PR mismatch → same
    path; a mismatch with an open PR → label removed → re-arm (branch and
    PR untouched, full retry round).
59. **Durable attempt ledger** (`triage.test.mjs`): the ledger file is
    written with `outcome:"started"` before the shaping fake is spawned; a
    simulated crash (process exit) between write and spawn leaves an entry
    that a fresh process counts; the third such entry within 24 h yields
    `shaping-failed`; 8-day-old entries are ignored.
60. **Pre-strike helper receives resolved values** (`run.test.mjs`): the
    fleet argv's `--pre-strike-argv` JSON array has the pinned absolute
    `adlc` path (§9.1) as element 0 — never the bare name — and contains
    the elements `--model <effectiveModel> --quota-threshold <T>
    --quota-reserve <R> --iteration <id> --start-ordinal auto` for a
    non-default `--model sonnet --quota-threshold 40 --quota-reserve 10`;
    every fleet invocation that carries `--pre-strike-argv` also carries
    `--pre-strike-env` with exactly the four documented keys.
61. **Maintenance ownership + selector** (`maintain.test.mjs`): records
    in every non-candidate state (table-driven over the full enum,
    including `oid-mismatch` with an OPEN PR and `blocked`) produce zero
    git/gh mutating calls; a `pr-open` record whose token mismatches the
    marker, whose PR head name differs, whose PR base is not `main`, or
    whose `ls-remote` differs from the last pushed OID → `orphan`, zero
    mutations; `headRefOid != attestedHead` → `oid-mismatch`; all
    preconditions met → the rebase path runs.
62. **PR lifecycle** (`maintain.test.mjs`): `MERGED` → `done`, local
    worktree/branch/marker removed, zero `git push` calls, record deleted
    only when the `ls-remote` fake shows the ref gone, else
    `remote-pending`; `CLOSED` → local retire, zero `git push` calls,
    `remote-pending` while the ref exists, `adlc:autopilot-skip` +
    comment naming the exact remote-deletion command on the issue; PR not
    found → `orphan`.
63. **Lease-guarded remote delete is operator-only** (`recover.test.mjs`,
    real temporary git repository with a bare `origin`): automatic
    retirement of a pushed run issues zero `git push` calls and reports
    the ref under `remoteRefsLeft`; `reset --issue N --confirm-delete
    <OID> --delete-remote` deletes the remote ref using
    `--force-with-lease=<ref>:<oid>`; when the remote tip was advanced by
    another push, the delete fails the lease, the remote ref survives,
    and the run is `orphan`; a PR fake that appears right after a
    successful delete is reported as `pr-after-delete`.
64. **Argv-safe pre-strike** (`run.test.mjs`): with `--model
    'opus;touch /tmp/x'` preflight exits 1 `model-unknown` (grammar
    `^[a-z0-9][a-z0-9.-]{0,63}$`); the `--pre-strike-argv` value parses
    as a JSON array whose elements equal the resolved values verbatim; the
    spawn recorder shows every child (including the pre-strike helper as
    executed by the fleet fake) spawned with an argv array and
    `shell:false`.
65. **Fallback family normalization** (`quota.test.mjs`): `familyOf` maps
    `"Fable"`, `"claude-opus-5"`, `"Claude Sonnet 5"` and `"opus"` to
    their families and `"gpt-5"` to `unknown`; a fallback text with a
    `Current week (Opus): 70% used` line and `--model claude-opus-5` →
    refused; two `(Opus)` lines with different values → `quota-unknown`.
66. **CI normalization contract** (`ci.test.mjs`): fixtures captured
    verbatim from `gh pr checks --json name,state,bucket,workflow` for
    pass, fail, pending, skipping and cancel rows normalize as §6.9; a row
    with no `bucket` → red; `ticket-store-platform (windows-latest, 18)`
    matches the blocking prefix; a non-blocking `pre-ga-gate` fail is
    ignored.
67. **Authorized unlabel** (`recover.test.mjs`): an `unlabeled` timeline
    event by a `write`-permission actor → no transition, label re-applied,
    status `unauthorized-unlabel`; by an `admin` actor → transition, and
    the same event id is not acted on again on the next iteration.
68. **Pinned tools** (`preflight.test.mjs`): a PATH whose first entry is
    `<REPO_ROOT>/node_modules/.bin` containing a fake `adversarial-review`
    → that entry is skipped and the system binary is pinned; a tool that
    resolves only under `REPO_ROOT` → `untrusted-tool`; a fake `adlc`
    in a world-writable directory, one owned by another uid (fixture via
    an injected `stat`), and one reached through a symlink whose target
    directory is group-writable → `untrusted-tool:adlc` and the key is
    never placed in any child env; `--trusted-bin-dirs` restricts the
    search to the given directories; every recorded child env has the
    sanitized PATH.
69. **Digest protocol** (`digest.test.mjs`): a `gh` fake that fails after
    the comment is posted leaves `digestPosted:false`, and the next
    iteration finds the sentinel and posts nothing; a closed log issue →
    a new issue is created and cached; two open log issues → the lowest
    is used and `digest-issue-ambiguous` is reported.
70. **Local deletion revalidation** (`recover.test.mjs`, real temporary
    git repository): a retire whose branch tip moved after the record's
    `localHead`, or whose worktree has an uncommitted file, performs no
    deletion and marks `orphan`; the worktree removal is never forced; a
    ref that moves BETWEEN L2 and L3 makes `update-ref -d` fail, the
    worktree is moved back to `ISSUE_WT`, and both artifacts survive
    byte-identical; a record is deleted only when the `ls-remote` fake is
    empty and no local branch/worktree exists (the §2.1 canonical rule),
    table-driven over every row that ends in record deletion.
71. **Unit file paths** (`service.test.mjs`): generated unit contains
    line-anchored `WorkingDirectory=/<abs>`, `ExecStart=/<abs node>
    /<abs>/packages/autopilot/bin/adlc-autopilot.mjs loop --rest 10m`,
    `EnvironmentFile=/<abs>/.env.local`, `Restart=on-failure`,
    `KillMode=control-group`; no `%h`; a working directory lacking
    `.adlc/config.json` makes generation exit 1 `bad-working-directory`.
72. **P0/P1 record mechanics** (`sequence.test.mjs`): the coldstart
    fake is invoked with cwd = `ISSUE_WT`, `--tickets
    <ISSUE_WT>/.adlc/tickets`, `--prompt-only`, never `--dir`, and, on
    the record call, with `--prompt-only --record-verdict -`,
    `shell:false`, and stdin bytes
    that parse to an object whose `ticketHash` equals the hash `adlc
    ticket show` returned immediately before; a coldstart answer
    containing `'; touch /tmp/x; echo '` and `$(id)` reaches the fake's
    stdin byte-for-byte inside the `what` string and spawns no extra
    process; a
    `gaps` array with one entry → CLARIFY and zero record calls; the
    spec-lint fake sees `<ISSUE_WT>/.adlc/specs/<ULID>-ac.md` existing,
    beginning with `## Acceptance criteria`, and argv `--record --ticket
    <ULID> --dir <ISSUE_WT>/.adlc` on the in-repo bin path; after a
    reopen (§6.6) the coldstart record call repeats with the new hash.
73. **Input grammar** (`input.test.mjs`): `--issue 0`, `--issue 12a`,
    `--issue ../x`, an OID of 39 hex chars, a ticket id with a lowercase
    ULID, and a branch name supplied through any config field each exit 1
    `bad-input:<field>` with zero spawns and zero filesystem writes; a
    constructed `ISSUE_WT` whose `realpath` escapes `REPO_ROOT` (symlink
    fixture) is refused.
74. **Pagination contract** (`select.test.mjs`): the `gh api` fake
    serves 13 pages (12 × 100 + 50) → 13 calls with `page=1..13`, 1 250
    candidates, no `--paginate`/`--slurp` in any argv; a page that is an
    object, a page that is a string, an element without an integer
    `number`, a page exceeding the 4 MiB cap, or 50 full pages →
    `candidate-set-truncated` with the reason recorded and exactly 50
    calls at most (assert `page=51` is never requested).
75. **Exact-name dependency guard** (`sequence.test.mjs`): adding
    `@adlc/spec-lint` (an existing published workspace not in the allowed
    set) → `third-party-dep`; adding `@adlc/core` as a workspace link →
    pass; a lockfile entry `node_modules/@adlc/core` with a registry
    `resolved` URL → `lockfile-drift`.
76. **Secret scan is fail-closed** (`diffcheck.test.mjs`): a worker fake
    that adds a line matching each `SECRET_PATTERNS` entry (one fixture
    per pattern name, including a private-key block inside a test file
    and an `.env`-style `FOO_TOKEN=` line inside the ticket shard) and
    one that adds the literal orchestrator key value → outcome
    `secret-in-diff`, state `blocked`, zero `git push` / attestation /
    fleet re-dispatch calls, and the issue comment contains the pattern
    NAME and file:line but not the matched text (assert the secret string
    is absent from every recorded `gh` argv and from the status file).
77. **ticketSync config validates** (`config.test.mjs`): the §13
    example config passes `packages/ticket-sync/schemas/adlc-config.schema.json`
    (assert via the same validator ticket-sync uses); a block with
    `query: null` or without `provider` fails it.
78. **Bounded model-plane reads** (`run.test.mjs` + `sequence.test.mjs`
    + fleet's real-bwrap test): the fleet argv carries `--model-plane-read
    bounded`; the `--model-plane-read-only` list contains the pinned tool
    files and system paths and contains NEITHER `<REPO_ROOT>`,
    `<REPO_ROOT>/.git`, `<ISSUE_WT>`, `$HOME`, `/tmp`, the worker's
    worktree, nor the mirror (those two are writable roots), nor any path
    that is an ancestor of a writable root (path-prefix check over the
    full list); inside the sandbox the worker performs `git commit` in
    its worktree successfully and the new object appears in the mirror;
    a fleet fake reporting `readPolicy: "host"` or `gitSource: "shared"`
    is `sandbox-policy-mismatch` (no attestation).
79. **Dispatch approval modes** (`select.test.mjs`): with
    `dispatchApproval: "label-only"`, a `COLLABORATOR`-authored issue
    without `adlc:autopilot` is excluded (`dispatch-approval`), the same
    issue labeled by an `admin` actor is eligible, labeled by a `write`
    actor is excluded; with the default, the §4.2 trust predicate applies;
    an unknown value → `bad-config`.
80. **Approval hash pinned** (`preflight.test.mjs`): a manifest fixture
    whose newest `spec-approval` file hash differs from the spec blob at
    `BASE_OID` → `spec-approval-stale`, exit 1, zero dispatches; equal →
    passes; an older matching record followed by a newer non-matching one
    → stale (newest wins).
81. **Mirror is the only git database** (`run.test.mjs`): the fleet argv
    carries `--model-plane-git mirror --model-plane-git-mirror
    <REPO_ROOT>/.adlc/autopilot-runs/<issue>/mirror.git`; the mirror
    path appears ONLY as a writable root (fleet's `--json` echo lists it
    under `writableRoots`) and never in `--model-plane-read-only`;
    `<REPO_ROOT>/.git` appears in neither; no argv anywhere contains
    `--model-plane-git-sanitize`; a fleet fake reporting `gitSource:
    "shared"` back in `--json` is `sandbox-policy-mismatch` (no
    attestation).
82. **Revalidation before write and dispatch** (`sequence.test.mjs`): a
    `gh issue view` fake whose second read shows a changed `updatedAt`, a
    newly added `adlc:autopilot-skip`, a closed state, or a new open PR
    → zero worktree creation (before step 1) or, when triggered before
    dispatch, retirement of the worktree with zero fleet spawns, and
    outcome `revalidation-changed`; unchanged reads proceed.
83. **P1 gate is the runner's** (`preflight.test.mjs`, real `adlc run p1`
    binary against a temporary manifest): a segment with `spec-lint` +
    `premortem` + a `spec-approval` whose `data` has the full contract
    → exit 0 and dispatch allowed; missing `premortem`, `unresolved: 1`,
    `rounds: 0`, or a `spec_hash` that differs from the blob at `specBlob`
    → `spec-approval-stale`, zero dispatches.
84. **Git mirror** (`sequence.test.mjs`, real temporary git repository):
    the mirror created before dispatch has exactly one branch
    (`adlc/autopilot/issue-<n>`), no `remote.*`/`credential.*`/`hooksPath`
    config, no hooks, and `git -C <mirror> rev-list --all` equals the
    objects reachable from `BASE_OID` plus the issue branch (an extra
    local branch and a dangling commit planted in `REPO_ROOT` are absent);
    the fleet argv carries `--model-plane-git mirror` and the mirror path,
    and never `<REPO_ROOT>/.git` in any read set.
85. **Dispatch approval default** (`select.test.mjs`): with the default,
    an `OWNER`-authored issue is eligible without a label; a
    `COLLABORATOR`-authored issue is excluded (`dispatch-approval`) until
    an `admin` actor labels it; `"trusted-authors"` admits it; the
    `label-only` and unknown-value cases of the earlier criterion still
    hold.
86. **Plugin parity reads the baseline** (`preflight.test.mjs`): the
    parity check's git argv is `show <BASE_OID>:plugins/adlc-claude-code/.claude-plugin/plugin.json`;
    a local `origin/main` ref pointing at a manifest with a different
    version does not affect the verdict.
87. **Reservation ordinal is recorded** (`quota.test.mjs`): the status
    file's `startsThisIteration` is 0 at the top of an iteration, 1 after
    shaping, and each pre-strike helper invocation (run with the fake
    lock held) increments it and applies the reserve from ordinal 2; a
    helper run without the lock exits 1.
88. **Dead-end redaction is fail-closed** (`redact.test.mjs`): a
    preflight log containing each `SECRET_PATTERNS` entry and the literal
    orchestrator key value reaches the `--dead-end-file` with every match
    replaced by `[REDACTED:<pattern>]`; a redactor fake that throws or
    returns text still matching a pattern → the file contains only the
    withheld sentinel; the spawn recorder shows no raw log path passed to
    fleet, shaping, or coldstart; `gh run view --log-failed` output is
    redacted before being written.
89. **Approval bound to a merge identity** (`preflight.test.mjs`): a
    `gh api` fake returning the spec commit's PR as merged by a `maintain`
    login that equals the record's `approver` → dispatch allowed; merged
    by a `write` login, an unmerged PR, no PR, or an `approver` naming a
    different login → `spec-approval-unbound`, zero dispatches.
90. **Reason enum is closed** (`run.test.mjs`): the §6.10 mapping is
    table-driven over exactly the eight reasons of §14 including
    `mirror-fetch-failed` (→ `blocked`, worker branch preserved); an
    unknown reason string → treated as exit 1, never `blocked`.
91. **Outward redaction on every exit path** (`redact.test.mjs`): for
    each outward writer (CLARIFY comment, blocked findings comment after a
    fleet exit 2, stale/ci-red/oid-mismatch/pr-closed comments, digest,
    status file, run record) a payload containing every `SECRET_PATTERNS`
    entry and the key value is redacted; a redactor fake failure replaces
    the whole body with the withheld sentinel while the label is still
    applied; assert the secret string appears in no recorded `gh` argv,
    status file, or record.
92. **Detach before ref delete** (`recover.test.mjs`, real temporary git
    repository): after retirement L2 the quarantined worktree is detached
    at `localHead`; L3's conditional delete succeeds while the worktree
    still exists; L4's `rev-parse HEAD` equals `localHead` and
    `symbolic-ref -q HEAD` fails; a worktree whose HEAD was moved by hand
    between L2 and L4 aborts L4 and marks `orphan`.
93. **Crash-safe creation** (`recover.test.mjs`, real temporary git
    repository): a run record in `creating` with an existing markerless
    branch at `baseOid` → the marker is written from the record's token
    and the run continues; the same with the branch tip moved →
    `orphan`; with no branch → the record and any empty `ISSUE_WT` are
    removed and the issue is selectable; the record is observed on disk
    BEFORE the `git worktree add` argv in the spawn recorder.
94. **Mirror outside the worktree** (`sequence.test.mjs`, real temporary
    git repository): after dispatch the mirror exists at
    `<REPO_ROOT>/.adlc/autopilot-runs/<issue>/mirror.git`, `git -C
    <ISSUE_WT> status --porcelain` is empty, the clean-tree assertions of
    §6.7 pass, a stale mirror from a previous run is replaced before
    dispatch, and retirement removes the run directory including the
    mirror.
95. **Private tmp and per-file tool binds** (`run.test.mjs` +
    fleet's real-bwrap containment test): the read set contains the
    `realpath` of each pinned executable and the npm/corepack trees, and
    no directory that is a parent of a pinned executable; the fleet argv
    requests the private tmpfs; inside the sandbox a pre-existing host
    `/tmp` file is absent and a write to `/tmp` lands in the tmpfs
    (skipped loudly without bwrap).
96. **Model inputs are redacted** (`redact.test.mjs`): an issue body
    containing every `SECRET_PATTERNS` entry reaches the shaping `claude`
    spawn redacted; the same for a trusted-block body and the coldstart
    prompt; a redactor failure yields a CLARIFY without any `claude`
    spawn.
97. **Tombstone and selection-time remote check** (`select.test.mjs` +
    `recover.test.mjs`): deleting a record writes the tombstone; an issue
    whose branch name has a remote ref is excluded with
    `remote-ref-exists` even with no record and no tombstone; a tombstone
    older than 30 days is pruned; the tombstone carries `lastPushedOid`.
98. **Criteria document is tracked** (`sequence.test.mjs`): the ticket
    commit contains `.adlc/specs/<ULID>-ac.md`, the spec-lint record's
    file hash equals its sha256, and the actual-diff check accepts exactly
    that one criteria file and rejects a second or a modified one.
99. **Bounded CI log capture** (`redact.test.mjs`): a `gh run view
    --log-failed` fake emitting 5 MiB is killed at the 4 MiB cap, the
    capture is marked `truncated`, only the redacted last 64 KiB reaches
    the dead-end file, and a secret straddling a 64 KiB chunk boundary is
    still redacted.
100. **Foreign manifest lines rejected** (`diffcheck.test.mjs`): an
    appended `.adlc/manifest.d` line not in the run record's
    orchestrator-written set → `foreign-manifest-line`; a line with an
    invalid signature makes `gate-manifest verify` exit ≠ 0 → violation;
    the orchestrator's own signed appends pass.
101. **Body-only model input** (`triage.test.mjs`): the `gh issue view`
    argv requests `title,body` and never `comments`; a fixture whose
    comments contain a directive shows no trace of it in the shaping
    spawn's stdin.
102. **Prompt transport** (`triage.test.mjs`): both `claude -p` spawns
    carry no positional prompt in argv, receive the prompt as `stdinBytes`
    (the recorder captures it), have no prompt file on disk, and are
    killed at the 5-minute deadline like every other child.
103. **Pre-strike minimal env** (`run.test.mjs`): the `--pre-strike-env`
    object passed to fleet has exactly the keys `PATH`, `HOME`,
    `ADLC_AUTOPILOT_STATUS_FILE`, `ADLC_AUTOPILOT_LOCK_TOKEN`; an
    orchestrator env seeded with `ADLC_MANIFEST_KEY`, `GH_TOKEN` and
    `FOO_SECRET` leaks none of them (table-driven over the recorded env).
104. **Staged creation** (`recover.test.mjs`, real temporary git
    repository): a pre-existing `ISSUE_WT` directory → `orphan-dir`, zero
    git calls; creation goes through `<ISSUE_WT>.creating-<token>` and is
    moved only after the marker exists; a `creating` record with a
    staging path of a DIFFERENT token → nothing deleted, `orphan`; a
    crash after `worktree add` and before the marker → repair writes the
    marker and completes the move.
105. **Structured redaction keeps the schema** (`redact.test.mjs`): a
    run record whose `lastError` contains a secret is written with that
    field redacted and every identifier intact; a redactor failure on
    `lastError` yields `lastError: null` plus `redactionFailed:
    ["lastError"]` and the record still parses and drives recovery; the
    identifier fields are never handed to the redactor (spy assertion).
106. **Fetch-back advances the worker branch** (`sequence.test.mjs`,
    real temporary git repository): after a worker commit in the mirror,
    the recorded git argv shows the temp-ref fetch, the `merge-base
    --is-ancestor` check and the CAS `update-ref` with the cut tip as the
    old value; the worker branch in `ISSUE_WT`'s repository points at the
    worker's commit; a mirror tip that does not descend from the cut tip
    → `mirror-fetch-failed` with the branch ref untouched and the temp
    ref deleted.
107. **Creation phases are journaled** (`recover.test.mjs`, real
    temporary git repository): for each `creationPhase` value a crash
    fixture leaves the corresponding half-done state and recovery
    finishes it (staging branch at base → final branch with marker →
    worktree at `ISSUE_WT`, state `shaped`); the record is observed on
    disk with the next phase BEFORE each git argv; a `renamed` crash
    leaves no dangling staging path; the record is never deleted while a
    marker-bearing final branch exists.
108. **Mirror output reaches the integration branch** (`sequence.test.mjs`,
    real temporary git repository, one ticket, fleet fake that performs
    the real fetch-back sequence): after the run, `fleet/run-<id>` in the
    caller repository contains the worker's commit, `adlc/autopilot/issue-<n>`
    fast-forwards to it, and no gate argv references the mirror path.
109. **Label removal revokes** (`select.test.mjs`): a timeline fixture
    `labeled(admin) → unlabeled(anyone)` with the label absent → `not-
    authorized`; `labeled(admin) → unlabeled → labeled(write)` → `not-
    authorized`; `labeled(admin) → unlabeled → labeled(maintain)` with the
    label present → eligible; a label present on the issue but with NO
    timeline event readable → `not-authorized`; the same fixtures drive
    revalidation and triage.
110. **Pinned remote URL** (`run.test.mjs` + `recover.test.mjs`): every
    recorded `git ls-remote`/`fetch`/`push` argv carries the pinned URL
    literal and never the word `origin` as the remote argument; a `git
    remote get-url` fake that changes between preflight and a push →
    `remote-url-changed`, zero pushes, state `orphan`.
111. **Coverage gate is not vacuous** (`spec-coverage.test.mjs` self-test):
    a registry entry pointing at a test with no `lib/` import or no
    `assert` call fails the gate; a criterion number absent from the
    registry fails it; renumbering the spec without updating the registry
    fails it.
