# Spec — backlog grooming

Status: **draft, P1 in progress.** Consumes the confirmed intent in
`docs/intent/backlog-grooming.md`. Not yet approved; acceptance criteria below are
the contract a P0 ticket will carry.

## 1. Outcome

A separate, independently-runnable capability that grooms a GitHub issue backlog
against the code and writes its conclusions back to GitHub, leaving a ranked,
clustered, premise-verified set that `issue-lanes` consumes instead of deriving
its own selection.

## 2. Shape

Two artifacts, following the precedents already in this repo:

- `packages/backlog-groom/` — the portable core. `lib/` holds pure, injectable
  functions; `bin/backlog-groom.mjs` is the CLI. This is where every decision is
  made and every rule is enforced.
- `.claude/skills/backlog-groom/SKILL.md` — the agentic wrapper that drives the
  CLI, supplies model judgment where the core asks for it, and runs the
  adversarial gate. Mirrors how `release-audit` drives
  `scripts/release-audit-collect.mjs`.

Repo-specific facts live in `.claude/backlog-groom-profile.json`, read by the
core. This deviates deliberately from `.claude/release-profile.md`'s markdown: that
profile is read by a model, this one is parsed by code, and a machine-consumed
config with globs and an autonomy floor must fail closed on malformed input —
which a prose file cannot do.

## 3. Pipeline

`fetch → classify verifiability → verify → cluster → rank → gate → execute → report`

### 3.1 Fetch

Via `gh issue list --state open --json number,title,body,labels,url,updatedAt`.

A response of exactly the fetch limit is reported as `truncated`, never accepted
as complete — inherited verbatim from `release-audit-collect.mjs:fetchIssues`,
for its stated reason: a capped list is indistinguishable from a complete one, and
silently dropping the tail would let a sweep report "nothing to groom" about
issues it never saw.

### 3.2 Classify verifiability

Each issue is sorted into exactly one verification route:

| Route | Condition |
|---|---|
| `mechanical` | The body carries a parseable code reference — a `path:line` location and/or a fenced snippet attributed to that path |
| `model` | The body makes a checkable claim about code but carries no parseable reference |
| `unverifiable` | The body makes no checkable claim about code at all |

`unverifiable` is a first-class outcome, not a failure. Collapsing it into "still
valid" is the specific false-green this design exists to avoid: it would let a
sweep silently under-report while appearing to have examined everything.

### 3.3 Verify

- **`mechanical`**: read the cited path at HEAD. **The cited line number is a hint,
  never an identity.** Search the whole file for the snippet; conclude `fixed` only
  when the snippet is absent from the entire file, never merely absent from the
  cited line. Any unrelated edit above the citation shifts every line below it, so
  a line-anchored comparison would report `fixed` for live bugs — the single most
  likely wrong close in this design. Emit the verdict plus the evidence that
  produced it (the lines as they read now, and the commit that last touched them).
- **`model`**: the skill reads the issue against the code and emits the same
  verdict shape, with its reasoning as the evidence.
- **`unverifiable`**: verdict `unverifiable`, no evidence, never actioned.

Verdicts: `valid` · `fixed` · `moved` · `unverifiable`.
`moved` means the cited location no longer exists but the claim may still hold
elsewhere — it is never a close, only a re-locate proposal.

### 3.4 Cluster

Two independent groupings, not one:

- **Lane clusters** — issues whose verified locations fall in the same package or
  profile-declared unit, sized for one build. This is what `issue-lanes` consumes.
- **Relations** — `duplicate-of` and `superseded-by` links between issues.

Relations are judgments, not similarity scores, and must distinguish three cases
the intent's worked example demonstrates: duplicate, related-but-distinct, and
superseded-by. Title or label similarity alone is never sufficient evidence for a
relation.

Relations are O(n²) — 370 open issues is ~68,000 pairs — so a cheap similarity
pass **selects candidate pairs**, and judgment then decides each candidate. The
distinction is load-bearing: similarity is a *filter*, never *evidence*, and an
emitted relation cites reasoning rather than a score. The honest consequence is
that **the filter's recall is the ceiling on what relations can ever be found** —
a pair the filter never surfaces is a relation the tool cannot report — so the
filter's threshold and its miss rate are reported with the run, not hidden.

### 3.5 Rank

A rank computed from what grooming learned — verdict, cluster size, whether the
issue's paths are frozen by the profile, and the existing priority label as **one
input among several, not the answer**. Existing labels are never read as ground
truth, since their decay is the reason this exists.

### 3.6 Gate

No GitHub write executes until a fresh-context `adversarial-review` confirms that
specific write.

- **One-shot.** Review once. A refusal demotes the action to a proposal; there is
  no fix→re-review loop, because a conclusion has nothing to fix and looping would
  only retry until the reviewer agrees.
