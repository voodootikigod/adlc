# Plan: Installing & Integrating ADLC into OpenCode

**Status:** Proposal · **Branch:** `opencode-integration` · **Date:** 2026-06-18

---

## 1. Problem Statement

Today, the `@adlc/*` toolkit ships as 19 independent, gate-shaped CLI packages, managed under one `@adlc/cli` dispatcher (with the `@adlc/runner` phase engine pending merge from the sibling `feat/codex-integration-codex` branch). While highly composable, using the Agentic Development Lifecycle (ADLC) in a raw terminal environment requires developers to:
1. Know exactly which CLI tool maps to which lifecycle phase (P0–P7) or control dial (D1–D3).
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
- **Proposed SDK Extension Interfaces:** The model-routing and isolated-prompting capabilities detailed in this plan require specific extensions to the OpenCode plugin API (e.g., dynamic session model overriding and isolated sub-contexts). These are documented herein as target plugin specifications, to be verified or implemented in the OpenCode plugin SDK.

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
| **P0 Triage** | `/adlc-ticket` (runs interactive interview to write ticket triage class to `.adlc/tickets.json`) | **Slash Command** | Triages incoming tasks by risk × blast radius: (a) *Trivial*: Direct edit + existing rails + single prosecution pass, (b) *Bounded*: Skip to P3 rails (write test first), (c) *Substantial*: Full lifecycle loop, (d) *Architectural*: Full loop + P1 design alternatives judge panel. Writes triage categorization to `.adlc/tickets.json`. |
| **Spec Interrogation** (P1) | `/adlc-spec` (runs `adlc spec-lint`, `adlc premortem`, `adlc parallax`) + `/adlc-approve-spec` (signs manifest) + `adlc-runner run p1` (assertion) | **Slash Commands** / `/adlc-spec` & `/adlc-approve-spec` | Model-guided spec shaping via `/adlc-spec`. Human Gate 1 (spec approval) runs `/adlc-approve-spec` to record the human approval signature in the manifest. `adlc-runner run p1` is called to assert that both spec audit evidence and G1 signature exist. Transition to P2 (Decompose) is blocked until `adlc-runner run p1` passes. |
| **Decomposition** (P2) | `/adlc-decompose` (runs `adlc coldstart`, `adlc model-router`, `adlc merge-forecast`) + `adlc-runner run p2` (assertion) | **Slash Command** / `/adlc-decompose` | Splits spec into atomic, typed ticket partitions. Verifies that `coldstart` passes on each ticket and `merge-forecast` certifies execution width. Routes the recommended model selection to a ticket-specific configuration file. `adlc-runner run p2` asserts decomposition evidence exists. |
| **Rail Authoring & Freeze** (P3 / C5) | `/adlc-rail-write` (calls `rail-writer` agent, `adlc hollow-test`, `adlc rails-guard`) + `adlc-runner run p3` (assertion) | **Slash Command** / `/adlc-rail-write` & `tool.execute.before` (PreToolUse) | Gated subagent `rail-writer` writes tests and stubs in an isolated context. Runs `adlc hollow-test` to verify tests fail on implementation deletion before freeze. Hook intercepts structured edits. Blocks writes to rail paths declared in active tickets + freezes the `.adlc/tickets.json` trust root. `adlc-runner run p3` asserts rail-freeze evidence exists. |
| **Flail Supervision** (P4 / C6) | `adlc flail-detector` | `tool.execute.after` (PostToolUse) | **Enforcing (Proposed SDK Extension Specification)**: Scans tool logs for flailing. Strike 1 (Enforcing, Non-Destructive): terminates builder subagent, stashes uncommitted work safely (`git stash`), appends failed approaches and logs to `.adlc/tickets.json` history, and restarts builder in a fresh context with the amended ticket. Strike 2 (Enforcing, Non-Destructive): builder subagent is terminated, staged work is safely stashed, and ticket is escalated back to Phase 2 (Decompose) for specification repair. |
| **Hard-Bug Repair** (P4 / C7) | `adlc consensus-fix` | **Slash Command** (`/adlc-consensus-fix`) | User-invoked. Runs parallel candidate repairs and merges the consensus winner; escalates to human if candidates diverge. |
| **Prosecution** (P5) | Hostile subagents (5 lenses) + `adlc-runner run p5` (assertion) | **Slash Command** (`/adlc-prosecute`) | Pre-merge prosecution fanned out across independent, fresh-context, single-lens subagents (security, correctness, contract, diff, tests). Loops for a maximum of 5 rounds (convergence budget), stopping and escalating if findings do not dry out. `adlc-runner run p5` asserts: (1) no active findings remain, (2) all rails are green (tests pass), and (3) the rails-diff-empty proof exists in the manifest (verifying the builder never modified frozen rails). |
| **Integrate** (P6) | `/adlc-accept` (runs `adlc behavior-diff compare` + `adlc-runner accept --ticket <id>`) | **Slash Command** / `/adlc-accept` | Human Gate 2 (behavioral acceptance). Gathers diff evidence. Prompts the developer to run the demo. Running `/adlc-accept` records the human acceptance hash and signs the manifest. |
| **Gate Evidence** (C11) | `adlc gate-manifest verify` | `session.ended` / `session.terminated` | **Advisory**: Runs `adlc gate-manifest verify` on session end to check the integrity of the `.adlc/manifest.jsonl` append-only chain. |
| **Distill** (P7) | `/adlc-distill` (runs `adlc lesson-foundry`, `adlc rejection-mining`) + `adlc-runner run p7` (assertion) | **Slash Command** (`/adlc-distill`) | Runs lesson mining to harvest skills/lints. `adlc-runner run p7` asserts distillation evidence. **Simplify pass is strictly post-merge**: runs in the CI/CD pipeline under green tests, automatically opening a new pull request for final merging. |
| **Maintenance** (C10/C12) | `adlc skill-rot`, `adlc model-ratchet`, `adlc gate-fuzzing` | **Slash Command** (`/adlc-maintain`) + CI Action | Advisory. Runs checks on repository drift, stale skills, and gate bypasses. |

