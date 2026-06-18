# Plan: Installing & Integrating ADLC into OpenCode

**Status:** Proposal · **Branch:** `opencode-integration` · **Date:** 2026-06-18

---

## 1. Problem Statement

Today, the `@adlc/*` toolkit ships as 20 independent, gate-shaped CLI packages. While highly composable, using the Agentic Development Lifecycle (ADLC) in a raw terminal environment requires developers to:
1. Know exactly which CLI tool maps to which lifecycle phase (P0–P7, D1–D3).
2. Manually execute the appropriate tool at the correct moment.
3. Manage exit codes, environment files, and LLM API keys for model-backed gates.

ADLC dictates that **enforcement must live at the tool layer, not the prompt layer** (as detailed in [ADLC.md](file:///home/voodootikigod/Projects/voodootikigod/adlc/.worktrees/opencode-integration/ADLC.md): *"F5 reward-hacking routes around instructions; it cannot route around a tool hook"*). Relying on a human or an agent to remember to run a validation command defeats the lifecycle's structural safety guarantees.

**Goal:** Provide a native, deeply integrated OpenCode plugin that enforces the ADLC automatically at correct lifecycle boundaries. The model should discover the lifecycle natively, safety-critical gates must run automatically, and no external API keys should be required.

---

## 2. Design Thesis: Natively In-Process via Bun

OpenCode is an open-source, terminal-first agent harness. It uses a client-server architecture with a Go-based TUI/CLI client and a **Bun/JavaScript backend**. This design provides a powerful exploit for our integration:

- **In-Process JavaScript Hook execution:** Unlike Claude Code (which relies on external JSON-configured shell scripts), OpenCode executes plugins **in-process** in its Bun environment. The ADLC plugin can run natively in JavaScript, invoking the `@adlc/cli` dispatcher or using Bun's fast `Bun.spawn`/`Bun.$` APIs to run gates, process JSON outputs, and reject tool use with minimal overhead.
- **Keyless Execution via `--prompt-only`:** Every LLM-backed gate in the ADLC toolkit supports a `--prompt-only` flag. When triggered, the tool prints the prompt text to stdout and exits. The plugin intercepts this output, feeds it to OpenCode's active model client, gathers the response, and inputs it to the tool's stdin. **No external LLM provider API keys are needed; OpenCode's active session model is used natively.**
- **Model-Agnostic Adaptation:** Since OpenCode is model-agnostic (supporting local models via Ollama as well as remote models), the plugin must degrade gracefully or warn the user if a configured model lacks the capability to satisfy complex gates (e.g., a low-tier model running spec evaluation).

---

## 3. Primitive Mapping (ADLC to OpenCode)

OpenCode's extensibility points (custom commands, JavaScript event hooks, and agents) align cleanly with the ADLC primitive mapping established in the multi-harness roadmap.

Following **Option D (separate, concern-focused bins)** from the Command Reconciliation ADR:
- `adlc <tool>` is the umbrella dispatcher (`@adlc/cli`) for executing the 19 atomic gate tools.
- `adlc-runner <verb>` is the runner (`@adlc/runner`) for phase-evidence assertions (`adlc-runner run <phase>` and `adlc-runner accept --ticket <id>`).

| Lifecycle Organ (ADLC Phase) | CLI Tool(s) & Bins | OpenCode Native Primitive | Default Behavior & Integration Details |
|---|---|---|---|
| **Preflight** (D2 Phase 0) | `adlc preflight` | `session.created` / `session.start` | **Advisory**: Checks system requirements, Node/Bun runtimes, and git state. Logs warnings but never blocks the session. |
| **Spec Interrogation** (P1) | `adlc-runner run p1` (calls `spec-lint`, `premortem`, `parallax`) | **Custom Skill** / `/adlc-spec` | Model-guided spec shaping via `/adlc-spec`. Human Gate 1 (spec approval) runs `adlc-runner run p1` to verify and freeze the spec. Transition to P2 is blocked until spec is approved. |
| **Decomposition** (P2) | `adlc-runner run p2` (calls `coldstart`, `model-router`, `merge-forecast`) | **Custom Skill** / `/adlc-decompose` | Splits spec into atomic, typed ticket partitions. Verifies that `coldstart` passes on each ticket and `merge-forecast` certifies execution width before entering P3. |
| **Rail Freeze & Gating** (P3 / C5) | `adlc-runner run p3` (calls `hollow-test` + `rails-guard`) | `tool.execute.before` (PreToolUse) | **Enforcing**: Runs `adlc-runner run p3` to verify `hollow-test` (ensuring tests are load-bearing/non-vacuous before freeze). Hook intercepts structured edits (`write`, `edit`, `apply_patch`, `multi_edit`). Blocks writes to rail paths declared in active tickets + freezes the `.adlc/tickets.json` trust root. |
| **Flail Supervision** (P4 / C6) | `adlc flail-detector` | `tool.execute.after` (PostToolUse) | **Enforcing (Two-Strike Rule)**: Scans recent tool logs and outputs for repeated errors, scope drift, or excessive session bloat. If flailing is detected, the plugin terminates the active builder subagent and escalates to model-router or human, avoiding context rot. |
| **Hard-Bug Repair** (P4 / C7) | `adlc consensus-fix` | **Slash Command** (`/adlc-consensus-fix`) | User-invoked. Runs parallel candidate repairs and merges the consensus winner. |
| **Prosecution** (P5) | `adlc-runner run p5` (calls `hollow-test`, `behavior-diff`, `review-calibration`) | **Hostile Subagents** (Prosecution Fan-out) | Pre-merge prosecution fanned out across independent, fresh-context, single-lens subagents (security, correctness, etc.). Findings are verified by a separate reproducer/verifier agent. Loops until 2 consecutive passes are dry. |
| **Gate Evidence** (C11) | `adlc gate-manifest verify` | `session.ended` / `session.terminated` | **Advisory**: Runs `adlc gate-manifest verify` on session end to check the integrity of the `.adlc/manifest.jsonl` append-only chain. |
| **Distill** (P7) | `adlc-runner run p7` (calls `lesson-foundry`, `rejection-mining`) | **Slash Command** (`/adlc-distill`) | Runs lesson mining to harvest skills/lints and executes the **Simplify** pass (automated refactoring of code under green tests to prune bloat). |
| **Maintenance** (C10/C12) | `adlc skill-rot`, `adlc model-ratchet`, `adlc gate-fuzzing` | **Slash Command** (`/adlc-maintain`) + CI Action | Advisory. Runs checks on repository drift, stale skills, and gate bypasses. |

---

## 4. What We Build

We will implement the integration inside a project-level `.opencode/` folder or pack it as a global npm package under a unified harness adapter `@adlc/opencode-plugin`.

### 4.1. Directory Structure

```
.opencode/
  config.json             # Registers plugin pathways and maps commands
  plugins/
    adlc/
      index.ts            # Entrypoint exporting Plugin initializer and hooks
      package.json        # Plugin dependencies (declares @adlc/cli, @adlc/runner, and diff parser)
  commands/
    adlc-init.md          # Slash command to bootstrap .adlc/
    adlc-ticket.md        # Slash command to triage/create a ticket (P0)
    adlc-spec.md          # Slash command to shape/lint spec (P1)
    adlc-decompose.md     # Slash command to slice ticket partitions (P2)
    adlc-prosecute.md     # Slash command to run prosecution fan-out (P5)
    adlc-distill.md       # Slash command to run lesson foundry & simplify code (P7)
  agents/
    prosecutor-correctness.md  # Correctness lens reviewer (fresh context)
    prosecutor-security.md     # Security lens reviewer (fresh context)
    prosecutor-verifier.md     # Findings verification/reproduction agent
  skills/
    adlc.md               # Main phase-routing discovery flowchart (using-agent-skills mapping)
```

### 4.2. In-Process Hook Contract (Fail-Closed)

The plugin's hook file (`plugins/adlc/index.ts`) intercepting `tool.execute.before` executes with an **asymmetric fail-closed contract**:
- **No Rails Declared:** If `.adlc/tickets.json` is empty or no rails are declared in the active ticket, the hook behaves as a **no-op** and immediately permits the tool call (no-op safety: clean repos cannot be bricked by the plugin).
- **In-Session Direct Checks:** To avoid the performance overhead and nondeterministic failure risks of spawning shell commands or LLM calls on every tool use, the hook resolves and reads `.adlc/tickets.json` **directly via Node `fs`**.
- **Edit Allowlist & Matcher:** Instead of relying entirely on the regex matcher, the hook checks tool calls against an explicit internal allowlist (`write`, `edit`, `apply_patch`, `multi_edit`).
- **Path Protection & Symlink Hardening:** The hook canonicalizes all target paths using real physical paths (`fs.realpathSync`) and evaluates them against the ticket rails. It specifically denies edits to:
  1. Declared `rails` paths.
  2. The `.adlc/` directory (preventing editing of `tickets.json` or `manifest.jsonl`).
  3. The `.opencode/` directory (preventing modification of the plugin code or config).
- **`apply_patch` Payload Parsing:** For `apply_patch` tools, the hook parses the patch payload to extract all target files (inspecting lines prefixed with `--- a/` or `+++ b/`). If any target file matches a protected path, the edit is blocked.
- **OpenCode Fail-Closed Return:** If the hook determines an edit is blocked or encounters an operational error (e.g., config is corrupt or parsed incorrectly), it logs a diagnostic and returns `{ allow: false, reason: "..." }` to OpenCode rather than simply throwing an uncaught JS error, ensuring OpenCode's engine safely denies the tool execution.
- **Auditable Bypass:** Setting `ADLC_RAILS_BYPASS=1` is only permitted if the environment variable is validated through a secure human-in-the-loop prompt in the TUI, appending an audited bypass entry to `.adlc/manifest.jsonl`.

### 4.3. Keyless LLM-Gate Dispatch (The Bridge)

The plugin implements a bridge function `runKeylessGate(toolName: string, args: string[])`:
1. Spawns the CLI: `adlc <toolName> <args> --prompt-only`.
2. Concurrently streams/drains the stdout stream of the child process. This avoids pipe buffer deadlocks (where processes hang on the 64KB OS buffer limit).
3. If the process remains open waiting for input, it captures the prompt from stdout and invokes the native OpenCode API: `await context.client.prompt({ message: promptText })`.
4. Writes the model's reply back to the child process's stdin.
5. Propagates the final exit code:
   - `exit 0`: Allows the gate.
   - `exit 2`: Blocks the gate.
   - `exit 1` (Operational Error): Fails closed on enforcing gates (blocking further execution) and fails open (logs a warning) on advisory gates.

### 4.4. Binary Resolution and Verification
To support Command Reconciliation Option D, the plugin initialization performs explicit checks on PATH for both the dispatcher (`adlc`) and runner (`adlc-runner`) binaries using Node's `child_process.execSync` checks. If either bin is missing, the plugin prints a clear user-facing error message with NPM installation commands, rather than throwing unhandled `ENOENT` exceptions.

---

## 5. Creator/Critic Model Separation (Model Routing)

To prevent sycophancy (F2) and same-model self-review (C3/H5), the plugin isolates the active builder model from the gate models:

- **Model Routing Configuration:** The plugin reads a configuration file `.adlc/config.json` defining model routing tiers (frontier, mid, cheap).
- **Frontier Isolation:** For critical gates requiring a frontier model (Phase 1 Interrogate, Phase 3 hollow-test, Phase 5 Prosecute), the plugin bridge intercepts `runKeylessGate` and requests the configured frontier model endpoint from OpenCode (e.g. `context.client.prompt({ message: promptText, model: config.frontierModel })`).
- **Active Model Verification:** If OpenCode's client does not support multi-model targeting in-session, the plugin runs a capacity check. If the active session is running a model that does not satisfy the required tier for the gate, the plugin blocks execution and prompts the user in the TUI to temporarily switch their session model to a verified frontier tier (e.g., current-generation frontier models) before the gate can be cleared.

---

## 6. Completeness & Implementation Limitations

All 8 phases of the ADLC are represented in this plan, but three specific boundaries are partially implemented or restricted by design.

### 6.1. Phase 6 (Integrate) is Inherently Manual (Partial)
* **Status:** ⚠️ Partial Implementation
* **Reason:** Human Gate 2 ("Is this what I meant, running?") is the human's final control gate. While the plugin automates gathering evidence (`gate-manifest attest`, `behavior-diff compare`, and `review-calibration` scores), it **cannot automate behavioral acceptance**. The plugin surfaces an execution summary card in the TUI, prompting the developer to run the demo and sign off manually.

### 6.2. In-Session Bash Gating is Gated at CI/CD Commit Time (Partial)
* **Status:** ⚠️ Dropped for In-Session Hooks, Gated at CI/CD Commit Time
* **Reason:** Aligning with the command reconciliation decision history, parsing Bash commands in-session is a source of false security. Shell execution is Turing-complete (brace expansions, subshells, aliases, option overrides like `rm -rf`). Gating Bash in-session leads to bypasses.
* **Mitigation:** The plugin's `tool.execute.before` hook only gates structured, path-addressable file tools (`write`, `edit`, `apply_patch`, `multi_edit`). Any bash-based modifications to frozen rails are caught at commit time using an unbypassable **CI/CD rails-guard check** (`docs/ci/rails-guard.yml` or script `scripts/rails-guard-ci.mjs`) which diffs the branch against the trunk base.
* **Local-only / GitLab environments:** For repositories without GitHub workflows, a pre-commit git hook (`.git/hooks/pre-commit`) is written during `/adlc-init`. This hook runs `adlc rails-guard` locally, preventing commits that violate rail protection even if the user lacks a CI runner.

### 6.3. Background Scheduling (Partial)
* **Status:** ⚠️ Partial Implementation
* **Reason:** Phase 7 (Distill) mines repeated findings and PR rejections into reusable skills and lints. If the developer's OpenCode client runs on a transient host without persistent background daemons, cron-based maintenance or distillation runs are unavailable.
* **Mitigation:** The plugin exposes explicit TUI commands (`/adlc-distill`, `/adlc-maintain`) to run these processes on-demand at the end of a session, supplementing CI-based cron pipelines.

---

## 7. Phased Delivery Plan

We propose a six-phase delivery plan, mirroring the successful Claude Code implementation. Each phase will be subjected to an adversarial counter-review loop to check for bypasses:

* **Phase A — Dependency & Commands:** Configure package mappings for `adlc` and `adlc-runner`. Implement `/adlc-init`, `/adlc-ticket` (P0), and gated slash commands for `/adlc-spec` (P1) and `/adlc-decompose` (P2) to ensure the lifecycle has an entry point.
* **Phase B — The Keyless Bridge:** Write the plugin SDK hook that intercepts `--prompt-only` stdin/stdout, prevents deadlock via streaming, and routes prompts to the configured model tier.
* **Phase C — In-Process Advisory Hooks:** Implement `session.created` (runs `preflight`) and `session.ended` (runs `gate-manifest verify`).
* **Phase D — Enforcing Rail-Guard Hook:** Deploy the `tool.execute.before` hook gating structured file edits (`apply_patch` parser included) with path canonicalization, `.opencode`/`.adlc` write protection, and fail-closed return contracts.
* **Phase E — Prosecutor Subagents & Distill:** Configure the fanned-out prosecution subagents, the verifier/reproducer agent, and loop orchestration. Wire `/adlc-distill` for lesson mining and code simplification.
* **Phase F — CI Templates & Adoption Guide:** Deliver `.github/workflows` configurations, pre-commit hook scripts, and publish `docs/opencode.md` for users.
