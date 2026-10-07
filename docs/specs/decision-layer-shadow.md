# Spec — Opt-in decision layer, shadow mode only

**Status:** Draft for P1 interrogation
**Date:** 2026-10-06
**Supersedes for v1:** the shadow-mode portion of
the 2026-09-21 Jev decision-layer proposal (not in this repository); enforce mode is
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
  and the docs/registry entries every new `packages/*` directory needs. No
  `.gitignore` change: `.adlc/*` is already ignored. In particular no change to `@adlc/core`, `@adlc/prosecute`,
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

Selecting a provider without `--mode shadow` is a configuration error, and so is
selecting `jev` with no API key in the environment. An
environment variable may supply credentials and the endpoint only
(`TYPESAFE_API_KEY`, falling back to `JEV_API_KEY`; `TYPESAFE_API_URL`); it can
never select a mode, provider or model.

## Interface

```text
adlc decision evaluate --mode shadow --provider <jev|mock> --model <id> \
  --pack <pack-id> [--revision <rev>] [--ticket <id>] [--pr <number>] \
  [--mock-response <file>] [--json]
```

`--mock-response <file>` is valid only with `--provider mock`; anywhere else it
is a configuration error. The file holds the exact provider response the mock
returns, including malformed or failing ones (a JSON field `simulate` set to
`timeout`, `rate-limit` or `network` makes the mock behave as that failure), so
tests and demos can produce every outcome. Without the flag the mock returns a
fixed response, `risk: medium` and `needs-deeper-interrogation: no` at
probability 0.5, which reduces to `unknown`. The mock never derives answers
from the input, so its output can never be mistaken for a signal.

`--ticket` and `--pr` are recorded as join keys so a later calibration step can
match a signal to the outcome of the change it described. They are validated
(ticket ID shape, positive integer) and never sent to the provider.

`--revision` defaults to `HEAD` and is resolved to a full commit id.

Exit codes: 0 when the run completed and was recorded, whatever the answers;
1 for configuration, validation or sanitization failure, in which case nothing
is sent and no record is written, and 1 when the record cannot be written,
since the run was then not recorded; a provider failure is still exit 0 with status
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
- No answer obtained (timeout, 429/529, network failure) is `unknown`. A
  missing key never reaches the adapter: the CLI rejects it as configuration. An answer that arrived but is unusable (malformed, out of domain,
  resolved-model mismatch with a pinned request) is `error`. Neither is ever a
  fabricated answer.
- At most 2 retries, on 429/529 and network failure only; the attempt count is
  recorded.
- The Jev adapter is built only against a real response. Before it is written,
  one live call is made against TypeSafe's documented API with a real key, and
  the request shape and response are committed (key and account identifiers
  removed) as `packages/decision-layer/test/fixtures/jev-live-<date>.json`
  with the endpoint, model and capture date. The adapter's tests replay that
  fixture. The endpoint the earlier branch assumed,
  `https://api.typesafe.ai/v1/decisions`, is a starting point, not a fact.
  Until the fixture exists, no Jev adapter code ships: `--provider jev` is a
  configuration error naming the missing fixture, and only `mock` works.
- Both the requested and the provider-resolved model identifiers are recorded;
  an alias is allowed in shadow mode.
- The adapter cannot write tickets, branches, manifests or any file other than
  the run record.

## Input boundary

Sanitization is one deterministic component that runs before any provider is
called. The adapter accepts only its output:

```text
raw local state
  -> pack input allowlist
  -> metadata projection
  -> UTF-8 / control-character normalization
  -> secret scanner and redactor
  -> per-field and total size limits
  -> canonical sanitizedInput
  -> provider adapter
```

v1 packs are metadata-only, and every v1 input comes from a source that already
exists:

| Field | Source |
| --- | --- |
| `extensionCounts` | files changed per extension (lowercase, no dot; `none` for no extension), from `git diff --numstat` between the merge-base of `--revision` with the default branch and `--revision` |
| `linesAdded`, `linesDeleted`, `filesChanged` | the same diff; binary files count as changed with 0 lines |
| `ticketCategory` | the `category` of `--ticket` in the ticket store, or `none` without `--ticket` |
| `declaredRailCount` | the number of `rails` on `--ticket`, or `none` without `--ticket` |

