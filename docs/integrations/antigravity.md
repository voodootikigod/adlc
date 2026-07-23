# ADLC × Google Antigravity (`agy`)

Native ADLC integration for the Antigravity CLI. Two layers:

1. **In-session rails-guard (advisory).** A `PreToolUse` plugin hook denies edits to
   frozen rails. It is best-effort: agy fails **open** on a non-zero hook exit, so a
   hook crash/timeout/Windows-path failure can let a rail write through.
2. **CI diff gate (the guarantee).** `scripts/rails-guard-ci.mjs` (documented in
   [`docs/ci/rails-guard.yml`](../ci/rails-guard.yml)) is the unbypassable,
   cross-platform control. Make it a required check. **Private-repo / free-plan
   caveat:** on a private repo on GitHub's free plan, the required-status-check
   APIs 403 — see the fallback below.

## Install

> **⚠️ Fail-open, CI is the real backstop.** The in-session `PreToolUse` rail hook
> installed below is **advisory only** — `agy` fails **OPEN** on a non-zero hook
> exit (crash, timeout, unsupported platform), so a frozen-rail write can slip
> through. Do not treat the hook as a hard block. The unbypassable control is the
> CI diff gate (`scripts/rails-guard-ci.mjs`, wired via
> [`docs/ci/rails-guard.yml`](../ci/rails-guard.yml)) — **make it a required
> check** before relying on this integration for enforcement.

**Local Checkout (Recommended/Verified).** Currently, the most reliable way to install the plugin is directly from a local checkout:

```sh
agy plugin install /abs/path/to/adlc/plugins/adlc-antigravity
```

Then run `/adlc-init` inside your agent session (or execute the steps manually to bootstrap `.adlc/` in your repository).

**npm-assisted install.** `agy` has no native `agy install npm:X` command — `agy
plugin install` always takes a filesystem path — but `@adlc/antigravity` is now
published on npm, so you can install it as a normal dependency and point `agy` at
`node_modules`:

```sh
npm install @adlc/antigravity
agy plugin install ./node_modules/@adlc/antigravity
```

**Universal Installer (Planned — Not yet supported).** Support for Google Antigravity inside the vendor-neutral `plugins` installer is currently in development and **not yet present**. Once implemented, you will be able to install it via:

```sh
npx plugins add voodootikigod/adlc
```


**Note on native marketplace:** The native `.agents` marketplace registration command (`agy plugin install adlc-antigravity@adlc`) is currently subject to a CLI limitation where the CLI rejects unregistered third-party marketplaces with `unknown marketplace: adlc`. Local installation is the recommended path.

Then `/adlc-init` (or manual bootstrap). Enforcement: `export ADLC_P4_ENFORCEMENT=1` with an active ticket.

## Formal ADLC Coverage

| Phase | Antigravity surface |
|-------|---------------------|
| P0 Triage | `/adlc-init`, `/adlc-status`, `/adlc-doctor`, `adlc-ticket` skill → `.adlc/tickets.json` |
| P1 Interrogate | `adlc spec-lint/premortem/parallax` via the `adlc` CLI |
| P2 Decompose | `adlc coldstart/model-router/merge-forecast` |
| P3 Rail | **PreToolUse rails-guard hook** (advisory) + **build-gate backstop** + CI gate (guarantee) |
| P4 Build | doctrine skill; **in-session flail tracker** + `adlc flail-detector/consensus-fix` |
| P5 Prosecute | `adlc-prosecutor` skill + **5-lens prosecutor roster** (`contract`, `correctness`, `diff`, `security`, `tests`) + `verifier` |
| P6 Integrate | human gate — `adlc gate-manifest` |
| P7 Distill | `adlc lesson-foundry/rejection-mining` |

## Rail enforcement — two layers

Antigravity's hooks are a **best-effort, in-session** layer, not the control:

