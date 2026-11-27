# Intent: Post-v1.13 Deferred Architecture & Consolidation Roadmap

**Status:** queued roadmap (post-Wave 0–2 surgical hardening).
**Date:** 2026-11-27
**Evaluated against:** ADLC @ `v1.13.0` (`443fe00`, 35 workspace packages, 8 plugins)

---

## Context

During the post-`v1.13.0` adversarial architectural review, we intentionally separated **surgical Wave 0–2 hardening** (model-aware `agy` provider identity, dual-era Ed25519 manifest signing & zero-secret verification, and compiling `@adlc/gemini` from a hardened `@adlc/hook-engine` to retire `6,469` LOC of inline forks) from **five larger structural initiatives** whose blast radius warrants dedicated design, ceremony, or lockstep release waves.

 Note also: Google transitioned **Gemini CLI** into **Antigravity CLI (`agy`)**, rebranding extensions as Antigravity plugins; `@adlc/gemini` (`plugins/adlc-gemini`) therefore remains the single unified integration for `agy` and `jetski` rather than splitting into two packages.

---

## Queued Initiatives (Recommended Execution Order)

| Priority | Initiative | Issue | Primary Surface | Prerequisite / Ceremony |
|---|---|---|---|---|
| 1 (`P1-high`) | **Enroll `.adlc/admin.pub` & sunset symmetric `ADLC_MANIFEST_KEY`** | [#1431](https://github.com/voodootikigod/adlc/issues/1431) | `.adlc/admin.pub`, CI secrets, `@adlc/gate-manifest` | Wave 0–2 Ed25519 support merged + `#141` `trust-root-change` CODEOWNER ceremony |
| 2 (`P1-high`) | **Archive ~600 shipped shards in `.adlc/tickets/` & add O(1) active-rail index** | [#1430](https://github.com/voodootikigod/adlc/issues/1430) | `.adlc/tickets/`, `.adlc/ticket-archive/`, `@adlc/tickets` | Protected-base archive ceremony (cf. `#308`) |
| 3 (`P2-medium`) | **Migrate remaining 5 harness plugins onto `@adlc/hook-engine` (`T-P21b`) & retire `generate.mjs`** | [#1429](https://github.com/voodootikigod/adlc/issues/1429) | `plugins/adlc-{claude-code,codex,copilot,opencode,pi,cursor}`, `scripts/build-hooks.mjs` | Wave 0–2 `@adlc/gemini` bundle pattern proven in CI |
| 4 (`P2-medium`) | **First-class artifact `--input <file>` mode for P1 spec & P3 rail-set review (`ADR-0008`)** | [#1432](https://github.com/voodootikigod/adlc/issues/1432) | `@adlc/prosecute`, `@adlc/runner`, `scripts/router/router-model.mjs` | Coordinate revision/input binding with `#1278` and `#1099` |
| 5 (`P2-medium`) | **Consolidate 35 workspace packages into ~12 domain packages (preserving `adlc <verb>` CLI)** | [#1428](https://github.com/voodootikigod/adlc/issues/1428) | `packages/*`, `scripts/release.mjs`, `docs/` | Initiatives 2–3 complete to minimize cross-package merge churn; major-version npm deprecation plan |

---

## Initiative Summaries

### 1. Full Ed25519 Key Enrollment & `ADLC_MANIFEST_KEY` Sunset ([#1431](https://github.com/voodootikigod/adlc/issues/1431))

Wave 0–2 lands dual-era Ed25519 signing (`ADLC_MANIFEST_PRIVATE_KEY`) and zero-secret `.adlc/admin.pub` verification (`--trusted-dir "$GITHUB_WORKSPACE/.adlc"` in `cross-model-gate.yml`). Once merged:
1. Run `adlc gate-manifest generate-key --ed25519 --output <outside-repo-path> --public-output <pub-path>` with interactive TTY custody confirmation.
2. Open a dedicated `#141` trust-root PR committing `.adlc/admin.pub` with `trust-root-change` and non-author CODEOWNER approval.
3. Configure `ADLC_MANIFEST_PRIVATE_KEY` only in the trusted attestation-minting environment, delete `ADLC_MANIFEST_KEY` from GitHub Actions secrets and local `.env.local` files, and deprecate new HMAC minting in the next major release.

### 2. Ticket Store Archive Sweep & O(1) Hook Startup Index ([#1430](https://github.com/voodootikigod/adlc/issues/1430))

`.adlc/tickets/` currently holds **604 unarchived JSON shards** (`0` marked `completed: true`, `0` with active `rails`), forcing read-only hook invocations to scan and parse 604 files per check. A protected-base archive sweep (`adlc ticket-prune` / `adlc-tickets archive`) paired with post-merge completion automation and a hash-verified active-rail projection reduces hook cold reads from O(N) over historical tickets to O(1).

### 3. Complete `T-P21b` Hook-Engine Migration Across Remaining Harnesses ([#1429](https://github.com/voodootikigod/adlc/issues/1429))

After `plugins/adlc-gemini` compiles cleanly from `@adlc/hook-engine`, migrate `adlc-claude-code`, `adlc-codex`, `adlc-copilot`, `adlc-opencode`, `adlc-pi`, and the remaining `adlc-cursor` wrappers onto `scripts/build-hooks.mjs`, drain `PENDING_CONVERSION` in `scripts/test/hook-spawn-timeout-drift.test.mjs`, and retire `scripts/ticket-readers/generate.mjs`.

### 4. First-Class Artifact `--input` Review at P1 & P3 ([#1432](https://github.com/voodootikigod/adlc/issues/1432))

Close the `ADR-0008` follow-on so P1 specifications and P3 declared rail sets can be reviewed directly via `--input <file>` (bound to canonical artifact SHA-256 + base revision) rather than manual `--prompt-only` workflows.

### 5. Workspace Package Consolidation (`35 → ~12` Packages) ([#1428](https://github.com/voodootikigod/adlc/issues/1428))

Roughly `31,500` source LOC live across disconnected or single-verb packages (`@adlc/context-handoff` per `#966`, `@adlc/decision-layer`, `@adlc/model-ratchet`, `@adlc/backlog-groom`, `@adlc/merge-forecast`). Fold single-verb packages behind ~12 domain workspaces while keeping every `adlc <verb>` CLI command, flag, and exit code 100% compatible, reducing lockstep OIDC publish surface and tarball maintenance overhead.
