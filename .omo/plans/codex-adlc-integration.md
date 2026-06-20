# Codex ADLC Integration Plan

## TL;DR
> Summary: This is a decision plan for building an installable Codex plugin that wraps the existing ADLC npm CLIs with phase-specific skills, a small repo marketplace, optional rail-enforcement hooks, and copy-pasteable `codex exec` recipes. Keep the ADLC tools as the execution substrate; Codex should supply invocation, orchestration, and operator ergonomics.
> Future implementation deliverables:
> - `plugins/adlc-codex/` Codex plugin with `.codex-plugin/plugin.json`
> - `plugins/adlc-codex/skills/` with one router skill and four phase skills
> - `.agents/plugins/marketplace.json` for local/repo install
> - An installer smoke-test fixture that proves the marketplace root, plugin id, and skill discovery path before the install commands are published as supported
> - `docs/codex-integration.md` with install, quickstart, phase map, and adoption path
> - Optional plugin-bundled hooks for P4 rail freeze assistance, always paired with mandatory `rails-guard` proof
> Effort: Medium
> Risk: Medium - P5 prosecution is only partially deterministic until a first-party orchestration gate exists.

## Grounding
Local project facts:
- `README.md` describes ADLC as zero-dependency, gate-shaped Node.js CLIs with `.adlc/` runtime conventions and independently published `@adlc/*` packages.
- `docs/toolkit.md` maps tools to P0-P7 and names `.adlc/tickets.json`, `.adlc/manifest.jsonl`, and `.adlc/lessons/` as shared state.
- `docs/package-reference.md` lists 20 packages, 19 binaries, and exact command forms.
- `CONVENTIONS.md` establishes the shared CLI contract: Node 18+, no runtime dependencies beyond `@adlc/core`, `--json`, `--prompt-only`, exit codes `0/1/2`, dry-run-by-default writers.
- The current worktree reports `main...origin/main`, not `feat/codex-integration`; the executor must confirm the intended branch before creating implementation commits.

Public ADLC source facts:
- The series defines the lifecycle as eight phases, two human gates, and deterministic machine checks between phases.
- The flaw inventory is load-bearing: premature satisfaction, sycophancy, context rot, hallucination, reward hacking, finding-count prior, generative bloat, and coherence loss.
- Adoption guidance explicitly says teams should start with prosecution of existing PRs, then rails, then interrogation, then the full loop.

Codex surface facts:
- Skills are the right surface for reusable workflows; plugins are the distribution unit for reusable skills, app integrations, MCP config, and lifecycle hooks.
- Codex discovers repo skills from `.agents/skills` and installed plugin skills from plugin bundles.
- Codex plugin marketplaces can live under `$REPO_ROOT/.agents/plugins/marketplace.json` and point to local plugin folders.
- Codex hooks can run on `PreToolUse`, `PostToolUse`, `Stop`, and related events, but command hooks must be trusted and cannot fully police arbitrary shell writes.
- `codex exec` is the right automation surface for scripted gates and CI-like workflows; it supports explicit sandbox and approval settings plus JSONL output.

## Scope
### Current artifact
- This file is the planning artifact only. It is not the installable Codex ADLC integration.
- Do not publish install commands, claim `$adlc` exists, or mark Codex ADLC integration complete from this plan-only branch.
- A later implementation branch must produce the plugin, marketplace, skills, docs, hooks, fixtures, and installer evidence before any install path is supported.
- The plan artifact is complete only when its scope, assumptions, risks, verification steps, and future deliverables are internally consistent and executable by a downstream implementer.

