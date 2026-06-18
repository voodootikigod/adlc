---
description: Bootstrap the ADLC runtime (.adlc/) in this repo and verify the toolkit is installed.
argument-hint: (no arguments)
---

# /adlc-init — bootstrap the ADLC workspace

Set up the shared `.adlc/` runtime that every ADLC gate reads and writes, and
confirm the gate toolkit is reachable. Run this once per repository.

Do the following, in order, and report a concise summary at the end. Treat each
step as idempotent — never clobber an existing ticket file.

## 1. Verify the toolkit is installed

Run `adlc --version`.

- If it prints a version, the suite is installed — continue.
- If the command is **not found**, STOP and tell the user to install it first:
  ```sh
  npm install -g @adlc/cli
  ```
  Do not attempt to install it for them globally without their say-so. Once they
  confirm it is installed, re-run this command.

## 2. Create the runtime directory and ticket file

- Create the `.adlc/` directory if it does not exist.
- If `.adlc/tickets.json` does **not** exist, create it with the empty
  skeleton (exactly this content):
  ```json
  {
    "tickets": []
  }
  ```
- If `.adlc/tickets.json` already exists, leave it untouched and note that in the
  summary. Never overwrite existing tickets.

## 3. Separate the contract from the runtime evidence in git

The ticket file is the **source-of-truth contract** between tools and is worth
committing. Everything else under `.adlc/` — append-only ledgers, gate evidence,
the ticket lock, and hook runtime state — is a **runtime artifact** and should
not be. If a `.gitignore` exists (create one if it does not), ensure it ignores
all of `.adlc/` *except* the ticket file — add these two lines if absent:

```
.adlc/*
!.adlc/tickets.json
```

This negation keeps `tickets.json` tracked while ignoring all current and future
runtime files (ledgers, `lessons/`, `tickets.lock/`, …) without you having to
enumerate them. If the repo already has a blanket `.adlc/`
ignore (which would also hide `tickets.json`), point that out and ask the user
whether they want to track `tickets.json` (recommended) before changing it.

## 4. Run a preflight check

Run `adlc preflight --json` and summarize the verdict. This surfaces missing
tools, a dirty tree, or provider problems before any work fans out. A non-zero
exit here is informational for setup — report it, do not treat it as a failure of
this command.

## 5. Summarize

Report: toolkit version, whether `.adlc/tickets.json` was created or already
present, what (if anything) was added to `.gitignore`, and the preflight verdict.
Then point the user at `/adlc-ticket` to author their first ticket (P0), and note
that the `adlc` discovery skill will route them through the rest of the
lifecycle.