---

## 4. What We Build

We will implement the integration inside a project-level `.opencode/` folder or pack it as a global npm package under a unified harness adapter `@adlc/opencode-plugin`.

### 4.1. Directory Structure

```
.opencode/
  opencode.json           # Registers plugin pathways (autogenerated on /adlc-init if missing)
  plugin/
    adlc-opencode/
      index.ts            # Entrypoint exporting Plugin thin binding
      package.json        # Plugin dependencies (declares @adlc/cli, @adlc/runner)
      rails-checker.ts    # Self-contained rails validation and path helper
  command/
    adlc-init.md          # Slash command to bootstrap .adlc/ and scaffold .opencode/
    adlc-ticket.md        # Slash command to triage/create a ticket (P0)
    adlc-spec.md          # Slash command to shape/lint spec (P1)
    adlc-approve-spec.md  # Slash command to record human spec approval signature (P1 G1)
    adlc-decompose.md     # Slash command to slice ticket partitions (P2)
    adlc-rail-write.md    # Slash command to author tests and stubs (P3)
    adlc-consensus-fix.md # Slash command to run consensus repair (P4)
    adlc-prosecute.md     # Slash command to run prosecution fan-out (P5)
    adlc-accept.md        # Slash command to finalize behavioral acceptance (P6)
    adlc-distill.md       # Slash command to run lesson foundry (P7)
    adlc-maintain.md      # Slash command to run weekly/on-demand maintenance (C10/C12)
  agent/
    rail-writer.md            # P3 rail authoring agent (fresh context)
    prosecutor-correctness.md # Correctness lens reviewer (fresh context)
    prosecutor-security.md    # Security lens reviewer (fresh context)
    prosecutor-contract.md    # Contract conformance reviewer (fresh context)
    prosecutor-diff.md        # Spec-vs-implementation diff reviewer (fresh context)
    prosecutor-tests.md       # Auditor reviewer for builder-added tests (fresh context)
    prosecutor-verifier.md    # Findings verification/reproduction agent
  skill/
    adlc.md               # Main phase-routing discovery flowchart (using-agent-skills mapping)
```

