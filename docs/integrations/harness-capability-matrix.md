# ADLC capability × harness matrix

How each native integration implements the ADLC contract, side by side.
Compiled 2026-07-20, **Copilot column re-verified 2026-07-22** from the
integration docs in this directory, the plugin sources under `plugins/`, and —
for Copilot — the probed contract in
[`./copilot-probe-appendix.md`](./copilot-probe-appendix.md) (GitHub Copilot CLI
**1.0.73**, #240), which **overrides** the earlier pre-probe plan.

**Columns:** CC = Claude Code · Codex · OC = OpenCode · Pi · Cursor · agy =
Antigravity · Copilot = **built to the verified contract** (`plugins/adlc-copilot`;
one live end-to-end smoke still outstanding).

**Legend:** ✅ native/enforcing · ⚠️ partial, advisory, or unproven · ❌ absent
· 🧪 planned/unverified. The Copilot column is now read from a real binary; the
only remaining 🧪 is the end-to-end live install/deny smoke, which an org
Copilot policy blocked in the probe environment (must run behind
`ADLC_COPILOT_LIVE_INSTALL=1` in an unrestricted account).

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
| Install smoke script in CI | ✅ offline | ✅ offline + live | ✅ offline + live matrix | ✅ live + weekly version matrix | ✅ offline | ✅ offline | ⚠️ offline built; live gated on `ADLC_COPILOT_LIVE_INSTALL=1` (org policy blocked the probe) |

¹ A `plugins`-installer Codex target exists, but the adlc docs recommend the native Codex marketplace path.

## B. In-session rail enforcement (P3/P4)

| Capability | CC | Codex | OC | Pi | Cursor | agy | Copilot |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Structured-edit deny (Write/Edit) | ✅ enforcing | ✅ enforcing | ✅ enforcing by default | ✅ enforcing | ⚠️ deny emitted; host reliability unproven (the GA gate) | ⚠️ advisory (host fails open) | ⚠️ deny emitted via non-empty `{reason}` stdout + exit 0 (verified 1.0.73; **not** `permissionDecision`/exit 2); host fails open — advisory |
| Hook-crash failure mode | ⚠️ fail-open (only exit 2 blocks) | ⚠️ same convention² | ✅ fail-closed (throw aborts; unknown mutating tool denied) | ⚠️ n/d² | ⚠️ fail-open by config (`failClosed:false`) | ⚠️ fail-open (verified: non-zero exit ⇒ tool proceeds) | ⚠️ fail-open (verified: `success===false` ⇒ undefined ⇒ tool proceeds); adapter converts internal errors → deny, but OS-kill / `timeoutSec` remain open |
| Shell (Bash) gating in-session | ❌ intentional (CI catches) | ✅ shell classifier (vendored core copy, sync-pinned) | ✅ classifier + chained-command splitting | ✅ codex-parity ladder | ⚠️ advisory string-match, never denies | ❌ | ❌ in-session (CI catches); verified fleet option `--deny-tool shell` removes shell entirely |
| Reactive write-restore backstop (tool-independent) | ❌ | ❌ | ✅ `file.edited` quarantine-restore | ✅ pre-tool snapshot restore (never `HEAD`) | ⚠️ `afterFileEdit` audit only, no restore | ❌ | ❌ (no equivalent event known) |
| Build-gate (context-rot backstop) | ✅ enforcing | ✅ hook shipped | ✅ + disables post-compaction autocontinue | ✅ | ⚠️ advisory, default-off | ❌ | ⚠️ advisory hook shipped (fail-open host) |

² CC's documented hook semantics: non-2 exit codes are non-blocking. Codex and Pi crash behavior is not pinned in this repo's docs — treat as unverified rather than assumed safe. Copilot's fail-open is now **verified** against 1.0.73.

## C. Context defense

| Capability | CC | Codex | OC | Pi | Cursor | agy | Copilot |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Ticket context re-injection | ✅ 5 events (SessionStart/PreCompact/PostCompact/Subagent*/Stop) | ✅ 8 events | ✅ per-turn system transform + rail names in tool descriptions | ✅ per-turn system-prompt append | ⚠️ `beforeSubmitPrompt` ships; narrower scope | ❌ (PreToolUse only) | ✅ 4 events (`sessionStart`/`preCompact`/`subagentStart`/`subagentStop`), advisory narration |
| Compaction survival defense | ✅ | ✅ | ✅ compaction-prompt append + autocontinue disable | ✅ | ❌ | ❌ | ✅ `preCompact` wired |
| Flail detection | ✅ advisory | ✅ failure-signature recorder | ✅ advisory | ✅ | ✅ reminder | ❌ | ✅ advisory (`postToolUse`) |
| Live ticket statusline/footer | ❌ | ❌ | ✅ toast statusline | ✅ footer pill + verdict widget | ❌ | ❌ | ❌ |

## D. P5 prosecution

| Capability | CC | Codex | OC | Pi | Cursor | agy | Copilot |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 5-lens + verifier fresh-context fan-out | ✅ subagents | ✅ 6 agent TOMLs | ✅ isolated child sessions | ✅ child sessions (shared core lens roster) | ⚠️ sequential, one context (weakest independence) | ⚠️ single `prosecutor` agent, deterministic gates only | ⚠️ six read-only agents shipped; live in-session fan-out unproven (text-only `-p`) — `adversarial-review` fallback |
| Deterministic first-party P5 runner (code loop, not prose) | ⚠️ model-driven command; helpers unit-tested | ⚠️ MCP `adlc_prosecute` workflow | ✅ native tool (most deterministic of the six) | ✅ native tool | ❌ | ❌ | ⚠️ MCP `adlc_prosecute` + `@adlc/core` helpers (reference-equal shim) |
| Read-only enforcement on lenses | ✅ read-only tool lists | ✅ read-only TOMLs | ✅ wildcard-deny-first tools map | ✅ write-disabled children | ❌ | ⚠️ | ✅ read-only agent allowlists |
| Formal `adlc run p5` provenance | ⚠️ CLI runner path, not wired e2e | ✅ authoritative fixture | ⚠️ runner path | ⚠️ runner path | ⚠️ runner path | ⚠️ runner path | ⚠️ runner path |
| P5 live proof in CI | ❌ | ⚠️ (install/hook/MCP live proof; not a deny/convergence proof) | ✅ seeded-defect convergence + write-disable, required | ✅ required (Node 22 leg) | ❌ | ❌ | ❌ (live smoke pending — Gap d) |

## E. Gate access

| Capability | CC | Codex | OC | Pi | Cursor | agy | Copilot |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Model-callable gate tool | ✅ MCP (`adlc_gate`/`adlc_prosecute`) | ✅ MCP | ✅ native plugin tool | ✅ native tool | ❌ commands only | ❌ skill/CLI only | ✅ MCP (`adlc_gate`/`adlc_prosecute`) via `.mcp.json` → `adlc mcp-server`; headless-MCP caveat #633 |
| Keyless LLM-backed gates | ✅ `--prompt-only` | ✅ `--prompt-only` | ✅ live keyless child-session bridge | ✅ keyless via session model | ✅ `--prompt-only` | ✅ `--prompt-only` | ✅ `--prompt-only` |
| Commands / phase suite | ✅ `/adlc:*` (5) | ✅ `$adlc*` skills (6) | ✅ `/adlc-*` full suite | ✅ `/adlc-*` + `/ticket` + accept/rollback | ✅ `/adlc-*` full suite | ⚠️ commands auto-convert to skills | ✅ skills suite (`adlc`, `adlc-init`, `adlc-ticket`, `adlc-prosecute`, `adlc-distill`, `adlc-maintain`) |

## F. Headless & fleet

| Capability | CC | Codex | OC | Pi | Cursor | agy | Copilot |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Fleet worker adapter | ✅ | ✅ | ✅ | ✅ | ✅ (`cursor-agent -p`) | ✅ | ✅ `copilot -p` (text output only — no JSON mode; requires `--allow-all-tools`) |
| Headless in-session enforcement verified | ❌ not exercised | ⚠️ hook execution proven from installed cache | ✅ headless live-deny in CI | ✅ `pi --mode rpc` live-deny in CI | ❌ | ✅ probed (`--print` blocked a rail write) | ❌ not exercised (live smoke pending — Gap d) |

## G. Governance

| Capability | CC | Codex | OC | Pi | Cursor | agy | Copilot |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Unbypassable commit-time CI gate | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ the **enforcement tier** for Copilot (`rails-guard-ci`); the in-session hook is advisory only |
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
3. **Cursor, Antigravity & Copilot — advisory in-session tier, CI-gate as the
   real control.** All three have a **fail-open** in-session host contract, so
   the commit-time CI gate is the enforcement tier:
   - **Cursor** — full command suite, but the deny's host reliability is the open
     GA gate and P5 runs in one context.
   - **Antigravity** — fail-open host, single-lens P5, no build-gate or context
     defense; leans hardest on the CI gate (by design).
   - **Copilot** — **built to the verified 1.0.73 contract, not the pre-probe
     plan.** The in-session hook is **fail-open** (a crashed / killed / timed-out
     hook applies no deny — appendix §1.2), the **same tier as Cursor/agy, not
     "stronger."** Deny is a non-empty `{reason}` object on stdout at exit 0
     (**not** `permissionDecision`, **not** exit 2). Full context/skill/MCP/agent
     surface is wired and the adapter converts internal errors to denies, but an
     OS-kill or `timeoutSec` timeout is a genuine fail-open window, and the
     end-to-end live deny smoke is still outstanding (blocked by org policy in the
     probe). Distinctive-but-unconfirmed: the `--deny-tool shell` fleet option
     (verified) removes shell entirely, and a machine `policy.d` tier is
     **deferred** (`policy.d` not found in 1.0.73).

## Maintenance note

Update this file when an integration ships a capability change (the same PR
that changes `plugins/<harness>/` or its integration doc). The Copilot column is
pinned to [`./copilot-probe-appendix.md`](./copilot-probe-appendix.md); flip the
outstanding 🧪/⚠️ live-smoke cells to ✅ only after the end-to-end
`ADLC_COPILOT_LIVE_INSTALL=1` proof runs in an unrestricted account.
