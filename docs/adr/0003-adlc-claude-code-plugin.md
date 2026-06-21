# ADR: Bringing the ADLC to Claude Code as a plugin

**Status:** **Accepted — shipped.** Phases A–F merged to `main` via PR #6
(2026-06-18). The P7 skill-mining wiring is accepted and in review (PR #7). The
`adlc` command-name reconciliation with the Codex effort is a separate, related
decision — see [`0002-adlc-command-reconciliation.md`](./0002-adlc-command-reconciliation.md)
(Accepted — Option D).

**Date:** 2026-06-18
**Deciders:** Chris Williams (with `agy`/Gemini-3.5-Flash as the adversarial-review
counter-model throughout).

---

## Context

The ADLC (Agentic Development Lifecycle) ships as ~20 zero-dependency `@adlc/*`
gate CLIs — each a single phase gate that exits `0` (pass), `1` (operational
error), or `2` (gate fails). The toolkit is powerful but, as a bag of 20 separate
commands, has two adoption problems inside an agentic coding harness:

1. **Discovery.** A model will not reliably remember 20 tool names or which
   lifecycle moment each belongs to. Left to itself it uses none of them.
2. **Enforcement.** Gates that only run when someone remembers to invoke them are
   advisory by accident. The lifecycle's value comes from gates firing at the
   right moment — some automatically, some unbypassably.

The goal: make a user able to *install once* and have the whole ADLC become usable
from inside Claude Code — the model reaches the right gate without memorizing the
toolkit, the safety-critical gates fire on their own, and none of it requires API
keys. This is the "ship Appendix F as a plugin" thesis from `ADLC.md`.

### Constraints

- **No API keys.** Every LLM-backed gate supports `--prompt-only`: it prints its
  prompt and exits. Inside Claude Code *Claude is the model* — it answers the
  printed prompt and applies the judgment. The integration must lean on this, not
  on provisioning provider keys.
- **Zero-dependency, Node 18+.** Hooks and the dispatcher must not pull a
  dependency tree; they run in the user's environment on every session/edit.
- **Fail-safe.** Anything that blocks the user (an enforcing hook) must be correct
  and must degrade safely — no-op when the repo isn't ADLC-initialized, fail
  *closed* when it genuinely can't verify a safety decision.
- **Harness-portable in spirit.** A sibling effort targets Codex/Cursor/opencode,
  so decisions here should not gratuitously bind to Claude-Code-only mechanisms.

---

## Decision

Ship the ADLC as a **Claude Code plugin** that maps each ADLC primitive onto the
native Claude Code extension point that fits it, fronted by a single umbrella CLI.

### 1. Umbrella dispatcher — `@adlc/cli` (`adlc <tool>`)

A new package exposing one bin, `adlc`, that dispatches to the 20 gates
(`adlc spec-lint …`, `adlc rails-guard …`). This gives every command, hook, and
doc a single stable prefix to reference, instead of 20 independently-installed
bins. Prerequisite for everything else; only net-new code in the effort.

### 2. Plugin layout

A standard Claude Code plugin: `.claude-plugin/plugin.json` + `marketplace.json`
(the repo *is* its own marketplace — `/plugin marketplace add voodootikigod/adlc`),
plus `commands/`, `agents/`, `skills/`, `hooks/`.

### 3. Discovery skill — one phase-router, not 20 skills

A single `skills/adlc/SKILL.md` is a phase-routing flowchart ("where am I → which
gate"). **Decision: one router skill, not one skill per gate.** A skill per gate
would bloat discovery, and harness skill-lists truncate/omit large sets — the
router could fall off the list, leaving the model unable to find *any* gate. One
well-triggered router that points at the gates is more discoverable and is the
shape that embraces the lifecycle "in total."

### 4. Commands (explicit, user-invoked)

- `/adlc-init` — bootstrap `.adlc/`, split the committable ticket contract from
  runtime evidence in `.gitignore`, run preflight.
- `/adlc-ticket` (P0) — author a schema-valid, self-contained ticket (the contract
  every gate reads).
- `/adlc-distill` (P7) — mine repeated findings + PR rejections into deterministic
  defenses.
- `/adlc-maintain` (C10/C12) — decay-driven checks (skill-rot, model-ratchet,
  gate-fuzzing).

### 5. Prosecutor subagent (P5)

`agents/prosecutor.md` — a hostile pre-merge reviewer that runs `hollow-test`,
`behavior-diff`, and `review-calibration` and returns an evidence-backed verdict.

### 6. Hooks — advisory by default, one enforcing gate

| Hook | Event | Posture |
| --- | --- | --- |
| preflight | SessionStart | Advisory — warns if the environment isn't ready for fan-out. |
| flail-detection | PostToolUse | Advisory — flags repeated-error/churn loops over a bounded recent transcript window. |
| gate-manifest audit | Stop | Advisory — warns only if the gate-evidence chain is broken. |
| **rails-guard** | PreToolUse | **Enforcing** — denies structured edits to frozen rail paths. |

All hooks **no-op unless the repo is ADLC-initialized**. Rail enforcement
additionally no-ops until a ticket declares `rails`, so installing the plugin into
a repo with no rails can never block editing.

### 7. Rail enforcement — two layers, structured-edit only (Option C)

This is the load-bearing safety decision and consumed most of the hardening effort.

- **In-session PreToolUse hook** gates the **structured-edit** tools only:
  `Edit | Write | MultiEdit | NotebookEdit`. These have a parseable target path,
  so the hook can precisely deny an edit to a frozen rail and (once any rail
  exists) freeze `.adlc/tickets.json` itself as the trust root.
- **In-session Bash rail enforcement was deliberately dropped.** A shell is
  Turing-complete and cannot be reliably parsed for "which file will this mutate";
  every parser we built had another bypass. Trying to gate Bash in-session was a
  source of false confidence.
- **Commit-time CI gate** (`scripts/rails-guard-ci.mjs` → `adlc rails-guard`) is
  the **unbypassable backstop**: it inspects the git diff, so it catches a rail
  mutation regardless of how it was written (Bash, any spelling). The rail set is
  read from the **base** ref, so a PR cannot delete rails to disable the gate.

**Asymmetric fail-closed contract:** no rails declared → no-op; a rail is hit →
deny; the hook cannot verify (malformed stdin, chdir failure, schema-invalid
tickets, symlink loop) → **deny** (fail closed). The hook walks up to the
git-root-anchored `.adlc/`, resolves symlinks symmetrically on both target and
rail, and audits every hit on a multi-path edit.

**Bypass posture (two distinct layers):** `ADLC_RAILS_BYPASS=1` overrides the
*in-session* hook only, and only if the override is recorded to the gate-manifest
(an un-auditable bypass is refused). The *commit-time* CI gate is **not**
env-bypassable by design — changing a frozen rail is a privileged human action (a
maintainer admin-merges past the required check), which is the correct posture for
a decision that should require a human, not an environment variable.

### 8. P7 distill → skill-mining handoff

`/adlc-distill`'s `lesson-foundry` only *scaffolds* a `SKILL.md` stub; it does not
dedup against the public skill ecosystem or confirm the skill is usable cold. Per
doctrine ("lesson-foundry emits stubs; skill-mining manages the registry"), skill
defenses are routed through the existing **skill-mining** skill for dedup + a
fresh-context red-team before they are installed and PR'd. **Decision: reference
skill-mining, do not reimplement it** — it is cross-harness (`npx skills`), keeping
Claude Code / Codex / Cursor DRY. (Enhancements that would make skill-mining a
better fit for this handoff are tracked separately, out of scope for this ADR.)

### 9. CI backstops (recommended templates)

`docs/ci/rails-guard.yml` (required check; rail set from base ref) and
`docs/ci/adlc-maintenance.yml` (weekly advisory cron). Both pin `@adlc/cli` and
action SHAs and use `--ignore-scripts`.

---

## Primitive mapping (the heart of the decision)

| ADLC primitive | Claude Code extension point | Why |
| --- | --- | --- |
| Phase routing / "which gate" | **Skill** (discovery flowchart) | Loaded by description; routes the model into the lifecycle. |
| P0/P7 authored workflows | **Slash commands** | Explicit, user-invoked, multi-step. |
| P5 hostile review | **Subagent** | Fresh-context, role-scoped prosecution. |
| Environment / loop / evidence signals | **Advisory hooks** (SessionStart/PostToolUse/Stop) | Fire automatically, never block. |
| P3 frozen rails | **Enforcing PreToolUse hook + CI gate** | The one place blocking is correct; two layers because in-session is best-effort and CI is unbypassable. |
| Keyless LLM gates | **`--prompt-only` + Claude as the model** | No API keys; the harness model answers the printed prompt. |

---

## Phased delivery

Each phase was independently shippable and looped through `/adversarial-review`
(counter-model: `agy`) until clean.

- **Phase A — dispatcher.** `@adlc/cli` umbrella bin.
- **Phase B — plugin skeleton + discovery skill + `/adlc-init`/`/adlc-ticket`.**
- **Phase C — advisory hooks** (preflight/flail/manifest).
- **Phase D — enforcing rail-guard hook + prosecutor subagent + CI backstop.**
- **Phase E — `/adlc-distill` + `/adlc-maintain` + maintenance cron.**
- **Phase F — marketplace publish + adoption docs** (`docs/claude-code.md`).

---

## Alternatives considered

- **One skill per gate (rejected).** Precise-looking but harms discovery; large
  skill sets get description-truncated/omitted, risking the router itself dropping
  off the list. A single phase-router is more reliable. (See Decision §3.)
- **Gate Bash in-session too (rejected → Option C).** Parsing a shell for its
  write targets has no stable terminus; each parser had a new bypass. Dropping
  in-session Bash enforcement and relying on the unbypassable CI diff gate for
  Bash is more honest and actually safer than a leaky in-session parser that
  implies coverage it doesn't have.
- **Env-var bypass for the CI gate (rejected).** An environment variable that can
  unfreeze a rail in CI defeats the purpose of an unbypassable backstop. The
  bypass is intentionally a privileged human admin-merge.
- **Provision provider API keys for LLM gates (rejected).** Unnecessary inside a
  harness where the model is already present. `--prompt-only` keeps the
  integration keyless.
- **Reimplement skill-mining inside the plugin (rejected).** It already exists and
  is cross-harness; referencing it avoids duplication across the multi-harness
  roadmap.

---

## Consequences

**Positive**
- One install → the whole lifecycle is reachable; the model routes itself.
- Safety-critical rails are enforced in-session *and* unbypassably at commit time.
- Keyless: no provider credentials to manage.
- Advisory hooks prove the wiring and add value without ever blocking.
- Plugin is its own marketplace — distribution is just a `git push`.

**Negative / risks**
- **In-session Bash rails are not enforced.** A rail mutated via Bash is caught
  only by the CI gate at commit time, and only if the rail is a **tracked** file —
  a gitignored/untracked rail mutated via Bash is seen by neither layer. Mitigation:
  rails are normally declared on tracked files (tests, type contracts, configs);
  the docs state this limitation explicitly.
- **Enforcing hook is a blocking surface.** A bug could wrongly block a legitimate
  edit. Mitigation: extensive adversarial hardening + fail-closed-only-on-rail-hit;
  no rails declared → never blocks; audited `ADLC_RAILS_BYPASS=1` escape hatch.
- **The CI gate must be configured as a required check** to be a real backstop;
  shipping the template doesn't enforce it. Documented as a required step.
- **Discovery depends on the skill description matching** the user's phrasing; a
  poorly-triggered router silently does nothing. Mitigation: broad trigger set +
  the flowchart body.

**Neutral**
- `@adlc/cli` adds a dispatcher package to maintain; it has no runtime deps.
- The `adlc` bin name collides with the Codex effort's runner — resolved
  separately in the command-reconciliation ADR (Option D).

---

## Hardening record

The enforcing rail hook went through repeated adversarial-review rounds with a
counter-model (`agy`, deliberately different from the builder). Defects found and
fixed include: MultiEdit/nested target paths missed; fail-open on chdir/parse
failure; symlinked target/rail dodging the glob; multi-path bypass only auditing
the first hit; symlinked trust-root bypass; nested-`.adlc` shadowing; broken
symlinks and symlink loops; and relative-path resolution against the wrong base
dir. The terminal state of review for both the rail gate and the skill-mining
wiring was a clean approve with only exotic/out-of-scope findings remaining.

---

## Verification

- `npm test` green across all packages and the hook/CI suites.
- End-to-end install-smoke against a temp repo confirmed the Option C contract:
  in-session hook denies an Edit to a declared rail and freezes the trust root; a
  Bash mutation slips the hook (by design) and is caught by the CI diff gate; free
  (non-rail) files are never blocked by either layer.
