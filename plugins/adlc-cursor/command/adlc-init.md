---
description: One-flow ADLC onboarding for Cursor — detect CLI, adlc init --harness cursor, point at CI rails-guard.
---

# /adlc-init — bootstrap ADLC in Cursor (one flow)

Preferred UX after installing the **ADLC for Cursor** marketplace plugin:

1. Detect `adlc` on PATH  
2. `adlc init --harness cursor`  
3. Wire CI `docs/ci/rails-guard.yml` as a required check  

Do **not** require `npx @adlc/cursor` for normal users. The npm scaffolder
remains for contributors / local-dev only.

## 1. Verify the toolkit

Run `adlc --version`. If not found, STOP and tell the user:

```sh
npm install -g @adlc/cli
```

Missing CLI also breaks MCP (`adlc mcp-server` via the Roots proxy) — same fix.

## 2. Initialize the shared runtime

With the marketplace plugin already installed, run **only**:

```sh
adlc init --harness cursor --json
```

This bootstraps `.adlc/` (tickets/specs contracts). Prefer marketplace-delivered
hooks/skills/commands/agents/MCP — do not copy project-local `.cursor/` files
unless the user explicitly wants the legacy scaffolder.

### Legacy / contributor fallback (optional)

```sh
npx @adlc/cursor .
```

or the packaged `adlc-cursor-scaffold` bin. Idempotent merge into
`.cursor/hooks.json`; not required for marketplace users.

## 3. Required CI control

Point the user at
[`docs/ci/rails-guard.yml`](https://github.com/voodootikigod/adlc/blob/main/docs/ci/rails-guard.yml)
as a **required** check. In-session `permission: "deny"` is best-effort;
`failClosed` stays false on ADLC hooks.

## 4. Gitignore hygiene (if needed)

Ensure `.gitignore` keeps the ticket + specs contracts while ignoring other
`.adlc/` runtime evidence (the init/scaffolder paths do this when used).

## 5. Preflight + next step

Run `adlc preflight --json` (informational). Summarize toolkit version and
remind: marketplace → `/adlc-init` → CI. Point at `/adlc-ticket` for the first
ticket.

## Honesty

- MCP: wrapper landed / channel unverified until installed-Cursor Roots proof.
- P5 agents: packaged-but-unverified until installed-Cursor fan-out proof.
- Marketplace listing URL: do not fabricate; see
  `docs/integrations/cursor.md` (Marketplace publish checklist).
