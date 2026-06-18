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
| **Preflight** (SessionStart Check) | `adlc preflight` | `session.created` / `session.start` | **Advisory**: Checks system requirements, Node/Bun runtimes, and git state. Logs warnings but never blocks the session. Reads cached benchmark configuration from `.adlc/config.json` (runs calibration benchmark only if cache is missing or model configuration changes). |
| **P0 Triage** | `/adlc-ticket` (runs interactive interview to write ticket triage class to `.adlc/tickets.json`) | **Slash Command** | Triages incoming tasks by risk × blast radius: (a) *Trivial*: Direct edit + existing rails + single prosecution pass, (b) *Bounded*: Skip to P3 rails (write test first), (c) *Substantial*: Full lifecycle loop, (d) *Architectural*: Full loop + P1 design alternatives judge panel. Writes triage categorization to `.adlc/tickets.json`. `adlc-runner run p0` asserts that: (1) a valid ticket is active, (2) the triage class in `.adlc/tickets.json` has human sign-off, and (3) a dispatcher check verifies the active diff has not violated the blast radius restrictions for the declared triage class. |
| **Spec Interrogation** (P1) | `/adlc-spec` (runs `adlc spec-lint`, `adlc premortem`, `adlc parallax`) + `/adlc-approve-spec` (signs manifest) + `adlc-runner run p1` (assertion) | **Slash Commands** / `/adlc-spec` & `/adlc-approve-spec` | Model-guided spec shaping via `/adlc-spec`. Human Gate 1 (spec approval) runs `/adlc-approve-spec` to record the human approval signature in the manifest. `adlc-runner run p1` is called to assert that both spec audit evidence and G1 signature exist. Transition to P2 (Decompose) is blocked until `adlc-runner run p1` passes. |
| **Decomposition** (P2) | `/adlc-decompose` (runs `adlc coldstart`, `adlc model-router`, `adlc merge-forecast`) + `adlc-runner run p2` (assertion) | **Slash Command** / `/adlc-decompose` | Splits spec into atomic, typed ticket partitions. Verifies that `coldstart` passes on each ticket and `merge-forecast` certifies execution width. Routes the recommended model selection to a ticket-specific configuration file. `adlc-runner run p2` asserts decomposition evidence exists. |
| **Rail Authoring & Freeze** (P3 / C5) | `/adlc-rail-write` (calls `rail-writer` agent, `adlc hollow-test`, `adlc rails-guard`) + `adlc-runner run p3` (assertion) | **Slash Command** / `/adlc-rail-write` & `tool.execute.before` (PreToolUse) | Gated subagent `rail-writer` writes tests and stubs in an isolated context. Runs `adlc hollow-test` to verify tests fail on implementation deletion before freeze. Hook intercepts structured edits. Blocks writes to rail paths declared in active tickets + freezes the `.adlc/tickets.json` trust root. `adlc-runner run p3` asserts rail-freeze evidence exists. |
| **Build Gate** (P4 / G4) | `adlc-runner run p4` (assertion) | **Slash Command** (`/adlc-prosecute` execution boundary) | **Enforcing**: Asserts that the G4 build gate is satisfied (the build compiles, lints are clean, and all rail tests pass on the current implementation) prior to beginning Phase 5 prosecution. Blocks the transition if failures exist. |
| **Flail Supervision** (P4 / C6) | `adlc flail-detector` | `tool.execute.after` (PostToolUse) | **Enforcing (Proposed SDK Extension Specification)**: Scans tool logs for flailing. Strike 1 (Enforcing, Non-Destructive): terminates builder subagent, stashes uncommitted work safely (`git stash`), appends failed approaches and logs to `.adlc/tickets.json` history, and restarts builder in a fresh context with the amended ticket. Strike 2 (Enforcing, Non-Destructive): builder subagent is terminated, staged work is safely stashed, and ticket is escalated back to Phase 2 (Decompose) for ticket partition boundary repair. |
| **Hard-Bug Repair** (P4 / C7) | `adlc consensus-fix` | **Slash Command** (`/adlc-consensus-fix`) | User-invoked. Runs parallel candidate repairs and merges the consensus winner; escalates to human if candidates diverge. |
| **Prosecution** (P5) | Hostile subagents (5 lenses) + `adlc-runner run p5` (assertion) | **Slash Command** (`/adlc-prosecute`) | Pre-merge prosecution fanned out across independent, fresh-context, single-lens subagents (security, correctness, contract, diff, tests). Loops for a maximum of $R_{\text{max}}$ rounds (convergence budget) read from `.adlc/config.json`, stopping and escalating if findings do not dry out. `adlc-runner run p5` asserts: (1) no active findings remain, (2) all rails are green (tests pass), and (3) the rails-diff-empty proof exists in the manifest (verifying the builder never modified frozen rails). |
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
      dist/
        index.js          # Pre-bundled distribution entrypoint loaded by OpenCode (H3, L3)
      index.ts            # TypeScript entrypoint source
      package.json        # Plugin package metadata
      rails-checker.ts    # Thin wrapper mapping OpenCode args to shared @adlc/core rails engine (H3)
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

