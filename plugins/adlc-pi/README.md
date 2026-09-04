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
- **Context-rot handoff gate** — a session whose context window has filled past the
  handoff band loses its mutating tools until an operator hands the work off. See
  [The handoff gate](#the-handoff-gate).
- **Ticket doctrine injection** — the active ticket's scope, rails, and spec are appended
  to the system prompt each turn (the body fenced as untrusted).
- **Native tools** — `adlc_prosecute` runs the deterministic P5 review loop in-session;
  `adlc_gate` runs the LLM-backed gates keyless through your session model.
- **Commands + footer pill** — `/ticket`, `/adlc-init`, `/adlc-accept`, and a live
  widget (ticket, context %, degraded flag, plus hints) in the footer pill.
- **Completion hints** — when a session ends with a claimed-done ticket but
  no acceptance, or when lesson-foundry/skill-rot evidence goes stale
  (`ADLC_P7_STALE_DAYS`, default 14), the next session's widget says so — the
  third widget line prioritizes `P6 pending: run /adlc-accept` ahead of
  `P7 stale:` ahead of the last-gate summary.
- **Skills** — `adlc` (phase router), `adlc-spec` (P0–P2), `adlc-rail-build` (P3–P4),
  `adlc-prosecute` (P5–P6), `adlc-distill` (P7).

## Enforcement model

Enforcement is opt-in by activating a ticket — set `ADLC_TICKET` or write
`.adlc/current-ticket.json` (tickets file overridable via `ADLC_TICKETS`). With no active
ticket the extension is inert — with one deliberate exception, the handoff gate below.
Once a ticket resolves, the extension **fails closed**: an unreadable/unparseable tickets
file or an unknown ticket id blocks all tool calls until fixed. The commit-time backstop is
the harness-agnostic CI gate `scripts/rails-guard-ci.mjs` — make it a required check.

## The handoff gate

pi reports a live context-fill percentage (`ctx.getContextUsage().percent`), and the
handoff gate watches it against three bands: **50%** warns, **60%** is the handoff band,
and **80%** is hard-degraded. Past the handoff band the session loses `write`, `edit`,
`bash`, and any third-party tool that can mutate; reads (`read`, `grep`, `glob`, `list`,
`ls`) stay open. A session that trips the band has a deny record written under
`.adlc/handoffs/denies/`, and an open record denies **every** session in the repo until an
operator clears it.

**Installing ADLC in the repo is the opt-in**, and "installed" means a **ticket store** —
`.adlc/tickets.json`, `.adlc/tickets/`, or whatever `ADLC_TICKET_STORE`/`ADLC_TICKETS` names.
That is exactly the predicate the rail guard keys on. The gate returns allow, and writes
nothing, anywhere there is no store — at any fill percent.

The store, deliberately, rather than the presence of `.adlc/`. A directory holding only
`.adlc/.deny-store` and deny markers is what the pre-1.11 bug left behind, and testing for
the directory would let those artifacts vouch for the gate that created them, leaving an
affected repo bricked by its own fix. Nor is it the store *and* a local `.adlc/`:
`ADLC_TICKET_STORE` may name a store outside the worktree, which the rail guard honours
with no local directory.

Opting in is **monotonic** for the life of the process: once a root has been seen with `.adlc`, the
gate keeps enforcing it even if the directory later disappears, so neither removing `.adlc` nor
reloading the extension is an off switch. The memory is keyed by canonical root, so it never
arms a repo that did not opt in, and reaching the same checkout by a symlink or an
un-normalized path does not forget the opt-in.

The question is whether your cwd is *inside* an ADLC repo, not whether it *is* one: the gate
walks up from the directory pi gives it and enforces against the **outermost** `.adlc` in
your checkout. A session started in `<repo>/src` is therefore covered by the same deny store
as one started at the root, and a `.adlc` created in a subdirectory cannot become a second,
empty store to step around an open deny. The walk stops at a `.git` boundary in both
directions: a checkout vendored inside an ADLC repo stays its own project, and a store above
your checkout — a stray `~/.adlc/tickets.json`, say — never silently enforces over every
repo beneath it.

The boundary is honoured only when nothing above it is a real ADLC repo — a git checkout
that also holds a ticket store. Inside one, a `.git` in a subdirectory never releases
enforcement, however convincing it looks, because nothing on disk distinguishes a forged
checkout from a real one. Above an unrelated project, the boundary still does its job: a
stray `~/.adlc/tickets.json` cannot enforce over every repo beneath it, since a home
directory is not a checkout. The cost is that a vendored checkout inside an ADLC repo
answers to that repo's deny store rather than keeping its own.

Two things about the deny are deliberate and worth knowing before you meet one:

- **It is not ticket-scoped.** An open deny is a fact about session trust, so it holds even
  with no active ticket, unlike every other gate here.
- **It is not session-scoped either.** The record lives in the repo, so starting a fresh
  session walks straight back into it. Only an operator clears it.

### Recovery

The deny message names the recovery command for the denied session, by absolute path, and
pinned to the denied repo with `--dir` — without that the CLI resolves `.adlc` from the
shell's own directory, writes the grant somewhere else and still exits 0:

```bash
<node> <…>/@adlc/context-handoff/bin/handoff.mjs bypass --session <session-id> \
  [--unbound-reason pi-handoff-operator-recovery] --dir <repo>/.adlc --write
```

The `--unbound-reason` clause appears when the deny belongs to **another** session. A
band-generated marker is unbound (`ticket_id` and `content_hash` are both null), and a
bound grant only authorizes an unbound record belonging to its own session — so against a
foreign record a bound grant is consumed and you stay denied.

Either way the grant is **one-shot**, and it is spent by the next *gated tool call* rather than
the next mutation — pi gates every tool but a read, so even a `bash pwd` consumes it. The call
after that is denied again. `adlc handoff resume` / `continue` are the durable
handoff flows. All of these, plus `write`, `supervise` and `repair`, require
`ADLC_MANIFEST_KEY`.

If you do not have the key, delete the deny state by hand from a host shell (the agent's
own shell is inside the deny-set) — this is also the only durable clear. Run it from the
repo root, and remove **every** open marker plus **both** sentinel locations:

```bash
rm -rf <repo>/.adlc/handoffs <repo>/.adlc/.deny-store
```

The deny message prints this with the paths already resolved — run that version, and
check the paths are where you expect before you do. `.adlc` may itself be a symlink to a
store outside the checkout, and a relative `rm -rf .adlc/handoffs` follows it without
showing you where it went.

Take the whole tree, and do not glob. A single open marker denies every session in the repo,
so picking off your own leaves you exactly as locked — and the denying session is usually not
the one you are sitting in. A sentinel makes an emptied `denies/` directory read as
tampered-with, and the legacy `.adlc/handoffs/.deny-store` re-creates the canonical one on
the next read, so a recipe that misses it never terminates. And
`rm .adlc/handoffs/denies/*.json` expands *through* a symlink: if `denies` has been pointed
somewhere else, the glob deletes files outside your repo, where `rm -rf` on the directory
removes the link itself.

`adlc handoff unlock` needs no key, but it reclaims a session *lock* rather than a deny, so
it will not clear this.

## Docs

Full integration guide: [docs/integrations/pi.md](https://github.com/voodootikigod/adlc/blob/main/docs/integrations/pi.md)
in the ADLC repo — surfaces, coverage table, enforcement model, and CI backstops.

MIT © Chris Williams
