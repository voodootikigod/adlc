# Spec: Cursor native-integration parity (T16–T19)

**Goal:** make the ADLC integration into Cursor as robust, feature-complete, and
native-feeling as the Claude Code and OpenCode integrations, using only Cursor's
native surfaces (`.cursor/commands/*.md`, `.cursor/rules/*.mdc`,
`.cursor/hooks.json`), with honesty about what each surface can and cannot
guarantee (ADR-0006 discipline).

**Baseline (reviewed 2026-07-05):** the Cursor plugin is the rails-guard MVP from
ADR-0006 — a hardened `preToolUse` rails guard, an observational `afterFileEdit`
audit, one generated discovery rule, one command (`/adlc-init`) that the
scaffolder never actually deploys, and a scaffolder. Every capability added to
the toolkit since (build-gate, adversarial-review triggers, verdict recording,
ticket-prune, prosecutor loops) is absent.

## Tickets

- **T16** — scaffolder deploys `.cursor/commands/` (bug fix) + 8-command phase
  suite + router regeneration.
- **T17** — extract the byte-duplicated prosecutor convergence lib to
  `@adlc/core` (issue-#97 pattern), then the full `/adlc-prosecute` sequential
  multi-lens loop for Cursor.
- **T18** — hook parity: `buildgate` (preToolUse), `flail` (afterFileEdit
  piggyback), `stop-audit` + `preflight` (only if events pin against current
  Cursor docs; otherwise shipped disabled with ADR TODO), advisory-only
  `beforeShellExecution` rail notice.
- **T19** — truth sweep: ADR-0006, `docs/integrations/cursor.md`, smoke script,
  `apps/docs` cursor page.

Dependency order: T16 → {T17, T18} → T19. T17 and T18 are parallelizable after
T16 lands (disjoint scopes except `scripts/cursor-install-smoke.mjs`, which T17
touches and T19 finalizes).

## Design decisions (binding)

1. **Bare command form.** Cursor has no plugin-namespace convention; commands
   are `/adlc-<name>`, never `/adlc:adlc-<name>`. The claude-code-plugin-smoke
   bare-command guard scans only CC surfaces, so no conflict.
2. **No third prosecutor copy.** The convergence logic ships once, in
   `packages/core/lib/prosecutor.mjs`; both existing plugins become re-export
   shims with reference-equality delegation tests in NEW test files (existing
   per-plugin prosecutor test files are frozen rails and must pass unchanged).
3. **Sequential lenses, honestly labeled.** Cursor has no subagent fan-out. The
   `/adlc-prosecute` loop runs the five lenses sequentially in one context
   and must state that this has weaker independence than the siblings'
   fresh-context fan-out, recommending `npx adversarial-review --providers`
   for the cross-model risk gate — enforced by a caveat-string assertion in
   `scripts/cursor-install-smoke.mjs` (T17 AC5).
4. **No invented hook events.** `stop` / `beforeSubmitPrompt` are wired only if
   verified against current Cursor documentation and pinned in ADR-0006 (same
   discipline as the original preToolUse pinning). Unverifiable events ship
   disabled-by-default with a documented enable flag and an ADR TODO.
5. **buildgate delegates to `@adlc/build-gate`.** No KEEP-IN-SYNC hand-copy:
   Cursor hooks resolve workspace deps (rails-checker already imports
   `@adlc/core`), so the hook imports the real package. Context-fitness depth
   comes from a hook-persisted `.adlc/` tool-call counter or
   `ADLC_BUILD_GATE_DEPTH`, with the proxy's weakness documented.
6. **Advisory means advisory.** `beforeShellExecution` and `afterFileEdit`
   modes never deny; `buildgate` mirrors rails' best-effort deny with
   `failClosed: false`; the unbypassable control remains the CI rail-freeze
   gate. No doc may overstate this.

## Acceptance criteria

Consolidated; each ticket's ACs are authoritative and more granular.

- AC-S1: `scaffold()` deploys every `plugins/adlc-cursor/command/*.md` into
  `.cursor/commands/`, idempotently. Verified via
  `node --test plugins/adlc-cursor/test/scaffold.test.mjs`.
- AC-S2: the 8-command suite exists with valid frontmatter and the generated
  router references it. Verified via `node scripts/cursor-install-smoke.mjs .`
  and `node scripts/router/gen-routers.mjs --check`.
- AC-S3: exactly one prosecutor implementation exists repo-wide, in
  `packages/core/lib/prosecutor.mjs`. Verified via
  `node --test packages/core/test/prosecutor.test.mjs` plus the two new
  delegation tests, with frozen sibling prosecutor tests passing unchanged
  (`git diff --stat` on those files is empty).
- AC-S4: buildgate denies/allows/bypass-audits correctly, importing
  `@adlc/build-gate`. Verified via
  `node --test plugins/adlc-cursor/test/build-gate.test.mjs`.
- AC-S5: no unverified hook event is wired; ADR-0006 records pinned facts or
  disabled-mode TODOs. Verified by ADR diff review and hooks.json assertions in
  the smoke script.
- AC-S6: all documentation surfaces match shipped reality, enforced where
  possible by `scripts/cursor-install-smoke.mjs` string assertions. Verified via
  `node scripts/cursor-install-smoke.mjs .` and `cd apps/docs && npm run build`.
- AC-S7: zero regressions: full `npm test` exits 0; claude-code, opencode, and
  antigravity smoke scripts exit 0; frozen rails untouched, verified by
  `node scripts/rails-guard-ci.mjs origin/main` exiting 0 before each merge.

## Rails (frozen for this build)

Union across tickets — the per-ticket `rails` arrays in `.adlc/tickets.json`
are authoritative per active ticket:

- `packages/core/lib/tickets.mjs`, `packages/core/lib/scaffold-hygiene.mjs`,
  `packages/core/lib/risk-tier.mjs` — the shared engine this work builds on.
- `plugins/adlc-cursor/hooks/adlc-rails-guard.mjs`,
  `plugins/adlc-cursor/rails-checker.mjs`,
  `plugins/adlc-cursor/test/rails-guard.test.mjs` — the hardened threat-model
  surface must not regress while surrounding capability is added.
- `plugins/adlc-claude-code/lib/test/prosecutor.test.mjs`,
  `plugins/adlc-opencode/test/prosecutor.test.mjs` — characterization rails for
  the T17 extraction.
- `packages/build-gate/**` — consumed, never modified.

## Out of scope

- Publishing `@adlc/cursor-package` to npm (release-process work).
- Live deny-proof against a real Cursor binary (remains the GA gate per
  ADR-0006; nothing here claims it).
- Shell-write *blocking* (advisory only, by design).
- MCP-based integration surfaces.
