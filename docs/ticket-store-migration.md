# Migrating ADLC tickets to shards

ADLC keeps existing `.adlc/tickets.json` repositories fully operational while making
`.adlc/tickets/` the default for new repositories: `adlc-init` initializes an empty
`.adlc/tickets/` directory store on a genuinely fresh repo, so `adlc ticket create --write`
succeeds immediately after init. When a legacy `.adlc/tickets.json` (or a directory store)
already exists, `adlc-init` leaves the ticket store untouched — it never creates a second
backend, which would leave the repo in the ambiguous dual-store state that gates refuse to
resolve. Converting an existing legacy repo to the directory store is a separate, explicit
step (`adlc ticket store migrate`, below); `adlc-init` does not migrate.

Migration is explicit, representation-only, and never stages or commits files. Read-only
commands warn when the legacy backend is active. An interactive writer shows a validated
plan and asks `Apply migration? [y/N]`. Declining keeps the command on the legacy backend.
JSON and non-interactive modes never prompt.

Preview and apply deliberately:

```sh
adlc ticket doctor --json
adlc ticket store migrate
adlc ticket store migrate --write --yes
adlc ticket doctor --json
git diff -- .adlc .gitignore
```

Migration requires a clean worktree. It creates `.adlc/tickets/.store.json`, one
deterministically named shard per ticket, and `.adlc/ticket-archive/.store.json`, then
removes the legacy active file only after every ticket hash and the store hash match.
It leaves no `.bak`, does not contact a network, and does not stage or commit.

Commit the migration as its own human-reviewed change. Pause or rebase ticket-writing
branches across that commit. If an interrupted migration leaves a journal, normal gates
fail closed; inspect with `adlc ticket store status` and explicitly choose
`adlc ticket store recover --complete` or `--rollback`. Before merge, rollback is also
possible by discarding only the dedicated migration diff through normal Git workflow.
After merge, use an explicit Git revert and compatible legacy export only when rolling
back the release itself.

Completion recovery idempotently establishes the canonical `ticket-migrate/apply`
binding and appends a `recover-complete` record for the same transaction and hashes.
The migration CI gate accepts either an uninterrupted apply record or that exact
two-entry recovery sequence; unrelated or differently bound evidence still fails closed.

The 1.x bridge retains `ADLC_TICKETS` and `--tickets`. Prefer `ADLC_TICKET_STORE` and
`--ticket-store`. Normal legacy operation and old overrides are removed in 2.0, while
the migration reader remains available indefinitely. Declining migration does not weaken
the mutation contract: legacy writes use the same expected-snapshot check, recovery
journal, ticket/manifest lock order, and mandatory dual-hash evidence as directory writes.
Absolute legacy override paths remain supported during 1.x. Their recovery journals may
name only the exact configured external file; a changed or redirected target is rejected.