### 4.2. In-Process Hook Contract (Fail-Closed & Path Hardening)

To prevent runtime resolution failures and logic drift, the plugin does **not** load external `@adlc/core` modules directly at hook execution time. Instead, it vendors the core rails-checking, path-resolution, and patch-parsing helper functions into a self-contained, zero-dependency helper file `plugin/adlc-opencode/rails-checker.ts`.

The hook executes with an **asymmetric fail-closed contract**:
- **No Rails Declared:** If `.adlc/tickets.json` is empty or no rails are declared in the active ticket, the hook behaves as a **no-op** and immediately permits the tool call (no-op safety: clean repos cannot be bricked).
- **In-Session Direct Checks:** To avoid the performance overhead and nondeterministic failure risks of spawning shell commands or LLM calls on every tool use, the hook resolves and reads `.adlc/tickets.json` **directly via Node `fs`**.
- **Default-Intercept Path Filter:** Instead of gating an explicit allowlist of tool names, the hook utilizes a **default-intercept** approach for structured tools: it intercepts *all* tool calls that accept path arguments, allowlisting only explicitly safe read-only tools (`read`, `view`, `glob`, `search`, `grep`), and inspects their target paths.
- **Path Protection & Symlink Hardening:** The hook canonicalizes target paths. To prevent directory traversal and symlink bypasses on new file creation (where the file does not exist yet), the hook resolves symlinks on the *staged target path itself*, walking from the root directory segment-by-segment to verify that no path segment is a symlink resolving into a restricted directory.
  - At startup, the plugin resolves its own physical path using `fs.realpathSync(__filename)`. It locks this resolved canonical root path, protecting all files under the `.opencode/` directory from edits regardless of whether it is globally installed, locally copied, or symlinked.
  - It specifically denies edits to:
    1. Declared `rails` paths.
    2. The `.adlc/` directory (preventing editing of `tickets.json` or `manifest.jsonl`).
    3. The canonical plugin root path and the entire `.opencode/` directory, including the `plugin/`, `command/`, `agent/`, and `skill/` subdirectories and the `opencode.json` configuration file (preventing builder agents from altering plugin behavior, commands, skills, or agents in-session to bypass verification).
    4. The `.git/` directory (preventing deletion or manipulation of hooks, except for initial setup during `/adlc-init` execution).
    5. The `.github/` and CI config directories (preventing editing of workflows like `ci/rails-guard.yml`).
- **`apply_patch` Payload Parsing:** The helper parses patch payloads (inspecting unified diff markers) to identify target files and evaluate them against protected paths.
- **OpenCode Fail-Closed Return:** If the hook determines an edit is blocked or encounters an operational error, the plugin catches it and returns a native OpenCode block payload (e.g. `{ allow: false, reason: "..." }`) rather than failing open. If running in a subprocess hook environment, it exits the subprocess with `exit 2`. Any hook crash or operational error while rails are declared **fails closed**.
- **Auditable Bypass:** Setting `ADLC_RAILS_BYPASS=1` is only permitted if the environment variable is validated through a secure human-in-the-loop prompt in the TUI (via the plugin UI API). In non-interactive/headless runs (where no TUI is available), the bypass is **refused (fails closed)**.

### 4.3. Keyless LLM-Gate Dispatch (Two-Phase Bridge & Grandchild Cascading)

Because `@adlc/*` CLI tools comply with the `--prompt-only` execution contract, they print the generated prompt to `stdout` and **exit immediately with code 0** (rather than holding stdin open or waiting for interaction). To resolve this, the plugin bridge implements a **two-phase execution protocol**:

