# @adlc/decision-layer

Opt-in **shadow** decision layer. Asks a typed probabilistic classifier a
versioned question pack about a change and records the answers. In this version
the answers never change an ADLC outcome: no exit code, ticket, rail, routing
assignment, review requirement or verdict. They are observations, collected so a
later decision about enforcement can rest on evidence from your repository.

Nothing changes for a project that does not run the command.

---

## Usage

```
adlc decision evaluate --mode shadow --provider <jev|mock> --model <id> \
  --pack <pack-id> [--revision <rev>] [--ticket <id>] [--pr <number>] \
  [--mock-response <file>] [--json]
```

| Flag | Description | Default |
|---|---|---|
| `--mode` | `off` (does nothing) or `shadow`. Anything else is refused. | `off` |
| `--provider` | `mock` (offline), or `jev` (TypeSafe's API) | — |
| `--model` | Model identifier to request | — |
| `--pack` | Question pack ID. Shipped: `change-risk-v1` | — |
| `--revision` | Revision whose change is described | `HEAD` |
| `--ticket`, `--pr` | Join keys recorded with the run; never sent to the provider | — |
| `--mock-response <file>` | With `--provider mock`: the reply to return | fixed reply |
| `--json` | Print the run record as JSON | false |

Environment variables supply credentials and the endpoint only
(`TYPESAFE_API_KEY`, falling back to `JEV_API_KEY`; `TYPESAFE_API_URL`). They
never select a mode, provider or model.

### Exit codes

| Code | Meaning |
|---|---|
| `0` | The run was recorded, whatever the answers; or `--mode off` |
| `1` | A configuration, pack, unreadable-git-output or sanitization failure before dispatch: nothing was sent and nothing recorded. Or the record could not be written: the provider may have been asked, but the run was not recorded. |

## What is sent

Only declared metadata, after sanitization:

| Field | Source |
|---|---|
| `extensionCounts` | files changed per extension, from `git diff --numstat --find-renames` between the merge-base of `--revision` with the default branch and `--revision` (a rename counts once, under its new name) |
| `linesAdded`, `linesDeleted`, `filesChanged` | the same diff; binary files count with 0 lines |
| `ticketCategory`, `declaredRailCount` | the `--ticket` in the ticket store, or `none` |

Never source text, diff hunks, issue bodies, prompts, environment files, git
history, file paths or credentials. What the provider does receive, besides
these fields, is the pack itself: its ID and each question's ID, kind, prompt
and domain labels, since the provider cannot answer a question it is not shown.
For a project pack under `.adlc/decision-packs/` that is repository text, so
write its questions as you would anything sent to a third party. Strings are normalized, credential-shaped
values (API-key prefixes, JWTs, private-key blocks, high-entropy tokens) are
replaced with `<redacted:…>` tokens, and fields are capped at 4 KiB each and
32 KiB in total. Any sanitization failure stops the run before dispatch.

## The record

Each run appends one JSON line to `.adlc/decisions/runs.jsonl` in the
repository's main checkout, so removing a worktree keeps its records. The record
holds the revision, provider, requested model and resolved model (`null` when
the provider reported none), pack ID and hash,
the hash of the sanitized input (not the input), ticket and PR join keys, the
normalized answers, the reducer outcome (`allow`, `escalate` or `unknown`) and
the phase action it would take (`wouldAct`), status, error class, attempt count,
latency and usage. Usage keeps only the counters `inputTokens`, `outputTokens`
and `totalTokens`, each a non-negative integer; other keys a provider reports
are dropped, and a usage of any other shape makes the reply `malformed-response`.

## Question packs

Shipped packs live in `packs/<id>/pack.json`. A project may add its own at
`.adlc/decision-packs/<id>/pack.json`, but never one with a shipped ID. A pack
file may be at most 64 KiB, checked before it is read, and its description at
most 1024 characters. A
project pack is repository text, so its prompts and domain values are scanned
like the inputs: a pack carrying a credential-shaped value is refused before
anything is sent, and the whole request is held to the same 4 KiB per string and
32 KiB total.
`schemas/DecisionPack.schema.json` documents the format.

`change-risk-v1` asks two questions about the inputs above:

| ID | Kind | Domain |
|---|---|---|
| `risk` | `Choice` | `low` \| `medium` \| `high` |
| `needs-deeper-interrogation` | `Noul` | `yes` \| `no` |

It escalates when `risk` is `high` or `needs-deeper-interrogation` is `yes`,
allows only when `risk` is `low` and the answer is `no` with both probabilities
at least 0.7, and is `unknown` otherwise.

## Providers

`mock` runs fully offline. It returns the reply in `--mock-response` (a JSON
object with `simulate` set to `timeout`, `rate-limit` or `network` makes it fail
that way), or a fixed reply that reduces to `unknown`. It never derives answers
from its input.

`jev` asks TypeSafe's System One API (`https://api.typesafe.ai/v1/systemone`,
overridable with an https `TYPESAFE_API_URL`) using `TYPESAFE_API_KEY`, or
`JEV_API_KEY` when that is unset. Its tests replay live responses captured on
2026-10-08 (`test/fixtures/jev-live-2026-10-08.json`). One run is one call, so
every question in the pack must declare the same inputs, and only `Choice` and
`Noul` questions are supported (no live `Score` reply has been captured); any
other pack is refused as a configuration error (exit 1, nothing sent or recorded). TypeSafe answers a `Noul`
question with P(yes) = p, recorded as `yes` with probability p when p is at
least 0.5 (a tie counts as `yes`) and otherwise as `no` with probability 1 - p.
429, 529 and network failures are `unknown` after up to two retries; any other
5xx, or a reply that breaks off mid-body, is `unknown` without a retry; any
other non-2xx status (a redirect, a rejected key) is `error`, as is a reply that
does not report the model that answered. A key with whitespace or other
characters an HTTP header cannot carry is a configuration error.