1. **In-session (advisory).** The `PreToolUse` hook returns
   `{ "allow_tool": false, "deny_reason": "..." }` on a frozen-rail edit. Antigravity
   *should* block it, but the hook is subject to several fail-open conditions (see
   "Platform notes" below). The hook is configured to fail **open** so a hook
   bug/timeout/incompatibility can never brick your session. Bash/shell writes are
   **not** gated in-session (a Turing-complete shell can't be reliably parsed).

2. **Commit-time (unbypassable).** The real control is the CI rail-freeze gate
   (`scripts/rails-guard-ci.mjs`). It reads the frozen rail set **from the trusted base
   ref** and rejects any PR that edits a path frozen there, regardless of how the edit
   was made. **Make it a required check.**

   **Private-repo / free-plan caveat:** on a private repo on GitHub's free plan,
   both required-status-check mechanisms (`PUT .../branches/main/protection` and
   `POST .../rulesets`) return 403 ("Upgrade to GitHub Pro or make this repository
   public") — you cannot make this gate a required check there, so a maintainer
   can merge past a failing run. Fold the rail-freeze step into your existing
   required CI job instead (e.g. the main test job) — see the "Private-repo
   fallback" sketch at the bottom of
   [`docs/ci/rails-guard.yml`](../ci/rails-guard.yml).

   **Scope limit:** because the rail set is read from the base ref, the gate protects
   rails **already frozen on the base branch**. A PR that *introduces* a new rail
   **and** edits that path in the same PR is **not** caught — first-time rails are
   enforced only once they land on the base branch. Freeze rails in a separate,
   merged commit before the build PR if you need same-PR protection.

## Rail contract

Enforcement is identical to the sibling integrations (the engine is `@adlc/core`,
not re-implemented here):

- Active ticket via `ADLC_TICKET` **or** `.adlc/current-ticket.json` (schema and
  full read semantics: [the active-ticket pointer](../active-ticket-pointer.md)).
  A conflict between the two fails closed (denied) — the active ticket is
  per-worktree state, so parallel work on a second ticket needs its own worktree.
  An unparseable pointer, or an object with no recognized id key, also fails closed.
- Enforcement is phase-scoped to `ADLC_P4_ENFORCEMENT=1`; otherwise no-op.
- Rails in force = the **single** active ticket's `rails` plus the trust-root rails
  `.adlc/tickets.json` and `.adlc/current-ticket.json` (not a union across tickets).
- No-op when the repo is not ADLC-initialized, enforcement is off, or no active
  ticket resolves.
- Symlink aliases whose real target is a frozen rail are resolved and denied.

## Single-ticket projection

The [antigravity-booster](https://github.com/voodootikigod/antigravity-booster)
projects a **single-ticket** `.adlc/tickets.json` into each build worktree: the
worktree sees exactly one ticket — the one it is building — not the whole ticket
graph. This section pins the contract between that projection and the plugin's
fail-closed loader so the two repos cannot drift.

**The contract: the booster must project *edge-free* single-ticket files.** A
ticket in the full graph normally carries `edges[].to` references to sibling
tickets. When a single ticket is projected in isolation, any such edge becomes
**dangling** — it points at a ticket that is no longer present in the file.
`core-inline.mjs` `loadTickets` reports that as `edge to unknown ticket <id>`,
`rails-checker.mjs` `railPreconditions` treats **any** validation error as a
tamper signal and returns `{ state: 'deny' }`, and `checkRail`/`decide` then deny
**every mutating tool call for the whole session** — not just writes to rail
paths. A build worktree in that state cannot edit anything.

**The plugin stays fail-closed by design; it does not repair the trust root.**
Refusing to load a malformed `.adlc/tickets.json` is the correct security posture
(a partially-parseable trust root is exactly where a silent rail-narrowing attack
would hide). So the fix lives on the **booster** side: it must strip `edges` from
the single-ticket projection before writing it into the worktree, producing a
clean file that validates. The plugin does **not** add a special-case that
tolerates dangling edges.

This split is asserted from both sides so it can't regress:

- **Plugin (this repo):** `test/projection.test.mjs` pins both shapes — a clean
  single-ticket projection enforces its rail while allowing in-scope non-rail
  writes, and a dangling-edge projection produces the fail-closed deny-all
  (denying even a non-rail, in-scope write). See
  [antigravity-booster#11](https://github.com/voodootikigod/antigravity-booster/issues/11)
  and [adlc#142](https://github.com/voodootikigod/adlc/issues/142).
- **Booster (antigravity-booster#11):** strips edges from the projection so the
  dangling-edge state never reaches a real build worktree.

## Platform notes / limitations

- **POSIX only in-session** (`$HOME` command path); Windows in-session is unsupported —
  the CI gate protects Windows users regardless.
- Shell (`run_command`) writes are not gated in-session (CI gate catches them).

## Appendix: verified `agy` hook contract (agy 1.0.13)

This appendix documents the native hook contract verified by direct probing. These
facts are the foundation for the in-session rails-guard implementation and belong in
any document describing the integration's enforcement surface.

| # | Fact |
|---|------|
| V1 | agy has a **native plugin system**: `agy plugin install <path>` installs into `~/.gemini/config/plugins/<name>/`. Manifest is Claude-Code-shaped: root `plugin.json` (name, version) + `skills/`, `agents/`, `commands/` (auto-converted to skills), root `hooks.json`. `agy plugin import claude` even ingests Claude Code plugins. |
| V2 | `agy plugin validate` checks component **presence only**, not deep hook schema — it passed a `hooks.json` the runtime later refused to parse. **Validation is not sufficient; runtime load must be tested.** |
| V3 | **hooks.json schema (agy-native)** — verified working: `{ "<hook-name>": { "PreToolUse": [ { "matcher": ".*", "hooks": [ { "type":"command", "command":"<cmd>", "timeout":15 } ] } ] } }`. Top level is keyed by **hook name**, then event, then an **array** of `{matcher, hooks:[handler]}`. |
| V4 | `matcher` is a **regex on the tool name**. `.*` matches all. `write` did **not** match tool `write_to_file` — so use `.*` or exact names. |
| V5 | **Deny contract (INVERTED from Claude Code/Codex):** a hook denies by writing stdout `{"allow_tool": false, "deny_reason": "..."}` and **exiting 0**. `{"allow_tool": true}` allows. **Non-zero exit = hook FAILURE = FAIL-OPEN (tool proceeds).** |
| V6 | Hooks **fire in `agy --print` (headless) mode** — a write to a rail was actually blocked. So rails-guard protects both interactive sessions and the headless fleet path. |
| V7 | **stdin payload** (verbatim): `{"toolCall":{"name":"write_to_file","args":{"TargetFile":"/abs","CodeContent":"…","Overwrite":true}},"workspacePaths":[],"conversationId":…,"transcriptPath":…,"stepIdx":3}`. The path field varies per tool: `write_to_file`→`TargetFile`, `view_file`→`AbsolutePath`, `run_command`→`CommandLine`. Observed target paths were **absolute**. |
| V8 | Hook **cwd is the plugin dir** (`~/.gemini/config/plugins/<name>/`), **not the repo**. In `--print` mode `workspacePaths` was observed **empty (`[]`)**. There is **no workspace-root env var** (env exposes `ANTIGRAVITY_CONVERSATION_ID`, not a workspace path). |
| V9 | agy **expands `$HOME`** (and shell env vars) in the `command` string; there is **no** `${CLAUDE_PLUGIN_ROOT}`/`${AGY_PLUGIN_ROOT}`. Because plugins always install to `$HOME/.gemini/config/plugins/<name>/`, `node $HOME/.gemini/config/plugins/adlc-antigravity/hooks/adlc-rails-guard.mjs` is portable across users with no install-time rewrite. |
