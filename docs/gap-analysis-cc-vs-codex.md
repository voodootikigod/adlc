# Gap Analysis: Claude Code Integration vs. Codex Integration

**Date:** 2026-06-21  
**Branch:** `feat/gap-analysis-cc-vs-codex`  
**Scope:** Identify every meaningful gap between the Claude Code plugin (`.claude-plugin/`, `hooks/`, `commands/`, `agents/`, `skills/`) and the Codex integration (`plugins/adlc-codex/`, `packages/runner/`, `packages/prosecute/`) — covering documentation, functional surface, verification, and cross-integration concerns.

---

## Summary

The Claude Code integration shipped a complete plugin (Phases A–F, PR #6) and P7 wiring (PR #7). The Codex integration shipped a complete plugin plus formal phase-assertion packages (`@adlc/runner`, `@adlc/prosecute`). Both integrations are high-quality. The gaps below vary from trivial (a stale URL) to a confirmed functional defect: the `prosecutor` subagent's closing instruction directs CC users to `adlc gate-manifest record prosecution`, but that command's output is structurally incompatible with `adlc run p5` — meaning CC has no working path to formal P5 phase assertion today. The most actionable fixes are: correcting the `prosecutor.md` closing instruction (or wiring it to `adlc prosecute`), updating the `plugin.json` homepage URL, adding a `## Gaps` section to `docs/claude-code.md`, and updating `docs/README.md` to surface the CC integration.

---

## Gap 1 — `docs/README.md` does not reference the Claude Code integration [HIGH]

### What Codex has
`docs/README.md` "Start here" section links to `codex-integration.md` and `adr/0001-codex-native-adlc-integration.md` as first-class entries.

### What CC has
`docs/README.md` does not mention `claude-code.md`, the CC ADRs (`adr-adlc-claude-code-plugin.md`, `adr-adlc-command-reconciliation.md`), the CI templates under `docs/ci/`, or `docs/ticket-authoring.md`.

### Impact
A reader entering via `docs/` finds the Codex integration but not the Claude Code integration. The two integrations are equally shipped; neither should be buried. The omission is broader than CC alone — `ticket-authoring.md` and the `ci/` templates are also absent from the index even though they serve all users.

---

## Gap 2 — CC ADRs not filed in `docs/adr/` [MEDIUM]

### What Codex has
`docs/adr/0001-codex-native-adlc-integration.md` — formal numbered ADR in its own subdirectory, linked from `docs/README.md`.

### What CC has
`docs/adr-adlc-claude-code-plugin.md` and `docs/adr-adlc-command-reconciliation.md` — flat files in `docs/` root, not linked from `docs/README.md`.

### Impact
ADR search patterns (file-system, grep, docs-index) miss the CC architectural decisions. A reader who finds ADR 0001 has no path to the CC ADR. Over time, the flat naming and location will diverge further from the Codex pattern.

### Proposed fix
Move CC ADRs to `docs/adr/0002-adlc-claude-code-plugin.md` and `docs/adr/0003-adlc-command-reconciliation.md`. Update `docs/README.md` to list all three ADRs. Before assigning numbers, verify chronological order — ADR numbers should reflect creation order, not alphabetical sort. Run separate per-file commands (git does not support `--follow` with multiple pathspecs):

```sh
git log --oneline --follow -- docs/adr-adlc-claude-code-plugin.md
git log --oneline --follow -- docs/adr-adlc-command-reconciliation.md
git log --oneline --follow -- docs/adr/0001-codex-native-adlc-integration.md
```

---

## Gap 3 — `docs/claude-code.md` missing explicit "Gaps" section [HIGH]

### What Codex has
`docs/codex-integration.md` ends with a `## Gaps` section that enumerates three known limitations with honesty:
1. P5 not fully automated (orchestration loop missing).
2. Git-backed sparse marketplace install unsupported.
3. Hooks assist P4 but do not replace `rails-guard`.

### What CC has
`docs/claude-code.md` has no "Gaps" section. Real limitations exist (see Gap 5, Gap 6 below) but are not surfaced in the adoption doc.

### Impact
Adopters get an incomplete picture. The ADR documents risks in its "Consequences" section, but that is not the adoption doc. The policy of honesty about gaps — present in `codex-integration.md` — is absent here.

---

## Gap 4 — `docs/claude-code.md` missing "Boundary" section [LOW]

### What Codex has
`docs/codex-integration.md` ends with `## Boundary` defining `.adlc/` vs `.omo/` directory conventions and establishing that package READMEs are authoritative for flags and schemas.

### What CC has
No `## Boundary` section. The same directory conventions apply to CC users (they write to `.adlc/` the same way) but are not stated.

### Impact
Minor; the CC doc is shorter. But users who read both docs encounter a structural asymmetry that implies CC has no boundary conventions (it does).

---

## Gap 5 — No install verification script for the Claude Code plugin [HIGH]

### What Codex has
`scripts/codex-install-smoke.mjs` — a runnable Node script with two modes:
- **Offline** (`node scripts/codex-install-smoke.mjs .`): validates marketplace JSON, plugin manifest, hook structure, and skill sentinel strings. Any user can run this.
- **Live** (`ADLC_CODEX_LIVE_INSTALL=1 ...`): exercises an isolated `CODEX_HOME` install.

`docs/codex-integration.md` leads with both invocations. The CI suite runs the offline path.

### What CC has
Nothing. The CC adoption doc leads with four installation commands (`npm install -g`, `/plugin marketplace add`, `/plugin install`, `/adlc-init`) but provides no way to verify the plugin was installed correctly, that `hooks.json` registers the right tools, that `commands/*.md` are present, or that the `skills/adlc/SKILL.md` sentinel is intact.

### Impact
A user who misconfigures or partially installs the CC plugin has no local verification path. A CI pipeline that wants to gate on plugin integrity has nothing to invoke. This is the largest single gap.

### Proposed fix
Create `scripts/claude-code-plugin-smoke.mjs` that validates:
- `.claude-plugin/plugin.json` metadata fields (`name`, `version`, `description`, `homepage`). Note: unlike `plugins/adlc-codex/.codex-plugin/plugin.json`, the CC `plugin.json` does NOT declare path fields for skills/hooks/commands/agents — those are discovered by Claude Code's own convention. Validate the metadata fields that are present, not fields that don't exist.
- `.claude-plugin/marketplace.json` schema and plugin entry with correct `"source": "./"`.
- `hooks/hooks.json` registers all four hook types (`PreToolUse`, `SessionStart`, `PostToolUse`, `Stop`) with correct matchers.
- `hooks/adlc-hook.mjs` exists and has zero `@adlc/*` import statements (the file may reference `@adlc/*` in comments or strings — the check must target `import` statement lines only, e.g. `grep -E '^import.*@adlc' hooks/adlc-hook.mjs` should return empty).
- `commands/adlc-init.md`, `adlc-ticket.md`, `adlc-distill.md`, `adlc-maintain.md` all present.
- `agents/prosecutor.md` present.
- `skills/adlc/SKILL.md` present and contains a sentinel string.

---

## Gap 6 — P5 evidence banking in CC is definitively incompatible with `adlc run p5` [HIGH]

### What Codex has
A fully documented P5 evidence chain:
1. Run reviewer → produce normalized JSON matching `@adlc/prosecute` input schema.
2. `adlc prosecute --input <file> --ticket T1 --dir .adlc --json` — validates and records `p5-complete` into `.adlc/manifest.jsonl` with field `type: "p5-complete"`.
3. `adlc run p5 --ticket T1 --dir .adlc --json` — asserts a `p5-complete` entry exists (matched via `entry.type ?? entry.gate`).

The schema is documented in `@adlc/prosecute/lib/schema.mjs` and the fixture at `docs/examples/p5-passes.json`.

### What CC has
The `prosecutor` subagent runs `hollow-test`, `behavior-diff`, and `review-calibration` and returns a verdict. At the end it instructs:

> "After a clean prosecution, the evidence can be banked with `adlc gate-manifest record prosecution --files <changed files>`."

### Why this is definitively broken (not just potentially)

`adlc gate-manifest record prosecution` writes a manifest entry with field `gate: "prosecution"`. `adlc run p5` reads entries via `entry.type ?? entry.gate` and requires the resolved value to be `"p5-complete"` (hardcoded in `packages/runner/lib/assertions.mjs`: `p5: ['p5-complete']`). The string `"prosecution"` does not match `"p5-complete"`.

Beyond the name mismatch, `adlc run p5` runs `p5CompletionIntegrityErrors` which additionally requires: `provenance`, `transcript` (path + hash, must reference ticket and revision), `reviewPacket` (prompt/hash, inputs/hash, cleanWorktree), `consecutiveDry >= 2`, and `dryLenses.length >= 3`. Furthermore, the runner requires supporting entries in the manifest beyond the `p5-complete` entry itself: for each lens in `dryLenses`, a matching `p5-dry-pass` entry and a dry `p5-pass-completed` entry must exist; a contiguous final dry streak with `consecutiveDry >= 2` must be present; and all open `p5-finding-verified` and `p5-finding-needs-human` entries must be killed before completion is recorded. None of these entries are written by `gate-manifest record`. Even if the `p5-complete` entry name and top-level fields were corrected, the surrounding manifest state required for integrity checks would still be absent.

**CC users who follow the `prosecutor` subagent's own closing instruction cannot satisfy `adlc run p5`.**

### Impact
The CC integration has no valid path to formal P5 phase assertion. The `prosecutor` subagent gives a verdict, but there is no mechanism for recording evidence that `adlc run p5` accepts. The subagent's closing instruction actively misleads users into running a command that produces incompatible evidence.

### Required action
Choose one of:
1. **Wire `prosecutor` to call `adlc prosecute`** — after the gates pass, produce a normalized input JSON matching `@adlc/prosecute`'s schema and call `adlc prosecute --input <file> ...`. This closes the gap fully.
2. **Document the limitation explicitly** — state in `docs/claude-code.md` that `adlc run p5` is not available on the CC path, and that prosecution evidence is recorded informally via `gate-manifest` for provenance only, not phase assertion.
3. **Fix `prosecutor.md`** — at minimum, remove or correct the closing instruction that sends users to `adlc gate-manifest record prosecution` without warning them it cannot satisfy `adlc run p5`.

---

## Gap 7 — No example P5 fixtures for the Claude Code path [MEDIUM]

### What Codex has
`docs/examples/p5-passes.json` — a pinned prosecution fixture with a named revision (`docs-example-revision`) and detailed usage instructions in `codex-integration.md`:

```sh
adlc prosecute --input docs/examples/p5-passes.json --ticket T1 --revision docs-example-revision --dir .adlc --json
```

### What CC has
No example fixtures for the CC prosecution path. There is no example of what a valid prosecutor subagent output looks like, what the `adlc gate-manifest record prosecution` call should look like, or how to test the P5 evidence chain end-to-end.

---

## Gap 8 — `docs/claude-code.md` lifecycle coverage table lacks quality ratings [MEDIUM]

### What Codex has
`docs/codex-integration.md` uses a `## Formal ADLC Coverage` table with Strong / Partial / Conditional ratings per phase, with explanatory notes.

```
| P5 | Partial | Review evidence is machine-checkable, but there is still no first-party deterministic prosecution orchestrator... |
```

### What CC has
`docs/claude-code.md` uses a `## Lifecycle coverage` table with a "Wired via" column only — no quality rating. Users cannot tell which phases are fully enforced vs. advisory vs. intentionally partial.

### Proposed fix
Add a "Coverage" column (Strong / Partial / Conditional / Advisory) to match the Codex doc's level of honesty.

---

## Gap 9 — Neither adoption doc links to `docs/ticket-authoring.md` [MEDIUM]

### What exists
`docs/ticket-authoring.md` is the canonical ticket schema reference (fields: `id`, `title`, `body`, `scope`, `rails`, `edges`, `duration`, `category`, `budget`). It is the contract that P3 rails, P4 build supervision, and P5/P6 evidence all read. Codex skills reference ticket fields directly (`rails`, `scope`, `edges`) and the ticket-authoring doc exists as a standalone reference for all ADLC users.

### What both integration adoption docs have
Neither `docs/claude-code.md` nor `docs/codex-integration.md` links to `docs/ticket-authoring.md`. A user of either integration who wants to understand the ticket schema must discover that doc independently. This is an omission in both adoption docs, not a CC-specific gap.

### Why CC is the priority
`/adlc-ticket` is the primary CC mechanism for authoring tickets. The CC adoption doc describes the command as "Author a self-contained, schema-valid ticket" but provides no pointer to where the schema is defined. The gap is equally present in the Codex doc but is more prominent in the CC context because `/adlc-ticket` is an explicit user-facing command.

---

## Gap 10 — No cross-references between the two integration docs [MEDIUM]

### What exists
`docs/adr-adlc-command-reconciliation.md` explains the command-bin reconciliation between the two integrations. But neither `docs/claude-code.md` nor `docs/codex-integration.md` mentions the other integration's existence or links to it.

### Impact
A team using both integrations (e.g., Claude Code for interactive sessions, Codex for CI workers) has no authoritative statement that coexistence is supported or how it works. The command reconciliation ADR answers this but is not referenced from either adoption doc.

### Proposed fix
Add a brief "Using with Codex" note to `docs/claude-code.md` and a brief "Using with Claude Code" note to `docs/codex-integration.md`. Both should reference the command reconciliation ADR.

---

## Gap 11 — `docs/claude-code-integration-plan.md` is a stale planning artifact filed in `docs/` [LOW]

### What Codex has
The equivalent planning artifact lives in `.omo/plans/codex-adlc-integration.md` — operator artifacts directory, not `docs/`.

### What CC has
`docs/claude-code-integration-plan.md` is a pre-decision plan document (Status: Proposal) filed in `docs/` alongside canonical user-facing docs. It contains superseded design options and is not the authoritative architectural reference (the ADR is).

### Impact
Low, but a reader who finds `docs/claude-code-integration-plan.md` may read it as current design when it was a proposal. The ADR is the accepted record; the plan should either be moved to `.omo/plans/` or marked `Status: Superseded` with a pointer to the ADR.

---

## Gap 12 — `docs/claude-code.md` does not document the prosecutor evidence banking step [MEDIUM]

> Note: this gap is superseded in severity by Gap 6. The evidence banking step the prosecutor subagent currently instructs is definitively broken. The fix to Gap 6 renders this gap either resolved (if `prosecutor` is wired to call `adlc prosecute`) or explicitly documented (if the limitation is stated in the adoption doc). Address Gap 6 first.

### What Codex has
`docs/codex-integration.md` has a "Typical flow" section that explicitly covers what happens after each phase, including P5 prosecution evidence recording (`adlc prosecute`) and assertion (`adlc run p5`).

### What CC has
`docs/claude-code.md` lists "P5 Prosecute | prosecutor subagent" in the lifecycle table with no follow-on step. A user who runs the prosecutor subagent and gets a CLEAR verdict doesn't know what to do next to formally close P5.

---

## Gap 13 — `plugin.json` `homepage` points to a stale planning artifact [HIGH]

### What Codex has
Codex `plugins/adlc-codex/.codex-plugin/plugin.json`'s `homepage` is not the canonical adoption doc entry point — users install via marketplace. But the CC `plugin.json` is displayed to marketplace users when they browse or install the plugin.

### What CC has
`.claude-plugin/plugin.json`: `"homepage": "https://github.com/voodootikigod/adlc/blob/main/docs/claude-code-integration-plan.md"`

This URL points to `docs/claude-code-integration-plan.md` — a pre-decision planning document with `Status: Proposal` that contains superseded design options. Every marketplace user who clicks through from the Claude Code plugin browser lands on a stale proposal, not the adoption guide.

### Impact
The authoritative adoption guide is `docs/claude-code.md`. The planning doc is not. This affects every user who discovers the plugin through the Claude Code marketplace and follows the `homepage` link. It also elevates Gap 11 (stale planning doc in `docs/`) from LOW to MEDIUM because the doc is actively linked from the plugin manifest.

### Proposed fix
Update `plugin.json` `homepage` to `https://github.com/voodootikigod/adlc/blob/main/docs/claude-code.md`.

---

## Intentional Differences (Not Gaps)

For completeness, these are deliberate design differences between the two integrations that are not gaps:

| Dimension | Claude Code | Codex | Rationale |
|---|---|---|---|
| Skill count | 1 (phase router) | 5 (per phase cluster) | One router is more discoverable in CC's truncating skill lists; ADR §3 |
| Bash mutation gating | Dropped in-session; CI diff gate is the only backstop | In-session shell lexer present; CI diff gate also backstop | CC hook explicitly dropped in-session Bash enforcement after finding no stable parser (ADR §7, Revision 2). Codex hook (`adlc-rails-guard.mjs`) includes a shell-mutation lexer (`shellHasMutation`, `collectShellPaths`, `shellChangesCwd`, `shellHasExpansion`) and blocks cwd-changing and shell-expansion mutations in-session. Functionally different; not parity. |
| P6 human decision | Intentional gap | Conditional | P6 is by design a human gate in both; CC surfaces evidence, Codex requires packet |
| LLM model source | `--prompt-only` (Claude as harness model) | Codex CLI built-in model | Both are effectively keyless from the user's perspective. CC uses `--prompt-only` so Claude (the current session model) answers the gate prompt. Codex uses its own built-in model to invoke skills and process tool output. Neither requires external API key provisioning. |
| Planning artifacts | `docs/` (plan.md) | `.omo/plans/` | Both record intent; location differs by harness convention |

---

## Prioritized Fix List

| # | Gap | Priority | Effort | Notes |
|---|---|---|---|---|
| 6 | Fix P5 evidence chain — `prosecutor` → `adlc prosecute` or document limitation | HIGH | Medium | Definitively broken; misleads users |
| 13 | Fix `plugin.json` `homepage` URL | HIGH | Trivial | Marketplace users land on stale proposal |
| 5 | Create `scripts/claude-code-plugin-smoke.mjs` | HIGH | Large | No install verification exists |
| 1 | Update `docs/README.md` to list CC integration, ADRs, CI templates, ticket-authoring | HIGH | Small | CC invisible from docs index |
| 3 | Add `## Gaps` section to `docs/claude-code.md` | HIGH | Small | Parity with Codex doc honesty policy |
| 2 | Move CC ADRs to `docs/adr/0002` and `0003` (verify order first) | MEDIUM | Small | Discoverability and consistency |
| 8 | Add coverage ratings to CC lifecycle table | MEDIUM | Small | Users can't assess enforcement quality |
| 9 | Link `ticket-authoring.md` from CC adoption doc | MEDIUM | Small | Ticket schema undiscoverable for CC users |
| 10 | Add cross-references between CC and Codex adoption docs | MEDIUM | Small | Coexistence undocumented |
| 7 | Add example fixtures for CC P5 path | MEDIUM | Medium | Only after Gap 6 resolved |
| 12 | Document prosecutor evidence banking | MEDIUM | Small | Resolved by Gap 6 fix |
| 4 | Add `## Boundary` section to `docs/claude-code.md` | LOW | Small | Structural parity |
| 11 | Mark `docs/claude-code-integration-plan.md` as superseded | MEDIUM | Trivial | Elevated: actively linked from plugin.json |
