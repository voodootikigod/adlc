# Integration Plan: Deeply and Natively Integrating ADLC with the Pi Harness

This document outlines the architectural plan for natively and deeply integrating the **Agentic Development Lifecycle (ADLC)** toolkit and lifecycle with the **Pi Coding Agent Harness** (https://pi.dev). 

---

## Shipped vs design intent

Nothing below is claimed shipped unless it has a runtime caller in
`plugins/adlc-pi/` today. The phased plan for closing the gaps is
[docs/specs/pi-native-flush.md](../specs/pi-native-flush.md).

| Capability | Status |
| :--- | :--- |
| Ticket doctrine appended to the system prompt each turn (§3.3) | **Shipped** — appends to pi's assembled prompt (`event.systemPrompt + block`; the result field *replaces*, so appending is load-bearing) |
| Proactive `tool_call` gate: rails + scope on `write`/`edit`, codex-parity shell ladder on `bash` (§3.1) | **Shipped** — primitives delegated to `@adlc/core`; symlink-aware rail resolution |
| Reactive `tool_result` gate: snapshot-scoped rail restore + operative-only suppression scan (§3.2) | **Shipped** — restores the pre-tool snapshot, never `HEAD`; no `git add -N` |
| Live ticket lifecycle (`turn_start` reload) + `/ticket` + footer pill (§3.4) | **Shipped** |
| Live deny proof in CI (`scripts/pi-live-deny.mjs`, scripted stub provider, real `pi --mode rpc`) | **Shipped** — required-job step on the Node 22 leg |
| Build-gate + flail backstops (§Phase 2) | **Shipped** — degraded high-risk builds denied w/o audited override; flail advisories |
| Evidence rail + custom-tool coverage (§Phase 2) | **Shipped** — `.adlc/`/`.omo/` stay writable; non-core file-write tools are rail-checked |
| Context-rot handoff deny on live context fill (§3.5) | **Shipped** — pi's real `getContextUsage().percent` drives the bands; contained to repos that installed ADLC |
| Command suite + scaffolder + footer widget (§Phase 3) | **Shipped** — `/ticket`, `/adlc-ticket`, `/adlc-init`, `/adlc-approve-spec`, `/adlc-accept`, `/adlc-rollback`, prompt templates, ticket/verdict widget |
| Native `adlc_prosecute` tool: deterministic P5 loop (§4) | **Shipped** — in-session fan-out → verify → loop-until-dry over write-disabled children; live proof `scripts/pi-live-prosecute.mjs` (required, Node 22 leg) |
| `TICKET-DONE` completion listener → prosecution nudge (§4) | **Shipped** |
| Native `adlc_gate` tool + compaction defense (§Phase 4) | **Shipped** — LLM-backed gates keyless via the session model; rail context survives compaction |
| P6 integrate + `/adlc-accept` + rollback (§Phase 4) | **Shipped** — accept is command-driven; rollback path lands the revert |
| npm publication: `@adlc/pi` release-ready + folds into lockstep `/release` (§5) | **Shipped + published** — `@adlc/pi` is on npm, so the `pi install npm:@adlc/pi` (or project-scoped `pi install -l npm:@adlc/pi`) one-liner works today. Version-matrix smoke (`scripts/pi-version-matrix.mjs`, weekly cron) tracks upstream pi drift |
| P6 `session_shutdown` auto-capture (§2 table) | **Design intent** — acceptance is `/adlc-accept`-driven today |
| In-harness scheduled P7 distillation (§2 table) | **Design intent** — pi has no `/schedule`; CI cron is the substrate |

---

## 1. Thesis: The Synergy of ADLC and Pi

* **Pi's Philosophy:** A minimal, highly customizable terminal coding harness. It intentionally skips built-in complex orchestrators, subagents, and rigid planning modes, opting to let developers extend the harness via TypeScript Extensions, Skills, Prompt Templates, and Themes.
* **ADLC's Philosophy:** A development lifecycle built from the ground up to defend against model-specific failure modes (Premature Satisfaction **[F1]**, Sycophancy **[F2]**, Context Rot **[F3]**, Confident Hallucination **[F4]**, Reward Hacking **[F5]**, etc.) using deterministic, machine-checkable gates.

By integrating the two, we get the best of both worlds:
1. **Interactive Fluidity:** The developer works in Pi's high-fidelity terminal UI (TUI) with real-time feedback, session branching (`/tree`), and interactive tools.
2. **Rigorous Enforcement:** Behind the scenes, a native ADLC Pi Extension acts as a security officer, proactively blocking frozen rail edits, validating added lines for unapproved suppressions, injecting ticket scopes directly into the system prompt, and enforcing convergence bounds.

---

## 2. Integration Architecture: ADLC as a Native Pi Extension

Rather than wrapping Pi in brittle bash wrappers or external regex hooks, we can integrate the ADLC suite using Pi’s native **Extension API** (`ExtensionAPI`).

Here is how each ADLC lifecycle phase (P0–P7) maps to Pi's extensibility vectors:

| ADLC Phase | Mechanism / Tool | Native Pi Integration Vector | Description |
| :--- | :--- | :--- | :--- |
| **P0 Triage** | `adlc preflight` | Slash command `/adlc:triage` | Classifies incoming requests; sets up the initial project environment. |
| **P1 Interrogate** | `adlc parallax` & `spec-lint` | Prompt Templates & Custom UI | Uses `ctx.ui.select` and `ctx.ui.confirm` to resolve specification ambiguities with the developer. |
| **P2 Decompose** | `adlc coldstart` & `model-router` | Event `session_start` | Resolves active ticket metadata, registers ticket scope/rails, and automatically routes tasks to appropriate model tiers. |
| **P3/P4 Rail & Build** | `adlc rails-guard` | Event `tool_call` & `tool_result` | Proactively blocks edits to frozen files and reactively reverts unallowed suppression markers via git. |
| **P5 Prosecute** | `adlc prosecute` & `adversarial-review` | Pi SDK / Headless Subagents | Spawns parallel, refute-chartered sub-sessions with a fresh context to run multi-pass reviews. |
| **P6 Integrate** | `adlc behavior-diff` | Event `session_shutdown` / Command `/integrate` | Captures behavior diffs, prompts developer for behavioral acceptance, and registers gate-manifest entries. |
| **P7 Distill** | `adlc lesson-foundry` | Scheduled background task (`/schedule`) | Periodically runs lesson-foundry and skill-rot to mine patterns into deterministic lints and fresh skills. |

---

## 3. Core Implementation Design

The shipped package lives under `plugins/adlc-pi` (thin typed `index.ts` +
`lib/*.mjs`, every rail/glob/ticket/shell primitive delegated to `@adlc/core`
per ADR 0004). Key mechanisms:

### 3.1 Proactive Gating via `tool_call` (P4 Rail Freeze)
To prevent the model from reward hacking **[F5]** and modifying frozen rails (like test suites or API contracts), the extension intercepts tool executions *before* they touch the disk:
* Checks the event type: `write`, `edit`, or mutating `bash` commands.
* Resolves targeted file paths and matches them against `ticket.rails` glob patterns.
* Blocks execution with a descriptive reason if a violation is detected.

### 3.2 Reactive Gating with Snapshot Revert via `tool_result` (P3/P4 Suppression Gate)
To catch undeclared suppression markers (e.g. `@ts-ignore`, `eslint-disable`, `.skip(`) added by the model to bypass compiling/testing:
* At `tool_call` time the extension snapshots the target file (for `write`/`edit`) or the frozen-rail file set (for allowed mutating `bash`), so verification is scoped to what **this call** changed — pre-existing user edits are never attributed to the agent.
* When the tool returns, added lines are computed against the snapshot and scanned for suppression markers, delegating operative-vs-inert classification (prose docs, fenced/inline code in `.mdx`) to the shared `@adlc/rails-guard` gate logic.
* If an unallowed suppression or a rail change is found, the file is restored to its **pre-tool snapshot** — never `git checkout HEAD`, which would destroy the user's own uncommitted edits — and the tool's result is replaced with a `GATE FAILED` error, forcing the model to fix the compilation/test issue without cheating. Untracked files are observed via `git status --porcelain` (no `git add -N` index side effects).

### 3.3 Context Injection via `before_agent_start` (Defending F1/F3)
Before each turn, the extension dynamically appends the active ticket’s constraints (allowed scopes, frozen rails, spec description) directly into the agent's system prompt. This ensures the agent never suffers from context rot **[F3]** regarding its operational boundaries.

> Contract note (pinned against pi v0.80.3): the `before_agent_start` result's
> `systemPrompt` field **replaces** the turn's system prompt (chained across
> extensions). The extension therefore returns `event.systemPrompt + block` —
> returning the block alone would wipe pi's entire built-in prompt.

