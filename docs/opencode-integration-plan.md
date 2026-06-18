# Plan: Installing & Integrating ADLC into OpenCode

**Status:** Proposal · **Branch:** `opencode-integration` · **Date:** 2026-06-18

---

## 1. Problem Statement

Today, the `@adlc/*` toolkit ships as 19 independent, gate-shaped CLI packages, managed under one `@adlc/cli` dispatcher and `@adlc/runner` phase engine. While highly composable, using the Agentic Development Lifecycle (ADLC) in a raw terminal environment requires developers to:
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
- `adlc <tool>` is the dispatcher (`@adlc/cli`) for executing individual gate tools.
- `adlc-runner <verb>` is the runner (`@adlc/runner`) for phase-evidence assertions (`adlc-runner run <phase>` and `adlc-runner accept --ticket <id>`).

> [!IMPORTANT]
> The `@adlc/runner` package is a **pending-merge dependency** developed in the sibling `feat/codex-integration-codex` branch. Integrating it requires merging its binaries into the shared main branch.

| Lifecycle Organ (ADLC Phase) | CLI Tool(s) & Bins | OpenCode Native Primitive | Default Behavior & Integration Details |
|---|---|---|---|
| **Preflight** (SessionStart Check) | `adlc preflight` | `session.created` / `session.start` | **Advisory**: Checks system requirements, Node/Bun runtimes, and git state. Logs warnings but never blocks the session. Runs local benchmark. |
| **P0 Triage** | `/adlc-ticket` | **Slash Command** | Triages incoming tasks by risk × blast radius: (a) *Trivial*: Direct edit + existing rails + single prosecution pass, (b) *Bounded*: Skip to P3 rails (write test first), (c) *Substantial*: Full lifecycle loop, (d) *Architectural*: Full loop + P1 design alternatives judge panel. |
| **Spec Interrogation** (P1) | `adlc-runner run p1` (calls `spec-lint`, `premortem`, `parallax`) | **Custom Skill** / `/adlc-spec` | Model-guided spec shaping via `/adlc-spec`. Human Gate 1 (spec approval) runs `adlc-runner run p1` to verify and freeze the spec. Transition to P2 (Decompose) is blocked until spec is approved. |
| **Decomposition** (P2) | `adlc-runner run p2` (calls `coldstart`, `model-router`, `merge-forecast`) | **Custom Skill** / `/adlc-decompose` | Splits spec into atomic, typed ticket partitions. Verifies that `coldstart` passes on each ticket and `merge-forecast` certifies execution width. Routes the recommended model selection to a ticket-specific configuration file. |
| **Rail Authoring & Freeze** (P3 / C5) | `/adlc-rail-write` (calls `rail-writer` agent) and `adlc-runner run p3` (calls `hollow-test` + `rails-guard`) | **Slash Command** / `/adlc-rail-write` & `tool.execute.before` (PreToolUse) | Gated subagent `rail-writer` writes tests and stubs in an isolated context. Runs `adlc-runner run p3` to verify `hollow-test` (model-free validation ensuring tests fail on implementation deletion before freeze). Hook intercepts structured edits. Blocks writes to rail paths declared in active tickets + freezes the `.adlc/tickets.json` trust root. |
| **Flail Supervision** (P4 / C6) | `adlc flail-detector` | `tool.execute.after` (PostToolUse) | **Enforcing (ADLC C6 Alignment)**: Scans tool logs for flailing. Strike 1 (Enforcing, Non-Destructive): terminates builder subagent, stashes uncommitted work safely, and restarts builder in a fresh context. Strike 2 (Enforcing, Destructive): builder subagent is terminated, staged work is rolled back (`git reset --hard` + `git clean -fd`) strictly inside the isolated ticket worktree (stashes instead of cleaning if in main checkout), and ticket is escalated back to Phase 2 (Decompose). |
| **Hard-Bug Repair** (P4 / C7) | `adlc consensus-fix` | **Slash Command** (`/adlc-consensus-fix`) | User-invoked. Runs parallel candidate repairs and merges the consensus winner; escalates to human if candidates diverge. |
| **Prosecution** (P5) | `adlc-runner run p5` (calls `hollow-test`, `behavior-diff`, `review-calibration`) | **Hostile Subagents** (Prosecution Fan-out) | Pre-merge prosecution fanned out across independent, fresh-context, single-lens subagents (security, correctness, contract, diff, tests). Findings are verified by a separate verifier agent. Loops until 2 consecutive passes are dry. |
| **Integrate** (P6) | `adlc-runner accept --ticket <id>` | **Slash Command** / `/adlc-accept` | Human Gate 2 (behavioral acceptance). Prompts the developer to run the demo. Running `/adlc-accept` records the human acceptance hash and signs the manifest. |
| **Gate Evidence** (C11) | `adlc gate-manifest verify` | `session.ended` / `session.terminated` | **Advisory**: Runs `adlc gate-manifest verify` on session end to check the integrity of the `.adlc/manifest.jsonl` append-only chain. |
| **Distill** (P7) | `adlc-runner run p7` (calls `lesson-foundry`, `rejection-mining`) | **Slash Command** (`/adlc-distill`) | Runs lesson mining to harvest skills/lints. **Simplify pass is strictly post-merge**: runs in the CI/CD pipeline under green tests, automatically opening a new pull request for final merging. |
| **Maintenance** (C10/C12) | `adlc skill-rot`, `adlc model-ratchet`, `adlc gate-fuzzing` | **Slash Command** (`/adlc-maintain`) + CI Action | Advisory. Runs checks on repository drift, stale skills, and gate bypasses. |

