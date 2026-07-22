# ADLC capability × harness matrix

How each native integration implements the ADLC contract, side by side.
Compiled 2026-07-20, **Copilot column re-verified 2026-07-22** from the
integration docs in this directory, the plugin sources under `plugins/`, and —
for Copilot — the probed contract in
[`./copilot-probe-appendix.md`](./copilot-probe-appendix.md) (GitHub Copilot CLI
**1.0.73**, #240), which **overrides** the earlier pre-probe plan.

**Columns:** CC = Claude Code · Codex · OC = OpenCode · Pi · Cursor · agy =
Antigravity · Copilot = **built to, and live-verified against, the corrected
contract** (`plugins/adlc-copilot`; in-session deny-proof DONE, only the
marketplace install convenience smoke still gated on an unrestricted CI account).

**Legend:** ✅ native/enforcing · ⚠️ partial, advisory, or unproven · ❌ absent
· 🧪 planned/unverified. The Copilot column is read from a real binary **and a
live end-to-end deny-proof**; the in-session rail enforcement is verified to work
headless (the deny-ask defaults to deny, overriding `--allow-tool`) except under
`--allow-all-tools`. The only remaining gated item is the marketplace
install/uninstall convenience smoke (`ADLC_COPILOT_LIVE_INSTALL=1`, needs an
unrestricted CI account).

Shared invariants are not repeated per row: every integration delegates
rail/glob/ticket/shell primitives to `@adlc/core` (nothing re-implemented),
resolves the active ticket via `ADLC_TICKET` / `.adlc/current-ticket.json`
(conflict fails closed), scopes enforcement to `ADLC_P4_ENFORCEMENT=1`,
freezes the trust-root files, resolves symlink aliases, and relies on the same
commit-time CI diff gate (`rails-guard-ci.mjs`) as the real control — with the
universal caveat that the CI gate only enforces if actually configured as a
**required** check (impossible on private free-plan repos; fold into an
existing required job instead).

## A. Distribution & install

| Capability | CC | Codex | OC | Pi | Cursor | agy | Copilot |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Native plugin install | ✅ marketplace | ✅ git marketplace | ⚠️ npm pkg registered in `opencode.json` by scaffolder (no marketplace) | ✅ `pi install npm:@adlc/pi` | ✅ marketplace (publish step pending) | ⚠️ local-path only (3rd-party marketplace rejected by CLI) | ✅ `copilot plugin marketplace add voodootikigod/adlc` + `copilot plugin install adlc-copilot@adlc` (marketplace shape verified; live install smoke pending) |
| `npx plugins add` universal-installer target | ✅ | ✅¹ | ❌ | ❌ | ✅ | ❌ (planned) | ✅ (target exists) |
| Install smoke script in CI | ✅ offline | ✅ offline + live | ✅ offline + live matrix | ✅ live + weekly version matrix | ✅ offline | ✅ offline | ⚠️ offline built; marketplace install smoke gated on `ADLC_COPILOT_LIVE_INSTALL=1` (unrestricted CI account); in-session deny-proof DONE |

¹ A `plugins`-installer Codex target exists, but the adlc docs recommend the native Codex marketplace path.

## B. In-session rail enforcement (P3/P4)

| Capability | CC | Codex | OC | Pi | Cursor | agy | Copilot |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Structured-edit deny (Write/Edit) | ✅ enforcing | ✅ enforcing | ✅ enforcing by default | ✅ enforcing | ⚠️ deny emitted; host reliability unproven (the GA gate) | ⚠️ advisory (host fails open) | ✅ **enforces headless** — live-verified 1.0.73: non-empty `{reason}` stdout + exit 0 raises a permission ask that defaults to DENY and overrides `--allow-tool` (**not** `permissionDecision`/exit 2). **Except** `--allow-all-tools`/`--yolo` auto-approves the ask (neuters the hook) |
| Hook-crash failure mode | ⚠️ fail-open (only exit 2 blocks) | ⚠️ same convention² | ✅ fail-closed (throw aborts; unknown mutating tool denied) | ⚠️ n/d² | ⚠️ fail-open by config (`failClosed:false`) | ⚠️ fail-open (verified: non-zero exit ⇒ tool proceeds) | ⚠️ fail-open on crash only (verified: `success===false` ⇒ no ask raised ⇒ tool proceeds); adapter converts internal errors → deny, but OS-kill / `timeoutSec` remain open. (`--allow-all-tools` is the other fail-open window — see row above) |
| Shell (Bash) gating in-session | ❌ intentional (CI catches) | ✅ shell classifier (vendored core copy, sync-pinned) | ✅ classifier + chained-command splitting | ✅ codex-parity ladder | ⚠️ advisory string-match, never denies | ❌ | ⚠️ rails-guard hook's shell classifier blocks shell writes to rails (live-verified: a `printf > railfile` workaround was blocked); no general shell gating (CI catches); fleet option `--deny-tool shell` removes shell entirely |
| Reactive write-restore backstop (tool-independent) | ❌ | ❌ | ✅ `file.edited` quarantine-restore | ✅ pre-tool snapshot restore (never `HEAD`) | ⚠️ `afterFileEdit` audit only, no restore | ❌ | ❌ (no equivalent event known) |
| Build-gate (context-rot backstop) | ✅ enforcing | ✅ hook shipped | ✅ + disables post-compaction autocontinue | ✅ | ⚠️ advisory, default-off | ❌ | ⚠️ hook shipped but **inert** — Copilot exposes no session transcript, so context-fitness can't be measured; fires only if Copilot adds one (see copilot.md Gaps e) |

² CC's documented hook semantics: non-2 exit codes are non-blocking. Codex and Pi crash behavior is not pinned in this repo's docs — treat as unverified rather than assumed safe. Copilot's fail-open is now **verified** against 1.0.73.

## C. Context defense

| Capability | CC | Codex | OC | Pi | Cursor | agy | Copilot |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Ticket context re-injection | ✅ 5 events (SessionStart/PreCompact/PostCompact/Subagent*/Stop) | ✅ 8 events | ✅ per-turn system transform + rail names in tool descriptions | ✅ per-turn system-prompt append | ⚠️ `beforeSubmitPrompt` ships; narrower scope | ❌ (PreToolUse only) | ⚠️ 4 events wired (`sessionStart`/`preCompact`/`subagentStart`/`subagentStop`), advisory narration — the `additionalContext` ingestion shape is **bundle-derived, not live-confirmed** (appendix §1.4); a wrong shape degrades to a silent no-op |
| Compaction survival defense | ✅ | ✅ | ✅ compaction-prompt append + autocontinue disable | ✅ | ❌ | ❌ | ⚠️ `preCompact` wired (advisory; `additionalContext` ingestion bundle-derived, not live-confirmed) |
| Flail detection | ✅ advisory | ✅ failure-signature recorder | ✅ advisory | ✅ | ✅ reminder | ❌ | ✅ advisory (`postToolUse`) |
| Live ticket statusline/footer | ❌ | ❌ | ✅ toast statusline | ✅ footer pill + verdict widget | ❌ | ❌ | ❌ |

## D. P5 prosecution

| Capability | CC | Codex | OC | Pi | Cursor | agy | Copilot |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 5-lens + verifier fresh-context fan-out | ✅ subagents | ✅ 6 agent TOMLs | ✅ isolated child sessions | ✅ child sessions (shared core lens roster) | ⚠️ sequential, one context (weakest independence) | ⚠️ single `prosecutor` agent, deterministic gates only | ⚠️ six read-only agents shipped; live in-session fan-out unproven (text-only `-p`) — `adversarial-review` fallback |
| Deterministic first-party P5 runner (code loop, not prose) | ⚠️ model-driven command; helpers unit-tested | ⚠️ MCP `adlc_prosecute` workflow | ✅ native tool (most deterministic of the six) | ✅ native tool | ❌ | ❌ | ⚠️ MCP `adlc_prosecute` + `@adlc/core` helpers (reference-equal shim) |
| Read-only enforcement on lenses | ✅ read-only tool lists | ✅ read-only TOMLs | ✅ wildcard-deny-first tools map | ✅ write-disabled children | ❌ | ⚠️ | ✅ read-only agent allowlists |
| Formal `adlc run p5` provenance | ⚠️ CLI runner path, not wired e2e | ✅ authoritative fixture | ⚠️ runner path | ⚠️ runner path | ⚠️ runner path | ⚠️ runner path | ⚠️ runner path |
| P5 live proof in CI | ❌ | ⚠️ (install/hook/MCP live proof; not a deny/convergence proof) | ✅ seeded-defect convergence + write-disable, required | ✅ required (Node 22 leg) | ❌ | ❌ | ❌ (no seeded-defect P5 convergence proof in CI; the rail deny-proof is DONE) |

## E. Gate access

| Capability | CC | Codex | OC | Pi | Cursor | agy | Copilot |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Model-callable gate tool | ✅ MCP (`adlc_gate`/`adlc_prosecute`) | ✅ MCP | ✅ native plugin tool | ✅ native tool | ❌ commands only | ❌ skill/CLI only | ✅ MCP (`adlc_gate`/`adlc_prosecute`) via `.mcp.json` → `adlc mcp-server`; headless-MCP caveat #633 |
| Keyless LLM-backed gates | ✅ `--prompt-only` | ✅ `--prompt-only` | ✅ live keyless child-session bridge | ✅ keyless via session model | ✅ `--prompt-only` | ✅ `--prompt-only` | ✅ `--prompt-only` |
| Commands / phase suite | ✅ `/adlc:*` (5) | ✅ `$adlc*` skills (6) | ✅ `/adlc-*` full suite | ✅ `/adlc-*` + `/ticket` + accept/rollback | ✅ `/adlc-*` full suite | ⚠️ commands auto-convert to skills | ✅ skills suite (`adlc`, `adlc-init`, `adlc-ticket`, `adlc-prosecute`, `adlc-distill`, `adlc-maintain`) |

## F. Headless & fleet

| Capability | CC | Codex | OC | Pi | Cursor | agy | Copilot |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Fleet worker adapter | ✅ | ✅ | ✅ | ✅ | ✅ (`cursor-agent -p`) | ✅ | ✅ `copilot -p` (text output only — no JSON mode; **defaults to explicit `--allow-tool write --allow-tool shell`, NOT `--allow-all-tools`**, so the rails-guard hook keeps enforcing; `allowAllTools:true` is an opt-in for CI-gate-only autonomy) |
| Headless in-session enforcement verified | ❌ not exercised | ⚠️ hook execution proven from installed cache | ✅ headless live-deny in CI | ✅ `pi --mode rpc` live-deny in CI | ❌ | ✅ probed (`--print` blocked a rail write) | ✅ **live deny-proof DONE** (real `copilot -p` turns vs a frozen rail on 1.0.73 blocked the edit under the explicit allowlist; proceeded only under `--allow-all-tools`), re-runnable via `scripts/copilot-live-deny.mjs`, wired as a **daily scheduled drift canary** (`copilot-live-canary.yml`); default per-PR CI proves deny-*shape* only, so re-run after CLI upgrades |

## G. Governance

| Capability | CC | Codex | OC | Pi | Cursor | agy | Copilot |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Unbypassable commit-time CI gate | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ the **unbypassable hard tier** for Copilot (`rails-guard-ci`), covering both fail-open windows (hook crash and `--allow-all-tools`); the in-session hook otherwise enforces headless |
| Admin/org-level in-session enforcement | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ⚠️ `strictKnownMarketplaces` present in 1.0.73; `policy.d` machine-hook tier **not found** in this build — deferred/unverified |

## Reading the matrix — tiers

1. **OpenCode & Pi — deepest deterministic enforcement.** Both gate shell
   in-session, carry a reactive restore backstop, run P5 as first-party code
   with write-disabled fresh contexts, and prove the deny live in required CI.
   OpenCode edges ahead on fail-closed posture (unknown mutating tools denied);
   Pi on TUI-native surface (footer pill, accept/rollback commands).
2. **Codex & Claude Code — full surface, weaker proofs.** Complete hook/agent/
   MCP coverage; Codex adds shell gating and the only formal `adlc run p5`
   fixture. CC's gaps: no shell gating (intentional), no live deny proof in CI,
   fail-open hook crashes.
3. **Cursor & Antigravity — advisory in-session tier, CI-gate as the real
   control.** Both have a **fail-open** in-session host contract, so the
   commit-time CI gate is the enforcement tier:
   - **Cursor** — full command suite, but the deny's host reliability is the open
     GA gate and P5 runs in one context.
   - **Antigravity** — fail-open host, single-lens P5, no build-gate or context
     defense; leans hardest on the CI gate (by design).

4. **Copilot — enforces headless (live-verified), CI-gate as the unbypassable
   hard tier.** **Built to, and live-verified against, the corrected 1.0.73
   contract — not the pre-probe plan.** The in-session `preToolUse` hook's
   `{reason}` deny (non-empty object on stdout at exit 0 — **not**
   `permissionDecision`, **not** exit 2) is a permission **ask** that, headless,
   **defaults to DENY and blocks the tool, overriding the `--allow-tool`
   allowlist** (proven live: real `copilot -p` turns left the rail file
   unchanged). So it is **stronger than Cursor/agy's advisory tier — but not
   "strongest of the seven,"** because it has exactly two fail-open windows:
   `--allow-all-tools`/`--yolo` (auto-approves the ask, neutering the hook) and a
   crashed/killed/timed-out hook (no ask raised — appendix §1.1/§1.2). The fleet
   adapter therefore defaults to an explicit `--allow-tool` allowlist, never
   `--allow-all-tools`, and the CI diff gate (`rails-guard-ci`) is the
   unbypassable hard tier covering both windows. Full context/skill/MCP/agent
   surface is wired; the live deny-proof is DONE and only the marketplace install
   convenience smoke stays gated on an unrestricted CI account. Distinctive: the
   `--deny-tool shell` fleet option (verified) removes shell entirely, and a
   machine `policy.d` tier is **deferred** (`policy.d` not found in 1.0.73).

## Maintenance note

Update this file when an integration ships a capability change (the same PR
that changes `plugins/<harness>/` or its integration doc). The Copilot column is
pinned to [`./copilot-probe-appendix.md`](./copilot-probe-appendix.md); the
in-session deny-proof is DONE, so the remaining ⚠️ cell is the marketplace
install/uninstall convenience smoke — flip it to ✅ only after the
`ADLC_COPILOT_LIVE_INSTALL=1` proof runs in an unrestricted CI account.