### 3.4 TUI Visualization
The active ticket is displayed directly in the Pi footer bar using:
```typescript
ctx.ui.setStatus("adlc-ticket", `🎟️ Ticket: ${activeTicketId}`);
```
This gives the human constant visibility into the active enforcement context.

### 3.5 Context-Rot Handoff Deny (F3)

pi is the first adapter with a **real** context-fill signal rather than a transcript-size
proxy: `ctx.getContextUsage().percent` is a live 0–100 reading of the window. The handoff
gate feeds it to the shared bands in `@adlc/context-handoff` — **50%** warns, **60%** is the
handoff band, **80%** is hard-degraded. Past the handoff band the session loses `write`,
`edit`, `bash`, and any third-party tool that can mutate; reads stay open, so the session
can still explain itself while it is handed off.

Because pi is an *enforcing* tier, this is a deny and not an advisory. Two scoping choices
follow from what a deny actually means:

- **Not ticket-scoped.** An open deny record is a fact about session trust, so it holds with
  no active ticket — the one gate here that survives the no-ticket early return.
- **Not session-scoped.** The record is written to `.adlc/handoffs/denies/` and read back
  from disk, so it reaches later sessions in the repo too, and an open record denies every
  session, not only the one that tripped the band.

**Containment.** A **ticket store** is the opt-in — `.adlc/tickets.json`, `.adlc/tickets/`,
or whatever `ADLC_TICKET_STORE`/`ADLC_TICKETS` names — which is exactly the predicate
`resolveRailsInForce` keys on. The gate returns allow, writing nothing, wherever there is no
store, at any fill percent.