#### Phase 1: Prompt Extraction
1. **Spawn Extraction Process:** The bridge spawns the CLI command: `adlc <toolName> <args> --prompt-only`.
2. **Capture and Drain Prompt:** The bridge concurrently streams and captures the prompt output from the child process's `stdout` to avoid buffer deadlocks.
3. **Wait for Exit:** The bridge waits for the process to exit with code `0`. Stdin is never written to in this phase.
4. **Isolated Model Invocation:** To prevent polluting the active session's transcript and accelerating context rot (F3), the bridge forwards the captured prompt text to OpenCode's active model client within a transient, isolated conversation sub-context:
   `const completion = await context.client.prompt({ message: promptText, isolated: true });`
   **Programmatic Client Fallback / Manual Bypass (F4):** If OpenCode's programmatic prompting client API is missing, disabled, or refuses to execute, the bridge automatically degrades to a **Bypass-to-User Prompting Mode**: it outputs the generated prompt to the TUI (or stdout) along with an action card prompting the developer to paste the completion from an external frontier LLM, or checks the environment for a configured fallback API key (e.g., `ADLC_API_KEY`) to run the query directly, ensuring execution is not blocked by harness API limitations.

#### Phase 2: Execution & Gating
1. **Spawn Execution Process:** The bridge spawns the CLI tool *again* in execution mode (without the `--prompt-only` flag): `adlc <toolName> <args>`.
2. **Provide Model Completion:** The bridge writes the `completion` string directly to the process's `stdin` (or supplies it via a temporary parameter file if specified by the tool) and closes `stdin` to signal completion of input.
3. **Capture and Propagate Exit Code:** The bridge waits for the tool to complete and propagates the deterministic exit code:
   - `exit 0` (Pass): The gate passes, and the execution is permitted.
   - `exit 2` (Fail): The gate rejects, blocking the build or merge.
   - `exit 1` (Operational Error): Fails closed on all enforcing gates (P1 Interrogate, P3 Rail, P5 Prosecute) and fails open (logs warning) on advisory gates.

#### Grandchild Process Cascading (`adlc-runner`):
To enable keyless execution for the phase runner (`adlc-runner`), the runner is updated to bubble up fanned-out grandchildren prompts in a structured two-phase manner:
- **Phase 1 (Bubble):** When `adlc-runner run <phase>` spawns grandchildren, it passes the `--prompt-only` flag to them. If a grandchild outputs a prompt and exits `0`, the runner captures the prompt and bubbles it to the parent plugin process wrapped in a structured JSON envelope containing a correlation ID: `{"type": "prompt_request", "id": "grandchild-session-uuid", "prompt": "..."}`.
- **Phase 2 (Inject):** The parent plugin process queries the model in an isolated context and writes the response back to `adlc-runner`'s `stdin`: `{"type": "prompt_response", "id": "grandchild-session-uuid", "response": "..."}`. The runner then re-spawns the grandchild in execution mode, supplying this response, and aggregates the resulting exit code. This correlation protocol ensures concurrent execution paths do not experience stdin/stdout multiplexing collisions.

---

## 5. Creator/Critic Model Separation Target & Frontier-Free Scaling

To prevent sycophancy (F2) and same-model self-review (Principle 3 / E4), the plugin defines a target architecture to isolate the active builder model from the gate models:

> [!IMPORTANT]
> The model routing and separation features described in this section are target architectural designs that depend entirely on the proposed OpenCode SDK extensions (`agent.resolve` resolver hooks, dynamic model configuration, and the prompt UI API for human bypass confirmations). In environments where these extensions are not yet implemented in the harness, the plugin defaults to running the builder and gate tools on the active session model, relying strictly on **fresh-context isolation (Principle 3 / fresh context is the active ingredient)** as the primary security barrier to prevent sycophancy.

