---
name: backlog-groom
description: Groom a GitHub issue backlog against the code — verify each issue's cited premise at HEAD, cluster and rank what survives, and apply close/relabel/duplicate-link actions through an adversarial gate and a per-project autonomy floor. Triggers on "groom the backlog", "which issues are still real", "find fixed-but-open issues", "cluster the backlog", "prune stale issues".
---

# backlog-groom

Grooms a GitHub issue backlog **against the code**. The read half verifies every
issue's cited premise at HEAD and emits a ranked, clustered set; the write half
applies conclusions back to GitHub, each one gated by a fresh-context
adversarial review and bounded by the project's autonomy floor.

## The boundary this skill is bound by

**This skill must NEVER mutate GitHub directly.** Never close, reopen, edit,
comment on, label, lock or transfer an issue through `gh`, and never reach the
REST API with a write method. Every write flows through `backlog-groom --apply`.

This is not style. One such call here bypasses the autonomy floor, the
adversarial gate and the comment-first rule **in one call** — structurally the
same gap as an un-gated Bash surface beside a carefully-gated tool. The core is
where the rules live; a wrapper that writes is a wrapper that has none of them.
`packages/backlog-groom/test/skill-no-direct-mutation.test.mjs` enforces this, so
a mutation added here fails the suite rather than shipping.

That test matches literally, on purpose — which means this file cannot even
*quote* a mutating invocation as an example. That is a deliberate trade: a guard
that tries to tell a prohibition from an instruction is a guard with a hole in
it, and the hole is worth more than the example.

Reading is fine: `gh issue list`, `gh issue view` and any other query are how you
gather what the core cannot.

## What you supply that the core cannot

The core is deterministic and has no model. Two things need judgment:

1. **`model`-route verdicts.** An issue that makes a checkable claim but carries
   no parseable code reference routes to `model`. Read the issue against the code
   and emit the same verdict shape the mechanical route does — `valid`, `fixed`,
   `moved` — with your reasoning as the evidence.
2. **Relation judgments.** The core's similarity pass only *selects candidate
   pairs*; it never decides. You decide, and you must distinguish three outcomes,
   because they are genuinely different and none falls out of similarity:
   - **duplicate** — the same defect filed twice.
   - **related-but-distinct** — overlapping vocabulary, different defect. Two
     issues can share every keyword and be unrelated.
   - **superseded-by** — one issue's fix makes the other moot, or one is the
     *cause* of the other rather than a copy of it.

   Cite reasoning, never a score. A similarity number is a filter, never
   evidence.

## Running it

**There is no `backlog-groom` on PATH and no `adlc backlog-groom` subcommand yet.**
Registering the verb means editing `packages/cli/lib/registry.mjs`, which is a
frozen rail of an in-flight ticket, so the binary is invoked by path until that
ticket ships. Tracked in #1021.

```bash
# Read-only: verify, cluster, rank. Writes nothing, anywhere.
node packages/backlog-groom/bin/backlog-groom.mjs --json --out groomed.json

# Apply conclusions. Every action is gated and floored; nothing is applied
# without an approve from a provider distinct from the deciding one.
node packages/backlog-groom/bin/backlog-groom.mjs --apply --set groomed.json
```

When the verb lands, both become `adlc backlog-groom …` and this note goes away.

Read the run's **route distribution** before trusting its conclusions. A sweep
that mechanically verified 4% of the backlog is still useful, but it is not a
thorough one, and the number sits next to the conclusions so you cannot mistake
the second for the first. Same for `truncated`: a capped issue list is
indistinguishable from a complete one, so the run says which it had.

## What the gate will and will not do for you

- **One shot.** Each action is reviewed once, per `(issue, contentHash)`. A
  refusal **demotes the action to a proposal** — it is not an invitation to
  reword the artifact and ask again. The core records the verdict and refuses a
  second review of the same revision, so re-asking fails rather than eventually
  succeeding.
- **Only an explicit approve licenses a write.** A reviewer error, a timeout and
  a material finding all demote. "Not blocked" is not "approved".
- **No distinct provider means no autonomous writes.** If the profile does not
  declare both `providers.decider` and a different `providers.reviewer`, every
  action demotes to a proposal and the run still produces its report. That is the
  designed behaviour when quota is exhausted or only one provider is configured —
  not a failure to work around.
- **The floor outranks the reviewer.** Classes listed in `autonomyFloor` always
  require a human, however confident the review was. Widening the floor is a
  privileged change measured against the merge base, not the working copy.

## Reporting back

Lead with the route distribution and the counts, then the actions executed, then
**the actions the gate demoted and why**. The demoted set is the interesting
half: it is where the tool's judgment and an independent reviewer disagreed.
