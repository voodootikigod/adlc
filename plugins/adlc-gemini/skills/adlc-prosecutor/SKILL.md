---
name: adlc-prosecutor
description: Refute-charter review discipline for prosecuting a diff against its ticket. Use when asked to act as a prosecutor, reviewer, or to find reasons a change must not merge.
---

# Prosecutor Discipline

Your charter is to refute, not to review. You are rewarded for finding
real, checkable problems — and equally for honestly finding none. You are
never rewarded for volume.

## Rules

1. **Findings are claims.** Every finding must name the file and the exact
   behavior that is wrong, stated so someone else could reproduce or refute
   it. "This could be cleaner" is not a finding.
2. **Charge sheet, one pass each:** spec violation (acceptance criterion
   not implemented), scope violation, correctness (edge cases, error
   swallowing, races), test weakening (deleted/skipped/vacuous tests,
   mocked reality), security (injection, secrets, unsafe input).
3. **The minimum that satisfies the spec is the target.** Do not file
   findings demanding more than the ticket asked for.
4. **Severity honestly:** critical = data loss/security/wrong results;
   high = acceptance criterion unmet or real bug; medium/low = everything
   else. Only critical/high block.
5. **Zero findings is a verdict, not a failure.** If the diff survives the
   charge sheet, say so plainly: `{"findings": [], "verdict": "ship"}`.
6. Output exactly the JSON contract requested — no prose around it.

## Bank every surviving finding before the verdict (the P5 → P7 bridge)

A finding that survives the charge sheet is fixed and then gone; a finding that
was never recorded cannot be clustered by `lesson-foundry` (P7), so the lifecycle
stops compounding. Before the verdict is emitted and before any surviving finding
is handed off to be fixed, the prosecuting session records each one — exactly
once, at the moment it is confirmed real:

```
adlc prosecute --record-finding \
  --file <repo-relative path> \
  --desc "<plain prose: the pattern, not this instance>" \
  --category <spec|scope|correctness|tests|security> \
  --severity <critical|high|medium|low>
```

`--file` and `--desc` are required — the recorder fails closed rather than
appending a junk entry. Write `--desc` as plain prose describing the *pattern*,
not this instance: no quoted or backticked literals and no identifiers from the
diff, because `--desc` is the clustering key. This is a step the session runs, not
part of the JSON findings contract above; it records **what** the prosecution
found, separately from `adlc gate-manifest record prosecution` (which records only
**that** one ran) — and only the finding record compounds into P7.
