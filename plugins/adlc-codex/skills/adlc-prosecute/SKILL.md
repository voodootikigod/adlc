---
name: adlc-prosecute
description: Record ADLC P5 review evidence and P6 acceptance packet workflows in Codex. Use after skeptical review to record verified findings, dry-pass evidence, and behavior acceptance evidence.
---

ADLC_CODEX_SENTINEL_PROSECUTE_V1

# ADLC Prosecute

This skill does not run the reviewer by itself. Run the skeptical review first, capture the
transcript, then record the reviewer-produced evidence with `adlc prosecute`.
The transcript must name the ticket and reviewed `git-worktree:<hash>` revision that P5
records. Do not pass `--revision` in normal git worktrees; auto-resolved revisions keep
P6 staleness protection active.
The P5 input must also include `review_packet` with prompt path/hash, reviewed-input
path/hash, and `clean_worktree` equal to the reviewed revision.

For scoped P5 evidence:

```sh
adlc prosecute --input .adlc/p5-passes.json --ticket <ticket-id> --dir .adlc --json
adlc run p5 --ticket <ticket-id> --dir .adlc --json
```

P6 strict mode requires P5 evidence:

```sh
adlc behavior-diff capture --config behavior.json --out .adlc/before.json
adlc behavior-diff compare .adlc/before.json .adlc/after.json --json
adlc accept --ticket <ticket-id> --packet .adlc/packet.json --before .adlc/before.json --after .adlc/after.json --dir .adlc --json
adlc run p6 --ticket <ticket-id> --dir .adlc --json
```

The bundled docs fixture is static. Use it only with its fixture revision:

```sh
adlc prosecute --input docs/examples/p5-passes.json --ticket T1 --revision docs-example-revision --dir .adlc --json
```