- **One issue per artifact**, via `--input`. Batched artifacts do not converge, and
  a batched verdict is not attributable to a specific action.
- **`--min-confidence 0.3`**, not the 0.5 default: artifact-mode grounding halves
  every finding's confidence, so the default yields hollow approves.
- **Reviewer provider must differ** from the provider that produced the conclusion.
  When no distinct provider is available, every would-be autonomous action demotes
  to a proposal and the run continues — the read-only half stays useful, and the
  gate stays unbypassable.

**The one-shot property is enforced in the core, not by prose in the skill.** A
wrapper told "review once" will, under pressure to finish, re-run the reviewer on
a reworded artifact until it approves — which is the failure the one-shot rule
exists to prevent, and no amount of instruction text stops it. So the core records
the gate verdict against `(issue, contentHash)` and **refuses a second gate
attempt for the same revision**: a retry is detected and rejected by code, and a
changed artifact for unchanged content is itself the tell. This is the same
lesson the rail hook learned — enforcement that lives only in instructions is
advisory, and an agent routes around advisory.

Relatedly, **the skill must never mutate GitHub directly.** Every write flows
through the core, or the floor, the gate and the comment-first rule are all
bypassed by a single `gh issue close` in the wrapper — structurally the same gap
as rails-guard's un-gated Bash surface. A guard test asserts the shipped
`SKILL.md` contains no mutating `gh` invocation.

### 3.7 Autonomy floor

`autonomyFloor` in the profile lists action classes that always require a human
regardless of the reviewer's verdict. Action classes: `close`, `relabel`,
`duplicate-link`, `comment`.

Following `packages/model-router/lib/floor.mjs`:

- **One validator, every entry point.** The CLI and every library caller call the
  same function, so a library caller cannot disable what the CLI cannot.
- **Default is conservative.** Omitting the key yields `["close"]`. An empty floor
  is legal but must be written deliberately; a permissive floor cannot arise from
  a missing key or a typo.
- **Unknown classes are an operational error** (exit 1), never silently dropped —
  otherwise `"clsoe"` quietly removes the floor on closing.

**The profile is a trust root, with the same asymmetry rails-guard applies to
rails.** Narrowing autonomy (adding a class to the floor) is an ordinary change.
**Widening it — removing a class, or setting `[]` — is privileged** and follows the
repo's trust-root path. Without that asymmetry the floor is not a floor: the
escalation is a one-line profile PR followed by whatever closures you like, and
the autonomy model would be exactly as strong as PR review.

### 3.8 Execute

For each action the gate licensed and the floor permits:

1. **Comment first**, carrying the full evidence and rationale, and a durable
   marker (`<!-- backlog-groom:<issue>:<contentHash> -->`).
2. Then apply the action.

Never the reverse: the trail must be on the issue before it goes quiet, so a wrong
action is self-documenting and easy to challenge.

**Execution is idempotent, and that is a design constraint rather than a nicety.**
The two writes are not atomic: a comment can succeed and the action then fail
(rate limit, revoked token, a race with a human closing it first), leaving an
issue carrying a "closing because…" comment in an open state. A re-run must
detect its own prior marker for that `(issue, contentHash)` and resume at the
action rather than re-commenting, or the backlog accumulates duplicate evidence
comments with every retry. `scripts/ceremony-drift.mjs` solved exactly this shape
— its `MARKER` makes an unchanged report leave the issue untouched, and its module
header names idempotence as the whole design constraint.

A mid-sweep failure must therefore leave a resumable state, never a half-applied
one that a re-run compounds.

### 3.9 Report

Emits: the groomed set (ranked, clustered, with verdicts and evidence), the
actions executed, the actions **the gate demoted** and why, and the
`unverifiable` and `truncated` counts.

**Every run leads with its route distribution** — how many issues were verified
mechanically, how many by model, and how many not at all. A sweep that mechanically
verified 4% of the backlog is still useful, but that number must sit next to the
conclusions or a thin run reads as a thorough one. This is the same honesty rule as
`truncated`: an incomplete examination must never present as a complete one.

The emitted set carries a **schema version**. `issue-lanes` adoption is a separate
change with its own ticket, so the handoff is verified here against a committed
fixture rather than against `issue-lanes` itself — which keeps this work
independently verifiable and makes later schema drift a loud failure instead of a
silent one.

## 4. Incrementality

A gitignored cache keyed per issue on `(issue.updatedAt, contentHash of the paths
it references)`. An issue is re-verified when either changes. The profile may opt
into committing the cache; it is never committed by default, because the skill
cannot assume commit rights on an arbitrary repo.

A cache miss must never be silently treated as `valid`.