---

## 4. What We Build

We will implement the integration inside a project-level `.opencode/` folder or pack it as a global npm package under a unified harness adapter `@adlc/opencode-plugin`.

### 4.1. Directory Structure

```
.opencode/
  config.json             # Registers plugin pathways and maps commands
  plugins/
    adlc-opencode/
      index.ts            # Entrypoint exporting Plugin thin binding
      package.json        # Plugin dependencies (declares @adlc/cli, @adlc/runner)
      rails-checker.ts    # Self-contained rails validation and path helper
  commands/
    adlc-init.md          # Slash command to bootstrap .adlc/
    adlc-ticket.md        # Slash command to triage/create a ticket (P0)
    adlc-spec.md          # Slash command to shape/lint spec (P1)
    adlc-decompose.md     # Slash command to slice ticket partitions (P2)
    adlc-rail-write.md    # Slash command to author tests and stubs (P3)
    adlc-consensus-fix.md # Slash command to run consensus repair (P4)
    adlc-prosecute.md     # Slash command to run prosecution fan-out (P5)
    adlc-accept.md        # Slash command to finalize behavioral acceptance (P6)
    adlc-distill.md       # Slash command to run lesson foundry (P7)
    adlc-maintain.md      # Slash command to run weekly/on-demand maintenance (C10/C12)
  agents/
    rail-writer.md            # P3 rail authoring agent (fresh context)
    prosecutor-correctness.md # Correctness lens reviewer (fresh context)
    prosecutor-security.md    # Security lens reviewer (fresh context)
    prosecutor-contract.md    # Contract conformance reviewer (fresh context)
    prosecutor-diff.md        # Spec-vs-implementation diff reviewer (fresh context)
    prosecutor-tests.md       # Auditor reviewer for builder-added tests (fresh context)
    prosecutor-verifier.md    # Findings verification/reproduction agent
  skills/
    adlc.md               # Main phase-routing discovery flowchart (using-agent-skills mapping)
```

### 4.2. In-Process Hook Contract (Fail-Closed & Path Hardening)

To prevent runtime resolution failures and logic drift, the plugin does **not** load external `@adlc/core` modules directly at hook execution time. Instead, it vendors the core rails-checking, path-resolution, and patch-parsing helper functions into a self-contained, zero-dependency helper file `plugins/adlc-opencode/rails-checker.ts`.

The hook executes with an **asymmetric fail-closed contract**:
- **No Rails Declared:** If `.adlc/tickets.json` is empty or no rails are declared in the active ticket, the hook behaves as a **no-op** and immediately permits the tool call (no-op safety: clean repos cannot be bricked).
- **In-Session Direct Checks:** To avoid the performance overhead and nondeterministic failure risks of spawning shell commands or LLM calls on every tool use, the hook resolves and reads `.adlc/tickets.json` **directly via Node `fs`**.
- **Default-Deny Path Filter:** Instead of an allowlist of tool names, the hook utilizes a **default-deny** approach for structured tools: it intercepts *all* tool calls except for an explicit allowlist of read-only tools (`read`, `view`, `glob`, `search`, `grep`).
- **Path Protection & Symlink Hardening:** The hook canonicalizes target paths. To prevent directory traversal and symlink bypasses on new file creation (where the file does not exist yet), the hook resolves symlinks on the *staged target path itself*, walking from the root directory segment-by-segment to verify that no path segment is a symlink resolving into a restricted directory.
  - At startup, the plugin resolves its own physical path using `fs.realpathSync(__filename)`. It locks this resolved canonical root path, protecting the plugin code from edits regardless of whether it is globally installed, locally copied, or symlinked.
  - It specifically denies edits to:
    1. Declared `rails` paths.
    2. The `.adlc/` directory (preventing editing of `tickets.json` or `manifest.jsonl`).
    3. The canonical plugin root path (preventing modification of the plugin code, configs, or agents).
    4. The `.git/` directory (preventing deletion or manipulation of hooks).
    5. The `.github/` and CI config directories (preventing editing of workflows like `ci/rails-guard.yml`).
