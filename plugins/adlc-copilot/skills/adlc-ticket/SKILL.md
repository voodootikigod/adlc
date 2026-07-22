---
name: adlc-ticket
description: Author and triage an ADLC ticket (P0) through the canonical ticket store, then check it is executable.
---
<!-- ADLC_COPILOT_SENTINEL_TICKET_V1 -->

# adlc-ticket — author a ticket (P0 Triage)

Tickets are the contract every downstream ADLC tool reads (`coldstart`,
`model-router`, `merge-forecast`, `rails-guard`). This skill turns a request
into a well-formed, self-contained ticket through `adlc ticket`. It supports
both the sharded store and the 1.x legacy bridge.

The request to triage is the work the user described. If none is given, ask the
user what the ticket is for.

## 0. Preconditions

- Run `adlc ticket store status --json`. If no store exists, tell the user to run
  `/adlc-init` first (do not silently create the workspace here).
- Run `adlc ticket list --json` to inspect existing IDs and hashes. If the
  interactive command offers legacy migration, show the plan and honor the
  human's answer; decline continues on legacy storage.

## 1. Shape the ticket

A ticket must be **executable without guesswork** (that is exactly what
`coldstart` will check). Gather or infer:

- **id** — the next free `T<n>` (T1, T2, …); must be unique in the file.
- **title** — one line, imperative.
- **body** — full, self-contained ticket text: what to build, the acceptance
  criteria with concrete verification methods, and any context an agent needs.
  Do not assume the agent can see this conversation.
- **scope** — array of file globs this ticket may touch (e.g. `["src/auth/**"]`).
- **rails** — array of frozen paths that must NOT change during the build (e.g.
  `["test/auth/**"]`). Declaring rails here is what later lets the rail-guard
  gate block edits to them. Default to `[]` if none.
- **edges** — ordering constraints. Direction is **prerequisite → dependent**:
  an edge `{ "to": "TX", "contract": "src/types/auth.d.ts" }` lives on the
  *prerequisite* ticket and means **that ticket must complete before TX** (TX
  depends on it), per the ticket DAG's topological-sort contract. Two cases when
  wiring the new ticket's dependencies:
  - *Existing tickets depend on the new one* → add `{ "to": "<existing id>" }`
    edges to the **new** ticket (those ids already exist, so they validate).
  - *The new ticket depends on an existing prerequisite T0* → the edge must live
    on **T0** as `{ "to": "<new id>" }`. Do NOT put a reversed edge on the new
    ticket. Step 2 permits this single additive edit to T0.

  Default `[]` when the ticket has no ordering relationship.
- **duration** — relative build-time estimate, positive number (default `1`).
- **category** — free-form routing hint (e.g. `feature`, `bugfix`, `refactor`).
- **budget** — optional token budget (omit if unknown).

If anything required for a *self-contained* ticket is ambiguous, ask the user
rather than guessing — a vague ticket fails `coldstart`.

## 2. Apply the change safely through the store service

Write the proposed full ticket document to a temporary JSON file outside the
tracked store. Preview it with `adlc ticket create --input <file> --json`; show
the dry-run plan, validation, graph effects, file operations, and after hash.
Only after the human accepts the plan run the same command with `--write`.
Never directly edit `.adlc/tickets.json` or shard files, and never stage or
commit the result. Existing-prerequisite edge updates use `adlc ticket update`
with the current `ticketHash` supplied via `--expect`.

The canonical service owns locking, full-graph validation, compare-and-swap,
journaling, recovery, and evidence. If it reports `RECOVERY_REQUIRED`, stop and
ask the human to choose `adlc ticket store recover --complete` or `--rollback`.

The old flat-file lock/read/validate/atomic-write algorithm is superseded by the
service commands above and **must not be performed by an agent** — the service
handles locking and validation for you.

**Trust-root note.** Once any ticket declares `rails`, the plugin's `preToolUse`
rails-guard hook freezes `.adlc/tickets.json` itself (it is the rail trust root,
so it can't be edited to disable enforcement). The canonical way to change the
ticket set is the `adlc ticket` CLI, which locks and validates for you. If a
prior ticket already declares rails and you must make a deliberate direct edit,
set `ADLC_P4_ENFORCEMENT=0` for that operation — this is the escape the copilot
rails-guard honors. Note it is a **blunt disable** of the in-session hook, not
Claude Code's audited `ADLC_RAILS_BYPASS=1` (which the copilot hook does **not**
implement); the audit trail for the change is therefore the `rails-guard-ci` gate
plus git history, not a gate-manifest bypass record. The in-session hook enforces
headless (its deny-ask defaults to deny) unless the session runs with
`--allow-all-tools`; the CI `rails-guard-ci` gate is the unbypassable backstop.

## 3. Warn (don't fail) if the repo's formatter/linter would reformat the write

The write just changed `.adlc/tickets.json` on disk. If the repo's formatter or
linter is not excluding `.adlc/` (see `/adlc-init`), this file can go on to
silently red the next PR. Check now, non-blocking:

1. Read `package.json` at the repo root. Look for a `scripts.check` entry, else a
   `scripts.lint` entry (in that order). If neither exists, skip this step silently.
2. Detect the package manager from the lockfile present: `pnpm-lock.yaml` → `pnpm`,
   `yarn.lock` → `yarn`, `bun.lockb` → `bun`, else `npm`.
3. Run that check **scoped to the ticket file** if the tool supports a path argument
   (e.g. `<pm> exec biome check .adlc/tickets.json`, `<pm> exec eslint
   .adlc/tickets.json`, `<pm> exec prettier --check .adlc/tickets.json`). If you
   can't confidently scope it, run the full `<pm> run check` (or `lint`) instead.
4. If the check **fails**, do NOT undo the write or treat this as a failure. Warn
   plainly: the ticket was written, but the formatter/linter flagged
   `.adlc/tickets.json` — once this ticket declares `rails`, the file becomes a
   frozen trust root that can't be reformatted on a branch without tripping
   `rails-guard`. Point them at `/adlc-init` to add a permanent `.adlc/` exclusion.
5. If the check passes (or no script was found), continue silently.

## 4. Check executability (coldstart gate)

`coldstart` is LLM-backed, and inside the GitHub Copilot CLI **you are the model**
— there are no API keys. Do NOT run the bare `adlc coldstart <id>` form; with no
provider configured it exits `1`. Use the prompt-only flow instead:

1. Run `adlc coldstart <id> --prompt-only`. This prints the executability-audit
   prompt (the ticket plus instructions to find gaps that would force an agent to
   ask a human) and exits `0` without calling any provider.
2. **Answer that prompt yourself**, applying its own rubric: list every genuine gap
   that would block a fresh agent (information not derivable from the repo).
3. Report the verdict:
   - No gaps → the ticket is executable; done.
   - Gaps found → summarize them and offer to revise the ticket body/scope to close
     them, then re-run the prompt-only check.

(If the user has explicitly configured an API key and prefers a real provider call,
`adlc coldstart <id> --json` returns the same verdict as exit `0`/`2`; but
prompt-only is the default in-Copilot path.)

## 5. Summarize

Report the new ticket id and title, what scope/rails it declared, the
formatter/linter check result from step 3 (pass, warned, or skipped/no script), and
the coldstart verdict. If the ticket passed, point the user at the `adlc`
phase-routing skill for the P1 interrogation phase next.