**An issue with no referenced paths has no content-hash component, so it is not
cacheable as `valid`.** Degrading its key to `updatedAt` alone would mean code
changes never invalidate it: the issue gets fixed, nothing in the issue itself
changes, and the cache keeps returning `valid` forever. That reintroduces exactly
the decay this tool exists to detect, inside the tool's own cache. Such issues are
re-verified every run, or cached only as `unverifiable` — never as `valid`.

## 5. Acceptance criteria

- **AC1** An issue whose cited snippet still matches at HEAD verifies `valid`; one
  whose cited lines no longer contain the claimed code verifies `fixed` with the
  changing commit as evidence. verify: `node --test packages/backlog-groom/test/verify.test.mjs`
- **AC2** An issue with no parseable reference routes to `model`; one with no
  checkable claim routes to `unverifiable` and is never actioned. verify: `node --test packages/backlog-groom/test/classify.test.mjs`
- **AC3** A cited path that no longer exists verifies `moved`, never `fixed`. verify: `node --test packages/backlog-groom/test/verify.test.mjs`
- **AC4** A `gh` response of exactly the fetch limit sets `truncated` and the run
  reports it rather than presenting the list as complete. verify: `node --test packages/backlog-groom/test/fetch.test.mjs`
- **AC5** `autonomyFloor` omitted yields `["close"]`; an unknown class exits 1 with
  a message naming it; `[]` is accepted only when explicitly present. verify: `node --test packages/backlog-groom/test/floor.test.mjs`
- **AC6** The floor validator is called by the CLI *and* by the library entry
  point — a library caller cannot execute an action the CLI would have blocked. verify: `node --test packages/backlog-groom/test/floor.test.mjs`
- **AC7** No action executes without a recorded gate approval bound to that
  issue; a refusal demotes to a proposal and executes nothing. verify: `node --test packages/backlog-groom/test/gate.test.mjs`
- **AC8** With no distinct reviewer provider available, every would-be autonomous
  action demotes to a proposal and the verification report is still produced. verify: `node --test packages/backlog-groom/test/gate.test.mjs`
- **AC9** Every executed action is preceded by a comment carrying its evidence;
  an action whose comment write fails does not proceed. verify: `node --test packages/backlog-groom/test/execute.test.mjs`
- **AC10** A cached issue whose `updatedAt` or referenced-path content hash changed
  is re-verified; a cache miss never yields `valid`. verify: `node --test packages/backlog-groom/test/cache.test.mjs`
- **AC11** A relation is emitted only with evidence beyond title/label similarity;
  duplicate, related-but-distinct and superseded-by are distinguishable outcomes. verify: `node --test packages/backlog-groom/test/relations.test.mjs`
- **AC12** The emitted set carries a schema version and matches a committed
  fixture field-for-field; a shape change without a version bump fails. verify: `node --test packages/backlog-groom/test/emit.test.mjs`
- **AC13** A snippet that moved within its file (unrelated edit above it shifted
  the line numbers) verifies `valid`, never `fixed`. verify: `node --test packages/backlog-groom/test/verify.test.mjs`
- **AC14** A second gate attempt for the same `(issue, contentHash)` is refused by
  the core, so a reworded artifact cannot buy a second verdict. verify: `node --test packages/backlog-groom/test/gate.test.mjs`
- **AC15** Re-running after a comment-succeeded/action-failed interruption detects
  its own marker and resumes at the action without re-commenting. verify: `node --test packages/backlog-groom/test/execute.test.mjs`
- **AC16** An issue with no referenced paths is never cached as `valid`. verify: `node --test packages/backlog-groom/test/cache.test.mjs`
- **AC17** The shipped `SKILL.md` contains no mutating `gh` invocation. verify: `node --test packages/backlog-groom/test/skill-no-direct-mutation.test.mjs`
- **AC18** Widening the floor in the profile (removing a class, or `[]`) is
  refused outside the trust-root path; narrowing it is accepted. verify: `node --test packages/backlog-groom/test/floor.test.mjs`
- **AC19** A relation is emitted only for a candidate pair that judgment confirmed;
  the filter's threshold and miss rate appear in the run output. verify: `node --test packages/backlog-groom/test/relations.test.mjs`
- **AC20** The run output states how many issues were verified mechanically, by
  model, and not at all. verify: `node --test packages/backlog-groom/test/report.test.mjs`
- **AC21** Mutation gate green on the branch. verify: `node scripts/mutation-gate.mjs origin/main --max 12` exits 0

## 6. Out of scope

Filing new issues. Changing `issue-lanes`' build half. Reading issue comments as
evidence (title and body only, mirroring the autopilot triage boundary).

## 7. Approved assumptions

- The profile is JSON rather than markdown, deviating from `release-profile.md`,
  because it is parsed by code and must fail closed on malformed input.
- `issue-lanes` is not modified by this work; adopting the emitted set is a
  follow-on change to that skill.
