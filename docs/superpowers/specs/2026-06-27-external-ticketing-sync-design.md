# External Ticketing Sync — Design

**Date:** 2026-06-27
**Status:** Approved design, pending implementation plan
**Author:** Chris Williams (with Claude)

## Problem

ADLC's ticket system is a single local JSON file (`.adlc/tickets.json`, the
`{ "tickets": [...] }` envelope read by `@adlc/core`'s `loadTickets()`). This is
correct for the gates but wrong for end users: teams already run their work in
GitHub Issues, Linear, Jira, etc. We want ADLC to plug into those systems rather
than ask users to maintain a parallel ticket store.

## Goal

Support **two-way sync** between an external ticketing system and ADLC's local
ticket store, **GitHub Issues first**, behind a **provider-agnostic adapter** so
Linear/Jira can follow. The external tracker becomes the place users author and
read work; ADLC reads tickets and writes execution outcomes back.

### Non-goals (this iteration)

- Live, on-demand querying of the external API from inside gates (breaks the
  offline contract — see Key Constraint).
- Automatic three-way merge of conflicting edits (we warn and stop instead).
- Providers other than GitHub (the interface is defined; only GitHub is built).
- A hosted service / webhooks. Sync is explicit and user-invoked.

## Key constraint: gates stay offline and synchronous

ADLC's contract is that gates run offline, synchronously, with no API keys
(`loadTickets()` is `readFileSync`). External systems are network + auth + async.

**Resolution — the git model.** All network/auth I/O lives in two explicit
commands. Between them everything is offline and synchronous:

```
GitHub Issues  --gh CLI-->  [ticket-sync adapter]  -->  .adlc/tickets.json  -->  gates (offline, sync)
     ^                       (pull / push)                      |
     +-----------------------  push outcomes  <-----------------+
```

- The external tracker is the "remote"; `.adlc/tickets.json` is the "working copy".
- `adlc ticket pull` / `push` / `sync` are the **only** networked tools in the suite.
- Because every gate already reads through the single `loadTickets()` chokepoint,
  pull just has to materialize a valid local file and **nothing else changes**.

## Decisions (locked during brainstorming)

| # | Decision | Rationale |
|---|---|---|
| D1 | Two-way sync, **staged pull → push** | Pull (import) is independently valuable and low-risk; push carries the hard problems. Ship pull first. |
| D2 | **Provider-agnostic adapter**, GitHub first | "Traditional ticketing systems" is plural; define the seam once, implement GitHub now. |
| D3 | Transport = **`gh` CLI** (not a raw token) | Reuses existing `gh` auth (consistent with `rejection-mining`); no secret management; zero npm deps. |
| D4 | Metadata home = **fenced ` ```adlc ` block in the issue body** | Provider-portable, lossless round-trip, zero setup; editor-friendly via `$schema`. |
| D5 | **Definition-driven validator + generated JSON Schema** (bedrock) | One source of truth; code validator + JSON Schema cannot drift. |
| D6 | Conflict policy = **warn-don't-merge** (MVP) | Auto-merge is the #1 source of bidirectional-sync bugs; defer it. |
| D7 | **Field ownership** split | Humans own prose/labels; ADLC owns the block, `adlc:` labels, the status comment. |
| D8 | Add **`doctor`** (tiered diagnose/repair) | Drift is the steady state of two-way sync; a health+repair gate is load-bearing. |

## Architecture

### New package: `@adlc/ticket-sync`

Standard ADLC package shape: zero runtime deps (`gh` via `child_process`),
`--json`, dry-run-by-default, exit codes `0/1/2`.

```
packages/ticket-sync/
  package.json            # @adlc/ticket-sync, zero deps, bin: adlc-ticket-sync
  README.md
  bin/
    ticket-sync.mjs       # CLI: pull | push | sync | doctor ; --json, --write, --force
  lib/
    block.mjs             # fenced ```adlc codec: parseBlock(body) / serializeBlock(prose,fields)
    provider.mjs          # adapter contract + provider registry (name -> impl)
    reconcile.mjs         # pure: reconcile(local,remote) -> {merged, conflicts}
    outcomes.mjs          # derive push-able status from .adlc/manifest.jsonl (per-ticket verdict)
    config.mjs            # read .adlc/config.json (provider, repo) + gh/git auto-detect fallback
    doctor.mjs            # check registry + runner + tiered --fix orchestration
    providers/
      github.mjs          # gh-CLI transport (INJECTED) + mapIssueToTicket / mapTicketToPatch
    checks/
      config.mjs  gh.mjs  schema-drift.mjs  block-integrity.mjs
      lock.mjs    origin.mjs  remote-drift.mjs  push-completeness.mjs
  test/
    block.test.mjs  reconcile.test.mjs  github.test.mjs
    outcomes.test.mjs  cli.test.mjs  doctor.test.mjs
