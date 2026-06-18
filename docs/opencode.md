# Adopt the ADLC in OpenCode

The `@adlc/*` toolkit is a set of gate-shaped CLIs. This plugin makes the whole **Agentic Development Lifecycle** usable natively from inside OpenCode: the gates fire at the right lifecycle moments — some automatically — and the model reaches for the right gate without you memorizing 19 separate tools.

Following **Option D (separate, concern-focused bins)** from the Command Reconciliation ADR:
- `adlc` is the dispatcher (`@adlc/cli`) for executing individual gate tools.
- `adlc-runner` is the runner (`@adlc/runner`) for phase-evidence assertions.

> Design and rationale: [`opencode-integration-plan.md`](./opencode-integration-plan.md).
> The full thesis: [`../ADLC.md`](../ADLC.md).

---

## Install

### 1. Install the ADLC CLI Tools
The plugin needs both the ADLC dispatcher and runner binaries globally resolvable in your PATH (requires merging `@adlc/runner` from Codex branch first):

```sh
npm install -g @adlc/cli @adlc/runner
```

The plugin initialization check will verify that both `adlc` and `adlc-runner` bins are available on PATH and output a clear installation error if missing.

### 2. Install the OpenCode Plugin
Copy or link the plugin files to your project-local `.opencode` directory:

```sh
mkdir -p .opencode/plugins/
# Copy or symlink the integration code (link to plugins/ directory parent):
ln -s /path/to/adlc/plugins/adlc-opencode/ .opencode/plugins/
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
Bootstrap the ADLC workspace context in your repository by typing the following slash command directly into the OpenCode TUI chat interface:

```text
/adlc-init
```

This creates the `.adlc/` workspace configuration directory, templates the `.adlc/config.json` and `.adlc/tickets.json` structures, appends runtime logs and temp directories idempotently to your `.gitignore`, and sets up a local pre-commit hook (`.git/hooks/pre-commit`) for environments that lack CI runners.

---

## What You Get

### Commands (Slash Commands)

Trigger these directly within the OpenCode TUI interface:

| Command | Phase | Description |
| --- | --- | --- |
| `/adlc-init` | — | Bootstrap `.adlc/` workspace, configure config.json defaults, configure gitignore (idempotently), configure local pre-commit git hooks, and check environment readiness. |
| `/adlc-ticket` | P0 | Author a schema-valid ticket defining the ticket contract (which files are gated and where the rails are). |
| `/adlc-spec` | P1 | Runs `spec-lint`, `premortem`, and `parallax` to shape and audit the spec, blocking build start until spec approval (`adlc-runner run p1`). |
| `/adlc-decompose` | P2 | Runs `coldstart`, `model-router`, and `merge-forecast` to split tickets and verify contract boundaries (`adlc-runner run p2`). |
| `/adlc-rail-write` | P3 | Invokes the `rail-writer` agent to write tests and stubs in an isolated context before building (`adlc-runner run p3`). |
| `/adlc-consensus-fix` | P4 | Runs consensus repair by fanning out candidate fixes to resolve a hard failing test (`adlc consensus-fix`). |
| `/adlc-prosecute` | P5 | Run the pre-merge hostile prosecution subagent loops (`adlc-runner run p5`). |
| `/adlc-accept` | P6 | Finalizes the Phase 6 human gate. Signs the manifest and records behavioral acceptance (`adlc-runner accept --ticket <id>`). |
| `/adlc-distill` | P7 | Mines findings (`adlc-runner run p7`) via lesson foundry and rejection mining. Post-merge Simplify pass is run in CI. |
| `/adlc-maintain` | C10/C12 | Run decay-driven checks: stale skills, hot files, and gate calibration (`adlc skill-rot`, `adlc model-ratchet`, and `adlc gate-fuzzing`). |

---

### The Router Skill (Discovery Skill)

The `adlc` router skill acts as a native phase-routing flowchart. Instead of prompting the model to remember 19 CLI tools, the router identifies your current activity ("shape this spec", "verify this bugfix") and instructs OpenCode to reach for the correct ADLC tool or slash command.

---

### The Prosecutor Subagents (Phase 5)

Pre-merge prosecution fanned out across five independent, fresh-context, single-lens subagents to prevent context rot:
1. **`correctness`**: Off-by-one errors, error swallowing, concurrency, and logic races.
2. **`security`**: Threat modeling, injection vectors, hardcoded secrets, and unsafe input sanitization.
3. **`contract`**: Module boundary validation and interface contract matching.
4. **`diff`**: Compares implementation against the spec to verify all criteria are met.
5. **`tests`**: Audits unit tests added by the builder during the build phase (ensuring they assert behavior instead of mocking reality).

Findings are verified by a separate `prosecutor-verifier` reproducer agent. The loop runs until two consecutive passes are dry.

---

### In-Process Hooks

OpenCode runs the plugin in-process inside its Bun JavaScript engine, calling the self-contained hook checker helper `plugins/adlc-opencode/rails-checker.ts` on specific event triggers:

| Hook Event | Trigger Event | Posture | Behavior |
| --- | --- | --- | --- |
| **preflight** | `session.created` | Advisory | Warns the user if Node/Bun runtimes, git trees, or providers are misconfigured. Runs model benchmarking for local models. |
| **rails-guard** | `tool.execute.before` | **Enforcing** | Intercepts structured editing tools using a default-deny approach (gates all tool calls with path parameters, excluding read-only tools). Denies edits to paths declared as `rails` and locks `.adlc/`, `.opencode/`, `.git/`, `.github/`, and `tickets.json` files. Parses `apply_patch` payloads. Traverses path segments to block symlink creation bypasses. |
| **flail-detection** | `tool.execute.after` | **Enforcing** | Scans outputs for repeated loop errors, scope drift, or excessive logs. Strike 1: advisory warning and subagent restart. Strike 2: builder subagent termination and workspace rollback (`git reset --hard` + `git clean -fd`) strictly inside the isolated ticket worktree (stashes instead of cleaning if in main checkout). |
| **manifest-audit** | `session.ended` | Advisory | Runs `gate-manifest verify` to confirm the integrity of the append-only evidence chain on session close. |

#### Rail Gating Safety & Bypasses
- **Fail-Closed Guarantee:** If a ticket declares rails, but the plugin encounters an operational error, the hook **fails closed (blocks editing)** to prevent bypassing verification. If no rails are declared, the hook behaves as a safe no-op.
- **Isolated Prompting & Cascading:** Prompts from LLM-backed gates are queried in isolated, transient sub-contexts to avoid polluting the active chat session transcript. Grandchild prompts from the runner are bubbled up to the plugin using a structured cascade protocol with correlation IDs to prevent multiplexing collisions.
- **Frontier-Free Scaling:** Local models that fail dynamic calibrations are scaled up to N-pass parallel checks (ADLC Appendix E sampling diversity) and require consensus thresholds, instead of being blocked.
- **Bypass hatch:** Setting `ADLC_RAILS_BYPASS=1` overrides the in-session hook, but requires human approval in the TUI and logs the bypass event to `.adlc/manifest.jsonl` for audit compliance. हेडलेस सेशन में बाईपास रिफ्यूज (फेल-क्लोज) किया जाता है।
- **CI/CD / Local Backstop:** Shell-based rail mutations are blocked at commit-time via GitHub workflows or the local pre-commit hook. The local hook is hardened to read `.adlc/tickets.json` from `HEAD` (`git show HEAD:.adlc/tickets.json`) to prevent staging commits that disable their own rails. Local hooks are best-effort and must be backstopped by branch protection in CI/CD.
