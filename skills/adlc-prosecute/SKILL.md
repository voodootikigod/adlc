---
name: adlc-prosecute
description: Prosecute a change before merge (ADLC P5) — prove the tests are load-bearing rather than hollow, make behavior change visible, measure whether review would actually catch a planted defect, and record revision-bound evidence. Use before merging, or on requests like "prosecute this change", "is this safe to merge", "are these tests real", "will review catch anything".
---

# ADLC P5 — prosecute the change

P5 asks one question: **has this change earned the merge?** Not "does it look
right" — whether the evidence that it is right actually exists. A passing suite
is not evidence if the tests would pass with the behavior removed.

Run these gates. Every tool exits `0` = gate passes, `1` = operational error,
`2` = gate fails.

## 1. Are the tests load-bearing?

```sh
adlc hollow-test --test-cmd "node --test test/"
```

Mutates the changed code and reports tests that keep passing anyway. A surviving
mutant is a test that does not test. Exit 2 means the suite is hollow where it
matters — fix the tests, not the threshold.

## 2. Is the behavior change visible?

`capture` requires `--config <behavior.json>` — the file describing which
endpoints to snapshot. Without it the command exits on an operational error
before capturing anything:

```sh
adlc behavior-diff capture --config behavior.json --out before.json   # base revision
adlc behavior-diff capture --config behavior.json --out after.json    # the change
adlc behavior-diff compare before.json after.json
```

Produces the artifact the human P6 gate reads. An "internal refactor" that moves
this output is not an internal refactor.

## 3. Would review catch a planted defect?

```sh
adlc review-calibration --review-cmd "… {base} …"
```

Injects mutants and scores whether the review command finds them. This measures
the reviewer, not the change — low recall means the review process is theater
regardless of what it reported.

## 4. Cross-model adversarial review

```sh
npx adversarial-review --providers <a,b> --verify
```

≥2 **distinct** providers, fresh context, on the risk gate. Loop
review→fix→re-review until `exit 0 = SHIP`. `--verify` refutes stale findings so
you are not fixing things that are no longer true.

Without a native plugin you have no prosecutor subagent fan-out. Compensate by
running `--prompt-only` lenses yourself in separate, clean contexts — one lens
at a time (correctness, security, contract, spec-vs-implementation, test audit),
never all five in one pass. A single context reviewing its own prior reasoning is
not an independent review.

## 5. Record the evidence

`adlc prosecute --input <passes.json> --ticket <id>` requires both flags — the
review-evidence file
recording your two consecutive dry passes. It is the evidence recorder, not a
review trigger, so invoking it without `--input` fails rather than prosecuting
anything:

```sh
adlc prosecute --input passes.json --ticket <id> --base <ref>
adlc gate-manifest record P5
```

Run `adlc prosecute --input passes.json --ticket <id> --help` — or just
`adlc --help` — for the exact `passes.json` shape before writing one.

Evidence is ticket- and revision-bound. Evidence recorded against a different
revision is not evidence for this one.

### The trust-root exception

If the change touches an **enforcement package**, a **gated-artifact producer**,
a **rails deny-path**, or a **trust-root file**, a clean *same-model* P5 is not
enough. The prosecute runner (given `--base <ref>`) exits 2 until the manifest
holds a `cross-model-review` approve from a provider **distinct from the
author**, bound to the reviewed revision:

```sh
ADLC_MANIFEST_KEY=<key> adlc prosecute record-cross-model --ticket <id> \
  --provider <p> --author-provider <a> --verdict approve
```

The key is required: the gate trusts an attestation only via its signature, so without
`ADLC_MANIFEST_KEY` this fails closed (exit 1, nothing written) instead of recording an
inert unsigned entry after your review has already been spent. The key often lives in a
gitignored `.env.local` in the main checkout, which is **absent from a git worktree** —
source it explicitly there. `--allow-unsigned` writes an unsigned entry deliberately.

Pass the **same** `--input`/`--revision` you use for the gate run: the revision
is a content hash of the worktree, and an attestation bound to a different one
does not satisfy the gate. Record an approve only after a review actually ran —
nothing in the tool verifies that it did.

You cannot self-approve this tier. If you authored the change, a different model
has to review it.

## 6. Report honestly

State each gate's exit code. If a gate failed, say so and say what it found — do
not summarize a failing prosecution as "mostly clean". A P5 that reports no
findings on a substantial change is itself a finding: check that the gates
actually ran against the right base.

Then hand to P6, the human gate: `adlc gate-manifest show` and the
`behavior-diff compare` output are what the human decides on.
