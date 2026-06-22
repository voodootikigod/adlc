# ADR 0001: Codex-Native ADLC Integration

Status: Accepted

Date: 2026-06-18

## Context

ADLC is a toolkit of deterministic, gate-shaped CLIs plus doctrine for running
agentic software development. The Claude Code integration (now living at `plugins/adlc-claude-code/` in this
repo) is further along and proves useful lifecycle patterns, but Codex has
different native surfaces: plugins, progressive disclosure skills, lifecycle
hooks, app automations, and explicit subagent workflows.

The Codex integration must implement the ADLC doctrine, not mechanically port
Claude Code's command and agent file layout. The core doctrine is:

- deterministic gates between phases;
- exactly two mandatory human gates, P1 spec approval and P6 behavioral
  acceptance;
- rail freeze enforced at the tool layer and verified by deterministic gates;
- fresh-context prosecution with verified findings;
- `.adlc/manifest.jsonl` evidence as the source of phase truth;
- P7 compounding through distillation, skill mining, and maintenance.

An adversarial review of the first plan found material gaps: P0/P1/P6 were too
prose-driven, manifest recording could be decoupled from gate execution, rail
snapshots were not checked deeply enough, P5 fresh-context evidence was not
machine-checkable enough, P7 automation was unproven, and plugin install proof
could validate metadata without exercising behavior.

## Decision

Build a Codex-native peer integration with these hard requirements.

### Distribution and command surface

- Ship the Codex plugin from `plugins/adlc-codex/`.
- Use Codex skills as the primary user-facing workflows. Do not build the
  primary UX around deprecated Codex custom prompts.
- Use one public dispatcher binary: `adlc <tool>`.
- Add `@adlc/cli` as the package that owns the public `adlc` binary.
- Move phase assertions under the dispatcher as `adlc run <phase>` and
  `adlc accept ...`.
- Stop publishing `@adlc/runner` as the owner of the top-level `adlc` binary.
  It may keep an internal or explicit `adlc-runner` binary.
- Resolve tools through package metadata from `@adlc/cli` dependencies, not the
  user's `PATH`, so global stale binaries cannot silently satisfy gates.

### Phase completion and evidence

- Codex skills route work and execute commands; they cannot declare a phase
  complete from narration.
- A phase is complete only when `.adlc/manifest.jsonl` contains the required
  evidence and `adlc run <phase> --json` passes.
- Gate evidence must be recorded atomically with the checked operation wherever
  possible. If a separate manifest recording step is unavoidable, it must bind
  to a gate result artifact with ticket id, phase, command args, tool version,
  input hashes, output hash, and resolved git-worktree revision.
- Prompt-only LLM gates count only when the emitted prompt, Codex judgment, and
  reviewed inputs are captured as evidence.

### P0, P1, and P6 determinism

- Ticket authoring must be deterministic in the initial integration, not a
  future enhancement. It must lock `.adlc/tickets.json`, validate the proposed
  ticket graph in memory, write atomically, and preserve rails as a trust root.
- P1 human approval must be recorded as explicit evidence bound to the spec,
  ticket set, and revision being approved.
- P6 human acceptance must be an explicit attestation packet bound to ticket id,
  behavior-diff packet hash, artifact hashes, and exact reviewed revision. It
  must fail closed when the worktree, ticket definition, transcript, behavior
  packet, or snapshots change after acceptance.

### Skill topology

Use a small phase-clustered skill set rather than one skill per gate:

- `adlc`: doctrine router, work classifier, and phase map.
- `adlc-spec`: P0-P2 ticket/spec shaping, P1 approval, coldstart, merge forecast,
  and model routing.
- `adlc-rail-build`: P3-P4 rails, hook posture, preflight, flail detection,
  consensus-fix, and build supervision.
- `adlc-prosecute`: P5-P6 prosecution evidence, behavior-diff, acceptance
  packets, and revision binding.
- `adlc-distill`: P7 and maintenance, including lesson-foundry,
  rejection-mining, external skill-mining, skill-rot, model-ratchet,
  review-calibration, and gate-fuzzing.