An unknown `--ticket` is a configuration error (exit 1). They never send source
text, diff hunks, issue bodies, prompts, environment files, git history,
binary content, credentials or file paths.

Every input field is declared by the pack with a source, type, maximum bytes and
data classification. The component:

- keeps only the fields the pack declares and drops every other collected
  field unread, so a pack that declares a subset of the inputs sees only that
  subset (a pack declaring a field outside the input table above fails pack
  validation before any of this runs);
- rejects unknown pack versions;
- normalizes strings to UTF-8, removes NUL and other control characters, and
  sorts object keys before hashing or sending;
- applies hard limits of 4 KiB per field and 32 KiB in total; a pack may lower
  them, never raise them;
- scans every string value, including nested ones, for credential-shaped
  content: known API-key prefixes, JWTs, PEM and private-key blocks, and
  high-entropy tokens. A match is replaced with a typed token such as
  `<redacted:credential>`, and the run continues;
- stops the run before dispatch, with exit 1 and no record, if scanning,
  normalization, classification or a size check fails. There is no
  best-effort fallback to raw input.

Redaction is a privacy control, not proof that nothing sensitive remains; the
metadata-only rule is the primary boundary.

## Question packs

Default packs ship inside the package, at
`packages/decision-layer/packs/<pack-id>/pack.json`, versioned with the code. A
project may add its own at `.adlc/decision-packs/<pack-id>/pack.json`; this
repository ignores `.adlc/*`, so a project that wants its packs committed must
un-ignore that path itself. A project pack with the same ID as a shipped one is
a configuration error, never a silent override. Pack IDs match
`[a-z0-9][a-z0-9-]*`, validated offline against a shipped
`DecisionPack.schema.json`. The schema requires, per question: kind (`Choice`,
`Score`, `Noul`), the exact input fields it may see (source, type,
classification, byte limit), the answer domain, threshold and aggregation, and
the phase it describes. Validation rejects duplicate IDs, undeclared inputs,
unknown kinds, out-of-domain thresholds, unbounded fields, and any `mode` other
than `shadow`. The canonical pack hash is part of every record.

### The first pack: `change-risk-v1`

A P0/D1 risk signal. Both questions see the same declared inputs: every field
in the table under "Input boundary".

| ID | Kind | Domain | Asks |
| --- | --- | --- | --- |
| `risk` | `Choice` | `low` \| `medium` \| `high` | How risky is this change? |
| `needs-deeper-interrogation` | `Noul` | `yes` \| `no` | Should the spec get more interrogation before building? |

Aggregation, applied only when the result status is `ok`:

- `escalate` if `risk` is `high` or `needs-deeper-interrogation` is `yes`;
- `allow` only if `risk` is `low` and `needs-deeper-interrogation` is `no`,
  and both answers carry a provider probability of at least 0.7;
- `unknown` otherwise, including a missing probability.

## Reducer

Deterministic, pure, separate from the adapter:
`(status, answers, pack) -> allow | escalate | unknown`. A status of `unknown` or
`error` always reduces to `unknown`. `unknown` is never converted to `allow`.

The reducer also names the action the pack's phase would take for that
outcome, recorded as `wouldAct`. Nothing performs it in this version:

| Phase | allow | escalate | unknown |
| --- | --- | --- | --- |
| P0 triage | `keep-deterministic-triage` | `recommend-deeper-interrogation` | `record-inconclusive` |
| D1 model router | `keep-deterministic-assignment` | `recommend-one-tier-up` | `keep-deterministic-assignment` |

`change-risk-v1` declares both phases, so `wouldAct` holds one action per phase.
A pack naming any other phase fails validation.

## Run record

Each completed run appends one JSON line to `.adlc/decisions/runs.jsonl` in the
repository's main checkout, found through git's common directory, so removing a
worktree does not lose its records. The path is already ignored by `.adlc/*`:
records are local telemetry, not committed evidence, so they never enter a PR
or the rail-freeze gate's evidence checks. Each record contains: the resolved revision, provider,
requested and resolved model, pack ID and hash, the hash of the canonical
sanitized input (never of anything before sanitization, which could contain a
credential), ticket ID and PR number when given, normalized answers, reducer outcome and `wouldAct`, status, error
class, attempt count, latency and usage. No sanitized input, prompt or raw state is retained.