Not the presence of `.adlc/`, and this distinction is what completes the fix rather than
half-making it: the bug littered ordinary directories with `.adlc/.deny-store` and deny
markers, so a bare-directory test lets the bug's own artifacts vouch for the gate that
created them and a repo already hit stays bricked. Nor the store AND a local `.adlc/` —
an absolute `ADLC_TICKET_STORE` is honoured by the rail guard with no local directory, so
ANDing one on would leave rails enforcing while the deny-set silently stood down. Without that guard the band alone
denied mutations in whatever directory the agent happened to open, created `.adlc` state
there, and (the deny store being durable) followed that directory into every later session.

The test is whether the cwd is *inside* an ADLC repo, not whether it *is* one. The gate
resolves the **outermost** `.adlc` in the checkout and uses that root for containment, the
deny store, protected-path checks and the printed recovery command alike — one answer, so a
session in `<repo>/src` cannot read a different store than the one denying it. An
exact-match check let exactly that happen, and wrote band markers into a stray
`<repo>/src/.adlc` no operator would think to clear.

Outermost rather than nearest is a security choice: with nearest-match, an agent below the
band could `mkdir src/.adlc` and have every later call resolve to that empty store, stepping
around the repo's open deny (measured — deny became allow). The cost is that a nested `.adlc`
with no `.git` of its own no longer keeps a separate deny store; it answers to the enclosing
repo. One checkout, one ADLC root.

The `.git` boundary that survives this is honoured only when nothing above it is a real ADLC
repo — a git checkout that also holds a ticket store. That condition is the tiebreaker
between two requirements no filesystem test can satisfy at once: a `.git` an agent can create
must not release an enclosing repo, while a store above an unrelated checkout (a stray
`~/.adlc/tickets.json`) must not capture it. An enclosing git+store ancestor separates the
cases, since a home directory is not a checkout. So inside a real ADLC repo the boundary
never releases enforcement — cold, with no remembered root, however convincing the forgery —
and the cost is that a vendored checkout there answers to the enclosing store rather than
keeping its own.

