---
description: Author and triage an ADLC ticket (P0) into .adlc/tickets.json, then check it is executable.
argument-hint: [short description of the work]
---

# /adlc-ticket — author a ticket (P0 Triage)

Tickets are the contract every downstream ADLC tool reads (`coldstart`,
`model-router`, `merge-forecast`, `rails-guard`). This command turns a request
into a well-formed, self-contained ticket appended to `.adlc/tickets.json`.

The request to triage: **$ARGUMENTS** (if empty, ask the user what the ticket is
for).

## 0. Preconditions

- Ensure `.adlc/tickets.json` exists. If it does not, tell the user to run
  `/adlc-init` first (do not silently create the workspace here).
- Read the current `.adlc/tickets.json` so you know the existing ticket ids and
  can pick the next unused one.

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
  depends on it), per the ticket DAG's topological-sort contract. So there are
  two cases when wiring the new ticket's dependencies:
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

## 2. Apply the change safely, then write

The mutation model has exactly one allowed write to existing data: **adding a
prerequisite→new edge to a prerequisite ticket** (the second case in step 1).
Nothing else about an existing ticket may change. Because `.adlc/tickets.json` is
the shared contract every gate reads, the read-modify-write must be **mutually
exclusive** — never rely on "please don't run this twice". Validation happens on
the proposed **in-memory** array before any write, because the CLI gates read the
on-disk file and would otherwise only see the old state.

Run this exact protocol:

1. **Acquire a lock.** `mkdir .adlc/tickets.lock` — this is atomic, so it
   succeeds for exactly one writer and fails if another author holds it. If it
   fails, wait briefly and retry a few times; if still locked, abort and tell the
   user another ticket edit is in progress. **Guarantee release**: remove the
   lock (`rmdir .adlc/tickets.lock`) at the end, on every exit path including
   validation failure and error.
2. **Read the snapshot** of `.adlc/tickets.json` (this is now race-free — you hold
   the lock). Re-derive the next free `T<n>` from it in case it changed since
   step 0.
3. **Build the proposed array** in memory: append the new ticket; if it depends on
   an existing prerequisite T0, add the single edge `{ "to": "<new id>" }` to T0's
   `edges` (additive only — no other field of T0 changes, no reordering).
4. **Validate the proposed array in memory** (do not write yet):
   - `id` and `title` are required strings; `scope`/`rails`/`edges` are arrays;
     `duration` is a positive number.
   - every `edge.to` across all tickets resolves to an existing id; no id is
     duplicated.
   - **no dependency cycle** — trace the edges: no ticket may reach itself by
     following `edge.to` links.
   If any check fails, release the lock and report — do not write.
5. **Write atomically**: write the full JSON (2-space indent) to a temp file in
   `.adlc/` and rename it over `tickets.json`, so a crash never leaves a partial
   file. Holding the lock means no other author interleaves, so this cannot lose a
   concurrent update.
6. **Confirm post-write**: run `adlc merge-forecast --json`. If `gateFailures`
   reports a cycle (or the exit is not 0/2 as expected), restore the snapshot you
   read in step 2 (safe — you still hold the lock, so no newer write exists to
   clobber) and report the failure rather than leaving a corrupt contract.
7. **Release the lock** (`rmdir .adlc/tickets.lock`).

Trust-root note: once any ticket declares `rails`, the plugin's PreToolUse rail
hook freezes `.adlc/tickets.json` itself (it is the rail trust root, so it can't
be edited to disable enforcement). If a prior ticket already declares rails, the
write in step 5 will be denied — run this command with `ADLC_RAILS_BYPASS=1` set,
which allows the edit and records the change to the gate-manifest. Editing the
ticket set while rails are frozen is a deliberate, audited action.

Add `.adlc/tickets.lock` to the evidence-ignore set if it is not already covered.

## 3. Check executability (coldstart gate)

`coldstart` is LLM-backed, and inside Claude Code **you are the model** — there
are no API keys. Do NOT run the bare `adlc coldstart <id>` form; with no provider
configured it exits `1`. Use the prompt-only flow instead:

1. Run `adlc coldstart <id> --prompt-only`. This prints the executability-audit
   prompt (the ticket plus instructions to find gaps that would force an agent to
   ask a human) and exits `0` without calling any provider.
2. **Answer that prompt yourself**, applying its own rubric: list every genuine
   gap that would block a fresh agent (information not derivable from the repo).
3. Report the verdict:
   - No gaps → the ticket is executable; done.
   - Gaps found → summarize them and offer to revise the ticket body/scope to
     close them, then re-run the prompt-only check.

(If the user has explicitly configured an API key and prefers a real provider
call, `adlc coldstart <id> --json` returns the same verdict as exit `0`/`2`; but
prompt-only is the default in-Claude path.)

## 4. Summarize

Report the new ticket id and title, what scope/rails it declared, and the
coldstart verdict. If the ticket passed, point the user at the `adlc` discovery
skill (or `/adlc-spec`-style spec gates) for the P1 interrogation phase next.
