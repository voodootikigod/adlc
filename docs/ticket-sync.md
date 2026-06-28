# ADLC Ticket Sync (`@adlc/ticket-sync`)

Two-way sync between ADLC tickets (`.adlc/tickets.json`) and an external tracker —
**GitHub Issues** first. ADLC reads tickets, creates issues for local-only tickets,
and writes execution metadata back into the issue body; conversely it imports issues
(and their ADLC metadata) into tickets. Three commands span the boundary —
`pull` / `push` / `sync` — and everything between them is **offline and
synchronous**. A read-only `doctor` rounds out the surface.

The metadata GitHub Issues lack lives in a fenced JSON **block** inside the issue
body, between reserved HTML-comment sentinels; the durable sync bookkeeping lives in
a gitignored **sidecar** cache.

## Install

The package ships a single binary, `adlc-ticket-sync`:

```bash
npm i -g @adlc/ticket-sync     # or: npx @adlc/ticket-sync …
adlc-ticket-sync --help
```

It depends only on `@adlc/core` and the `gh` CLI (the GitHub provider shells out to
`gh` for all network I/O). Authenticate `gh` first (`gh auth login`).

> Throughout this guide the command is written `adlc ticket <sub>` to match the tool's
> own `--help` text; the installed executable is `adlc-ticket-sync <sub>`.

## Commands

```
usage: adlc ticket <pull|push|sync|doctor> [--write] [--force] [--allow-rail-narrowing] [--json]

  pull    import issues from the external tracker into .adlc/tickets.json
  push    write ADLC tickets/outcomes back to the tracker (update + idempotent create)
  sync    pull then push
  doctor  read-only offline health checks (config/tickets/schema/sidecar/lock)

Dry-run by default; pass --write to apply. Exit: 0 ok · 1 operational · 2 blocked.
```

### `pull` — external → local
Fetches all matching issues (explicit pagination; a capped fetch **fails closed**
rather than risk truncation-driven deletion), maps each to a ticket
(`id = gh:<owner>/<repo>#<n>`), and 3-way reconciles against the sidecar base:
remote-only change → take remote; local-only change → keep local; both changed →
**conflict** (exit 2; `--force` takes remote). Pull **unions** — local-only tickets
and out-of-selection synced tickets are preserved, never auto-deleted.

### `push` — local → external
Updates each synced issue's block (only when the canonical block actually changed),
creates issues for local-only tickets **idempotently** (see below), and renders
**display-only** status (labels + a marker-anchored comment) from the gate manifest.
A converged re-run makes **zero** mutating calls. Push runs a pre-flight permission
probe and fails early (exit 1) if write scope is missing.

### `sync` — pull then push
Composes the two: it pulls first, and a **non-clean pull aborts before push** (you
never push on top of an unreconciled pull). Pull flags compose.

### `doctor` — read-only, offline health checks
A flat list of offline checks; **read-only always** (no `--fix`, no network).
Exit 2 if any check fails, else 0. Checks:

- `.adlc/config.json` present + valid against `adlc-config.schema.json`.
- `tickets.json` loads with no errors (dup id / dangling edge / cycle / schema).
- Committed JSON Schemas == regenerated (bedrock drift / tampered install).
- Sidecar valid; no two ticket ids map to one `nodeId`; every entry has a
  `syncedHash`; no stale `pendingCreates` (a leftover may mean a create orphaned a
  remote issue). An **absent** sidecar is healthy (it is a rebuildable cache).
- Stale `.adlc/tickets.lock` (age-guarded; **reported, never removed**).

## Flag matrix

| Command | Default | `--write` | `--force` | other |
|---|---|---|---|---|
| `pull` | dry-run (print plan/diff) | apply local write | resolve a block conflict by taking **remote** (logged forensically) | `--allow-rail-narrowing` (logged) |
| `push` | dry-run (print remote ops) | perform remote edits/creates/labels/comment | — | — |
| `sync` | dry-run | pull then push | as `pull` | composes pull flags |
| `doctor` | read-only (always) | — | — | — |

`--json` is accepted on **all** commands for machine-readable output.

**Exit codes:** `0` ok · `1` operational (gh missing/auth/network/lock/truncation) ·
`2` blocked (validity failure, conflict, rail-narrowing without the flag).

## Configuration — `.adlc/config.json`

```json
{
  "ticketSync": {
    "provider": "github",
    "repo": "acme/app",
    "select": { "state": "open", "labels": ["adlc"], "query": null },
    "createLabel": "adlc",
    "statusLabels": { "p5-pass": "adlc:passed", "p5-fail": "adlc:failed", "wip": "adlc:in-progress" }
  }
}
```

- `repo` is auto-detected from the git remote / `gh repo view` when omitted.
- Default selector: open issues whose body carries an `adlc:begin` sentinel **or**
  the configured `select.labels`.
- `statusLabels` are **mutually exclusive** within the set; push renders exactly one.
- The config is schema-validated (`adlc-config.schema.json`); `doctor` re-checks it.