## Acceptance criteria

1. With no decision command run, no code path loads `@adlc/decision-layer`:
   running another verb (`adlc ticket list`) never resolves the package. verify:
   `node --test packages/decision-layer/test/isolation.test.mjs`
2. `--mode` other than `shadow`/`off`, a provider without a mode, `jev` without
   a key, `jev` without the live fixture, `--mock-response` without
   `--provider mock`, an unknown `--ticket`, and a project pack shadowing a
   shipped one each exit 1 before reading or sending anything, and write no
   record. verify: `node --test packages/decision-layer/test/cli.test.mjs`
3. The mock provider runs fully offline; the default test suite makes no network
   call (a test fails if `fetch` is reached). verify: `node --test packages/decision-layer/test/*.test.mjs`
4. (Follow-up ticket, not this one.) The Jev adapter's tests replay the
   committed live fixture; timeout, 429/529 and network failure become
   `unknown`, and malformed, out-of-domain and identity-mismatched responses
   become `error`. verify: `node --test packages/decision-layer/test/jev-adapter.test.mjs`
5. The sanitizer sends only the fields the pack declares (other collected
   fields are dropped), rejects oversize fields and totals and scanner failure
   before dispatch, and redacts credential-shaped values
   (API-key prefixes, JWT, PEM, high-entropy). verify: `node --test packages/decision-layer/test/sanitizer.test.mjs`
6. Pack validation enforces every rule under "Question packs". verify:
   `node --test packages/decision-layer/test/pack-validator.test.mjs`
7. The reducer is total over every answer/status combination and never yields
   `allow` for `unknown` or `error`. verify: `node --test packages/decision-layer/test/reducer.test.mjs`
8. A shadow run's exit code does not depend on the answers: identical exit for
   allow, escalate, unknown and error. verify: `node --test packages/decision-layer/test/evaluate.test.mjs`
9. The run record contains every field under "Run record" and no sanitized
   input. verify: `node --test packages/decision-layer/test/evaluate.test.mjs`
10. Run from a linked worktree, a record lands in the main checkout's
    `.adlc/decisions/runs.jsonl`, carries the given ticket ID and PR number, and
    that path is ignored by git. verify: `node --test packages/decision-layer/test/evaluate.test.mjs`
11. The package passes every repository guard that applies to a `packages/*`
    directory (docs and CLI registry, package references, temp-root fixtures,
    environment hermeticity, no home `.adlc`). verify: `npm run preflight`
12. No enforce-mode code ships: the only occurrence of `enforce` in
    `packages/decision-layer/lib` is the mode rejection. verify: `node --test packages/decision-layer/test/isolation.test.mjs`

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

## Decisions (P1 interrogation, round 2: premortem, 2026-10-06)

6. Default packs ship inside the package; project packs are optional and may
   not shadow a shipped ID.
7. A missing API key is a configuration error (exit 1, no record).
8. Records carry ticket and PR join keys and live in the main checkout, so
   worktree removal does not lose them. Who runs shadow evaluations, and when,
   is left for a later decision.
9. The mock provider ships first. The Jev adapter is built only after one live
   response is captured and committed as its contract fixture.
10. The input hash covers sanitized input only.

## Decisions (P2 coldstart, 2026-10-06)

11. The Jev adapter and criterion 4 are split into a follow-up ticket, started
    once someone with a TypeSafe key captures the fixture. The first ticket
    ships the mock provider and criteria 1-3 and 5-12; `--provider jev` stays a
    configuration error naming the missing fixture.
12. `change-risk-v1` asks two questions (`risk`, `needs-deeper-interrogation`)
    with the aggregation under "The first pack".
13. The spec carries its own sanitizer contract and phase-action table rather
    than referring to the earlier proposal.
14. `change-risk-v1` reads only inputs with an existing source: diff counts and
    the ticket's category and rail count. Change classification and gate/test
    summaries are dropped.
15. The mock provider returns a scripted response from `--mock-response`, or a
    fixed response that reduces to `unknown`; it never derives answers.
16. The input allowlist selects: the sanitizer keeps a pack's declared inputs
    and drops other collected fields, so a pack may declare a subset; a pack
    naming an input outside the input table is rejected by pack validation.
    (P5 prosecution, 2026-10-07.)
