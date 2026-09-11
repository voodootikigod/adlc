# Intent — backlog grooming skill

Status: **confirmed intent**, not yet specified or built. Produced by an
`interview-me` session on 2026-09-11 and confirmed line-by-line by the repo owner.
Downstream is `/adlc:adlc-spec` → ticket → lane. This document is the contract that
spec work consumes; it is not itself a spec and carries no acceptance criteria.

## Outcome

A separate, independently-runnable skill that grooms a GitHub backlog **against the
code**, writes its conclusions back to GitHub (always commenting the full evidence
and rationale *before* any close), and leaves behind a ranked, clustered,
premise-verified set.

## User

The repo owner. Built for this repo today, but **portable from the start**:
`issue-lanes` is moving into a broader skills package, and most of what makes
selection work here is specific to this repo.

## Why now

370 open issues that are *already* labeled — `P1-high` 74, `P2-medium` 104,
`P3-low` 166, plus `area:*` clusters — but decaying. A label is stamped once at
filing and then rots; nothing re-checks it. 295 of these issues came from a single
automated release-audit sweep, so the backlog also carries structural
near-duplicates by construction.

Two concrete costs observed while running the 2026-09-10 four-lane batch:

- Lane selection re-pays the same code-grounded analysis every batch and throws it
  away — tiering per candidate, active-rail checks, and `grep`-ing each issue's
  cited line to confirm it still reads as filed.
- #582 sat fixed-but-open long enough to waste real time, and #905's "until it
  lands" premise was false in three separate places in the `issue-lanes` skill.

## Success

`/issue-lanes` stops deriving its own selection and reads the groomed set instead.
The backlog measurably shrinks, and every closed issue carries the evidence and
rationale that closed it.

## Constraints

**Code-grounded, therefore incremental.** Verification means opening files and
checking whether an issue's cited premise still holds at HEAD. That is the
expensive part, so runs must be incremental rather than re-checking every issue
each time.

**The adversarial gate licenses execution; a configurable floor overrides it.**
An earlier draft of this document made evidence quality decide *whether* to
execute — mechanical conclusions applied, inferred ones (priority changes,
duplicate links) proposed only. That rule existed because inferred judgments had
no second check. The adversarial gate below supplies exactly that check, so the
two rules were redundant and the propose-only half is retired.

What evidence quality decides now is *what the reviewer is shown*: a mechanical
case presents the diff and the commit that changed it; an inferred case presents
the reasoning. Either can execute once the reviewer confirms.

Above that sits an **autonomy floor**: a per-project list of action classes that
always require a human hand regardless of the reviewer's verdict, because the
right answer differs by repo — a solo repo and one with other contributors do not
want the same defaults. It lives in the repo profile. Three properties, following
`packages/model-router/lib/floor.mjs`, which solved the same shape for the P3
rail-density gate:

- **One validator, every entry point.** The CLI and every library caller run the
  same check, so a library caller cannot disable what the CLI cannot.
- **Disabling is explicit, never accidental.** An empty floor is legal but must be
  written deliberately; omitting the setting yields the conservative default, and
  a floor that would permit everything cannot arise from a missing key.
- **Unknown action classes fail closed.** A typo'd class is an operational error,
  not a silently ignored entry — otherwise `"clsoe"` quietly drops the floor on
  closing. (`floor.mjs` rejects `parseFloat` for the same reason: it would accept
  `0.5abc` as `0.5`.)

Anything the gate refuses is demoted to a proposal in the report. That demoted set
is the useful signal — it is where two independent contexts disagreed — and it
replaces the pre-emptive propose-only list.

**Comment before close, always.** A close is preceded by a comment carrying the
full evidence and rationale, so the audit trail is on the issue before it goes
quiet and a wrong close is self-documenting and easy to challenge.

**No GitHub write executes until a fresh-context `adversarial-review` confirms
it.** The gate sits in front of *execution*, not in front of proposals — a
proposal already has a human as its second reader. Three properties this gate must
have, each learned the expensive way:

- **One-shot, not a loop.** For code, the review loops fix→re-review until clean,
  because there is something to fix. For a close decision there is nothing to fix,
  so looping would only be retrying until the reviewer agrees — the opposite of a
  gate. Review once; a "no" **demotes the close to a proposal**. The demoted set is
  itself signal: it is where the skill's judgment and the reviewer's disagree.
- **`--min-confidence 0.3`, not the 0.5 default.** Artifact-mode grounding halves
  the confidence of every finding, so the default yields hollow approves — an
  exit 0 that reviewed nothing.
- **Per-issue artifact, not one batched document.** Each close is small and
  self-contained (issue text, cited location, what the code says now, the commit
  that changed it) — the size that actually converges under review. Big artifacts
  do not converge, and a batched verdict is not attributable to a specific close.

The reviewer must be a **different provider** from whatever made the call, on the
same distinct-context principle as the cross-model attestation.

Cost follows from this: the adversarial gate runs once per *autonomous close*, not
per issue examined. A sweep of 370 yielding 20 confident closes costs 20 reviews.

**Portability via a repo profile.** Repo-specific facts — what is tiered, what is
frozen, label conventions, and the permitted autonomy level — live in a profile
file, not in the skill. The autonomy level belongs there specifically because
autonomously closing another contributor's issue in a shared repo is a different
act from closing your own in a solo one.

## Out of scope

- Filing new issues.
- Touching `issue-lanes`' build half. Grooming runs before it, or entirely without
  it; the coupling is a handoff artifact, not a merged skill.

Relabeling and duplicate-linking are **in scope and executable**, subject to the
adversarial gate and the project's autonomy floor. Duplicate and superseded-by
detection is the highest-value output, since it is the only one that genuinely
shrinks the backlog. An earlier draft listed both as out of scope or proposal-only;
that was superseded by the floor model above.

## Shape (recommendation, not yet confirmed)

Follow the two precedents already in this repo rather than inventing a form: a
skill that drives a collector script (as `release-audit` drives
`scripts/release-audit-collect.mjs`), reading repo-specific facts from a profile
file (as `release` reads `.claude/release-profile.md`).

## Worked example of the judgment required

Filed during the same session, these three issues show the distinction the skill
must draw — and why duplicate detection cannot be a similarity score:

- **#324** — full-suite flakiness, scoped by its own text to developer machines,
  "never in CI".
- **#990** — a nested `gate-deps` clone race, observed **in CI**. Not a duplicate
  of #324 despite overlapping vocabulary, because #324's stated scope excludes it.
- **#992** — an unguarded `records.update` that turns a clean `init-failed` return
  into an unhandled rejection. Not a duplicate of #990 but **caused** by it: the
  clone failure in #990 is the error that reaches the unguarded handler in #992.

Duplicate, related-but-distinct, and superseded-by are three different verdicts,
and none is derivable from labels or title similarity.