```

### Touch points in existing code

- `packages/core/lib/ticket-schema.mjs` (**new**) — the bedrock declarative field
  definition (see Schema below).
- `packages/core/lib/tickets.mjs` — `validateTicket()` refactored to be
  definition-driven; add optional `origin` field. **`loadTickets()` stays
  synchronous and unchanged** (gates never learn about sync).
- `packages/core/lib/checks/` (**new**) — `ticket-validity.mjs`, `edge-graph.mjs`
  (core ticket-integrity checks the doctor registry consumes).
- `packages/core/schemas/` (**new, generated + committed**) —
  `adlc-ticket.schema.json`, `adlc-block.schema.json`.
- `packages/core/test/ticket-schema.test.mjs` (**new**) — drift gate + conformance.
- `packages/cli/lib/registry.mjs` — register the `ticket` tool -> new bin.
- `scripts/gen-ticket-schema.mjs` (**new**) — generates the JSON Schema files from
  the definition.
- `.adlc/config.json` (**new**) — `{ "ticketSync": { "provider": "github", "repo": "owner/name" } }`;
  `repo` auto-detected from the git remote / `gh repo view` when absent.
- Docs: `packages/ticket-sync/README.md`, `docs/ticket-sync.md` guide, and an
  `origin` note in `docs/ticket-authoring.md`.

### Component responsibilities (one purpose each, all offline-testable)

- `block.mjs` — the only code that knows the sentinel/serialization format.
- `providers/github.mjs` — the only code that knows `gh`; the `gh` runner is
  **injected**, so tests feed canned `--json` fixtures with zero network.
- `reconcile.mjs` / `outcomes.mjs` — pure functions, no I/O.
- `doctor.mjs` + `checks/*` — each check is an isolated unit.
- `bin` — orchestration + flags only.

## The fenced ` ```adlc ` block

The block carries ADLC execution metadata that GitHub Issues lack
(`rails`, `scope`, `edges`, `duration`, `category`, `budget`). It is wrapped in
HTML-comment sentinels so it round-trips losslessly and is unambiguous to find.
Example issue body (shown indented; in a real issue it is a fenced `adlc` block
between the sentinels):

    <!-- adlc:begin -->
    ```adlc
    # yaml-language-server: $schema=<schema-url>/adlc-block.schema.json
    v: 1
    scope: ["src/**"]
    rails: ["test/**"]
    edges:
      - to: gh-42
        contract: "src/contracts/export.schema.json"
    duration: 2
    category: feature
    budget: 200000
    ```
    <!-- adlc:end -->

- `id` and `title` are **not** in the block — they come from the issue number and
  title (`id = "gh-<number>"`, `origin = { provider, repo, number, url }`).
- Human prose lives above the `adlc:begin` sentinel and is human-owned.

### Block validation (two layers, one schema)

1. **Format layer (`block.mjs`):** sentinels present and matched; exactly one
   block; fenced content parses (YAML or JSON) to an object; a `v:` version tag;
   unknown keys preserved + warned (so a newer ADLC's extra fields are not
   clobbered when an older ADLC round-trips the issue).
2. **Field layer (reuse):** assemble the full candidate ticket (`id`+`title`+
   `origin`+block fields) and run it through the existing **`validateTicket()`**.
   No second schema; field semantics have exactly one definition.

## Schema bedrock: one definition -> both outputs

```
packages/core/lib/ticket-schema.mjs     <- THE source of truth (plain data, zero deps)
        |--> validateTicket()           <- code-authoritative validator, definition-driven
        |--> gen -> adlc-ticket.schema.json   (full ticket)
        +--> gen -> adlc-block.schema.json    (the subset legal inside ```adlc — no id/title)
```

- `scripts/gen-ticket-schema.mjs` emits both JSON Schema files from the definition.
- **Drift gate:** `core/test/ticket-schema.test.mjs` regenerates in-memory and
  asserts the committed `.schema.json` files match — same snapshot pattern as the
  release lockfile gate. The artifacts cannot diverge from the definition.
- The block schema's `$id` points at a stable URL (raw GitHub or published), so a
  block can carry `# yaml-language-server: $schema=...` for editor autocomplete +
  inline validation while authoring in the tracker.
- `validateTicket()` is refactored to iterate the definition. Existing ticket
  tests become the conformance corpus; their error-message expectations are
  preserved (or changed deliberately and called out) under TDD.

## Data flow

### Pull (external -> local)

1. `gh issue list/view --json ...` -> raw issues.
2. Split each body into human prose + the fenced block; parse the block.
3. Map issue -> ticket: `id = "gh-<number>"`, attach `origin`.
4. Reconcile with the local file (field ownership, D7), validate via
   `validateTicket()`, write atomically (reusing the `/adlc-ticket` lock +
   temp-rename protocol).
5. Block cases:
   - **No block** -> import title/body only, execution fields empty (enrichable via
     P0/P1). Not an error.
   - **Valid block** -> materialize the ticket.
   - **Present but invalid block** -> **fail closed**: report the error against that
     ticket, do not materialize it, exit `2`. Never degrade a broken `rails` block
     to "no rails."

### Work

Gates run exactly as today against `.adlc/tickets.json`.

### Push (local -> external, idempotent)

1. Re-serialize each ticket's block back into its issue body, replacing in place
   between sentinels.
2. Publish outcomes (status from `gate-manifest` evidence, e.g. P5 verdict) as
   `adlc:`-namespaced **labels-as-state** + **one bot-managed comment** keyed by a
   hidden `<!-- adlc:status -->` marker, updated in place — so re-running never
   spams duplicates.
3. A ticket with no `origin` is skipped (purely local), reported, not an error.

### Field ownership (conflict policy)

- **Human-owned:** issue title, body prose above the marker, non-`adlc:` labels.
- **ADLC-owned:** the fenced block, `adlc:` labels, the managed status comment.
- **MVP rule:** pull lets human-owned fields win; if the *fenced block* differs
  between local and remote, pull **warns and stops** (exit `2`), with `--force` to
  override. Auto-merge is explicitly deferred (D6).

## `doctor` — health + repair

Drift is the expected steady state of two-way sync, so a single command reports
"what's wrong and can I fix it." Complements `preflight` and `gate-manifest verify`.

### Three tiers of authority (escalating, opt-in)

1. **Diagnose (default, read-only):** run all checks, report findings, exit `2` if
   any errors else `0`. Mutates nothing.
2. **`--fix` (local repairs only):** apply safe, unambiguous, local corrections,
   then re-check.
3. **`--fix --write` (remote repairs):** also mutate the external tracker
   (idempotent re-push of missing labels/status comment, rewrite a recoverable
   upstream block) — same remote-write gate as `push`.

### Checks (offline always; online only when `gh` is available, else skipped)

| Check | Offline | Auto-fix tier |
|---|---|---|
| `.adlc/config.json` present + valid; provider known; repo resolvable | yes | `--fix` (scaffold / auto-detect repo) |
| `gh` installed + authenticated | probe | suggest-only |
| `tickets.json` parses + every ticket schema-valid | yes | suggest-only |
| Duplicate ids / cyclic / dangling edges | yes | suggest-only |
| Committed JSON Schema == definition (bedrock drift) | yes | `--fix` (regenerate artifact) |
| Local block malformed-but-recoverable / missing `$schema` line | yes | `--fix` (re-serialize canonical) |
| Stale `.adlc/tickets.lock` (no holder) | yes | `--fix` (age-guarded) |
| `origin` collisions (two tickets -> same issue) | yes | suggest-only |
| Local block != remote block (conflict) | online | suggest-only (never auto-merge) |
| Orphaned `origin` (issue deleted upstream) | online | suggest-only (detach vs delete = human) |
| Incomplete push (labels / status comment missing upstream) | online | `--fix --write` (idempotent re-push) |

**Fixable rule:** only auto-fix what is **deterministic and reversible-or-additive**
(regenerate an artifact, re-serialize to canonical, idempotent re-push). Anything
needing judgment — conflicts, cycles, orphans — is reported with a recommended
action, never auto-applied.

### Architecture

A **check registry**: each check is `{ name, scope, online, run(ctx) ->
{severity, findings, fixable}, fix(ctx) }`. `doctor` runs the registered set,
aggregates, and (with `--fix`) applies fixable ones and re-runs. ticket-sync
registers config/sync checks; core registers ticket-integrity checks. A future
top-level `adlc doctor` could aggregate registries.

## Error handling

ADLC contract: `0` ok · `1` operational · `2` blocked; fail closed on anything
security-relevant; never leave `.adlc/tickets.json` half-written.

**Pull**
- `gh` missing / unauthenticated -> exit `1`, actionable message.
- Network / rate-limit -> exit `1`, **zero local mutation** (build in memory,
  validate, atomic temp-rename only on full success).
- Present-but-invalid block -> fail closed (exit `2`), never degrade `rails`.
- Block conflict -> exit `2`, require `--force`.
- Reuses the `.adlc/tickets.lock` mkdir-lock; concurrent local op -> exit `1`.

**Push** (mutates real issues)
- **Dry-run by default**; `--write` required. Dry-run prints the exact body diff /
  labels / comment per issue.
- Idempotent anchors (hidden comment marker + `adlc:` labels) -> re-push converges.
- Partial failure -> best-effort, per-issue result list, exit `1` if any failed;
  re-run safely retries only the unsynced ones.

**Schema** — validation errors are structured (definition-driven); schema-file
drift is caught by the core drift test in CI, not at runtime.

## Testing (offline, per ADLC contract)

Everything is built so 100% of logic runs offline — the only code that touches
`gh` is `providers/github.mjs` via an **injected runner**; tests feed canned
`--json` fixtures.

- `block.test.mjs` — round-trip lossless, missing sentinel, garbled YAML, wrong
  types (-> `validateTicket`), unknown-key preserve+warn, `$schema`/version line
  preserved.
- `core/test/ticket-schema.test.mjs` — drift gate (committed == regenerated),
  definition-driven `validateTicket` conformance corpus (existing tests + `origin`
  + new cases), schemas structurally valid.
- `reconcile.test.mjs` — field-ownership rules, conflict -> blocked, add/update/
  remove merges.
- `github.test.mjs` — `mapIssueToTicket` from fixtures; `mapTicketToPatch` emits
  the right `gh` calls; **idempotency**: push twice against a recording fake -> the
  second run makes no mutating calls.
- `outcomes.test.mjs` — derive labels/comment from a fixture `.adlc/manifest.jsonl`.
- `cli.test.mjs` — subcommand routing, dry-run default, exit codes, `--json`,
  `--force`.
- `doctor.test.mjs` — each check with fixtures; `--fix` idempotency; exit codes.

Target 80%+ coverage; TDD throughout. The single untested edge is the thin "real
`gh`" runner (documented), consistent with other shell-boundary code.

## Implementation staging

1. **Schema bedrock** — `ticket-schema.mjs`, definition-driven `validateTicket()`,
   generator, generated schemas, drift test, `origin` field. (Foundation; no
   network.)
2. **Block codec** — `block.mjs` + tests (parse/serialize/validate). (No network.)
3. **Pull (import)** — adapter interface, GitHub provider (injected `gh`),
   reconcile, `adlc ticket pull`, config. (First user value.)
4. **Push (write-back)** — `outcomes.mjs`, idempotent push, `adlc ticket push` /
   `sync`. (Closes the loop.)
5. **Doctor** — registry + checks + tiered `--fix`, `adlc ticket doctor`. (Can
   start with the offline checks and grow.)
6. **Docs + optional hardening** — README/guide; route `prosecute`'s direct
   `tickets.json` read through `loadTickets()` for consistency now that `origin`
   exists.

## Open / optional items

- **`prosecute` direct read** (`packages/prosecute/lib/run.mjs`) bypasses
  `loadTickets()`. Optional cleanup folded into stage 6.
- **Schema `$id` hosting** — raw GitHub URL for MVP; a vanity/published URL later.
- **Tool naming** — `adlc ticket <pull|push|sync|doctor>` (package
  `@adlc/ticket-sync`). Distinct from the `/adlc-ticket` Claude Code authoring
  command; revisit if the overlap confuses users.