### Must have
- Make ADLC installable in Codex through the documented plugin path, not only as loose repo instructions.
- Preserve the existing npm CLIs as source of truth; do not reimplement ADLC gate logic inside Codex skills.
- Provide one obvious user entry point: `$adlc`.
- Provide phase-specific skills for users who know where they are in the lifecycle.
- Include a low-friction adoption path that matches the ADLC series without overstating gates: a P5 manual review pilot may come first for trust-building, but strict ADLC gate adoption starts with P3 rails until a deterministic P5 prosecution harness exists.
- Include exact commands for local development and local marketplace install. Include Git-backed marketplace install only after sparse payload proof exists; before then, docs must use a planned/unsupported placeholder.
- Include an explicit completeness matrix from P0 through P7.
- Name gaps where Codex cannot currently enforce ADLC mechanically.
- Treat install smoke testing as a Wave 0 blocker: no install command may be documented as supported until it passes in a temporary `CODEX_HOME`.
- Mark P5 as incomplete unless the implementation also adds a deterministic prosecution orchestrator or a tested `codex exec` harness that enforces fan-out, finding verification, dry-pass looping, and `gate-manifest` evidence. All P5-first messaging must say "manual review pilot, not completed ADLC gate" until then.

### Must NOT have
- Do not add a second CLI framework, daemon, or MCP server in the first integration.
- Do not require global npm installs. Supported recipes must use local workspace binaries when run from this repo, or pinned per-package `@adlc/<tool>@<PACKAGE_VERSION>` invocations when run outside the repo. Unpinned `npx @adlc/*` is allowed only in explicitly best-effort docs with a version-skew warning.
- Do not make custom prompts the primary UX; Codex docs mark custom prompts deprecated in favor of skills.
- Do not promise that hooks fully freeze rails against all write paths. Hooks can assist, but `rails-guard` and file permissions remain the deterministic proof.
- Do not require users to adopt all P0-P7 phases on day one.
- Do not ship hook marketing or docs that say "rails are frozen" unless the same workflow also proves `rails-guard` passes after every shell-capable build step.

## Recommended Architecture
### 1. Plugin as installable wrapper
Add:

```text
plugins/adlc-codex/
  .codex-plugin/plugin.json
  skills/adlc/SKILL.md
  skills/adlc-spec/SKILL.md
  skills/adlc-rail-build/SKILL.md
  skills/adlc-prosecute/SKILL.md
  skills/adlc-distill/SKILL.md
  hooks/hooks.json
  hooks/adlc-rails-guard.mjs
  assets/
.agents/plugins/marketplace.json
docs/codex-integration.md
```

Candidate marketplace fixture to test before implementation proceeds. This is not a required schema until Wave 0 proves it unchanged:

```json
{
  "name": "adlc",
  "plugins": [
    {
      "name": "adlc-codex",
      "source": {
        "source": "local",
        "path": "./plugins/adlc-codex"
      },
      "policy": {
        "installation": "AVAILABLE",
        "authentication": "ON_INSTALL"
      },
      "category": "Developer Tools"
    }
  ]
}
```

Candidate plugin id and manifest fixture to test before implementation proceeds. This is not a required schema until Wave 0 proves it unchanged:

```json
{
  "name": "adlc-codex",
  "version": "1.0.0",
  "description": "Codex workflows for operating the Agentic Development Lifecycle with the ADLC toolkit.",
  "skills": "./skills/"
}
```

Rationale:
- The plugin is the installable unit.
- Skills carry the ADLC operating method through progressive disclosure.
- Hooks are optional enforcement assists bundled with the plugin, not the only gate.
- Docs give deterministic install commands and adoption recipes.

### 2. Skill split
- `$adlc`: router skill. Classifies request risk, chooses direct/bounded/full ADLC route, and tells the user the next gate.
- `$adlc-spec`: P0-P2. Runs interrogation, `parallax`, `spec-lint`, `premortem`, ticket decomposition, `coldstart`, `merge-forecast`, and `model-router`.
- `$adlc-rail-build`: P3-P4. Writes rails in a separate context, validates RED-for-right-reasons, runs `hollow-test`, `preflight`, `rails-guard`, and `flail-detector`.
- `$adlc-prosecute`: P5-P6. Runs refute-chartered review, verifies findings, records evidence with `gate-manifest`, captures behavior with `behavior-diff`, and prepares the human acceptance packet.
- `$adlc-distill`: P7 and maintenance. Runs simplification planning, `lesson-foundry`, `rejection-mining`, `skill-rot`, `model-ratchet`, and `review-calibration`.

This is easier to use than 8 separate phase skills while still preventing one huge skill from loading every tool description at once.

