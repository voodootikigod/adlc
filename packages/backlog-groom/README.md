# @adlc/backlog-groom

Grooms a GitHub issue backlog **against the code**: verifies whether each issue's
premise still holds at HEAD, clusters issues by the package their verified
locations sit in, ranks them from what was learned, and emits a versioned set.

**This package is the READ path. It writes nothing to GitHub.** The adversarial
gate, the autonomy floor and execution are the write path, built separately.
Proposals are emitted for it to decide on; nothing here applies them.

> **The `backlog-groom` verb is not registered yet.** `packages/cli/lib/registry.mjs`
> is a frozen rail of an in-flight ticket, so the binary is invoked by path until that
> ticket ships — see #1021.

```bash
node packages/backlog-groom/bin/backlog-groom.mjs                 # report
node packages/backlog-groom/bin/backlog-groom.mjs --json          # the groomed set
node packages/backlog-groom/bin/backlog-groom.mjs --out set.json  # write it to a file
```

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

**That baseline is anchored to the REMOTE** (#1036). `git ls-remote --symref
origin HEAD` asks the remote for its own default branch and the commit it points
at, in one exchange, and the merge base must be reachable from that commit. Local
refs decide nothing: `git update-ref refs/remotes/origin/main HEAD` is a local
write, and a baseline the caller can move is not a baseline. Asking the remote
directly also binds the branch to the commit — an earlier version asked a forge
API for the branch name, which a different host holding a same-named repository
could answer. Every way of failing to reach the remote — no origin, an
unreachable repository, a commit that cannot be fetched, a merge base outside the
remote's history — refuses the run rather than falling back, because a fallback
would restore the hole exactly when the remote could not contradict it. Only
`--apply` reaches the remote; the read path stays as local as it was.

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

## Incrementality

A gitignored cache at `.adlc/backlog-groom-cache.json`, keyed per issue on
`(updatedAt, contentHash)`. **An issue with no referenced paths is never cached
as `valid`** — a key with no code component can never be invalidated by a code
change, and the cache would answer `valid` forever after the bug was fixed.

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