## The block (issue-body metadata)

A fenced JSON block between reserved HTML-comment sentinels carries the execution
fields GitHub Issues lack. The prose around it is **human-owned and preserved
verbatim**; only the JSON between the sentinels is ADLC-owned:

```
Human-authored description (preserved).

<!-- adlc:begin v=1 key=7f3a… -->
```json
{ "scope": ["src/**"], "rails": ["test/**"], "duration": 2, "category": "feature" }
```
<!-- adlc:end -->

More human prose may follow (also preserved).
```

- `v=1` (schema version) and the create idempotency `key` live **on the sentinel**.
- `$schema` inside the block is an optional editor hint, **excluded from equality**
  (its presence never causes push churn).
- Exactly one well-formed sentinel pair is allowed; zero/multiple/unbalanced → fail
  closed with the offending line named.

## Sidecar — `.adlc/ticket-sync.state.json`

All sync bookkeeping lives in a **gitignored, rebuildable cache** so routine syncs
never touch the rails trust root. It is keyed by ticket id and read by no gate:

```json
{
  "version": 1,
  "tickets": {
    "gh:acme/app#42": { "provider": "github", "repo": "acme/app", "number": 42,
      "nodeId": "I_kwDO…", "syncedHash": "<canonical-block hash>", "createKey": "<uuid>" }
  },
  "pendingCreates": { "<uuid>": { "localId": "T7", "title": "…" } }
}
```

- `nodeId` is the durable identity (stable across transfer/renumber); reconcile
  matches by `nodeId`, falling back to `provider+repo+number`.
- `syncedHash` is the 3-way base. A **missing or unparseable** base fails safe to
  **conflict** (never a silent take-remote) — so tampering with or deleting the
  sidecar can at worst force a conflict prompt.
- The sidecar is gitignored: a committed base could be pre-seeded, and it would churn
  git history. On a fresh clone it is absent and rebuilt on the next pull.

## Idempotent create + id reassignment

Creating an issue for a local-only `T<n>` ticket is the highest-blast-radius path
(it can duplicate real issues or orphan edges), so it is defended in depth:

1. A **stable sentinel `key`** (uuid) is recorded in `pendingCreates` **before** the
   remote call (crash recovery).
2. A **pre-create adoption scan** of the already-paginated issue list looks for that
   key. Exactly one match → adopt it (no duplicate). **More than one match → fail
   closed (exit 2)**; a human reconciles.
3. After create/adopt, the ticket id is reassigned `T<n>` → `gh:<owner>/<repo>#<n>`,
   **every `edges[].to` is rewritten store-wide**, and gate-manifest evidence is
   carried forward by **append-only re-attestation** (the manifest is a hash-chained,
   signable ledger — history is never rewritten).

A re-run after a lost local write re-adopts the existing issue instead of creating a
second one. Integrity comes from **convergence** (the next push overwrites drift),
not from trusting the rendered labels/comment, which are display-only.

## GitHub token scopes

Document and grant the **minimum**:

- `pull` needs **`issues:read`**.
- `push` needs **`issues:write`** (create/edit/label/comment).

Prefer a fine-grained PAT scoped to the single repo over the broad `repo` scope.
`GH_HOST` is honored for GitHub Enterprise. `push`'s pre-flight probe fails early
(exit 1) when write scope is missing.

## Rails trust root

`.adlc/tickets.json` is the rails trust root. Routine syncs leave it byte-identical
(all bookkeeping is in the sidecar), so the CI rails-guard is never involved. When a
sync genuinely changes ticket **content** (a new ticket with rails, or changed
rails/scope/edges pulled from the tracker), that change lands in `tickets.json` and
goes through the **same human review + CI gate** as any `/adlc-ticket` rail change —
that review is the authoritative protection against a malicious external edit (rail
strip, scope widen). The local `--allow-rail-narrowing` guard is early UX, not the
backstop, and is logged to the gate manifest as forensics.

## Testing

100% of the logic runs **offline** — the only code touching `gh` is the injected
runner in `lib/gh.mjs`; tests feed canned `--json` fixtures. The one untested edge,
the thin real-`gh` runner, has a single **opt-in live smoke** that is not part of the
default suite:

```bash
ADLC_TICKET_SYNC_LIVE=1 ADLC_TICKET_SYNC_REPO=owner/repo \
  node scripts/ticket-sync-smoke.mjs
```

It is **read-only** (only `gh issue list` + an offline dry-run pull; it never
creates, edits, labels, or comments) and **skips with exit 0** unless
`ADLC_TICKET_SYNC_LIVE=1` is set, so it is safe to invoke anywhere.

## Deferred (follow-up specs)

`doctor` auto-repair (`--fix`) and online checks (remote drift, orphaned origin,
incomplete push); a provider registry; multi-repo selection. The id space is already
repo-qualified, so multi-repo needs no id change later.