### 3. Install UX
These commands are the target UX, not a supported promise until Wave 0 proves them against a temporary `CODEX_HOME`.

Local development target:

```sh
codex plugin marketplace add .
codex plugin add adlc-codex --marketplace adlc
```

Git-backed marketplace target after release: do not publish a command yet. Wave 0 must first prove the exact sparse payload behavior and record the transcript. Until that evidence exists, the only allowed docs text is: "Git-backed install is planned but unsupported; use the local marketplace or pinned per-package `npx @adlc/<tool>@<PACKAGE_VERSION>` fallback."

No-install fallback target. The docs generator must resolve `<SPEC_LINT_VERSION>` and `<RAILS_GUARD_VERSION>` from each CLI package's own `packages/<name>/package.json`, then verify that exact package exists in the registry or local release manifest. Unpinned `npx @adlc/*` must not appear in supported recipes:

```sh
npx @adlc/spec-lint@<SPEC_LINT_VERSION> spec.md --json
npx @adlc/rails-guard@<RAILS_GUARD_VERSION> --ticket T1 --tickets .adlc/tickets.json --record --json
```

The docs must include exact verification:

```sh
tmp_home="$(mktemp -d)"
tmp_codex_home="$tmp_home/.codex"
tmp_xdg_config="$tmp_home/.config"
tmp_xdg_cache="$tmp_home/.cache"
tmp_xdg_data="$tmp_home/.local/share"
mkdir -p "$tmp_codex_home" "$tmp_xdg_config" "$tmp_xdg_cache" "$tmp_xdg_data"

tree_manifest() {
  {
    find "$1" -mindepth 1 -printf '%y %m %p -> %l\n' 2>/dev/null
    find "$1" -type f -exec sha256sum {} + 2>/dev/null
  } | sort
}

before_real_home="$(tree_manifest "$HOME/.codex")"

HOME="$tmp_home" XDG_CONFIG_HOME="$tmp_xdg_config" XDG_CACHE_HOME="$tmp_xdg_cache" XDG_DATA_HOME="$tmp_xdg_data" CODEX_HOME="$tmp_codex_home" codex plugin marketplace add .
HOME="$tmp_home" XDG_CONFIG_HOME="$tmp_xdg_config" XDG_CACHE_HOME="$tmp_xdg_cache" XDG_DATA_HOME="$tmp_xdg_data" CODEX_HOME="$tmp_codex_home" codex plugin add adlc-codex --marketplace adlc
HOME="$tmp_home" XDG_CONFIG_HOME="$tmp_xdg_config" XDG_CACHE_HOME="$tmp_xdg_cache" XDG_DATA_HOME="$tmp_xdg_data" CODEX_HOME="$tmp_codex_home" codex plugin marketplace list
HOME="$tmp_home" XDG_CONFIG_HOME="$tmp_xdg_config" XDG_CACHE_HOME="$tmp_xdg_cache" XDG_DATA_HOME="$tmp_xdg_data" CODEX_HOME="$tmp_codex_home" codex plugin list
find "$tmp_home" -type f -path '*/skills/adlc/SKILL.md' -exec grep -H 'ADLC_CODEX_SENTINEL_PHASE_ROUTER_V1' {} \;

after_real_home="$(tree_manifest "$HOME/.codex")"
test "$before_real_home" = "$after_real_home"
```

### 4. Evidence and state
- Keep `.adlc/` as the ADLC runtime state directory.
- Keep `.omo/plans/` as planning artifacts only, because this repo already uses OMO planning conventions.
- Add a docs section explaining the boundary:
  - `.adlc/`: tickets, ledgers, gate evidence, lessons consumed by ADLC tools.
  - `.omo/`: Codex planning and execution artifacts when OMO-style plans are used.

