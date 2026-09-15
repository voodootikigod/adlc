---
title: backlog-groom
description: Documentation for the backlog-groom tool in the ADLC toolkit.
---

# backlog-groom

**ADLC phase: maintenance / cross-phase — backlog hygiene**

A backlog's labels are stamped once at filing and then rot. Nothing re-checks
whether an issue is still true, so a mature backlog quietly fills with issues
whose premise the code has already outgrown. `backlog-groom` verifies each
issue's premise **against the code at HEAD**, clusters issues by the package
their verified locations sit in, ranks them from what it learned, and emits a
versioned set.

> **Not yet routed through `adlc`.** Registering the verb means editing
> `packages/cli/lib/registry.mjs`, which is a frozen rail of an in-flight ticket,
> so the tool is invoked by its own binary for now and the `adlc backlog-groom`
> verb lands once that rail expires.

This package is the **read path**: it writes nothing to GitHub. The adversarial
gate, the autonomy floor and execution are the write path.

## Usage

```
backlog-groom [--profile <path>] [--cache <path>] [--no-cache]
              [--threshold <n>] [--json] [--out <path>]
```

Exit codes: `0` ran, `1` operational error. A read-only sweep has no verdict to
fail, so there is no gate-fail exit.

## Routes and verdicts

Each issue is routed by what evidence its body carries — `mechanical` (a
parseable code reference), `model` (a checkable claim with nothing parseable),
or `unverifiable` (no claim about code at all). `unverifiable` is a first-class
outcome: collapsing it into "still valid" is the false green this tool exists to
detect.

Verdicts are `valid`, `fixed`, `moved`, `unverifiable`, and `unverified` for the
model route. Three rules keep `fixed` honest, since it is the verdict that leads
to a close:

- The cited **line is a hint, never an identity** — an unrelated edit above a
  citation shifts everything below it, and a line-anchored check would report
  `fixed` for live code.
- An **elided excerpt is still a citation**. Bodies routinely quote
  non-contiguous lines, so matching is an in-order subsequence; *partial*
  survival is `unverifiable`, because changed is not fixed.
- A path **git has never tracked is not a deleted file** — it is prose shaped
  like a path.

Across several citations the order is `moved` > `valid` > `fixed`, so every
tie-break fails towards not closing.

## Profile

`.claude/backlog-groom-profile.json` holds the repo-specific facts — units,
frozen paths, label conventions, the autonomy floor the write path reads, and
`providers.decider`. It **fails closed**: an unrecognised key at any depth is an
operational error, because a config that ignores what it does not understand
hands the operator a setting they believe is in force and is not. A missing
profile is fine; the defaults are complete and conservative.

## Incrementality

A gitignored cache keyed on `(updatedAt, contentHash)`. An issue with no
referenced paths has no `contentHash` and is **never cached as `valid`** — such a
key could never be invalidated by a code change, so the cache would answer
`valid` forever after the bug was fixed.

## Honesty

Every run leads with its route distribution, and a truncated fetch says so
loudly. Relation candidates come from a similarity **filter, never evidence**;
each run reports how many pairs it excluded, because those were never judged and
they bound what the run could have found.

## What `fixed` does and does not mean

`fixed` means **every line this issue cited is gone from the file it cited**. It
does not mean the defect was fixed, and the difference matters:

- A refactor can preserve the same wrong behaviour while rewriting every quoted
  line. This tool would verdict `fixed`; the bug would still be there.
- Conversely, code can survive verbatim while the surrounding logic stops
  reaching it.

That is why `fixed` produces a close **proposal** rather than a close, why the
evidence carries the revision it was computed against and the paths it read, and
why the write path puts every proposal through a fresh-context reviewer and the
autonomy floor before anything is applied. The verdict is a strong signal for
triage, not a proof, and no part of this design treats it as one.

The evidence field is named `lastCommitTouchingPath` for the same reason: it is
the last commit to touch the file, not necessarily the commit that removed the
cited lines. Finding that would need a pickaxe search per citation, and calling
it the removing commit would be a claim the tool never checked.

## The cache is not a trust boundary