Containment must not become an off switch, so the opt-in is **monotonic** per process: a
root seen with `.adlc` stays enforced even if the directory is later removed. A custom tool
whose target the extractor cannot see is not rail-checked while the store is cold, so a
plain presence check would have let an agent below the band delete `.adlc` and walk past
every later deny — including one it had already tripped. The memory is keyed by root, so
remembering one repo never arms another.

**Recovery.** The deny message carries the session id and the recovery command by absolute
path, pinned to the denied repo with `--dir` (the CLI otherwise resolves `.adlc` from the
operator's own cwd, writes the grant there and exits 0 regardless). When the deny belongs to
another session the command carries `--unbound-reason`: a band-generated marker is unbound —
`ticket_id` and `content_hash` are both null — and a bound grant only authorizes an unbound
record of its own session, so against a foreign one it is consumed and the caller stays
denied. The grant is one-shot either way, and it is spent by the next *gated tool call* rather than the
next mutation — pi gates every tool but a read, so a `bash pwd` consumes it. The message says so
rather than presenting it as a clear. A store-integrity deny (`D0:deny_store_unavailable`,
`D3:invalid_record:<label>`) also takes the unbound form: measured, unbound lifts it and bound
does not, so the message offers the grant that works and names the durable store repair beside
it. `resume` / `continue` are
the durable keyed flows.

When no `ADLC_MANIFEST_KEY` is configured — which every mutating verb but one requires —
the message instead names the keyless path, which is also the only durable clear:
`rm -rf <repo>/.adlc/handoffs <repo>/.adlc/.deny-store` from a host shell, printed with the
paths already resolved because `.adlc` may itself be a symlink to an external store and a
relative `rm` would follow it silently. The whole tree, and no glob — clearing one marker while another remains leaves the repo just as locked, since
any open marker denies every session; a sentinel makes an emptied `denies/` read as
tampered-with; the legacy `.adlc/handoffs/.deny-store` re-creates the canonical one on the
next read, so a recipe that omits it never terminates; and a glob inside `denies/` expands
through a symlink, so an agent that repoints that directory has the operator delete files
outside the repo. `adlc handoff unlock` is the one
keyless mutating verb, but it reclaims a session *lock* rather than a deny.

---

## 4. Skeptical Multi-Pass Prosecution (P5) with Pi Subagents

A core pillar of ADLC is **P5 Prosecution**: never asking an agent to review its own work (agreement bias **[F2]**), and running skeptical reviews in parallel using fresh contexts until convergence.

In Pi, this is achieved natively via **Subagents** or the **Pi SDK**:
1. When a builder completes a ticket (e.g. outputs `TICKET-DONE`), the extension intercepts the message.
2. The extension programmatically launches a background **Refute-Chartered Subagent** (`invoke_subagent` or a headless Pi SDK session).
3. This subagent is configured with a frontier model tier (Opus-class), given the git diff of the main session, and commanded to find bugs/vulnerabilities.
4. If findings are verified, they are logged in `.adlc/findings.jsonl`, and the main session is alerted to fix them.
5. If the review is clean (zero findings), it counts as a dry pass. The extension loops this process across multiple review lenses (security, correctness, integration) until consecutive dry-pass limits are satisfied.

---

## 5. Deployment as a Shareable Pi Package

The entire integration is packaged in `plugins/adlc-pi/` with the following structure:
* `package.json`: Manifest declaring the extension and skills.
* `index.ts`: The TypeScript extension module containing the lifecycle hooks.
* `skills/`: Standard agent skills mapping to ADLC operations (`adlc-spec`, `adlc-rail-build`, `adlc-prosecute`, etc.).

This package can be loaded locally using:
```bash
pi --extension plugins/adlc-pi/index.ts
```
Or installed globally/per-project via `pi install`:

```sh
npm install -g @adlc/cli

# Per-project team install (lands in .pi/):
pi install -l npm:@adlc/pi

# Or helper one-liner via npx:
npx adlc-pi install

# Or user-global install:
pi install npm:@adlc/pi
```
