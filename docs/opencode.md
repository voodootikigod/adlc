# Adopt the ADLC in OpenCode

The `@adlc/*` toolkit is a set of gate-shaped CLIs. This plugin makes the whole **Agentic Development Lifecycle** usable natively from inside OpenCode: the gates fire at the right lifecycle moments — some automatically — and the model reaches for the right gate without you memorizing 21 separate tools.

> Design and rationale: [`opencode-integration-plan.md`](./opencode-integration-plan.md).
> The full thesis: [`../ADLC.md`](../ADLC.md).

---

## Install

### 1. Install the ADLC CLI Tools
The plugin needs the ADLC dispatcher and runner binaries globally resolvable in your PATH:

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

### 3. Initialize your Repository
Bootstrap the ADLC workspace context in your repository:

```sh
/adlc-init
```

This creates the `.adlc/` workspace configuration directory, templates the `.adlc/tickets.json` structure, and adds runtime logs and temp directories to your `.gitignore`.

---

## What You Get

### Commands (Slash Commands)

Trigger these directly within the OpenCode TUI interface:

| Command | Phase | Description |
| --- | --- | --- |
| `/adlc-init` | — | Bootstrap `.adlc/` workspace, configure gitignore, and check environment readiness. |
| `/adlc-ticket` | P0 | Author a schema-valid ticket defining the ticket contract (which files are gated and where the rails are). |
| `/adlc-prosecute` | P5 | Run the pre-merge hostile prosecution gates (`hollow-test`, `behavior-diff`, `review-calibration`). |
| `/adlc-distill` | P7 | Mine repeated findings and PR rejections into reusable lint checks, skills, and templates. |
| `/adlc-maintain` | C10/C12 | Run decay-driven checks: stale skills, hot files, and gate calibration. |

---

### The Router Agent (Discovery Skill)

The `adlc-router` agent acts as a native phase-routing flowchart. Instead of prompting the model to remember 21 CLI tools, the router identifies your current activity ("shape this spec", "verify this bugfix") and instructs OpenCode to reach for the correct ADLC tool or slash command.

---

### The Prosecutor Subagent

The `prosecutor` is a hostile critic agent chartered to refute the builder's diff. It executes the Phase 5 (Prosecute) gates:
1. **`hollow-test`**: Mutates the changed code to verify if the tests are load-bearing (fail when the implementation is broken) or hollow.
2. **`behavior-diff`**: Verifies that behavior changes are visible and documented.
3. **`review-calibration`**: Ensures the reviewer catches planted bugs.

It will only approve a merge when two consecutive passes run dry (zero verified findings).

---

### In-Process Hooks

OpenCode runs the plugin in-process inside its Bun JavaScript engine, executing hooks natively on specific event triggers:

| Hook Event | Trigger Event | Posture | Behavior |
| --- | --- | --- | --- |
| **preflight** | `session.created` | Advisory | Warns the user if Node/Bun runtimes, git trees, or providers are misconfigured. |
| **rails-guard** | `tool.execute.before` | **Enforcing** | Intercepts structural editing tools (`write`, `edit`, `apply_patch`, `multi_edit`). Denies edits to paths declared as `rails` in the active ticket and locks the `.adlc/tickets.json` file. |
| **flail-detection** | `tool.execute.after` | Advisory | Scans execution outputs for repeated loop errors, scope drift, or excessive logs, prompting warning notifications. |
| **manifest-audit** | `session.deleted` / `session.idle` | Advisory | Runs `gate-manifest verify` to confirm the integrity of the append-only evidence chain. |

#### Rail Gating Safety & Bypasses
- **Fail-Closed Guarantee:** If a ticket declares rails, but the plugin encounters an operational error (e.g., corrupt config or missing binaries), the PreToolUse hook **fails closed (blocks editing)** to prevent bypassing verification. If no rails are declared, the hook is a complete no-op (fails open) so clean repositories are never bricked.
- **Bypass hatch:** Setting `ADLC_RAILS_BYPASS=1` overrides the in-session hook, but logs the bypass event to `.adlc/manifest.jsonl` for audit compliance.
- **CI/CD Backstop:** Since Bash/shell execution is Turing-complete, the in-session hook does not gate shells. All shell-based rail mutations are blocked at commit-time in CI.

---

## CI/CD Backstops (Required)

Always pair the in-session hook with a commit-time CI/CD check. Copy these configurations into your `.github/workflows/` directory:

- **`ci/rails-guard.yml`** — Rejects any Pull Request whose diff touches a frozen rail. The rails are read from the **base** ref, ensuring a PR cannot remove rails to pass the check.
- **`ci/adlc-maintenance.yml`** — A weekly advisory workflow that runs the maintenance suite (`skill-rot`, `model-ratchet`, `gate-fuzzing`) and publishes the health report to the job summary.

---

## ADLC Phase Coverage

| Lifecycle Phase | Mapping Point | Execution Method |
| --- | --- | --- |
| **P0 Triage** | `/adlc-ticket` command | Triage risk × blast radius; create ticket contract. |
| **P1 Interrogate** | `spec-lint` / `premortem` / `parallax` | Model-guided Spec shaping via the `adlc-router` agent. |
| **P2 Decompose** | `coldstart` / `model-router` / `merge-forecast` | Splits tickets into atomic parallel boundaries. |
| **P3 Rail** | `rails-guard` (PreToolUse hook + CI) | Frozen tests and type contracts written from spec. |
| **P4 Build** | `flail-detector` (hook) / `consensus-fix` | Developer agent writes code; two-strike regeneration. |
| **P5 Prosecute** | `prosecutor` subagent | Hostile review loops until dry. |
| **P6 Integrate** | Gate manifest verification | Summary card displayed in TUI for **Human Gate 2**. |
| **P7 Distill** | `/adlc-distill` command | Lesson foundry and rejection mining. |
| **Maintenance** | `/adlc-maintain` / CI Actions | calibrates reviewers, checks skill-rot and model-ratchet. |
