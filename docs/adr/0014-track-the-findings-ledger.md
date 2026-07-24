# ADR 0014: Track the P7 findings ledger (`.adlc/findings.jsonl`) in git

**Status:** **Accepted.** `.adlc/findings.jsonl` is tracked in the repository,
negated out of the blanket `.adlc/*` ignore exactly as `.adlc/manifest.jsonl`
already is. The standing constraint that makes this safe: **every entry is a
curated prose finding record — never a raw tool dump, and never a secret.**

**Date:** 2026-07-23
**Deciders:** Chris Williams

> Related: [ADR-0010 (sharded ticket store)](./0010-sharded-ticket-store.md)
> established the `.adlc/*`-blanket-plus-negation pattern that first tracked the
> ticket store and manifest; commit `d344a35` negated `manifest.jsonl`. This ADR
> extends the same pattern to the findings ledger that feeds P7.

---

## Context

`.adlc/findings.jsonl` is the ledger the P5 prosecutor writes to
(`adlc prosecute --record-finding`) and the P7 `lesson-foundry` reads from: it is
the memory that lets a repeated review finding become a permanent, deterministic
defense (a lint rule, a skill, or a spec-gap interrogation question). The
compounding "prosecute → cluster → bank a defense" loop only works if that memory
persists.

By the `0da039e` design the ledger was machine-local (gitignored), like the rest
of `.adlc/` runtime evidence. That choice quietly broke the loop:

- Findings recorded in a **fleet worktree** or in **CI** died with the workspace.
  The prosecutor surfaced a finding, it was reported and fixed, and the durable
  trail the bridge is supposed to leave never left the machine.
- `adlc lesson-foundry --gate` (T79) — which fails when a recurring finding
  cluster has no banked lesson — **cannot run in CI** against a ledger that does
  not exist there. The cluster set only lives where the ledger lives.

So the ledger has the same property the ticket store and manifest already have: it
is not disposable scratch state, it is durable state that a PR, a reviewer, and a
CI gate all need to see. Those were tracked for exactly this reason; the findings
ledger was the omission.

### Why not "export" instead of "track"?

The considered alternative was to keep the ledger machine-local and add an
`export`/`import` step that lifts findings into some tracked artifact at PR time.
Rejected as strictly more machinery for the same outcome:

- It reintroduces a lossy hop (export can be forgotten; the machine-local copy is
  still the source of truth and still dies with the workspace).
- It needs a schema and a merge story that `git` already provides for an
  append-only JSONL file.
- The manifest already proved the tracked-ledger pattern works inside the
  `.adlc/` trust boundary. A second, different mechanism for a sibling ledger is
  divergence for its own sake.

Tracking is the smaller, reversible change — reversible **via this ADR**: if a
concrete reason to stop tracking appears, drop the negation and record the
reversal here.

## Decision

**1. Track `.adlc/findings.jsonl`.** Add a `!.adlc/findings.jsonl` negation to
`.gitignore`, positioned **after** the blanket `.adlc/*` rule so last-match-wins
keeps it live, mirroring the `manifest.jsonl` and `lessons/` negations directly
above and below it. The diff is minimal and additive — it edits `.gitignore`
inside the `.adlc/` trust boundary, so it is visible to rails-guard / trust-root
review by design, and nothing else about the ignore file moves.

**2. Findings are curated prose — the no-secrets basis.** Tracking a ledger is
only safe because of what the ledger is allowed to contain. Each entry is a
short, human-authored description of a *pattern* (the failure class, not the raw
instance), with a repo-relative file path and a category/severity. This is the
**standing rule**, not a one-time review outcome:

- An entry MUST be curated prose. It MUST NOT be a raw tool dump (a full
  `adversarial-review` transcript, a diff hunk, a stack trace, a log paste).
- An entry MUST NOT contain a secret, credential, token, key, or any value copied
  from a secret-bearing file. `--desc` is a description of a defect class; a
  secret is never part of that description.
- The recorder already pushes authors toward this: `--desc` is the clustering
  key, and `lesson-foundry` routes literal-bearing descriptions differently from
  prose ones, so quoted literals and identifiers from a specific diff are
  discouraged on their own merits.

The 16 entries present when this decision was made were reviewed against the above
and contain no secrets and no raw dumps — every entry is a one-line pattern
description with a repo-relative path. That review is the evidence for *this*
commit; the rule above is what keeps every future entry safe to track.

## Consequences

- The P5→P7 bridge survives fleet worktrees and CI: a finding recorded anywhere
  reaches `main`, and `lesson-foundry --gate` can be evaluated against a real,
  shared cluster set. Wiring that gate into CI is a permitted follow-up now that
  the ledger is portable (this ADR does not itself wire CI).
- The ledger is reviewable: a finding lands in a PR diff, where a human can see
  what the prosecutor is banking and object to a bad entry before it clusters.
- A new obligation on everyone (and every tool) that appends to the ledger: keep
  entries curated prose, secret-free. A raw dump or a secret in `.adlc/findings.jsonl`
  is now a tracked-file leak, not a local-only smell. Treat a would-be secret in a
  finding the way any secret-in-source is treated.
- **The primary guarantee is the curated-prose discipline above, not an automated
  filter.** `assertPublishableFinding` (at the single ledger-write boundary,
  `appendEntries`) rejects known credential formats, long high-entropy tokens,
  multi-line output, and dump-length descriptions — but a format-based check is
  best-effort and inherently fail-open for shapes it does not know. It is a backstop
  against an obvious slip, not a substitute for writing pattern descriptions rather
  than quoting values, nor for a real secret scanner in CI.
- Because the file is inside the `.adlc/` trust boundary, edits to it are subject
  to the same trust-root review as the rest of that boundary.

## Verification

- `git check-ignore .adlc/findings.jsonl` exits non-zero — git no longer ignores
  the ledger, so `git add` tracks it.
- `scripts/test/gitignore-negations-effective.test.mjs` proves the negation is
  **effective**, not merely present: its generic assertion (every `.gitignore`
  negation must be un-ignored, via `git check-ignore` — precedence is settled by
  git, not by reading the text) now covers this path, and a dedicated named case
  pins `.adlc/findings.jsonl` specifically so a future reorder that strands the
  negation fails here rather than silently dropping the ledger from commits.