- **Model Routing Configuration:** The plugin reads a configuration file `.adlc/config.json` (autogenerated on `/adlc-init` if missing) defining model routing tiers (frontier, mid, cheap).
- **Dynamic Model Routing for Builders (Proposed SDK Extension Specification):** During Phase 2, the `/adlc-decompose` slash command executes `adlc model-router` (or delegates to the decomposition skill), which writes the recommended model selection to a ticket-specific routing file (`.adlc/routing/<ticket-id>.json`). When OpenCode spawns the builder agent, the plugin intercepts the agent creation via the proposed `agent.resolve` resolver hook interface and dynamically sets the agent's model configuration (`model` property) to match the recommended tier.
- **Frontier Isolation for Gates (Proposed SDK Extension Specification):** For critical gates requiring a frontier model (Phase 1 Interrogate, Phase 3 hollow-test, Phase 5 Prosecute), the plugin bridge intercepts `runKeylessGate` and requests the configured frontier model endpoint from OpenCode via `context.client.prompt({ message: promptText, model: config.frontierModel, isolated: true })`.
- **Frontier-Free Scaling via Dynamic Calibration:**
  - If the active model name does not match standard cloud provider routing schemas (e.g. running a local model via Ollama), the plugin runs a startup benchmark using `adlc review-calibration`. To prevent live working-tree mutation, this tool plants synthetic bugs onto a historical git diff (retrieved from the repository history) and verifies if they are caught by the model, restoring the repository state immediately afterwards.
  - **Fresh Repository Handling:** If the repository has no merge or commit history (e.g., a newly initialized repository), the calibration benchmark is skipped. The plugin falls back to a safe default consensus setting (e.g., $N = 3$ passes under majority consensus) and outputs a warning advising that calibration cannot run until the initial commits are recorded.
  - Conforming to ADLC Appendix E2 (Search replaces insight) and C8, the plugin does not analytically extrapolate $N$ parallel passes using an independence assumption (since same-model high-temperature resampling produces correlated failures, meaning a model that misses a vulnerability class will consistently miss it on all draws). Instead, the plugin **empirically measures the actual fanned-out $N$-pass stack recall score**.
  - The plugin runs `adlc review-calibration` on the $N$-pass stack (starting at $N = 3$) and increments $N$ until the empirically measured stack recall meets or exceeds the required threshold (e.g., $95\%$).
  - **Consensus Threshold & Specificity Blowup (L10):** A strict unanimous-to-pass rule over $N$ passes drives false blocks (false positives) up as $1 - (1 - f)^N$, where $f$ is the single-pass false-positive rate. To mitigate this specificity blowup, the calibration benchmark evaluates *both* recall and specificity, and the plugin sets the consensus threshold to require a majority (e.g., $k$-out-of-$N$ consensus where $k = \lfloor N/2 \rfloor + 1$) rather than unanimity, ensuring both high recall and high specificity. The system warns the user that validation depth has been calibrated to $N$ passes under $k$-out-of-$N$ consensus, preserving the zero-key thesis.

---

## 6. Completeness & Implementation Limitations