Every skill must use the dispatcher form (`adlc <tool>`) and must describe the
manifest-backed completion rule.

### Rails

- Ship plugin-bundled hooks metadata (e.g. `plugins/adlc-codex/hooks/hooks.json` for the Codex plugin); do not leave hook scripts orphaned.
- Use an enforcing `PreToolUse` hook for structured file-editing tools that can
  identify target paths and shell-capable tools whose command payload can mutate
  files.
- The hook blocks shell commands that target frozen rails and fails closed on
  mutating shell payloads whose target paths cannot be identified or whose cwd
  changes before mutation, and on shell expansion that prevents literal path
  accounting.
- The hook no-ops outside active P4 enforcement.
- The hook fails closed when rails are declared and it cannot make a trustworthy
  decision.
- `adlc run <phase>` must verify frozen rail snapshots directly, so shell,
  generator, formatter, or package-script mutations cannot advance the local
  lifecycle merely because CI is not installed.
- CI rail backstops remain required for pull requests and shell-capable writes.

### P5 prosecution

- Do not make first completion depend on plugin-bundled Codex custom subagents;
  Codex subagents are explicit workflows and custom-agent plugin packaging is
  less proven than skills/hooks.
- The `adlc-prosecute` skill defines the process and may ask Codex to spawn
  parallel reviewer subagents when explicitly requested and supported.
- Deterministic P5 pass requires a machine-checkable evidence packet consumed by
  `adlc prosecute` and asserted by `adlc run p5`.
- The P5 schema must include ticket id, exact revision, clean worktree proof,
  reviewer identity/session boundary, prompt/hash packet, required lenses,
  finding dispositions, command evidence, and stale-revision rejection.

### P7 automation

- Treat scheduled P7 metabolism as first-class.
- Use Codex app scheduled automations as the primary substrate because they can
  invoke skills, run on schedules, and use project worktrees.
- Run P7 automations in project worktree mode to avoid colliding with active
  local work.
- The automation invokes `$adlc-distill` and the external `$skill-mining` skill.
  Skill-mining is an external prerequisite installable with
  `npx skills add voodootikigod/skill-mining`.
- LLM or write-producing automation must produce reviewable diffs or proposals;
  it must not silently mutate protected rails or merge changes.
- CI cron remains the deterministic fallback for keyless checks such as
  `adlc skill-rot` and `adlc model-ratchet --dry-run`.
- Completion must include a smoke proof that the automation prompt can resolve
  the required skills, write P7 no-op evidence, and preserve rails.

### Install and verification

- Keep the offline marketplace/manifest/sentinel smoke test.
- Add isolated `CODEX_HOME` install proof before declaring the plugin supported.
- The isolated install smoke must verify usable behavior, not only metadata:
  installed skill discovery, bundled hook registration, dispatcher help, at
  least one routed tool, hook payload simulation from installed files, and no
  mutation of real `~/.codex`.
- Git-backed sparse marketplace proof is a separate deliverable.

## Consequences

- The first implementation is larger than a skill-only plugin because P0/P1/P6
  must become executable contracts.
- The unified dispatcher becomes the stable command prefix for docs, hooks,
  skills, CI, and automations.
- The plugin remains idiomatic Codex while preserving the lifecycle doctrine
  proven in the Claude integration.
- Evidence schemas become part of the product surface; tests must cover stale
  revision, stale ticket, tampered artifact, rail mutation, and install behavior
  failures.

## Acceptance Criteria

- `adlc --help`, unknown-tool handling, routed tool execution, `adlc run`, and
  `adlc accept` pass tests.
- `@adlc/runner` no longer publishes the `adlc` binary.
- Codex skills and docs use `adlc <tool>` forms.
- The plugin includes bundled hooks metadata and hook tests.
- P0/P1/P5/P6/P7 evidence contracts are documented and covered by tests.
- `node scripts/codex-install-smoke.mjs .` passes.
- An isolated `CODEX_HOME` install smoke exercises installed plugin behavior.
- The integration is driven through dispatcher commands, hook payload
  simulations, plugin install smoke, and the P5/P6 fixture flow before it is
  called complete.