## Completeness Evaluation
| ADLC phase | Existing tool coverage | Codex integration coverage | Completeness |
| --- | --- | --- | --- |
| P0 Triage | `preflight`, phase docs | `$adlc` routes trivial/bounded/substantial/architectural | Strong |
| P1 Interrogate | `parallax`, `spec-lint`, `premortem` | `$adlc-spec` forces executable acceptance criteria and human spec approval | Strong |
| P2 Decompose | `coldstart`, `merge-forecast`, `model-router`, tickets schema | `$adlc-spec` emits `.adlc/tickets.json` and validates cold-start gaps | Strong |
| P3 Rail | `hollow-test`, `rails-guard` | `$adlc-rail-build` creates separate-context rails and runs RED/hollow/freeze gates | Strong, with hook caveat |
| P4 Build | `preflight`, `flail-detector`, `model-router`, worktree guidance | `$adlc-rail-build` wraps fresh-context ticket execution and two-strike regeneration | Medium-strong |
| P5 Prosecute | `review-calibration`, `gate-fuzzing`, `model-ratchet`; external `adversarial-review` | `$adlc-prosecute` gives refute charter and recipes, but no first-party deterministic fan-out/verify/dry-pass orchestrator exists yet | Incomplete for strict ADLC; medium for adoption |
| P6 Integrate | `behavior-diff`, `gate-manifest` | `$adlc-prosecute` can produce a manual acceptance packet; strict integrate gate requires verified P5 manifest evidence first | Conditional: strong only after deterministic P5 evidence |
| P7 Distill | `lesson-foundry`, `rejection-mining`, `skill-rot` | `$adlc-distill` turns repeated findings into skills/lints/templates | Strong |

Overall completeness: good for staged ADLC practice adoption, not yet complete for strict ADLC. The blocker is P5 orchestration: full dimension fan-out, finding verification, loop-until-two-dry-passes, and manifest recording are not yet one deterministic ADLC gate. P6 is therefore conditional: the human acceptance packet is useful for adoption, but strict ADLC integration is strong only when backed by verified P5 manifest evidence. The implementation must either add that orchestrator as a follow-on deliverable or keep the shipped completeness claim at "P0-P4/P7 strong, P5 partially manual, P6 conditional."

## Simplicity Evaluation
Install simplicity:
- Good if a repo marketplace is added. Two commands after release are acceptable.
- Excellent for local development only after Wave 0 proves `codex plugin marketplace add .` from the repo root with a temporary `CODEX_HOME`.
- Weak if users must manually copy skills into `~/.agents/skills`; that should be fallback only.

Use simplicity:
- Strong if `$adlc` is the single recommended entry point.
- Strong if phase skills are discoverable but optional.
- Medium if users must know every `@adlc/*` binary. The skills must hide most binary selection.

Adoption simplicity:
- Strong if docs lead with either "manual P5 review pilot, not a completed ADLC gate" for trust-building or "freeze rails" for strict ADLC gate adoption, instead of full lifecycle ceremony.
- Weak if the first page asks teams to create tickets, hooks, worktrees, behavior snapshots, and distillation artifacts before they see value.

Operational simplicity:
- Strong because the npm CLIs already share exit codes, `--json`, `--prompt-only`, and `.adlc/`.
- Medium because provider-backed tools need API keys or prompt-only fallback. The skills must explicitly choose prompt-only when credentials are absent.

## Known Gaps
1. **No single ADLC orchestrator CLI.** Codex skills can sequence tools, but a deterministic `adlc run <phase>` wrapper would make CI and non-Codex adoption simpler.
2. **P5 is not fully automated.** `adversarial-review` covers skeptical review, but the repo needs a first-party prosecution orchestrator that fans out lenses, verifies findings, loops until dry, and records `gate-manifest` evidence. Until that exists, all docs, skills, and matrices must say "manual P5 review pilot, not completed ADLC gate."
3. **Rails freeze cannot rely only on Codex hooks.** Hooks can block direct patch/edit tools, but shell commands can still mutate files unless paired with file permissions, sandbox policy, or post-hoc `rails-guard`. The hook acceptance suite must include an intentional shell-bypass fixture and require `rails-guard` to catch it.
4. **Ticket authoring schema needs examples.** `packages/core/lib/tickets.mjs` defines the schema, but Codex users need templates for atomic tickets, rails, scopes, edges, and allowed suppressions.
5. **Model-router uses ADLC tiers, not Codex profile names.** The integration must document mapping from `cheap|mid|frontier` to current Codex models/config profiles without hardcoding stale model names into tool logic.
6. **No installer smoke test yet.** This is now Wave 0 and blocks all plugin work. The fixture must install the local marketplace in an isolated temporary home, confirm the `adlc-codex` plugin id resolves, prove installed skill files and sentinels mechanically, and run a separate release-blocking `$adlc` discovery proof before docs claim the command works.
7. **Git-backed sparse install needs payload proof.** The Git-backed marketplace command must fetch both `.agents/plugins` and `plugins/adlc-codex`; release docs must not publish any Git-backed install command until the sparse payload transcript proves it.
8. **Branch mismatch.** The current checkout is on `main`; implementation should start by confirming or switching to `feat/codex-integration`.
9. **Custom prompts are deprecated.** Any slash-command-like UX should be through skills/plugins, not `~/.codex/prompts`.