All 8 phases of the ADLC are represented in this plan (with Phase 4 (Build) realized natively by OpenCode's active builder agent and gated dynamically in-session by the `rails-guard` and `flail-detector` hooks), but three specific boundaries are partially implemented or restricted by design.

### 6.1. Phase 6 (Integrate) is Inherently Manual (Partial)
* **Status:** ⚠️ Partial Implementation
* **Reason:** Human Gate 2 ("Is this what I meant, running?") is the human's final control gate. While the plugin automates gathering evidence (`gate-manifest attest`, `behavior-diff compare`, and `review-calibration` scores), it **cannot automate behavioral acceptance**. The plugin surfaces an execution summary card in the TUI, and the developer runs `/adlc-accept --ticket <id>` to record human acceptance.

### 6.2. In-Session Bash Gating is Gated at CI/CD Commit Time (Partial)
* **Status:** ⚠️ Dropped for In-Session Hooks, Gated at CI/CD Commit Time
* **Reason:** Aligning with the command reconciliation decision history, parsing Bash commands in-session is a source of false security. Shell execution is Turing-complete (brace expansions, subshells, aliases, option overrides like `rm -rf`). Gating Bash in-session leads to bypasses.
* **Mitigation:** The plugin's `tool.execute.before` hook only gates structured, path-addressable file tools (`write`, `edit`, `apply_patch`, `multi_edit`). Any bash-based modifications to frozen rails are caught at commit time using an unbypassable **CI/CD rails-guard check** (`docs/ci/rails-guard.yml` or script `scripts/rails-guard-ci.mjs`) which diffs the branch against the trunk base. Crucially, the CI check pins its trust root by reading the authoritative rail declarations from the **trunk base branch** (e.g., `git show origin/main:.adlc/tickets.json` or the target base ref) rather than the branch's local copy. This prevents a builder agent from staging commits that delete or edit `.adlc/tickets.json` to bypass verification.
* **Local-only / GitLab / Pre-commit Hook Hardening:** For repositories without GitHub workflows, a pre-commit git hook (`.git/hooks/pre-commit`) is written during `/adlc-init`. To prevent self-modification bypasses, the pre-commit hook executes `adlc rails-guard` reading `.adlc/tickets.json` explicitly from `HEAD` (`git show HEAD:.adlc/tickets.json`). If `HEAD` does not exist (e.g. initial repository commit), the hook falls back to reading the staged index. We explicitly note that local git hooks are best-effort (as the agent can delete `.git/hooks/pre-commit` via a bash terminal execution) and must be backstopped by branch protection in CI/CD.

### 6.3. Background Scheduling (Partial)
* **Status:** ⚠️ Partial Implementation
* **Reason:** Phase 7 (Distill) mines repeated findings and PR rejections into reusable skills and lints. If the developer's OpenCode client runs on a transient host without persistent background daemons, cron-based maintenance or distillation runs are unavailable.
* **Mitigation:** The plugin exposes explicit TUI commands (`/adlc-distill`, `/adlc-maintain`) to run these processes on-demand at the end of a session, supplementing CI-based cron pipelines.

---

## 7. Phased Delivery Plan

We propose a six-phase delivery plan, mirroring the successful Claude Code implementation. Each phase will be subjected to an adversarial counter-review loop to check for bypasses:

* **Phase A — Dependency & Commands:** Configure package mappings for `adlc` and `adlc-runner` (pending merge). Implement `/adlc-init` (which scaffolds `.adlc/config.json` and copies/symlinks slash command/agent/skill directories into `.opencode/` from the package source), `/adlc-ticket` (P0 triage interview writer), `/adlc-approve-spec` (P1 G1), and gated slash commands for `/adlc-spec` (P1) and `/adlc-decompose` (P2) to ensure the lifecycle has an entry point.
* **Phase B — The Keyless Bridge:** Write the plugin SDK hook that implements the two-phase execution protocol to extract prompts via `--prompt-only` and feed completions to execution-mode subprocesses, handles grandchild processes via the correlation ID JSON bubble/inject protocol, and routes prompts to isolated sub-contexts.
* **Phase C — In-Process Advisory Hooks:** Implement `session.created` (runs `preflight` and benchmarking) and `session.ended` (runs `gate-manifest verify`).
* **Phase D — Enforcing Rail-Guard Hook:** Deploy the `tool.execute.before` hook thin adapter (calling the self-contained `rails-checker.ts`) gating structured file edits with parent/segment canonicalization, canonical plugin root path protection, and fail-closed return contracts.
* **Phase E — Prosecutor Subagents & Distill:** Configure the fanned-out prosecution subagents (5 lenses), the verifier/reproducer agent, and loop orchestration. Wire `/adlc-distill` for lesson mining.
* **Phase F — CI Templates & Adoption Guide:** Deliver `.github/workflows` configurations (hardened to read `.adlc/tickets.json` from the trunk base ref), pre-commit hook scripts (hardened via `HEAD`), and publish `docs/opencode.md` for users.
