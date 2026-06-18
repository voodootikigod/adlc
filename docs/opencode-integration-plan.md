# Plan: Installing & Integrating ADLC into OpenCode

**Status:** Proposal · **Branch:** `opencode-integration` · **Date:** 2026-06-18

---

## 1. Problem Statement

Today, the `@adlc/*` toolkit ships as 21 independent, gate-shaped CLI packages. While highly composable, using the Agentic Development Lifecycle (ADLC) in a raw terminal environment requires developers to:
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

| Lifecycle Organ (ADLC Phase) | CLI Tool(s) | OpenCode Native Primitive | Default Behavior & Integration Details |
|---|---|---|---|
| **Preflight** (D2 Phase 0) | `preflight` | `session.created` / `session.start` | **Advisory**: Checks system requirements, Node/Bun runtimes, and git state. Logs warnings but never blocks the session. |
| **Rail Freeze** (P3 / C5) | `rails-guard` | `tool.execute.before` (PreToolUse) | **Enforcing**: Intercepts structural editing tools (`write`, `edit`, `apply_patch`, `multi_edit`). Blocks writes to rail paths declared in active tickets + freezes the `.adlc/tickets.json` trust root. |
| **Flail Supervision** (P4 / C6) | `flail-detector` | `tool.execute.after` (PostToolUse) | **Advisory**: Scans recent tool logs and outputs for repeated errors, scope drift, or excessive session bloat. Displays TUI warning cards. |
| **Spec Interrogation** (P1) | `spec-lint`, `premortem`, `parallax` | **Custom Skill** / `/adlc-spec` | Model-invoked via `.opencode/skills/` router flowchart or `/adlc-spec`. Runs `--prompt-only`. |
| **Decomposition** (P2) | `coldstart`, `model-router`, `merge-forecast` | **Custom Skill** / `/adlc-decompose` | Model-invoked. Splits spec into atomic, typed ticket partitions. |
| **Hard-Bug Repair** (P4 / C7) | `consensus-fix` | **Slash Command** (`/adlc-consensus-fix`) | User-invoked. Runs parallel candidate repairs and merges the consensus winner. |
| **Prosecution** (P5) | `hollow-test`, `behavior-diff`, `review-calibration` | **Hostile Subagent** (`prosecutor`) | Invoked prior to merge. Runs hostile review lenses, filters findings through verification, and loops until dry. |
| **Gate Evidence** (C11) | `gate-manifest` | `session.deleted` / `session.idle` | **Advisory**: Runs `gate-manifest verify` to check integrity of the `.adlc/manifest.jsonl` append-only chain. |
| **Distill** (P7) | `lesson-foundry`, `rejection-mining` | **Slash Command** (`/adlc-distill`) | Manual execution or automated background post-merge distillation. |
| **Maintenance** (C10/C12) | `skill-rot`, `model-ratchet`, `gate-fuzzing` | **Slash Command** (`/adlc-maintain`) + CI Action | Advisory. Runs checks on repository drift, stale skills, and gate bypasses. |

---

## 4. What We Build

We will implement the integration inside a project-level `.opencode/` folder or pack it as a global npm package under a unified harness adapter `@adlc/opencode-plugin`.

### 4.1. Directory Structure

```
.opencode/
  config.json             # Registers plugin pathways
  plugins/
    adlc/
      index.ts            # Entrypoint exporting Plugin initializer and hooks
      package.json        # Plugin dependencies (declares @adlc/cli, @adlc/runner)
  commands/
    adlc-init.md          # Slash command to bootstrap .adlc/
    adlc-ticket.md        # Slash command to triage/create a ticket (P0)
    adlc-spec.md          # Slash command to shape/lint spec (P1)
    adlc-decompose.md     # Slash command to slice ticket partitions (P2)
    adlc-prosecute.md     # Slash command to invoke prosecutor subagent (P5)
    adlc-distill.md       # Slash command to mine lessons (P7)
  agents/
    prosecutor.md         # Definition of the hostile critic reviewer
  skills/
    adlc.md               # Main phase-routing discovery flowchart (using-agent-skills mapping)
```

### 4.2. In-Process Hook Contract (Fail-Closed)

The plugin's hook file (`plugins/adlc/index.ts`) intercepting `tool.execute.before` executes with an **asymmetric fail-closed contract**:
- **No Rails Declared:** If `.adlc/tickets.json` is empty or no rails are declared in the active ticket, the hook behaves as a **no-op** and immediately permits the tool call (no-op safety: clean repos cannot be bricked by the plugin).
- **Rails Declared & Healthy:** If rails are active and the tool is writing to a non-rail path, allow. If editing a frozen rail path, **deny** and throw a native JavaScript Error, blocking tool execution.
- **Fail-Closed on Failure:** If rails are active but the hook cannot guarantee a safe decision (e.g., the `adlc` CLI is missing, the `.adlc/` directory is inaccessible, or ticket configuration is corrupt), it **must fail closed (block the tool execution)**.
- **Auditable Bypass:** Setting `ADLC_RAILS_BYPASS=1` will bypass the in-session hook, but the event is appended to `.adlc/manifest.jsonl` as an audited bypass.