## Gap Reduction Plan
This section resolves the open strict-ADLC gaps in the safe order. It is separate from the Codex plugin packaging waves because strict ADLC correctness depends on deterministic contracts before ergonomic wrappers.

### G0: Continuous Codex Install Proof
- Run the isolated Codex marketplace/plugin smoke test from Wave 0 before and after every plugin-facing change, not only at the end.
- Keep Git-backed install docs unpublished until sparse payload proof exists.
- Acceptance: `.omo/evidence/adlc-codex-install-smoke.txt` proves isolated home, marketplace registration, plugin id resolution, skill file discovery, and no mutation of real `$HOME/.codex`.

### G1: Minimal Ticket and Evidence Contracts
- Add minimal examples before building P5:
  - `.adlc/tickets.example.json`
  - `docs/ticket-authoring.md`
  - fixture tickets covering valid rails, missing rails, overlapping scopes, edges/contracts, and allowed suppressions.
- Define the evidence records P5/P6 require:
  - review pass started/completed
  - raw finding
  - verified finding
  - killed/unverified finding
  - dry pass
  - two-dry-pass completion
  - P6 acceptance packet generated from a manifest revision.
- Acceptance: `gate-manifest` can record and verify each evidence shape from fixtures before any P5 orchestrator code is accepted.

### G2: P5 Contract Pieces Before Orchestration
- Define a stable finding schema before implementing `@adlc/prosecute`:
  - `id`, `lens`, `severity`, `category`, `file`, `line_start`, `line_end`, `evidence`, `claim`, `recommendation`, `confidence`, `verified_status`.
- Define verifier behavior:
  - every finding must become `verified`, `killed`, or `needs-human`;
  - unverified findings must not be sent to the builder as required fixes;
  - verifier failures are operational errors, not dry passes.
- Define dry-pass semantics:
  - one dry pass means no verified findings in that pass;
  - strict P5 completion requires two consecutive dry passes over the same target plus unchanged rail proof.
- Acceptance: schema validation and dry-pass fixtures pass without invoking any model.

### G3: Deterministic P5 Orchestrator CLI
- Implement `@adlc/prosecute` only after G1-G2 are accepted.
- Required behavior:
  - run configured refute-chartered lenses;
  - normalize findings into the finding schema;
  - verify every finding before reporting it as actionable;
  - loop until two consecutive dry passes or convergence budget exhausted;
  - record all pass, finding, verifier, and dry-pass evidence through `gate-manifest`;
  - exit `0` only on two verified dry passes, `2` on verified open findings or convergence failure, `1` on operational failure.
- Acceptance: fixture review commands prove verified findings block, killed findings do not block, two dry passes pass, and missing manifest evidence fails.

### G4: P6 Strict Evidence Packet
- Keep `behavior-diff` and acceptance packet generation separate from P5.
- P6 strict mode may run only when the manifest contains current-target P5 completion evidence.
- Acceptance: P6 packet generation fails without verified P5 manifest evidence and succeeds with a fixture manifest containing two dry passes plus behavior diff references.

