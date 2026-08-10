# Adopt the ADLC in Claude Code

The `@adlc/*` toolkit is a set of gate-shaped CLIs. This plugin makes the whole
**Agentic Development Lifecycle** usable from inside Claude Code: the gates fire
at the right lifecycle moments — some automatically — and the model reaches for
the right gate without you memorizing 20 tools.

> Design and rationale: [ADR 0003 — Bringing the ADLC to Claude Code as a plugin](../adr/0003-adlc-claude-code-plugin.md).
> The full thesis: [`../../ADLC.md`](../../ADLC.md).

## Install

**Recommended.** Install with [`plugins`](https://www.npmjs.com/package/plugins) — the
vendor-neutral installer that reads this repo's `marketplace.json`, translates the plugin
into the target's native format, and installs it. It auto-detects your agent tools (Claude
Code, Cursor) and installs into each, so the same one-liner works everywhere:

```sh
npx plugins add voodootikigod/adlc           # install the plugin into your agent tool(s)
npm install -g @adlc/cli                     # the gate toolkit the plugin shells out to
/adlc:adlc-init                               # bootstrap .adlc/ in your repo (once)
```

The plugin's gates shell out to the `adlc` binary, so the `@adlc/cli` toolkit is a
prerequisite either way — the `plugins` installer handles the plugin, not the toolkit.
Pin a specific release with `npx plugins@<version> add …`; scope the install with
`--scope user|project|local` (default `user`) and skip the prompt with `--yes`.

**Alternative — native Claude Code marketplace.** If you'd rather use Claude Code's
built-in plugin marketplace commands, they resolve the same `marketplace.json`:

```sh
npm install -g @adlc/cli                     # the toolkit, behind one `adlc <tool>` command
/plugin marketplace add voodootikigod/adlc   # register this repo as a marketplace
/plugin install adlc@adlc                     # install the plugin
/adlc:adlc-init                               # bootstrap .adlc/ in your repo (once)
```

Local install verification:

```sh
node scripts/claude-code-plugin-smoke.mjs .
```

That smoke test validates the plugin manifest, marketplace entry, hook
registrations (all four event types), hook zero-dependency guarantee, command
files, prosecutor subagent, and skill sentinel. It does not exercise the rail
hook or interact with Claude Code.

**No API keys.** Every LLM-backed gate supports `--prompt-only`: inside Claude
Code, *Claude is the model* — the gate prints its prompt, Claude answers it, and
the judgment is applied. The only prerequisite is `adlc` on your PATH (the npm
install above) and Node 18+.

## What you get

### Commands

| Command | Phase | What it does |
| --- | --- | --- |
| `/adlc:adlc-init` | — | Bootstrap `.adlc/`, split the committable ticket contract from runtime evidence in `.gitignore`, run preflight. |
| `/adlc:adlc-ticket` | P0 | Author a self-contained, schema-valid ticket (the contract every gate reads), then check it is executable. Ticket schema: [`docs/ticket-authoring.md`](../ticket-authoring.md). |
| `/adlc:adlc-prosecute` | P5 | Multi-lens adversarial pre-merge review: fan out five independent lens subagents, dedupe findings, independently verify each via a sixth verifier subagent, loop until two consecutive dry rounds. |
| `/adlc:adlc-distill` | P7 | Mine repeated findings and PR rejections into deterministic defenses (lint rules, skills, review lenses). |
| `/adlc:adlc-maintain` | C10/C12 | Decay-driven checks: stale skills, hot files to re-prosecute, gate calibration. |

### The discovery skill

The `adlc` skill is a phase-routing flowchart: describe what you're doing ("shape
this spec", "is this safe to merge") and it routes you to the right gate. It is
how the model embraces the lifecycle in total.

### The prosecutor subagent and `/adlc:adlc-prosecute`

`prosecutor` is a hostile pre-merge (P5) reviewer: it runs `hollow-test` (are the
tests load-bearing?), `behavior-diff` (is the behavior change visible?), and
`review-calibration` (would the review catch a planted defect?) and returns an
evidence-backed verdict. These are mechanical, deterministic-gate checks.