- **`apply_patch` Payload Parsing:** The shared core's path extractor parses patch payloads (inspecting unified diff markers) to identify target files and evaluate them against protected paths.
- **OpenCode Fail-Closed Return:** If the hook determines an edit is blocked or encounters an operational error, the plugin catches it and returns a native OpenCode block payload (e.g. `{ allow: false, reason: "..." }`) rather than failing open. If running in a subprocess hook environment, it exits the subprocess with `exit 2`. Any hook crash or operational error while rails are declared **fails closed**.
- **Auditable Bypass:** Setting `ADLC_RAILS_BYPASS=1` is only permitted if the environment variable is validated through a secure human-in-the-loop prompt in the TUI, appending an audited bypass entry to `.adlc/manifest.jsonl`. In non-interactive/headless runs (where no TUI is available), the bypass is **refused (fails closed)**.

### 4.3. Keyless LLM-Gate Dispatch (The Bridge & Grandchild Cascading)

The plugin implements a bridge function `runKeylessGate(toolName: string, args: string[])`:
1. Spawns the CLI: `adlc <toolName> <args> --prompt-only`.
2. Concurrently streams and drains the stdout stream of the child process. This avoids pipe buffer deadlocks.
3. If the process remains open waiting for input, it captures the prompt from stdout.
4. **Isolated Prompting (No Transcript Contamination):** To prevent polluting the active session's transcript and accelerating context rot (F3), the plugin invokes the prompt in an **isolated conversation sub-context** using the OpenCode API: `await context.client.prompt({ message: promptText, isolated: true })`.
5. Writes the model's reply back to the child process's stdin.
6. Propagates the final exit code:
   - `exit 0` for pass, `exit 2` for fail.
   - `exit 1` (Operational Error): Fails closed on all enforcing gates (P1 Interrogate, P3 Rail, P5 Prosecute) and fails open (logs warning) on advisory gates.

#### Grandchild Process Cascading (`adlc-runner`):
To enable keyless execution for the phase runner (`adlc-runner`), the runner is updated to support a `--prompt-only-cascade` flag:
- When `adlc-runner run <phase>` is spawned, it forwards this flag to its fanned-out grandchildren processes.
- If a grandchild outputs a prompt, the runner bubbles up the prompt request to the parent plugin process wrapped in a structured JSON envelope containing a correlation ID: `{"type": "prompt_request", "id": "grandchild-session-uuid", "prompt": "..."}`.
- The parent plugin process intercepts this envelope, queries the model via the isolated context, and writes the response back to `adlc-runner`'s stdin using the correlation ID envelope: `{"type": "prompt_response", "id": "grandchild-session-uuid", "response": "..."}`. This correlation protocol prevents stdin/stdout multiplexing collisions during concurrent grandchild executions.

---

## 5. Creator/Critic Model Separation & Frontier-Free Scaling

To prevent sycophancy (F2) and same-model self-review (Principle 3 / E4), the plugin isolates the active builder model from the gate models:

- **Model Routing Configuration:** The plugin reads a configuration file `.adlc/config.json` defining model routing tiers (frontier, mid, cheap).
- **Dynamic Model Routing for Builders:** During Phase 2, `adlc-runner run p2` executes `model-router`, which writes the recommended model selection to a ticket-specific routing file (`.adlc/routing/<ticket-id>.json`). When OpenCode spawns the builder agent, the plugin intercepts the agent creation via the native `agent.resolve` resolver hook and dynamically sets the agent's model configuration (`model` property) to match the recommended tier.
- **Frontier Isolation for Gates:** For critical gates requiring a frontier model (Phase 1 Interrogate, Phase 3 hollow-test, Phase 5 Prosecute), the plugin bridge intercepts `runKeylessGate` and requests the configured frontier model endpoint from OpenCode (e.g. `context.client.prompt({ message: promptText, model: config.frontierModel, isolated: true })`).
- **Frontier-Free Scaling via Dynamic Calibration:**
  - If OpenCode's active model name does not match standard cloud provider routing schemas, the plugin executes a startup benchmark using the `review-calibration` tool to evaluate the active model's planted-bug recall.
  - If the calibration recall score falls below the required threshold, **the gate continues to block**. Conforming to ADLC Appendix E (Frontier-Free Doctrine), the plugin dynamically calculates the required $N$ parallel passes necessary to meet the target recall and activates **Multi-Pass Search Verification (N-Pass Loop-Until-Dry)**: it runs the gate prompt $N$ times in parallel (sampling diversity exploit, E1). The gate only passes if fanned-out candidates reach a consensus threshold (e.g., unanimous agreement) verifying correctness. The system warns the user that validation depth has been scaled up to N-passes to maintain gate recall on the local model, preserving the zero-key thesis.

