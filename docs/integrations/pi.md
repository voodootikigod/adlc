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