`/adlc:adlc-prosecute` is the independent multi-lens adversarial loop, matching the
shape of OpenCode's own `adlc-prosecute` command (invoked bare there, since
OpenCode has no plugin-namespace convention): it fans out five independent lens
subagents (`prosecutor-correctness`, `prosecutor-security`, `prosecutor-contract`,
`prosecutor-diff`, `prosecutor-tests`) on the diff, dedupes findings across
lenses by file + line range + title (keeping the highest severity), independently
verifies each deduped finding via a sixth `prosecutor-verifier` subagent (a
finding survives only on a strict majority "real" vote — fail-closed to
"survives" if no valid vote is obtained), and repeats until two consecutive
rounds surface no new confirmed findings. The pure dedupe/verify/convergence
logic is unit-tested at `plugins/adlc-claude-code/lib/prosecutor.mjs`
(`plugins/adlc-claude-code/lib/test/prosecutor.test.mjs`). The two mechanisms are
complementary: `prosecutor` supplies mechanical evidence, `/adlc:adlc-prosecute`
supplies independent model judgment with cross-lens verification.

**Context hygiene of the lens agents** (issue #276): each of the five
`agents/prosecutor-{correctness,security,contract,diff,tests}.md` files
declares only what makes it different — its lens focus. The refute charter,
output schema, and tool-access constraints those five (plus the verifier)
share are defined once, in `commands/adlc-prosecute.md` step 1, and included
in every Task prompt from there, rather than duplicated in each agent file.
This is a maintainability property (one place to update the schema) more than
a runtime token saving — fresh-context subagents (E4) still each need the
full contract, whether it arrives via their fixed system prompt or the
per-call task prompt; moving it doesn't eliminate it, it just stops five
files from drifting independently.

Similarly, the trust-root tier explanation (when a same-model P5 pass isn't
enough — cross-model gating, ADR-0007/T39) is canonical in
`skills/adlc/references/trust-root.md`, loaded on demand. `agents/prosecutor.md`
points there instead of restating it. `skills/adlc/SKILL.md` keeps its own full
copy: that file is generated from a template shared across all six harness
ports (`scripts/router/router-model.mjs`), so it can't assume a
claude-code-only `references/` file exists — the other five harnesses have no
such directory. Progressive-disclosure restructuring of SKILL.md's body itself
(splitting per-phase detail into `references/p0-p7.md`-style files) would need
to happen at that generator layer to stay in sync across all six harnesses,
and is deliberately out of scope here (see issue #277) rather than attempted
as a same-session, higher-risk change.

Six of the seven prosecution agents (`prosecutor-{correctness,security,contract,
diff,tests,verifier}`) carry a one-line `description` in their frontmatter
("P5 … lens subagent; invoked by /adlc:adlc-prosecute — do not invoke
directly.") rather than the fuller prose the same field had before — they are
only ever invoked programmatically, by exact name, from `/adlc:adlc-prosecute`,
never model-selected by description matching, so a longer description was pure
always-loaded-session cost with no discovery benefit. `prosecutor` (the
user-facing one, model-selected by intent — "prosecute this", "is this safe to
merge") keeps its full descriptive text.

### Hooks (automatic)

| Hook | Event | Behavior |
| --- | --- | --- |
| preflight | SessionStart | Advisory: warns if the environment isn't ready for fan-out. |
| **ticket-context re-injection** | SessionStart, PreCompact, PostCompact, SubagentStart, SubagentStop | Advisory: re-surfaces the active ticket's id, title, rail-protection status, and scope so a compaction or subagent boundary can't silently drop rail-protection awareness — the same summary a fresh `adlc coldstart`-certified session would see. |
| flail-detection | PostToolUse | Advisory: flags repeated-error / churn loops over a bounded recent window of the transcript. |
| gate-manifest audit | Stop | Advisory: warns only if the gate-evidence chain is broken. |
| **adversarial-review trigger** | Stop | Advisory by default: diffs the working tree/branch against the [ADR-0007](../adr/0007-multimodel-adversarial-review.md) §1 risk-tier path patterns (auth/trust boundary, security controls/deny paths, secrets, data-loss ops, schema/migration, CI/CD/supply-chain) and warns if a risk-gated change has no `adversarial-review` gate-manifest record. This is the mechanical trigger [ADR-0005](../adr/0005-adversarial-design-review-gate.md)/[ADR-0007](../adr/0007-multimodel-adversarial-review.md) deferred pending operator-reliance proving insufficient — set `ADLC_ADVERSARIAL_REVIEW_ENFORCEMENT=1` to make it block (Stop `decision: "block"`) instead of just warn. |
| **rails-guard** | PreToolUse | **Enforcing**: denies structured edits (Edit/Write/MultiEdit) to frozen rail paths declared in tickets. Bash is not gated in-session (a shell can't be reliably parsed); Bash rail mutations are caught by the CI diff gate at commit time. |
| **build-gate** | PreToolUse | **Enforcing** (issue #48): for the *active* ticket (`ADLC_TICKET` env var or `.adlc/current-ticket.json`), denies a structured edit when the ticket is high-risk (declared `risk: 'high'`, or derived from category/external-effect/identity-mutation/trust-root-touch signals) AND this session's context-fitness signal (transcript tool-call depth or byte size) is past threshold — i.e. a context-rot backstop on the riskiest builds. Bash is not gated in-session (same reason as rails-guard) and, unlike rails, there is no CI backstop for it — see Gaps below. |
| **context-handoff** | PreToolUse | **Enforcing** (T157 / context-rot handoff slice 4): evaluates D1–D3 via `@adlc/context-handoff` (`loadDenyRecords` / `mutationGateInputFromLoad` / `evaluateMutationGate`). Denies Edit/Write/MultiEdit/NotebookEdit **and Bash|Shell** under an active deny-set (fail-closed-all); ensures a deny marker when the absolute handoff/hard band fires; protects `.adlc/handoffs/denies/**`, `.adlc/.deny-store`, and `*.resume-auth.json` / `*.model-ok` / `*.lock`. Session id from `session_id` / `sessionId` / transcript basename. |

All hooks no-op unless the repo is ADLC-initialized. Rail enforcement
additionally no-ops until a ticket declares `rails`, so installing the plugin
into a repo with no rails can never block editing. The build-gate similarly
no-ops until an active ticket is resolved via `ADLC_TICKET`/
`.adlc/current-ticket.json` — see [the active-ticket pointer](../active-ticket-pointer.md)
for that file's schema and read semantics (an unparseable pointer, an object with
no recognized id key, or a pointer conflicting with `ADLC_TICKET` all fail closed),
plus [`docs/specs/build-gate-fitness.md`](../specs/build-gate-fitness.md)
and [`@adlc/build-gate`](../../packages/build-gate/README.md). Context-handoff
no-ops until `.adlc/` exists and a deny store / handoff band applies — see
[`docs/specs/context-rot-handoff.md`](../specs/context-rot-handoff.md) and
[`@adlc/context-handoff`](../../packages/context-handoff/README.md).

**Build-gate bypass.** `ADLC_BUILD_GATE_BYPASS=1` overrides a build-gate deny
only if the override is durably recorded to the gate-manifest (an un-auditable
bypass is refused) — the same posture as `ADLC_RAILS_BYPASS` above. The
recommended response to a deny is to resume the ticket in a fresh session (or
an isolated subagent) rather than overriding — the ticket is coldstart-certified
to be safely resumable with no conversation context.

**Rails must be tracked files.** The commit-time CI gate inspects the git diff,
so it only protects files under version control. A gitignored/untracked rail
mutated via Bash is seen by neither the in-session hook (Bash isn't gated) nor
the CI diff gate. Declare rails on tracked files (tests, type contracts, configs)
— which is their normal use.

**Rail bypass — two distinct layers.** `ADLC_RAILS_BYPASS` overrides the
*in-session* PreToolUse hook only, and only if the override is recorded to the
gate-manifest (an un-auditable bypass is refused). The *commit-time* CI gate is
deliberately **not** env-bypassable — that is the whole point of an unbypassable
backstop. A legitimately needed rail change (e.g. updating a frozen test once its
ticket is complete) is therefore a privileged, human action: a maintainer
overrides the required `rails-guard` check (admin merge) — which is the correct
posture, since changing a frozen rail is exactly the kind of decision that should
require a human, not an environment variable. Once any rail is declared,
`.adlc/tickets.json` itself is frozen so the rail set can't be quietly edited away.

**Scope, lifetime, and visibility of the override.** Two forms:

- `ADLC_RAILS_BYPASS=<glob>` — **scoped**: authorizes only rail hits whose path
  matches the glob (same glob semantics as the rails themselves). An edit to a
  frozen path outside the glob is still denied, so an override granted for one
  area cannot silently authorize edits to another. Prefer this form.
- `ADLC_RAILS_BYPASS=1` — **unscoped, session-wide**, kept for backward
  compatibility. It authorizes every frozen rail for the rest of the session.

Be aware of the actual **lifetime**: when the variable is set through a harness
`env` block (e.g. `.claude/settings.local.json`), it is loaded into the running
agent process and is **session-lifetime** — *deleting the settings file does not
unset it*. To revoke, unset `ADLC_RAILS_BYPASS` and restart the session. Because
this diverges from the "per-edit" mental model, every honored bypass now emits a
visible in-session notice (a `systemMessage`) on the allowed edit — naming the
scope, and, for the unscoped `=1` form, stating plainly that it is session-wide
and not revoked by deleting a settings file. A stale bypass is therefore seen,
not silently in effect.

### MCP server

The plugin bundles an MCP server (`plugins/adlc-claude-code/.mcp.json`,
auto-discovered by Claude Code at the plugin root — no `plugin.json` entry
needed) exposing the same `adlc_gate`/`adlc_prosecute` tools the Codex
integration ships, over the stable `adlc mcp-server` entrypoint. It shells to
the globally-installed `adlc` binary rather than resolving `@adlc/cli` as a
local npm dependency, so it works the same way whether the plugin was
installed via the `plugins` installer or Claude Code's native marketplace.

## CI backstops (recommended)

The in-session rail hook is best-effort for Bash; pair it with the commit-time
gate so obfuscated shell writes are still caught. Copy these into
`.github/workflows/`:

- [`ci/rails-guard.yml`](../ci/rails-guard.yml) — rejects a PR whose diff touches a
  frozen rail. Make it a required check. The rail set is read from the **base**
  ref, so a PR can't remove rails to disable the gate.
- [`ci/adlc-maintenance.yml`](../ci/adlc-maintenance.yml) — a weekly advisory cron
  running the deterministic maintenance checks into the job summary.

**Private-repo / free-plan caveat.** "Make it a required check" assumes your
GitHub plan allows configuring one. On a **private repo on GitHub's free plan**,
both required-status-check mechanisms (`PUT .../branches/main/protection`,
`POST .../rulesets`) return 403 ("Upgrade to GitHub Pro or make this repository
public") — the gate still runs on every PR, but nothing stops a merge past a red
run. If that's your setup, don't ship `rails-guard` as a standalone job; fold the
rail-freeze step into the job backing your existing required check (e.g. the main
`test` job) instead. See the "Private-repo fallback" sketch at the bottom of
[`ci/rails-guard.yml`](../ci/rails-guard.yml).

Both templates pin `@adlc/cli` and their actions to exact versions/SHAs; bump
deliberately after reviewing a release.

## Troubleshooting

### `Marketplace 'adlc' not found` after a successful `/plugin marketplace add`

**Most likely cause:** You are running `/plugin install adlc@adlc` from inside
the `voodootikigod/adlc` repository itself. Claude Code detects the local
`.claude-plugin/marketplace.json` at the project root and uses that as the
"adlc" marketplace source rather than the registered global cache entry. The
local source is not a proper install target, so the lookup fails.

**Fix:** Use the CLI command instead of the slash command, which bypasses the
CWD-local marketplace detection:

```sh
claude plugin install adlc@adlc
```

This works from any directory including the adlc repo itself.

If you are installing into your own project (not the adlc repo), the
`/plugin install adlc@adlc` slash command works normally — this issue only
affects the adlc repo developer workflow.

**Secondary cause:** A stale `adlc@adlc` entry in
`~/.claude/plugins/installed_plugins.json` from a previous local-scope install.
If the CLI command also fails, remove the stale entry:

```sh
$EDITOR ~/.claude/plugins/installed_plugins.json   # delete the "adlc@adlc" key
claude plugin install adlc@adlc
```

### `npm warn Unknown user config "min-release-age"` during install

**This is not caused by @adlc.** Neither `npx plugins add voodootikigod/adlc`
nor `npm install -g @adlc/cli` sets, reads, or ships an `.npmrc` — the toolkit
has no `config` field and no install/postinstall script. Reproduce the
documented install commands from a clean environment against the real registry
and neither one emits this warning.

**Actual cause:** `min-release-age` is a real npm config (the "install
cooldown" supply-chain-safety feature that delays installing a package version
until it has been public for N days). npm only added it to its list of known
config keys in **npm 11.10.0**. If your `~/.npmrc` (npm's *user* config, not
this repo's) already has `min-release-age` set — e.g. because you or your org
adopted npm's cooldown feature — and your active npm is anywhere in the 11.x
line *before* 11.10.0, npm treats the key as unrecognized and warns on **every**
`npm install`/`npm install -g` you run, not just the `@adlc/cli` one. (npm's
own bundled version in Node 20, 10.x, predates the unknown-config check
entirely and never warns either way; npm >= 11.10.0 recognizes the key and
never warns.) The `npm install -g @adlc/cli` step in these docs is simply the
first npm command most readers run after cloning, so it takes the blame.

**Fix:** upgrade npm past the version boundary where it learns the key:

```sh
npm install -g npm@latest
```

Then re-run the install command; the warning is gone because your npm now
recognizes `min-release-age`, not because anything was suppressed.

---

## Lifecycle coverage

| Phase | Coverage | Wired via |
| --- | --- | --- |
| P0 Triage | Strong | `/adlc:adlc-ticket` |
| P1 Interrogate | Strong | `spec-lint`, `premortem`, `parallax` (via the `adlc` skill) |
| P2 Decompose | Strong | `coldstart`, `model-router`, `merge-forecast` |
| P3 Rail | Strong | rails-guard PreToolUse hook + CI backstop |
| P4 Build | Strong | flail-detection hook, `consensus-fix` |
| P5 Prosecute | Strong | `/adlc:adlc-prosecute` runs the full multi-lens fan-out/dedupe/verify/converge loop (parity with OpenCode); `prosecutor` subagent runs complementary deterministic gates. Formal `adlc run p5` phase assertion is a harness-agnostic runner path (see below), not blocked on any one CLI. |
| P6 Integrate | Conditional | gate-manifest evidence surfaced for the human gate; strong when backed by valid P5 evidence. |
| P7 Distill | Strong | `/adlc:adlc-distill` |
| Maintenance | Strong | `/adlc:adlc-maintain` + CI cron |

P6 is a human decision by design; the plugin surfaces the evidence, it does not
automate the judgment.

After a prosecution that returns CLEAR, record informal evidence with
`adlc gate-manifest record prosecution --files <changed files>`. This entry is
useful for provenance auditing but does **not** by itself satisfy `adlc run p5`
— see the Gaps section below for the full explanation and the runner path for
formal phase assertion.

## Using with Codex

The Claude Code plugin and the Codex plugin are designed to coexist. A common
setup uses Claude Code for interactive sessions (commands, hooks, skill routing)
and Codex for CI workers (skill invocations, phase-assertion hooks). Both write
to the same `.adlc/` workspace and read the same tickets.

Command separation is by design (ADR 0002):
- `adlc <tool>` — gate dispatcher; routes tool invocations and, via reserved
  verbs, phase-assertion commands (`adlc run <phase>`, `adlc accept`).
- `adlc-runner` — the underlying runner binary (`@adlc/runner`); invoked by
  the dispatcher, not called directly in normal workflows.

Formal phase assertions (`adlc run p5`, `adlc accept`) are part of the Codex
surface. See [`codex.md`](./codex.md) and
[ADR 0002](../adr/0002-adlc-command-reconciliation.md) for the full command
reconciliation rationale.

## Gaps

Current gaps relative to the formal ADLC doctrine:

1. **Recording formal `adlc run p5` phase assertion from the CC path is not yet
   wired up end-to-end (narrower than before issue #61).** The independent
   multi-lens loop itself — fan-out, dedupe, verifier refutation, loop-until-dry
   — now runs natively on Claude Code via `/adlc:adlc-prosecute` and the
   `prosecutor-{correctness,security,contract,diff,tests,verifier}` subagents,
   the same shape as the OpenCode integration. What remains unwired is the
   *recording* step: `/adlc:adlc-prosecute`'s default evidence path is `adlc
   gate-manifest record prosecution --files <changed files>`, which carries
   `gate: "prosecution"` and does not by itself satisfy `adlc run p5`. Formal
   assertion requires `@adlc/prosecute`'s `type: "p5-complete"` provenance chain
   (ticket- and revision-bound, transcript hashes, two consecutive dry passes) —
   a harness-agnostic runner path (`adlc prosecute --input <file> --ticket <id>`
   → `adlc run p5`), not exclusive to the Codex integration; any harness that can
   produce the `@adlc/prosecute` input JSON from its own lens findings can drive
   it. There is no example fixture yet for a CC-native run comparable to
   `docs/examples/p5-passes.json`; the Codex fixture remains the authoritative
   reference until one exists.
2. **In-session Bash rail enforcement is absent (intentional).** A shell is
   Turing-complete and cannot be reliably parsed for mutation targets; every
   parser attempted had further bypasses. Rail mutations via Bash are caught at
   commit time by the unbypassable `rails-guard` CI diff gate. See
   [ADR 0003](../adr/0003-adlc-claude-code-plugin.md) for the full rationale.
3. **Skill discovery depends on description matching.** The `adlc` phase router
   is one skill with a broad trigger set, but a poorly-phrased request may not
   match the description and will not route through the lifecycle.
4. **The build-gate active-ticket pointer has no Bash or CI backstop
   (intentional design, partially mitigated).** `.adlc/current-ticket.json`
   is frozen as a rails trust root (same as `.adlc/tickets.json`) whenever
   the ticket set declares ANY rails, so a structured edit that overwrites
   the pointer is denied. But like rails-guard, build-gate's PreToolUse hook
   only matches `Edit|Write|MultiEdit|NotebookEdit` — a Bash command can
   still delete or overwrite `.adlc/current-ticket.json` mid-session (this is
   never gated, trust-root or not), after which `resolveActiveTicketIdForBuildGate`
   sees "no active ticket" and every subsequent structured edit is allowed
   with **zero** risk evaluation and **zero** manifest entry (a strictly
   weaker outcome than even `ADLC_BUILD_GATE_BYPASS=1`, which at least
   requires a durably-recorded gate-manifest entry). A ticket that is
   high-risk without declaring any `rails` (e.g. purely via `category:
   'contract'`) gets no trust-root protection at all. Unlike the rails Bash
   gap (#2 above), this one has **no CI diff backstop**:
   `.adlc/current-ticket.json` is gitignored local session state (see
   `.gitignore`), not a tracked file, so there is no diff for a commit-time
   gate to inspect — and build-gate's degradation signal (transcript
   tool-call depth) can't be reconstructed after the fact anyway. Mitigate by
   treating `.adlc/current-ticket.json` deletion/edits as a reviewable signal
   in your own audit tooling (e.g. session logging), and by not relying on
   build-gate as the sole safeguard for a high-risk ticket — pair it with
   human review at P5/P6.

## Boundary

- `.adlc/` is the runtime state area for tickets, manifests, and gate evidence.
- `.omo/` is for operator planning artifacts (Codex-specific; CC planning files
  currently live under `docs/` by convention).
- The docs in this directory are the high-level map; package READMEs are the
  source of truth for exact flags, schemas, and exit codes.