### G5: Phase Runner With Artifact Assertions
- Add `adlc run <phase>` only after the phase contracts exist.
- The runner must assert artifacts, not only command execution:
  - `p1` passes only with spec-lint/premortem evidence;
  - `p2` passes only with valid ticket DAG/coldstart evidence;
  - `p3` passes only with RED/hollow/frozen-rails evidence;
  - `p4` passes only with green rails, no rail diff, and flail checks;
  - `p5` passes only with deterministic P5 completion evidence;
  - `p6` passes only with P5 evidence plus behavior acceptance packet;
  - `p7` passes only with recorded lesson/mining/rot evidence or an explicit no-op record.
- Acceptance: runner fixture tests fail when a command exits zero but the required manifest artifact is missing.

### G6: Rails Hardening From One Source of Truth
- Use `.adlc/tickets.json` as the canonical rail declaration source.
- Use `ADLC_TICKET` as the CI/automation active-ticket selector and `.adlc/current-ticket.json` as local fallback with the precedence rules in Wave 3.
- Add optional file-permission freeze only as a defense-in-depth layer; `rails-guard` remains the deterministic proof.
- Acceptance: hook, runner, and CI fixtures all resolve the same active ticket and rails, and all detect the same shell-bypass mutation.

### G7: Codex UX and Documentation
- Keep `$adlc` as the single user entry point, but do not let skill text become the gate.
- Skills may recommend commands; ADLC CLIs and manifest assertions decide pass/fail.
- Model tier mapping must be config-driven and documented, not hardcoded.
- Acceptance: Codex skills drive fixture commands and evidence checks; no skill claims a phase complete unless the corresponding deterministic gate passes.