### 4.3. Keyless LLM-Gate Dispatch (The Bridge)

The plugin implements a bridge function `runKeylessGate(toolName: string, args: string[])`:
1. Spawns the CLI: `adlc <toolName> <args> --prompt-only`.
2. Intercepts the generated prompt output.
3. Invokes the native OpenCode API: `await context.client.prompt({ message: promptText })`.
4. Writes the model's reply back to the child process's stdin.
5. Propagates the final exit code (`0` for pass, `2` for fail, `1` for error).

---

## 5. Completeness & Implementation Limitations

All 8 phases of the ADLC are represented in this plan, but three specific boundaries are partially implemented or restricted by design.

### 5.1. Phase 6 (Integrate) is Inherently Manual (Partial)
* **Status:** ⚠️ Partial Implementation
* **Reason:** Human Gate 2 ("Is this what I meant, running?") is the human's final control gate. While the plugin automates gathering evidence (`gate-manifest attest`, `behavior-diff compare`, and `review-calibration` scores), it **cannot automate behavioral acceptance**. The plugin surfaces an execution summary card in the TUI, prompting the developer to run the demo and sign off manually.

### 5.2. In-Session Bash Gating is Dropped (Partial)
* **Status:** ⚠️ Dropped for In-Session Hooks, Gated at CI/CD Commit Time
* **Reason:** Aligning with the command reconciliation decision history, parsing Bash commands in-session is a source of false security. Shell execution is Turing-complete (brace expansions, subshells, aliases, option overrides like `rm -rf`). Gating Bash in-session leads to bypasses.
* **Mitigation:** The plugin's `tool.execute.before` hook only gates structured, path-addressable file tools (`write`, `edit`, `apply_patch`, `multi_edit`). Any bash-based modifications to frozen rails are caught at commit time using an unbypassable **CI/CD rails-guard check** (`docs/ci/rails-guard.yml` or script `scripts/rails-guard-ci.mjs`) which diffs the branch against the trunk base.

### 5.3. Background Scheduling & Distillation (Partial)
* **Status:** ⚠️ Partial Implementation
* **Reason:** Phase 7 (Distill) mines repeated findings and PR rejections into reusable skills and lints. If the developer's OpenCode client runs on a transient host without persistent background daemons, cron-based maintenance (`docs/ci/adlc-maintenance.yml`) or distillation runs are unavailable.
* **Mitigation:** The plugin exposes explicit TUI commands (`/adlc-distill`, `/adlc-maintain`) to run these processes on-demand at the end of a session, supplementing CI-based cron pipelines.

### 5.4. Model-Agnostic Capacity Risk (Partial)
* **Status:** ⚠️ Advisory
* **Reason:** OpenCode supports 75+ AI models. If a developer runs a lightweight local model (e.g., Llama-3 8B via Ollama), complex LLM-backed gates like `spec-lint` (checking specs for unverifiable wishes) or `premortem` (writing adversarial postmortems) will suffer from low recall and high hallucination rates.
* **Mitigation:** The plugin includes a **model-router warning**: if the active model in OpenCode does not meet capability thresholds, it prints a TUI warning suggesting the routing of Phase 1 (Interrogate) and Phase 5 (Prosecute) to frontier models (Gemini 1.5 Pro, Claude 3.5 Sonnet), while running Phase 4 (Build) on cheaper models.

---

## 6. Phased Delivery Plan

We propose a six-phase delivery plan, mirroring the successful Claude Code implementation. Each phase will be subjected to an adversarial counter-review loop to check for bypasses:

* **Phase A — Dependency & Commands:** Configure package mappings. Implement `/adlc-init` and `/adlc-ticket` (P0) to ensure the lifecycle has an entry point.
* **Phase B — The Keyless Bridge:** Write the plugin SDK hook that intercepts `--prompt-only` stdin/stdout and bridges it to OpenCode's native client prompt API.
* **Phase C — In-Process Advisory Hooks:** Implement `session.created` (runs `preflight`) and `tool.execute.after` (runs `flail-detector` asynchronously).
* **Phase D — Enforcing Rail-Guard Hook:** Deploy the `tool.execute.before` hook gating structured file edits with the fail-closed contract, symlink auditing, and `ADLC_RAILS_BYPASS` logging.
* **Phase E — Prosecutor Subagent & Distill:** Configure `.opencode/agents/prosecutor.md` to run `hollow-test`, `behavior-diff`, and `review-calibration`. Wire `/adlc-distill` for lesson mining.
* **Phase F — CI Templates & Adoption Guide:** Deliver `.github/workflows` configurations and publish `docs/opencode.md` for users.