To prevent runtime resolution failures, logic drift, and drifting copies (violating the ADR's companion direction), the plugin does **not** duplicate or manually vendor the core rails-checking, path-resolution, and patch-parsing helper functions. The file `plugin/adlc-opencode/rails-checker.ts` is a **thin, local harness adapter** that maps OpenCode-specific tool arguments to the canonical, shared validation function exported by `@adlc/core` (or `@adlc/hook-core`), which is declared as a devDependency and **pre-bundled** at build time into the plugin's single-file distribution bundle (`plugin/adlc-opencode/dist/index.js`) using a bundler.

The hook executes with a strict fail-closed contract:
- **Base Tool and Event Names Caveat (L2):** The base hook event signatures (e.g., `tool.execute.before`, `tool.execute.after`, `session.created`) and tool names (e.g., `write`, `edit`, `apply_patch`) are target API interfaces to be verified against the official OpenCode SDK specification during implementation.
- **Hook Gating Boundary & Subprocess Bypass (M4):** The in-session hook strictly gates **agent edit-tools** (e.g., the intercepted file mutation tools). It does **not** intercept or block file system writes performed by the plugin's own CLI subprocesses (e.g., `Bun.spawn` running `adlc` or `adlc-runner` commands), which write directly via the Node `fs` API.
- **Phase Gating & Triage-Class Skips (H1, M1, L3):**
  - If a ticket is active in the repository (`.adlc/tickets.json`), the hook enforces a **Phase Transition Gate** at the tool layer to prevent the builder agent from bypassing spec and decomposition checks.
  - **Triage Class Gating & Mechanical Override:** The ticket's triage classification is determined through an interactive human interview via `/adlc-ticket`. To prevent builder agents from reward-hacking the classification to bypass gates (F5/M1), the triage class must be confirmed by the human developer. The dispatcher (`adlc` CLI utility) or the hook itself enforces a **mechanical blast-radius check**: if the diff touches any existing rails, modifies files outside the designated domain boundaries declared in the ticket, or introduces new configuration/environment files, the classification is automatically overridden to **Substantial** in `.adlc/tickets.json` and the linear gates are engaged. The runner `adlc-runner run p0` strictly asserts that: (1) a valid ticket is active, (2) the triage class in `.adlc/tickets.json` has human sign-off, and (3) a dispatcher check verifies the active diff has not violated the blast radius restrictions for the declared triage class (M-1, M-2).
  - If the active ticket is triaged as **Substantial** or **Architectural**, the hook intercepts and blocks *all* structured file edits to any repository path (returning `{allow:false}`) until `adlc-runner run p1` (spec interrogation) and `adlc-runner run p2` (decomposition) have successfully asserted.
  - If the active ticket is triaged as **Bounded**, the hook blocks all edits until the rails are written and frozen in Phase 3.
  - **P3-to-P4 Rail Freeze Transition:** When a Bounded/Substantial/Architectural ticket is active, the declared `rails` paths are initially marked as **Pending** (writable by the `rail-writer` agent). P3 is completed when `/adlc-rail-write` is executed (which runs `adlc hollow-test` to verify tests fail on implementation deletion, and appends the rail-freeze signature). Once P3 is asserted, the rails transition from **Pending** to **Frozen**, engaging the hook's edit block on those paths.
  - **Trivial Gating & Hardening choice:** If the active ticket is triaged as **Trivial**, the hook skips P1, P2, P3, and P6 (G2) gates entirely (marking them as auto-passed/skipped in the manifest) and permits edits immediately. A single prosecution pass (P5) runs automatically to verify tests and checks. Conforming to the two-human-gates-maximum boundary, no P6 (G2) human acceptance ceremony is required for Trivial changes, minimizing adoption friction (L-1).
  - If no ticket is active, the hook behaves as a **no-op** and immediately permits the tool call (no-op safety: clean repos cannot be bricked).
- **Suppression-Marker Gating (Goodhart Defense):** The rails-guard hook, pre-commit hook, and CI/CD workflows scan the diff (or parse file edits) and fail the check if any new test skip/xfail decorators (e.g., `test.skip`, `it.only`, `@pytest.mark.skip`, `@unittest.skip`) or lint-suppress comments (e.g., `eslint-disable`, `eslint-disable-next-line`, `ts-ignore`, `eslint-disable-line`) are introduced, unless they are explicitly declared in the ticket's `allowedSuppressions` whitelist in `.adlc/tickets.json` (complying with ADLC C5 and the Goodhart Annex) (M-3).
- **In-Session Direct Checks:** To avoid the performance overhead and nondeterministic failure risks of spawning shell commands or LLM calls on every tool use, the hook resolves and reads `.adlc/tickets.json` **directly via Node `fs`**.
- **Default-Intercept Path Filter & Unresolved Target Protection (L1):** Instead of gating an explicit allowlist of tool names, the hook utilizes a **default-intercept** approach for structured tools: it intercepts *all* tool calls that accept path arguments, allowlisting only explicitly safe read-only tools (`read`, `view`, `glob`, `search`, `grep`), and inspects their target paths. If a tool call is write-capable (non-allowlisted) but its target paths cannot be resolved by the hook (e.g., unrecognized parameter names or arguments), the hook **must deny the execution (fail closed)** by returning `{ allow: false, reason: "Unresolved target path on mutation tool call" }` to prevent silent bypasses.
- **Path Protection & Symlink Hardening:** The hook canonicalizes target paths. To prevent directory traversal and symlink bypasses on new file creation (where the file does not exist yet), the hook resolves symlinks on the *staged target path itself*, walking from the root directory segment-by-segment to verify that no path segment is a symlink resolving into a restricted directory.
  - At startup, the plugin resolves its own physical path using `fs.realpathSync(__filename)`. It locks this resolved canonical root path, protecting all files under the `.opencode/` directory from edits regardless of whether it is globally installed, locally copied, or symlinked.
  - It specifically denies edits to:
    1. Declared `rails` paths (once frozen).
    2. The `.adlc/` directory (preventing editing of `tickets.json` or `manifest.jsonl`).
    3. The canonical plugin root path and the entire `.opencode/` directory, including the `plugin/`, `command/`, `agent/`, and `skill/` subdirectories and the `opencode.json` configuration file (preventing builder agents from altering plugin behavior, commands, skills, or agents in-session to bypass verification).
    4. The `.git/` directory (preventing deletion or manipulation of hooks, except during `/adlc-init` execution). To prevent builder agents from spoofing init mode, `/adlc-init` generates a transient, cryptographically signed one-time token in memory, which the hook verifies before permitting writes to `.git/` (L5). All other edits to `.git/` are blocked.
    5. The `.github/` and CI config directories (preventing editing of workflows like `ci/rails-guard.yml`).
- **`apply_patch` Payload Parsing:** The helper parses patch payloads (inspecting unified diff markers) to identify target files and evaluate them against protected paths.
- **OpenCode Fail-Closed Hook Configuration (H1, H3, H4):**
  - The plugin does **not** call `process.exit()` (which would terminate the in-process Bun backend and crash the entire OpenCode server). It strictly throws standard JS errors or returns the native block payload: `{ allow: false, reason: "..." }`.
  - **onFailure Hook Posture (Proposed SDK Extension Specification):** Conforming to ADR Refinement 3, a fail-closed contract cannot live solely inside the plugin's JavaScript execution (since syntax or loading errors would prevent the JS from running, causing a fail-open default). Instead, the plugin registration in `.opencode/opencode.json` proposes a hook configuration option to fail-closed on loading errors or hook crashes:
    `{ "event": "tool.execute.before", "handler": "./plugin/adlc-opencode/dist/index.js", "onFailure": "deny" }`
    *Note: If the harness does not support a native `onFailure: deny` hook configuration, any plugin loading error, syntax exception, or startup crash will default-allow (fail open) the in-session hook. In such environments, the rails-guard safety guarantee relies entirely on the CI/CD rails-guard workflow backstop.*
- **Automated Manifest Side-Effects (M6):**
  - Non-human evidence (such as test runs, `hollow-test` results, `flail-detector` logs, and prosecutor verdicts) is automatically captured and appended to `.adlc/manifest.jsonl` as an automated side effect of tool completion (via the `tool.execute.after` hook), rather than relying on manual slash command ceremonies. Human-gate approvals (G1 spec approval `/adlc-approve-spec` and G2 acceptance `/adlc-accept`) remain human-signed ceremonies.
- **Auditable Bypass (L11):** Setting `ADLC_RAILS_BYPASS=1` is only permitted if the environment variable is validated through a secure human-in-the-loop prompt in the TUI (via the proposed plugin UI API). In non-interactive/headless runs (where no TUI is available), the bypass is **refused (fails closed)**.

### 4.3. Keyless LLM-Gate Dispatch (Two-Phase Bridge & Stdio JSON Cascade Protocol)

Because `@adlc/*` CLI tools comply with the `--prompt-only` execution contract, they print the generated prompt to `stdout` and **exit immediately with code 0** (rather than holding stdin open or waiting for interaction). However, several critical tools (such as `parallax`, `premortem`, and `consensus-fix`) execute multi-sample (E1 sampling diversity) or multi-round operations natively when run directly via the `adlc` dispatcher.

To bridge both simple single-prompt gates and complex multi-sample/multi-round/grandchild runner commands keylessly, the plugin bridge implements a **Two-Phase Stdio JSON Cascade Protocol** (H-2):

#### Bin Execution PATH Resolution (H3):
To resolve the install resolution and unpublished runner package constraints, the plugin does NOT declare `@adlc/cli` or `@adlc/runner` as direct npm package dependencies (which would crash installation on the unpublished runner). Instead, the plugin expects these CLI tools to be installed globally by the user. At runtime, the bridge resolves the paths of the binaries by searching the user's environment `$PATH` (or executing them directly via `Bun.spawn` using the environment PATH) and falls back to searching standard global npm bin prefixes, verifying their presence and logging detailed user-friendly error guides if missing.

#### Phase 1: Prompt Extraction & Cascade Loop
1. **Spawn Extraction Process:** The bridge spawns the absolute command: `adlc <toolName> <args> --prompt-only` (or `adlc-runner run <phase> --prompt-only`).
2. **Concurrently Stream and Parse Output:** The bridge captures the stdout of the child process. To handle multi-sample draws and multi-round prompts, the dispatcher tools and runner bubble up prompts wrapped in structured JSON envelopes:
   `{"type": "prompt_request", "id": "session-uuid", "sample": 0, "round": 1, "prompt": "..."}`
   *Note: If the output is raw text rather than JSON, the bridge wraps it in a default single-round, single-sample JSON request envelope.*
3. **Parallel/Async Model Resolution:** The bridge intercepts these envelopes, extracts the prompt text, and executes them concurrently using OpenCode's active model client in transient, isolated conversation sub-contexts:
   `const completion = await context.client.prompt({ message: promptText, isolated: true });`
   If the tool requests a specific model configuration, the bridge passes the target model endpoint in the prompt request.
   **Programmatic Client Fallback / Manual Bypass (F4):** If OpenCode's programmatic prompting client API is missing, disabled, or refuses to execute, the bridge automatically degrades to a **Bypass-to-User Prompting Mode**: it outputs the generated prompt to the TUI along with an action card prompting the developer to paste the completion from an external frontier LLM, or checks the environment for a configured fallback API key (e.g., `ADLC_API_KEY`) to run the query directly.
4. **Feed Completions via Stdin:** The bridge writes the completions back to the child process's stdin as structured JSON responses:
   `{"type": "prompt_response", "id": "session-uuid", "sample": 0, "round": 1, "response": "..."}`
   The bridge loops stream-drain and stdin-feed operations until the process exits.
5. **Wait for Exit:** The bridge waits for the process to exit with code `0`, completing prompt extraction.

#### Phase 2: Execution & Gating
1. **Spawn Execution Process:** The bridge spawns the absolute CLI path *again* in execution mode (without the `--prompt-only` flag): `adlc <toolName> <args>` (or `adlc-runner run <phase>`).
2. **Supply Saved Responses:** During execution mode, the bridge supplies the cached completions generated during Phase 1 to the child process's stdin (or via temporary parameters), resolving the gate keylessly.
3. **Capture and Propagate Exit Code:** The bridge waits for the tool to complete and propagates the exit code:
   - `exit 0` (Pass): The gate passes, and the execution is permitted.
   - `exit 2` (Fail): The gate rejects, blocking the build or merge.
   - `exit 1` (Operational Error): Fails closed on all enforcing gates (P1 Interrogate, P3 Rail, P4 Build Gate, P5 Prosecute) and fails open (logs warning) on advisory gates.

---

## 5. Creator/Critic Model Separation Target & Frontier-Free Scaling

To prevent sycophancy (F2) and same-model self-review (Principle 3 / E4), the plugin defines a target architecture to isolate the active builder model from the gate models:

> [!IMPORTANT]
> The model routing, keyless automatic prompts, and separation features described in this section are target architectural designs that depend entirely on the proposed OpenCode SDK extensions (`agent.resolve` resolver hooks, dynamic model configuration, isolated programmatic model client prompting `context.client.prompt`, and the prompt UI API for human bypass confirmations). In environments where these extensions are not yet implemented in the harness, the plugin defaults to running the builder and gate tools on the active session model, relying strictly on **fresh-context isolation (Principle 3 / fresh context is the active ingredient)** as the primary security barrier to prevent sycophancy, and falls back to manual API key setup (`ADLC_API_KEY`) or user-prompt copy-paste flows.

- **Model Routing Configuration:** The plugin reads a configuration file `.adlc/config.json` (autogenerated on `/adlc-init` if missing) defining model routing tiers (frontier, mid, cheap).
- **Dynamic Model Routing for Builders (Proposed SDK Extension Specification):** During Phase 2, the `/adlc-decompose` slash command executes `adlc model-router` (or delegates to the decomposition skill), which writes the recommended model selection to a ticket-specific routing file (`.adlc/routing/<ticket-id>.json`). When OpenCode spawns the builder agent, the plugin intercepts the agent creation via the proposed `agent.resolve` resolver hook interface and dynamically sets the agent's model configuration (`model` property) to match the recommended tier.
- **Frontier Isolation for Gates (Proposed SDK Extension Specification):** For critical gates requiring a frontier model (Phase 1 Interrogate, Phase 3 hollow-test, Phase 5 Prosecute), the plugin bridge intercepts `runKeylessGate` and requests the configured frontier model endpoint from OpenCode via `context.client.prompt({ message: promptText, model: config.frontierModel, isolated: true })`.
- **Frontier-Free Scaling via Dynamic Calibration (L4):**
  - If the active model name does not match standard cloud provider routing schemas (e.g. running a local model via Ollama), the plugin runs a startup benchmark using `adlc review-calibration`. To prevent live working-tree mutation and protect the user's active tree from corruption (M-5), this tool operates entirely within a cloned git repository in a temporary directory (or a temporary memory-backed git ref), planting synthetic bugs on a historical git diff (retrieved from the repository history) and verifying if they are caught by the model stack, completely bypassing the active working tree.
  - **Fresh Repository Handling:** If the repository has no merge or commit history (e.g., a newly initialized repository), the calibration benchmark is skipped. The plugin falls back to a safe default consensus setting (e.g., $N = 3$ passes under majority consensus) and outputs a warning advising that calibration cannot run until the initial commits are recorded.
  - **Calibration Caching (M2):** To avoid the high computational cost of running review-calibration on every single session start, the plugin caches the calibrated stack size $N$ and consensus $k$ settings in `.adlc/config.json`. The preflight hook (`session.created`) only checks for this cache and prompts for a recalibration run on model changes, rather than executing the calibration pass on every session startup.
  - Conforming to ADLC Appendix E2 (Search replaces insight) and C8, the plugin does not analytically extrapolate the stack size $N$ parallel passes using an independence assumption (since same-model high-temperature resampling produces correlated failures, meaning a model that misses a vulnerability class will consistently miss it on all draws). Instead, the plugin **empirically measures the actual fanned-out $N$-pass stack recall score**.
  - The plugin runs `adlc review-calibration` on the $N$-pass stack (starting at $N = 3$) and increments the stack size $N$ until the empirically measured stack recall meets or exceeds the required threshold (e.g., $95\%$).
  - **Consensus Threshold & Specificity Blowup (L10):** A strict unanimous-to-pass rule over $N$ passes drives false blocks (false positives) up as $1 - (1 - f)^N$, where $f$ is the single-pass false-positive rate. To mitigate this specificity blowup, the calibration benchmark evaluates *both* recall and specificity, and the plugin sets the consensus threshold to require a majority (e.g., $k$-out-of-$N$ consensus where $k = \lfloor N/2 \rfloor + 1$) rather than unanimity, ensuring both high recall and high specificity. The system warns the user that validation depth has been calibrated to $N$ passes under $k$-out-of-$N$ consensus, preserving the zero-key thesis.
  - **Consensus vs. Verifier Composition (M5):** The $k$-out-of-$N$ majority consensus governs the *calibration threshold* for local-model scaling at setup time (evaluating if the model is statistically capable), whereas the `prosecutor-verifier` agent handles *individual finding validation* in the active prosecution loop. To ensure the manifest's calibration score accurately describes the active reviewer (M-6), the `adlc review-calibration` CLI performs calibration by reading the exact same agent system-prompt definitions from `.opencode/agent/prosecutor-*.md` and executing them, matching the exact subagent reviewer stack that issues the prosecution verdicts and preserving the C8↔C11 provenance link.
  - **Loop Convergence Budget (M3):** The maximum number of loop rounds for prosecution convergence is denoted by $R_{\text{max}}$ (read dynamically from `maxRounds` in `.adlc/config.json`, defaulting to 5 rounds) to differentiate it from the parallel stack size $N$ (number of parallel sampling passes). If $R_{\text{max}}$ loop rounds are reached without drying out, prosecution terminates and escalates.

---

## 6. Completeness & Implementation Limitations

All 8 phases of the ADLC are represented in this plan (with Phase 4 (Build) realized natively by OpenCode's active builder agent and gated dynamically in-session by the `rails-guard` and `flail-detector` hooks), but three specific boundaries are partially implemented or restricted by design.

### 6.1. Phase 6 (Integrate) is Inherently Manual (Partial)
* **Status:** ⚠️ Partial Implementation
* **Reason:** Human Gate 2 ("Is this what I meant, running?") is the human's final control gate. While the plugin automates gathering evidence (`gate-manifest attest`, `behavior-diff compare`, and `review-calibration` scores), it **cannot automate behavioral acceptance**. The plugin surfaces an execution summary card in the TUI, and the developer runs `/adlc-accept --ticket <id>` to record human acceptance.

### 6.2. In-Session Bash Gating is Gated at CI/CD Commit Time (Partial)
* **Status:** ⚠️ Dropped for In-Session Hooks, Gated at CI/CD Commit Time
* **Reason:** Aligning with the command reconciliation decision history, parsing Bash commands in-session is a source of false security. Shell execution is Turing-complete (brace expansions, subshells, aliases, option overrides like `rm -rf`). Gating Bash in-session leads to bypasses.
* **Mitigation (H3, M5):**
  - **CI/CD Rails-Guard Union Strategy:** Any bash-based modifications to frozen rails are caught at commit time using an unbypassable **CI/CD rails-guard check** (`docs/ci/rails-guard.yml` or script `scripts/rails-guard-ci.mjs`) which diffs the branch against the trunk base. Crucially, to prevent deletion bypasses and protect new rails introduced in the same PR (M-4), the CI check evaluates the **union of rail declarations** from both the trunk base branch (e.g., `git show origin/main:.adlc/tickets.json` or target base ref) and the current head ref (PR branch). Any rail path present in the base branch `tickets.json` is strictly locked and cannot be deleted or modified by the PR commits (deletion-proof), while any new rail paths declared in the PR branch's `tickets.json` are also enforced as frozen for all implementation changes within that PR (new-rail-aware).
  - **Local-Only / Non-CI Simplify Fallback (M5):** Since repositories without CI/CD workflows cannot execute the post-merge Simplify pass automatically, the plugin expands the `/adlc-distill` command: running `/adlc-distill --simplify` executes the Simplify pass locally on-demand once all tests are green, protecting the repository against code bloat.
* **Local-only / GitLab / Pre-commit Hook Hardening:** For repositories without GitHub workflows, a pre-commit git hook (`.git/hooks/pre-commit`) is written during `/adlc-init`. To prevent self-modification bypasses, the pre-commit hook executes `adlc rails-guard` reading the union of rail declarations from `HEAD` (`git show HEAD:.adlc/tickets.json`) and the staged index, ensuring new rails are locked locally. We explicitly note that local git hooks are best-effort (as the agent can delete `.git/hooks/pre-commit` via a bash terminal execution) and must be backstopped by branch protection in CI/CD.

### 6.3. Background Scheduling (Partial)
* **Status:** ⚠️ Partial Implementation
* **Reason:** Phase 7 (Distill) mines repeated findings and PR rejections into reusable skills and lints. If the developer's OpenCode client runs on a transient host without persistent background daemons, cron-based maintenance or distillation runs are unavailable.
* **Mitigation:** The plugin exposes explicit TUI commands (`/adlc-distill`, `/adlc-maintain`) to run these processes on-demand at the end of a session, supplementing CI-based cron pipelines.

### 6.4. Keyless Prompting & Creator/Critic SDK Dependencies (Partial, H2)
* **Status:** ⚠️ Partial Implementation / Dependent on SDK Extensions
* **Reason:** The keyless prompt extraction bridge, isolated sub-contexts, flail-detector builder restart, and creator/critic model separation rely on proposed OpenCode SDK extension interfaces (`context.client.prompt({ isolated, model })` and `agent.resolve` hooks). Until these APIs are implemented in the harness, the plugin uses fresh-context isolation on the active session model, and requires manual `ADLC_API_KEY` configuration or manual copy-pasting for gate queries.

---

## 7. Phased Delivery Plan

We propose a six-phase delivery plan, mirroring the successful Claude Code implementation. Each phase will be subjected to an adversarial counter-review loop to check for bypasses:

* **Phase A — Dependency & Commands:** Configure package mappings for `adlc` and `adlc-runner` (pending merge). Implement `/adlc-init` (which scaffolds `.adlc/config.json` and copies/symlinks slash command/agent/skill directories into `.opencode/` from the package source), `/adlc-ticket` (P0 triage interview writer), `/adlc-approve-spec` (P1 G1), and gated slash commands for `/adlc-spec` (P1) and `/adlc-decompose` (P2) to ensure the lifecycle has an entry point.
* **Phase B — The Keyless Bridge:** Write the plugin SDK hook that implements the two-phase execution protocol to extract prompts via `--prompt-only` and feed completions to execution-mode subprocesses, handles concurrent multi-round and multi-sample flows via the Two-Phase Stdio JSON Cascade Protocol, and routes prompts to isolated sub-contexts.
* **Phase C — In-Process Advisory Hooks:** Implement `session.created` (reads cached preflight calibration from `.adlc/config.json` and runs benchmarks on model changes) and `session.ended` (runs `gate-manifest verify`).
* **Phase D — Enforcing Rail-Guard Hook:** Deploy the `tool.execute.before` hook thin adapter (`rails-checker.ts` importing validation logic from `@adlc/core`) gating structured file edits with parent/segment canonicalization, canonical plugin root path protection, suppression-marker scans (Goodhart defense), and fail-closed return contracts.
* **Phase E — Prosecutor Subagents, G4 Build Gate & Distill:** Configure the G4 build gate assertion (`adlc-runner run p4` running build/lint/test suite prior to prosecution), the fanned-out prosecution subagents (5 lenses), the verifier/reproducer agent, and loop orchestration. Wire `/adlc-distill` for lesson mining and optional local `--simplify` pass.
* **Phase F — CI Templates & Adoption Guide:** Deliver `.github/workflows` configurations (hardened to read the union of `.adlc/tickets.json` from the trunk base ref and head branch), pre-commit hook scripts (hardened via union of HEAD and staged index), and publish `docs/opencode.md` for users.