## Execution Strategy
### Wave 0: Prove Codex marketplace install semantics
- Create a temporary fixture outside the product paths with the candidate marketplace JSON and plugin manifest shape.
- Treat Wave 0 as the schema source of truth: if Codex requires any different field, root, or path semantics, update the plan and use only the tested schema. Do not copy the candidate JSON into product paths until the isolated transcript proves it unchanged.
- Run all commands with a temporary `HOME`, `CODEX_HOME`, `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, and `XDG_DATA_HOME` so Codex cannot fall back to the developer's real home:
  - `tmp_home="$(mktemp -d)"`
  - `tmp_codex_home="$tmp_home/.codex"`
  - `HOME="$tmp_home" XDG_CONFIG_HOME="$tmp_home/.config" XDG_CACHE_HOME="$tmp_home/.cache" XDG_DATA_HOME="$tmp_home/.local/share" CODEX_HOME="$tmp_codex_home" codex plugin marketplace add <fixture-root>`
  - `HOME="$tmp_home" XDG_CONFIG_HOME="$tmp_home/.config" XDG_CACHE_HOME="$tmp_home/.cache" XDG_DATA_HOME="$tmp_home/.local/share" CODEX_HOME="$tmp_codex_home" codex plugin marketplace list`
  - `HOME="$tmp_home" XDG_CONFIG_HOME="$tmp_home/.config" XDG_CACHE_HOME="$tmp_home/.cache" XDG_DATA_HOME="$tmp_home/.local/share" CODEX_HOME="$tmp_codex_home" codex plugin add adlc-codex --marketplace adlc`
  - `HOME="$tmp_home" XDG_CONFIG_HOME="$tmp_home/.config" XDG_CACHE_HOME="$tmp_home/.cache" XDG_DATA_HOME="$tmp_home/.local/share" CODEX_HOME="$tmp_codex_home" codex plugin list`
- Verify the installed plugin exposes a `$adlc` skill using deterministic offline checks:
  - mechanically enumerate the installed plugin files under the isolated temporary home and XDG roots;
  - assert exactly one installed `skills/adlc/SKILL.md` exists;
  - assert that installed file contains `ADLC_CODEX_SENTINEL_PHASE_ROUTER_V1`, a sentinel phrase stored only in the `$adlc` skill and never in the smoke-test prompt;
  - create `$tmp_codex_home`, `$tmp_xdg_config`, `$tmp_xdg_cache`, and `$tmp_xdg_data` before the first Codex invocation;
  - do not use `codex exec`, `CODEX_API_KEY`, network, or live model behavior in the blocking marketplace-correctness smoke test.
- Release-blocking `$adlc` discovery proof, required before docs claim the installed command works:
  - prefer a Codex-native skill/plugin listing command if Codex exposes one that can prove the installed skill is registered without a model call;
  - otherwise require explicit `CODEX_API_KEY` or pre-seeded isolated auth and run `codex exec` from a newly initialized temporary Git repository outside the ADLC repo so repo-local `.agents/skills` and AGENTS guidance cannot satisfy the prompt;
  - capture behavioral stdout and require `ADLC_CODEX_SENTINEL_PHASE_ROUTER_V1`;
  - if auth, network, or native discovery is unavailable, the release must stop before publishing "install and use `$adlc`" docs; only the offline marketplace-correctness result may be reported.
- Capture a full tree manifest of the real `$HOME/.codex` before and after the fixture run including file type, path, symlink target, permissions, and regular-file content hashes; fail the smoke test if any entry changes. Prefer also making the real `$HOME/.codex` read-only in CI-style smoke tests when permissions allow it.
- If any command differs from the target UX, update this plan and `docs/codex-integration.md` to the tested command. Do not preserve aspirational commands.
- Acceptance: one captured transcript under `.omo/evidence/adlc-codex-install-smoke.txt` proves marketplace root, plugin id, skill discovery, and no mutation of the default `$HOME/.codex`.
- Git-backed acceptance: only after local install passes, run the candidate release command with both sparse paths, `--sparse .agents/plugins --sparse plugins/adlc-codex`, in the same isolated-home harness and prove that `plugins/adlc-codex/.codex-plugin/plugin.json` and every `skills/*/SKILL.md` file exist in the resolved marketplace snapshot before `codex plugin add` runs. Publish the Git-backed install command only if this transcript exists and is linked from `docs/codex-integration.md`.

### Wave 1: Plugin skeleton and marketplace
- Create `plugins/adlc-codex/.codex-plugin/plugin.json`.
- Create `.agents/plugins/marketplace.json`.
- Add minimal `assets/` only if needed for Codex app presentation.
- Acceptance: copy only the Wave 0-proven fixture shape into product paths and re-run the same isolated-home installer smoke test from the repository root. If Wave 0 changed the candidate schema, product paths must use the changed tested schema, not the earlier candidate block.

### Wave 2: Skills
- Add `$adlc` router skill.
- Add the four phase skills.
- Each skill must name:
  - phase objective
  - matching ADLC flaws defended
  - commands to run
  - evidence to record
  - stop conditions
  - when to ask the human
  - an install sentinel phrase unique to that skill for fixture validation
- Acceptance: `codex exec --ignore-user-config` with the local plugin can invoke each skill explicitly against fixtures and prove executable ADLC behavior:
  - `$adlc` classifies at least one trivial, bounded, substantial, and architectural request and names the correct next gate.
  - `$adlc-spec` invokes the local workspace `spec-lint` binary or pinned `npx @adlc/spec-lint@<SPEC_LINT_VERSION>` against a fixture spec, propagates exit `2` on unverifiable criteria, and records the expected prompt-only fallback when credentials are absent.
  - `$adlc-rail-build` invokes `preflight`, `hollow-test`, `rails-guard`, and `flail-detector` fixture commands, propagates nonzero exits, and writes or references `.adlc/manifest.jsonl` only through the ADLC CLI.
  - `$adlc-prosecute` runs a fixture skeptical-review command, distinguishes verified from unverified findings in output, and refuses to label P5 complete without dry-pass and manifest evidence. If no deterministic prosecution harness is implemented, it must label itself "manual review pilot" in every successful path.
  - `$adlc-distill` invokes `lesson-foundry`, `rejection-mining`, and `skill-rot` in dry-run or prompt-only fixture mode and reports the generated `.adlc/lessons/` or prompt-only artifacts.
  - Each skill has one malformed-state fixture that must stop before implementation work and surface the gate failure rather than printing a generic checklist.

### Wave 3: Optional hooks
- Add a conservative `PreToolUse` hook that blocks direct Codex edit/write attempts to active ticket rails during P4.
- Define activation exactly: P4 enforcement is active only when `ADLC_P4_ENFORCEMENT=1`. Any other value, including unset, is inactive and must emit a visible "P4 rail hook inactive" notice rather than silently implying protection.
- Resolve the active ticket with explicit precedence:
  - `ADLC_TICKET` is the canonical CI/automation source and names a ticket id in `.adlc/tickets.json`.
  - `.adlc/current-ticket.json` is the local interactive fallback and must contain the same ticket id shape.
  - If both are present and agree, proceed.
  - If both are present and disagree, block as a configuration conflict.
  - If exactly one valid source is present, proceed with that source.
  - If no valid source resolves a ticket with non-empty `rails`, block.
- Treat hook failure as "fail closed" only when `ADLC_P4_ENFORCEMENT=1`, and document that this is an assistive guard rather than the ADLC gate proof.
- In P4 enforcement mode, malformed ticket JSON, unknown ticket id, conflicting active-ticket sources, or an empty resolved `rails` set is a blocking hook error. Missing `.adlc/current-ticket.json` is acceptable when `ADLC_TICKET` resolves valid rails; unset `ADLC_TICKET` is acceptable when `.adlc/current-ticket.json` resolves valid rails. The hook must never interpret missing or invalid active-ticket state as "no rails."
- Require `rails-guard --ticket <id> --tickets .adlc/tickets.json --record --json` after every P4 step that allowed shell execution or any other write-capable tool.
- Acceptance:
  - hook blocks a direct edit to a declared rail file in a fixture;
  - hook allows non-rail edits;
  - hook emits inactive notice and does not block when `ADLC_P4_ENFORCEMENT` is unset;
  - hook emits inactive notice and does not block when `ADLC_P4_ENFORCEMENT=0`;
  - hook fail-closes on configuration errors only when `ADLC_P4_ENFORCEMENT=1`;
  - hook allows an env-only valid `ADLC_TICKET` fixture;
  - hook allows a file-only valid `.adlc/current-ticket.json` fixture;
  - hook allows a both-present matching fixture;
  - hook blocks a both-present conflicting fixture;
  - hook blocks when `ADLC_P4_ENFORCEMENT=1` and neither active-ticket source exists;
  - hook blocks malformed ticket JSON;
  - hook blocks an unknown ticket id;
  - hook blocks a ticket with no resolved rail globs;
  - shell-bypass fixture mutates a declared rail file and demonstrates that the hook alone does not catch it;
  - the same shell-bypass fixture is caught by mandatory `rails-guard`.

### Wave 4: Documentation and examples
- Add `docs/codex-integration.md`.
- Include local install commands, pinned per-package fallback `npx @adlc/<tool>@<PACKAGE_VERSION>` commands, phase map, adoption path, and state directory explanation.
- Include Git-backed install commands only after the sparse payload smoke transcript exists and is linked.
- Add sample `.adlc/tickets.example.json`.
- Acceptance: a fresh user can follow the docs from local checkout to `$adlc` invocation without reading `ADLC.md`.

### Wave 5: Verification
- Run `npm test`.
- Run installer smoke test in a temporary `CODEX_HOME`.
- Run at least one dry/prompt-only command per LLM-backed package referenced by the skills.
- Verify that docs never call P5 a completed ADLC gate unless the deterministic prosecution harness exists.
- Run `npx adversarial-review --base main --include-files "focus on plugin install safety, hook overclaims, and supply-chain risk"` against the implementation branch before PR.

## Success Criteria
- Installation is two commands for local development. Git-backed install is two commands only after sparse payload evidence exists; otherwise it remains documented as planned, not supported.
- `$adlc` is the only command users need to remember for the happy path.
- Every ADLC phase P0-P7 has a Codex skill path; only phases with deterministic CLI enforcement are labeled complete.
- P5 is either backed by a deterministic prosecution orchestrator or explicitly labeled incomplete/partially manual everywhere.
- The docs explicitly teach the staged adoption path, not only the full lifecycle.
- Hook docs and tests distinguish assistive enforcement from deterministic gate proof, including the shell-bypass case.
- All plugin, skill, and docs tests pass in a temporary `CODEX_HOME`.
- The final branch review includes `adversarial-review` output and resolves or documents every material concern.
