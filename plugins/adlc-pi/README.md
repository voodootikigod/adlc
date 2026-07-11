# @adlc/pi

ADLC ([Agentic Development Lifecycle](https://www.agenticlifecycle.ai)) integration for the
[pi](https://pi.dev) terminal coding agent: a native TypeScript extension that enforces
frozen rails, ticket scope, and undeclared-suppression reverts in-session, plus native
`adlc_prosecute` / `adlc_gate` agent tools and the ADLC lifecycle skills.

## Install

```sh
# 1. The gate toolkit (the skills shell out to the `adlc` binary)
npm install -g @adlc/cli

# 2a. Register for one project — lands in .pi/, auto-installs for every teammate
#     on trusted startup (the best team-install story of the six integrations):
pi install -l npm:@adlc/pi

# 2b. …or user-global (~/.pi/agent/npm/…), available in every repo you open:
pi install npm:@adlc/pi
```

Then run `/adlc-init` inside pi to finish the repo scaffold (`.adlc/`), or scaffold from a
checkout with `adlc init`. `pi install` records the package in your `settings.json`
`packages` array so it re-installs deterministically.

### From a source checkout

Before the first npm release ships (or when hacking on the extension itself), load it by
path instead:

```sh
pi --extension /path/to/adlc/plugins/adlc-pi/index.ts
```

Requires Node ≥ 22.19 (the pi floor). Peer dependency: `@earendil-works/pi-coding-agent`
— tested against 0.80.3; the manifest pins `"*"` and compatibility is tracked here rather
than in a version range.

## What you get

- **Proactive rail gate** (`tool_call`) — blocks `write`/`edit`/`bash` before it touches
  disk when the target is a frozen rail, out of the ticket's scope, or an ADLC trust root.
  Bash writes (redirects, `tee`, `rm`/`mv`/`cp`, in-place `sed`, mutating `git`, interpreter
  file-write APIs) are recognized and rail-checked.
- **Reactive revert gate** (`tool_result`) — restores the pre-tool snapshot on a rail
  violation and scans added lines for undeclared suppression markers, delegating
  operative-vs-inert classification to `@adlc/rails-guard`.
- **Build-gate + flail backstops** — a degraded (context-rot) session on a high-risk
  ticket is denied its build until an audited override is recorded; repeated errors, scope
  churn, and oversized logs surface as advisories.
- **Ticket doctrine injection** — the active ticket's scope, rails, and spec are appended
  to the system prompt each turn (the body fenced as untrusted).
- **Native tools** — `adlc_prosecute` runs the deterministic P5 review loop in-session;
  `adlc_gate` runs the LLM-backed gates keyless through your session model.
- **Commands + footer pill** — `/ticket`, `/adlc-init`, `/adlc-accept`, and a live status
  pill for the active enforcement context.
- **Skills** — `adlc` (phase router), `adlc-spec` (P0–P2), `adlc-rail-build` (P3–P4),
  `adlc-prosecute` (P5–P6), `adlc-distill` (P7).

## Enforcement model

Enforcement is opt-in by activating a ticket — set `ADLC_TICKET` or write
`.adlc/current-ticket.json` (tickets file overridable via `ADLC_TICKETS`). With no active
ticket the extension is inert. Once a ticket resolves, the extension **fails closed**: an
unreadable/unparseable tickets file or an unknown ticket id blocks all tool calls until
fixed. The commit-time backstop is the harness-agnostic CI gate `scripts/rails-guard-ci.mjs`
— make it a required check.

## Docs

Full integration guide: [docs/integrations/pi.md](https://github.com/voodootikigod/adlc/blob/main/docs/integrations/pi.md)
in the ADLC repo — surfaces, coverage table, enforcement model, and CI backstops.

MIT © Chris Williams