The cache is a local, gitignored performance artifact. Anyone able to write it
can inject a verdict — but anyone able to write it can also edit the code that
produces verdicts, so it adds no privilege. It follows that a cached verdict is
**not** evidence: the write path must treat proposals as things to be reviewed on
their own merits, and `--no-cache` forces full re-verification when a run needs
to stand on its own.

## The write path

`--apply` is the only mode that writes to GitHub, and it is a separate branch
rather than a flag threaded through the read run — the read path must stay
reachable with no possibility of a write, so the two never share a code path a
flag could flip.

```bash
backlog-groom --json --out groomed.json     # read-only, writes nothing anywhere
backlog-groom --apply --set groomed.json    # gated, floored, comment-first
```

Three things stand between a verdict and a closed issue, and they answer
different questions.

**The gate — is this conclusion sound?** Each proposed action is reviewed once,
in artifact mode, at `--min-confidence 0.3` rather than the tool's 0.5 default:
artifact-mode grounding halves every finding's confidence, so at 0.5 material
findings fall below the gate and the run returns a hollow approve. The reviewer
must be a provider distinct from `providers.decider`; without both declared, the
rule is unenforceable and every action demotes to a proposal.

**One shot, enforced in the core.** The verdict is recorded against
`(issue, contentHash)` and a second review of the same revision is refused. A
wrapper told "review once" will reword the artifact and ask again until it gets
an approve — that is the failure the rule exists to prevent, and instruction text
does not stop it. A changed artifact for unchanged content is itself the tell.
An issue with no `contentHash` has no revision to bind a verdict to, so it cannot
be gated at all and is never actioned.

**Only an explicit approve licenses a write.** The reviewer's contract is exit 0
approve, 2 needs-attention, 1 error. A reviewer error, a timeout and a crash all
demote: "the review could not complete" and "the review found nothing" are
opposite facts, and a truthiness check on the exit code would merge them.

**The floor — is anyone allowed to act on this at all?** `autonomyFloor` lists
action classes that always require a human regardless of the verdict, so a
sufficiently confident reviewer cannot talk past an operator's policy. Omitting
the key yields `["close"]`; only a deliberate `[]` empties the floor; an unknown
class is an operational error rather than a silently dropped entry, because
`"clsoe"` must not quietly leave closing unguarded.

Widening the floor is privileged, and is measured **against the merge base**, not
the working copy. A check that reads only the checked-out profile validates the
claim of whoever is widening it. An unreadable base floor refuses rather than
assuming an empty one — otherwise deleting the profile at the base would be the
cheapest possible widening.

## Execution is idempotent by design

Every action comments its evidence and a durable marker **first**, then acts.
Never the reverse: the trail must be on the issue before it goes quiet, so a
wrong action is self-documenting and easy to challenge.

The two writes are not atomic. A comment can land and the action then fail — rate
limit, revoked token, a human closing it first — leaving a "closing because…"
comment on an open issue. A re-run detects its own marker for that
`(issue, contentHash)` and resumes **at the action**, rather than stacking a
second identical rationale with every retry. A marker from a different revision
does not suppress the comment, because stale evidence is not this decision's
trail.

A mid-sweep failure therefore leaves a resumable state, never a half-applied one
that a retry compounds.

## Stated limits

Two things this design does **not** defend against, recorded here because a limit
nobody wrote down is indistinguishable from an oversight.

**The gate ledger is not tamper-evident.** `.adlc/backlog-groom-ledger.json` is a
local, gitignored file. Someone who can write it can add an `approve` entry and
the write path will honour it without consulting a reviewer. It is loaded
strictly — corruption is refused rather than treated as empty, so replay
protection cannot be erased by deleting the file — but a *well-formed* forged
entry is accepted.

The reason it is a limit rather than a hole: anyone who can write that file can
also edit the code that reads it. Signing entries would need a key, and this tool
deliberately has none. The one asymmetry worth naming is that the ledger is
untracked, so tampering leaves no trace in version control where a source edit
would — which is why the autonomy floor, not the ledger, is the control that
stands between a groomed set and a closed issue.

**Relations are bounded by the candidate filter's recall.** A pair the similarity
pass never surfaces is a relation the tool cannot report. The filter's threshold
and miss rate are printed with every run so the ceiling is visible rather than
implied.
