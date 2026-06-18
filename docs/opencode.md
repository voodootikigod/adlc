# Adopt the ADLC in OpenCode

The `@adlc/*` toolkit is a set of gate-shaped CLIs. This plugin makes the whole **Agentic Development Lifecycle** usable natively from inside OpenCode: the gates fire at the right lifecycle moments — some automatically — and the model reaches for the right gate without you memorizing 20 separate tools.

Following **Option D (separate, concern-focused bins)** from the Command Reconciliation ADR:
- `adlc` is the dispatcher (`@adlc/cli`) for executing individual gate tools.
- `adlc-runner` is the runner (`@adlc/runner`) for phase-evidence assertions.

> Design and rationale: [`opencode-integration-plan.md`](./opencode-integration-plan.md).
> The full thesis: [`../ADLC.md`](../ADLC.md).

---

## Install

### 1. Install the ADLC CLI Tools
The plugin needs both the ADLC dispatcher and runner binaries globally resolvable in your PATH:

```sh
npm install -g @adlc/cli @adlc/runner
```

### 2. Install the OpenCode Plugin
Copy or link the plugin files to your project-local `.opencode` directory:

```sh
mkdir -p .opencode/plugins/adlc
# Copy or symlink the integration code:
ln -s /path/to/adlc/plugins/adlc-opencode/ .opencode/plugins/adlc
```

Alternatively, register it globally in your `~/.config/opencode/opencode.json`:

```json
{
  "plugins": [
    "/path/to/adlc/plugins/adlc-opencode"
  ]
}
```

The plugin initialization check will verify that both `adlc` and `adlc-runner` bins are available on PATH and output a clear installation error if missing.

### 3. Initialize your Repository
Bootstrap the ADLC workspace context in your repository:

```sh
/adlc-init
```

This creates the `.adlc/` workspace configuration directory, templates the `.adlc/tickets.json` structure, appends runtime logs and temp directories idempotently to your `.gitignore`, and sets up a local pre-commit hook (`.git/hooks/pre-commit`) for environments that lack CI runners.

---

## What You Get

### Commands (Slash Commands)

Trigger these directly within the OpenCode TUI interface:

| Command | Phase | Description |
| --- | --- | --- |
| `/adlc-init` | — | Bootstrap `.adlc/` workspace, configure gitignore (idempotently), configure local pre-commit git hooks, and check environment readiness. |
| `/adlc-ticket` | P0 | Author a schema-valid ticket defining the ticket contract (which files are gated and where the rails are). |
| `/adlc-spec` | P1 | Runs `spec-lint` and `premortem` to shape and audit the spec, blocking build start until spec approval (`adlc-runner run p1`). |
| `/adlc-decompose` | P2 | Runs `coldstart` and `merge-forecast` to split tickets and verify contract boundaries (`adlc-runner run p2`). |
| `/adlc-prosecute` | P5 | Run the pre-merge hostile prosecution subagent loops (`adlc-runner run p5`). |
| `/adlc-distill` | P7 | Mines findings (`adlc-runner run p7`) and runs the **Simplify** pass to deduplicate and clean code. |
| `/adlc-maintain` | C10/C12 | Run decay-driven checks: stale skills, hot files, and gate calibration. |

---

### The Router Agent (Discovery Skill)

The `adlc-router` agent acts as a native phase-routing flowchart. Instead of prompting the model to remember 20 CLI tools, the router identifies your current activity ("shape this spec", "verify this bugfix") and instructs OpenCode to reach for the correct ADLC tool or slash command.

---

### The Prosecutor Subagents (Phase 5)

Pre-merge prosecution fanned out across independent, fresh-context, single-lens subagents (security, correctness, etc.) to prevent context rot. Findings are verified by a separate reproducer/verifier agent. Loops until 2 consecutive passes are dry.

---

### In-Process Hooks

OpenCode runs the plugin in-process inside its Bun JavaScript engine, executing hooks natively on specific event triggers:

| Hook Event | Trigger Event | Posture | Behavior |
| --- | --- | --- | --- |
| **preflight** | `session.created` | Advisory | Warns the user if Node/Bun runtimes, git trees, or providers are misconfigured. |
| **rails-guard** | `tool.execute.before` | **Enforcing** | Intercepts structural editing tools (`write`, `edit`, `apply_patch`, `multi_edit`). Denies edits to paths declared as `rails` in the active ticket and locks `.adlc/`, `.opencode/`, and `.adlc/tickets.json` files. Parses `apply_patch` payloads for target files. |
| **flail-detection** | `tool.execute.after` | **Enforcing** | Scans execution outputs for repeated loop errors, scope drift, or excessive logs. Terminates the active builder subagent on a second strike. |
| **manifest-audit** | `session.ended` | Advisory | Runs `gate-manifest verify` to confirm the integrity of the append-only evidence chain on session close. |

#### Rail Gating Safety & Bypasses
- **Fail-Closed Guarantee:** If a ticket declares rails, but the plugin encounters an operational error, the PreToolUse hook **fails closed (blocks editing)** to prevent bypassing verification. If no rails are declared, the hook is a complete no-op (fails open).
- **Bypass hatch:** Setting `ADLC_RAILS_BYPASS=1` overrides the in-session hook, but requires human approval in the TUI and logs the bypass event to `.adlc/manifest.jsonl` for audit compliance.
- **CI/CD / Local Backstop:** Shell-based rail mutations are blocked at commit-time via GitHub workflows or the local pre-commit hook.

---

## CI/CD Backstops (Required)

Always pair the in-session hook with a commit-time check. Copy these configurations into your `.github/workflows/` directory:

- **`ci/rails-guard.yml`** — Rejects any Pull Request whose diff touches a frozen rail. The rails are read from the **base** ref, ensuring a PR cannot remove rails to pass the check.
- **`ci/adlc-maintenance.yml`** — A weekly advisory workflow that runs the maintenance suite (`skill-rot`, `model-ratchet`, `gate-fuzzing`) and publishes the health report to the job summary.

---

## ADLC Phase Coverage

| Lifecycle Phase | Mapping Point | Execution Method |
| --- | --- | --- |
| **P0 Triage** | `/adlc-ticket` command | Triage risk × blast radius; create ticket contract. |
| **P1 Interrogate** | `/adlc-spec` command | Runs `spec-lint`/`premortem` on frontier models. approved via `adlc-runner run p1`. |
| **P2 Decompose** | `/adlc-decompose` command | Splits tickets; runs `coldstart` & `merge-forecast` via `adlc-runner run p2`. |
| **P3 Rail** | `rails-guard` (PreToolUse hook + CI) | Runs `hollow-test` to verify tests before freeze via `adlc-runner run p3`. |
| **P4 Build** | `flail-detector` (hook) / `consensus-fix` | Developer agent writes code; two-strike subagent termination. |
| **P5 Prosecute** | `/adlc-prosecute` command | Hostile fanned-out subagents + verifier loop via `adlc-runner run p5`. |
| **P6 Integrate** | Gate manifest verification | Summary card displayed in TUI for **Human Gate 2** (manual sign-off). |
| **P7 Distill** | `/adlc-distill` command | Runs `lesson-foundry`/`rejection-mining` via `adlc-runner run p7` and executes code **Simplify** pass. |
| **Maintenance** | `/adlc-maintain` / CI Actions | calibrates reviewers, checks skill-rot and model-ratchet. |