---

## 6. Completeness & Implementation Limitations

All 8 phases of the ADLC are represented in this plan, but three specific boundaries are partially implemented or restricted by design.

### 6.1. Phase 6 (Integrate) is Inherently Manual (Partial)
* **Status:** ⚠️ Partial Implementation
* **Reason:** Human Gate 2 ("Is this what I meant, running?") is the human's final control gate. While the plugin automates gathering evidence (`gate-manifest attest`, `behavior-diff compare`, and `review-calibration` scores), it **cannot automate behavioral acceptance**. The plugin surfaces an execution summary card in the TUI, and the developer runs `/adlc-accept --ticket <id>` to record human acceptance.

### 6.2. In-Session Bash Gating is Gated at CI/CD Commit Time (Partial)
* **Status:** ⚠️ Dropped for In-Session Hooks, Gated at CI/CD Commit Time
* **Reason:** Aligning with the command reconciliation decision history, parsing Bash commands in-session is a source of false security. Shell execution is Turing-complete (brace expansions, subshells, aliases, option overrides like `rm -rf`). Gating Bash in-session leads to bypasses.
* **Mitigation:** The plugin's `tool.execute.before` hook only gates structured, path-addressable file tools (`write`, `edit`, `apply_patch`, `multi_edit`). Any bash-based modifications to frozen rails are caught at commit time using an unbypassable **CI/CD rails-guard check** (`docs/ci/rails-guard.yml` or script `scripts/rails-guard-ci.mjs`) which diffs the branch against the trunk base.
* **Local-only / GitLab / Pre-commit Hook Hardening:** For repositories without GitHub workflows, a pre-commit git hook (`.git/hooks/pre-commit`) is written during `/adlc-init`. To prevent self-modification bypasses, the pre-commit hook executes `adlc rails-guard` reading `.adlc/tickets.json` explicitly from `HEAD` (`git show HEAD:.adlc/tickets.json`). If `HEAD` does not exist (e.g. initial repository commit), the hook falls back to reading the staged index. We explicitly note that local git hooks are best-effort (as the agent can delete `.git/hooks/pre-commit` via a bash terminal execution) and must be backstopped by branch protection in CI/CD.

### 6.3. Background Scheduling (Partial)
* **Status:** ⚠️ Partial Implementation
* **Reason:** Phase 7 (Distill) mines repeated findings and PR rejections into reusable skills and lints. If the developer's OpenCode client runs on a transient host without persistent background daemons, cron-based maintenance or distillation runs are unavailable.
* **Mitigation:** The plugin exposes explicit TUI commands (`/adlc-distill`, `/adlc-maintain`) to run these processes on-demand at the end of a session, supplementing CI-based cron pipelines.

---

## 7. Phased Delivery Plan

We propose a six-phase delivery plan, mirroring the successful Claude Code implementation. Each phase will be subjected to an adversarial counter-review loop to check for bypasses:

* **Phase A — Dependency & Commands:** Configure package mappings for `adlc` and `adlc-runner` (pending merge). Implement `/adlc-init`, `/adlc-ticket` (P0), and gated slash commands for `/adlc-spec` (P1) and `/adlc-decompose` (P2) to ensure the lifecycle has an entry point.
* **Phase B — The Keyless Bridge:** Write the plugin SDK hook that intercepts `--prompt-only` stdin/stdout, prevents deadlock via streaming, cascades prompts to grandchild processes using correlation IDs, and routes prompts to the configured model tier in isolated contexts.
* **Phase C — In-Process Advisory Hooks:** Implement `session.created` (runs `preflight` and benchmarking) and `session.ended` (runs `gate-manifest verify`).
* **Phase D — Enforcing Rail-Guard Hook:** Deploy the `tool.execute.before` hook thin adapter (calling the self-contained `rails-checker.ts`) gating structured file edits with parent/segment canonicalization, canonical plugin root path protection, and fail-closed return contracts.
* **Phase E — Prosecutor Subagents & Distill:** Configure the fanned-out prosecution subagents (5 lenses), the verifier/reproducer agent, and loop orchestration. Wire `/adlc-distill` for lesson mining.
* **Phase F — CI Templates & Adoption Guide:** Deliver `.github/workflows` configurations, pre-commit hook scripts (hardened via `HEAD`), and publish `docs/opencode.md` for users.
