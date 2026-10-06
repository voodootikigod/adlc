# Spec — Opt-in decision layer, shadow mode only

**Status:** Draft for P1 interrogation
**Date:** 2026-10-06
**Supersedes for v1:** the shadow-mode portion of
[jev-opt-in-decision-layer.md](./jev-opt-in-decision-layer.md); enforce mode is
out of scope here and needs its own spec.

## Summary

Add `@adlc/decision-layer`: an opt-in, advisory way to ask a typed probabilistic
classifier (Jev first) a versioned set of questions about a change, and record
the answers. In this version the answers can never change an ADLC outcome. They
are observations, collected so a later decision about enforcement can be made on
evidence from this repository rather than on vendor confidence.

Nothing changes for a project that does not run the new command.

## Goals

1. A provider-neutral adapter contract for typed decisions, with Jev over native
   `fetch` as the first provider and an offline mock provider for tests.
2. Versioned, repository-owned question packs that declare exactly which
   metadata each question may see.
3. A deterministic pre-dispatch sanitizer: nothing leaves the machine that the
   pack did not declare, and nothing that fails scanning or size limits.
4. A deterministic reducer that maps answers to `allow | escalate | unknown`
   and records which phase action it *would* take, without taking it.
5. A record of every run, sufficient to compare the signal against real outcomes
   later.

## Non-goals

- Enforce mode, or any path by which a decision changes an exit code, ticket,
  rail, routing assignment, review requirement, or merge verdict.
- Any change outside `@adlc/decision-layer`, except registering its CLI verb
  (and the docs/registry entries every new `packages/*` directory needs) and
  adding `.adlc/decisions/` to `.gitignore`. In particular no change to `@adlc/core`, `@adlc/prosecute`,
  `@adlc/model-router`, `@adlc/gate-manifest`, or any trust-root path.
- Calling the decision layer from an existing gate (P0, D1, P5, C8). Shadow
  runs are invoked explicitly, alongside those gates, not from inside them.
- Sending source text, diff hunks, issue bodies, prompts, environment files,
  git history, file paths, or credentials to a provider.
- Adding a runtime dependency (the TypeSafe SDK needs Node 20; ADLC supports 18).
- Calibration scoring (C8 integration). This version only records the data a
  later calibration step needs.

## Operating modes

| Mode | Default | Network | Effect on ADLC |
| --- | --- | --- | --- |
| `off` | yes | never | none |
| `shadow` | no | only when selected | records a signal; cannot block, promote or route |

Any other mode value, including `enforce`, is a configuration error (exit 1)
before anything is read or sent.

`--mode off` is a no-op: exit 0, nothing read, nothing sent, no record.

Selecting a provider without `--mode shadow` is a configuration error. An
environment variable may supply credentials and the endpoint only
(`TYPESAFE_API_KEY`, falling back to `JEV_API_KEY`; `TYPESAFE_API_URL`); it can
never select a mode, provider or model.

## Interface

```text
adlc decision evaluate --mode shadow --provider <jev|mock> --model <id> \
  --pack <pack-id> [--revision <rev>] [--json]
```

`--revision` defaults to `HEAD` and is resolved to a full commit id.

Exit codes: 0 when the run completed and was recorded, whatever the answers;
1 for configuration, validation or sanitization failure, in which case nothing
is sent and no record is written; a provider failure is still exit 0 with status
`unknown`/`error` recorded, since shadow output never gates.

## Adapter contract

```text
evaluateDecision({ provider, model, pack, sanitizedInput, timeoutMs, revision })
  -> { status: "ok" | "unknown" | "error",
       answers: [{ id, kind, value, probability?, confidence? }],
       requestedModel, resolvedModel, packHash, latencyMs, usage?, errorClass? }
```

- Exactly one answer per declared question; a missing, duplicate, extra,
  malformed or out-of-domain answer makes the whole result `error`.
- No answer obtained (timeout, 429/529, network failure, missing key) is
  `unknown`. An answer that arrived but is unusable (malformed, out of domain,
  resolved-model mismatch with a pinned request) is `error`. Neither is ever a
  fabricated answer.
- At most 2 retries, on 429/529 and network failure only; the attempt count is
  recorded.
- The Jev adapter posts to `https://api.typesafe.ai/v1/decisions` by default
  (to be confirmed against TypeSafe's API documentation before the adapter is
  built; the earlier branch used it but never made a live call).
- Both the requested and the provider-resolved model identifiers are recorded;
  an alias is allowed in shadow mode.
