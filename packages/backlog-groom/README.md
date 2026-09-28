# @adlc/backlog-groom

Grooms a GitHub issue backlog **against the code**: verifies whether each issue's
premise still holds at HEAD, clusters issues by the package their verified
locations sit in, ranks them from what was learned, and emits a versioned set.

**Read-only by default; `--apply` writes.** Without `--apply` the command reads
the backlog and the code and writes nothing to GitHub. With `--apply --set
<groomed.json>` it acts on a groomed set — closes and relabels — and every action
passes an adversarial reviewer, the autonomy floor and a comment-first write.
Writing also needs `ADLC_MANIFEST_KEY`: without it every action demotes to a
proposal (see [The gate ledger is signed](#the-gate-ledger-is-signed)).

```bash
adlc backlog-groom                                   # report (read-only)
adlc backlog-groom --json                            # the groomed set (read-only)
adlc backlog-groom --threshold 0.4 --out set.json    # write the set to a file (read-only)
adlc backlog-groom --apply --set set.json            # gated, floored writes to GitHub
```

The package's own binary, `backlog-groom`, takes the same flags.

| Flag | Meaning |
|---|---|
| `--profile <path>` | profile JSON (default `.claude/backlog-groom-profile.json`); refused with `--apply` |
| `--cache <path>` / `--no-cache` | the verdict cache (default `.adlc/backlog-groom-cache.json`), or skip it |
| `--threshold <n>` | relation candidate-filter threshold, 0–1 (default 0.2) |
| `--json` / `--out <path>` | emit the groomed set as JSON / write it to a file |
| `--apply` | act on a groomed set — the only mode that writes to GitHub |
| `--set <path>` | with `--apply`: the groomed set to act on |

Exit codes: `0` the run completed (including an `--apply` run whose every action
demoted to a proposal), `1` operational error. There is no gate-fail exit.

## Why it exists

A backlog's labels are stamped once at filing and then rot. Nothing re-checks
whether an issue is still true. This package answers that question mechanically
where it can, says so plainly where it cannot, and never lets "we did not look"
read as "we looked and it holds".

## The three routes

| Route | Meaning |
|---|---|
| `mechanical` | The body carries a parseable code reference — a `path:line` and/or a fenced snippet attributed to it |
| `model` | A checkable claim about code, but nothing parseable to check against |
| `unverifiable` | No checkable claim about code at all |

`unverifiable` is a first-class outcome. Collapsing it into "still valid" is the
specific false green this package exists to avoid.

## The verdicts

`valid` · `fixed` · `moved` · `unverifiable` · `unverified` (model route, not yet judged)

Three rules keep `fixed` — the verdict that leads to a close — honest:

- **The cited line is a hint, never an identity.** Any unrelated edit above a
  citation shifts every line below it, so a line-anchored comparison reports
  `fixed` for live code.
- **An elided excerpt is still a citation.** Issue bodies routinely quote
  non-contiguous lines. Matching is an in-order subsequence, and *partial*
  survival is `unverifiable` — the code changed, and changed is not fixed.
- **A path git has never tracked is not a deleted file.** It is prose that looks
  like a path, and calling it `moved` floods the report with citations this
  repository never had.
- **A cited path must be a file.** A directory at the revision is `unverifiable`:
  git would show a listing, and an excerpt never matches a listing.

Clusters and area relabels use only the citations whose own check was `valid` or
`fixed`. An issue can be `valid` on one live citation while another names a path
that never existed; that second path says nothing about where the work is.

Across several citations the precedence is `moved` > `valid` > `unverifiable` >
`fixed`, so every tie-break fails towards *not* closing. `unverifiable`
outranking `fixed` is the subtle one: an issue with one citation gone and another
that could not be checked has not been shown fixed, and closing it would act on
incomplete evidence.

## Profile

`.claude/backlog-groom-profile.json`, parsed by the core and **failing closed** —
an unrecognised key at any depth is an operational error, because a config that
silently ignores what it does not understand hands you a setting you believe is
in force and is not.

```jsonc
{
  "schemaVersion": 1,               // the only required key
  "autonomyFloor": ["close"],       // read by the write path
  "units": [{ "name": "parallax", "paths": ["packages/parallax/**"] }],
  "frozenPaths": ["packages/rails-guard/**"],
  "labels": { "priority": { "high": "P1-high" }, "areaPrefix": "area:" },
  "providers": { "decider": "anthropic", "reviewer": "openai" }
}
```

A missing profile is fine — the defaults are a complete, conservative profile.
A malformed one is not: that is a statement you made and got wrong.

The write path treats the profile as a trust root and compares it against the
merge base with the default branch: a wider `autonomyFloor`, fewer `frozenPaths`,
or different `providers`, `labels` or `units` refuse `--apply`, and `--apply`
refuses `--profile` because the baseline is read at the profile's own path.

**That baseline is anchored to the REMOTE.** `git ls-remote --symref origin HEAD`
asks the remote for its own default branch and the commit it points at, in one
exchange, and the merge base must be reachable from that commit. Local refs decide
nothing: `git update-ref refs/remotes/origin/main HEAD` is a local write and does
not move the comparison point. Every way of failing to reach the remote — no
origin, an unreachable repository, a commit that cannot be fetched, a merge base
outside the remote's history — refuses the run rather than falling back. Only
`--apply` reaches the remote; the read path stays local.

**What the remote anchor does not cover.** `origin` is whatever `.git/config`
names, and that file is local state. A caller who can rewrite it (`git remote
set-url`) can point `origin` at a repository they control, holding a commit with
a widened floor, and the baseline follows. The anchor stops a caller who can edit
the profile or move a local ref; it does not stop one who can rewrite
`.git/config`. Against that caller the ledger key is the boundary: without
`ADLC_MANIFEST_KEY` nothing is written, however the policy check went.

## The gate ledger is signed

Each entry in `.adlc/backlog-groom-ledger.json` carries an HMAC over its whole
content, keyed by `ADLC_MANIFEST_KEY` and domain-separated from every other
signed artifact (#1035). `ledgerApproves` refuses an entry whose signature is
missing, wrong, or no longer matches what it covers — including `applied`, which
decides whether a write is skipped and reported as already done.

**Writing is therefore a key-holder act.** With no key nothing can be sealed, so
every action demotes to a proposal, the run still reports what it would have
done, and it exits 0. An unattended agent proposes; closing an issue takes the
key. The signature is the one field a caller cannot compute — every other one,
`artifactDigest` included, is derivable from the action itself.

**The ledger is per-checkout state.** `.adlc/backlog-groom-ledger.json` is
gitignored, and an absent file is a first run. The one-shot rule — one review
per `(issue, contentHash)` — therefore holds within one checkout: removing the
file, or running from a fresh checkout or a new worktree, forgets every spent
review, and the same revision can be reviewed again. The signature stops a
forged approval, not a forgotten refusal. The key is the boundary: whoever holds
it can re-run from a fresh checkout and get a fresh review.

## Incrementality

A gitignored cache at `.adlc/backlog-groom-cache.json`, keyed per issue on
`(updatedAt, contentHash)`. **An issue with no contentHash is only ever cached as
`unverifiable` or `unverified`.** That covers an issue with no referenced paths
and one citing any path unreadable at the revision: its key has no code
component, so no code change can invalidate it, and a cached `valid` or `fixed`
would outlive the fix — or the revert.

## Relations

Similarity is a **candidate filter, never evidence**. Judgment decides each
candidate, and an emitted relation cites reasoning rather than a score. The
filter's recall is the ceiling on what can be found, so each run reports how many
pairs it excluded — those were never judged, and they bound what the run could
have found.

A true miss rate would need ground truth this tool does not have; reporting one
would be false precision. The excluded count is what is actually knowable.

Choose `--threshold` from those reported numbers. Because judgment is per pair,
the only useful threshold is one whose surfaced count will actually be judged,
and that count collapses steeply: measured on this repo at 381 open issues
(72,390 pairs), the `0.2` default surfaces 23,327 pairs, `0.3` surfaces 360,
`0.35` surfaces 47, `0.4` surfaces 13, `0.5` surfaces 1, and `0.6` and above
surface none. `0.4` is a reasonable starting point. The figures scale with
backlog size and title similarity, so re-measure rather than reusing them — every
run prints `relationFilter`.

## Honesty rules

Every run leads with its route distribution, and a truncated fetch says so
loudly. A sweep that mechanically verified 4% is still useful — but that number
sits next to the conclusions, because an incomplete examination must never
present as a complete one.

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