- The adapter cannot write tickets, branches, manifests or any file other than
  the run record.

## Input boundary

Unchanged from the parent spec's "Input boundary and sanitization contract":
pack allowlist → metadata projection → UTF-8/control normalization → secret
scanner and redactor → per-field (4 KiB) and total (32 KiB) limits → canonical
`sanitizedInput`. Any failure stops the run before dispatch; there is no raw
fallback. v1 packs are metadata-only (change classification, extension counts,
line counts, ticket risk metadata, deterministic gate/test summaries).

## Question packs

Stored only at `.adlc/decision-packs/<pack-id>/pack.json`, ID matching
`[a-z0-9][a-z0-9-]*`, validated offline against a shipped
`DecisionPack.schema.json`. The schema requires, per question: kind (`Choice`,
`Score`, `Noul`), the exact input fields it may see (source, type,
classification, byte limit), the answer domain, threshold and aggregation, and
the phase it describes. Validation rejects duplicate IDs, undeclared inputs,
unknown kinds, out-of-domain thresholds, unbounded fields, and any `mode` other
than `shadow`. The canonical pack hash is part of every record.

The first pack is `change-risk-v1` (P0/D1 risk signal).

## Reducer

Deterministic, pure, separate from the adapter:
`answers -> allow | escalate | unknown`, plus the phase action the parent
spec's table would assign. In shadow mode that action is recorded as
`wouldAct`, and nothing performs it. `unknown` is never converted to `allow`.

## Run record

Each completed run appends one JSON line to `.adlc/decisions/runs.jsonl` in the
current checkout. The directory is gitignored: records are local telemetry, not
committed evidence, so they never enter a PR or the rail-freeze gate's
evidence checks. Each record contains: revision and state hash, provider,
requested and resolved model, pack ID and hash, sanitized-input hash (not the
input; the state hash is the hash of the metadata projection before
redaction), normalized answers, reducer outcome and `wouldAct`, status, error
class, attempt count, latency and usage. No sanitized input, prompt or raw state is retained.

## Acceptance criteria

1. With no decision command run, no code path loads `@adlc/decision-layer`, and
   no existing test changes. verify: `npm test` on the branch matches main
   outside `packages/decision-layer`.
2. `--mode` other than `shadow`/`off`, and a provider without a mode, exit 1
   before reading or sending anything. verify: `node --test packages/decision-layer/test/cli.test.mjs`
3. The mock provider runs fully offline; the default test suite makes no network
   call (a test fails if `fetch` is reached). verify: `node --test packages/decision-layer/test/*.test.mjs`
4. Jev responses are schema-validated; timeout, 429/529, malformed and
   identity-mismatched responses become `unknown`/`error` and are recorded.
   verify: `node --test packages/decision-layer/test/jev-adapter.test.mjs`
5. The sanitizer rejects undeclared fields, oversize fields and totals, and
   scanner failure before dispatch, and redacts credential-shaped values
   (API-key prefixes, JWT, PEM, high-entropy). verify: `node --test packages/decision-layer/test/sanitizer.test.mjs`
6. Pack validation enforces every rule under "Question packs". verify:
   `node --test packages/decision-layer/test/pack-validator.test.mjs`
7. The reducer is total over every answer/status combination and never yields
   `allow` for `unknown` or `error`. verify: `node --test packages/decision-layer/test/reducer.test.mjs`
8. A shadow run's exit code does not depend on the answers: identical exit for
   allow, escalate, unknown and error. verify: `node --test packages/decision-layer/test/evaluate.test.mjs`
9. The run record contains every field under "Run record" and no sanitized
   input. verify: `node --test packages/decision-layer/test/evaluate.test.mjs`
10. `.adlc/decisions/` is ignored by git, and a configuration failure writes no
    record. verify: `node --test packages/decision-layer/test/evaluate.test.mjs`
    (asserts `git check-ignore .adlc/decisions/runs.jsonl` succeeds and the log
    is absent after an exit-1 run)

## Decisions (P1 interrogation, round 1, 2026-10-06)

1. Run records go to a plain gitignored log, not the signed C11 manifest. No
   `gate-manifest` or other trust-root code changes.
2. No cache: one provider call per run, plus bounded retries.
3. No retention of sanitized input, including for diagnostics.
4. Write fresh against these criteria. A piece of the earlier
   `feat/jev-opt-in-decision-layer` branch may be ported only if it passes these
   tests unchanged and carries no enforce-mode code.
5. Failure classification: no answer obtained is `unknown`; an unusable answer
   is `error`.
