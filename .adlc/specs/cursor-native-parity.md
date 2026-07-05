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
T16 lands, EXCEPT that all four tickets scope
`scripts/cursor-install-smoke.mjs` (round-2 review correction — the earlier
"only T17 touches it" claim was false). Smoke edits are append-style
assertions; T17/T18 merges are sequenced (whichever lands second rebases the
smoke additions), and T19 finalizes.

## Design decisions (binding)

1. **Bare command form.** Cursor has no plugin-namespace convention; commands
   are `/adlc-<name>`, never `/adlc:adlc-<name>`. CAUTION (design-review
   finding): the claude-code-plugin-smoke bare-command guard does NOT scan
   only CC surfaces — its doc-wide scan (#96) covers every `.md` under
   `docs/` plus `README.md`, against command names that collide with the new
   cursor commands. `plugins/adlc-cursor/**` and `apps/docs/**/*.mdx` are not
   scanned, and `docs/integrations/cursor.md` + ADR-0006 are already in
   `EXCLUDED_DOC_PATHS`. Binding rule: bare `/adlc-*` cursor references may
   appear ONLY in unscanned or already-excluded paths; T19 must not add them
   to `README.md`/`docs/README.md` unless it also adds the path to
   `EXCLUDED_DOC_PATHS` with a reviewed reason.
2. **No third prosecutor copy.** The convergence logic ships once, in
   `packages/core/lib/prosecutor.mjs`; both existing plugins become re-export
   shims with reference-equality delegation tests in NEW test files (existing
   per-plugin prosecutor test files are frozen rails and must pass unchanged).
3. **Sequential lenses, honestly labeled.** Cursor has no subagent fan-out. The
   `/adlc-prosecute` loop runs the five lenses sequentially in one context
   and must state that this has weaker independence than the siblings'
   fresh-context fan-out, recommending `npx adversarial-review --providers`
   for the cross-model risk gate — enforced by a caveat-string assertion in
   `scripts/cursor-install-smoke.mjs` (T17 AC5). Lens briefs live INLINE in
   the `adlc-prosecute.md` command body (design-review finding: a separate
   `command/` lens file would be deployed to the user's palette as a fake
   command by T16's deploy-everything semantics). The command body must be
   fully self-describing — it may not defer semantics to the re-export shim
   files, which are hollow outside the monorepo. It must also instruct
   recording the outcome via `adlc gate-manifest record adversarial-review
   --files <risk-gated paths> --data '{...}'` so T18's stop-audit
   (`decideAdversarialReviewNotice`) has a satisfiable record instead of
   nagging unconditionally — smoke-asserted (T17).
4. **No invented hook events.** `stop` / `beforeSubmitPrompt` are wired only if
   verified against current Cursor documentation and pinned in ADR-0006 (same
   discipline as the original preToolUse pinning). Unverifiable events ship
   disabled-by-default with a documented enable flag and an ADR TODO.
5. **buildgate delegates to `@adlc/build-gate` via pinned deep-subpath
   imports.** No KEEP-IN-SYNC hand-copy. Design-review finding:
   `packages/build-gate/package.json` has no `main`/`exports`, so a bare
   `import from '@adlc/build-gate'` throws; the sanctioned import form is the
   deep subpath (`@adlc/build-gate/lib/risk.mjs`, `.../lib/decide.mjs`,
   `.../lib/active-ticket.mjs`), which resolves under legacy resolution.
   Same for `@adlc/flail-detector` (also no `exports`; T18 uses its lib
   subpaths). `packages/build-gate/**` stays a frozen rail (no exports-map
   edits). Both packages must be declared as dependencies in
   `plugins/adlc-cursor/package.json` AND asserted by
   `cursor-install-smoke` — workspace-root resolution masks a missing
   declaration in in-repo tests.
6. **Single `preToolUse` dispatcher; rails deny always wins.** Design-review
   finding: Cursor's multi-entry-per-event ordering and permission-combination
   semantics are UNPINNED — a second `preToolUse` entry could mask a rails
   deny. Therefore T18 ships ONE new dispatcher hook script that runs the
   rails decision first (importing the frozen guard's exports, never modifying
   it) and only consults buildgate when rails allows; a rails deny is
   returned unchanged. hooks.json's `preToolUse` rewires to the dispatcher
   (scaffold-managed, not frozen). A dedicated test asserts a rails deny
   survives a buildgate allow. Bonus: one process spawn per tool call, one
   10s timeout budget.
7. **buildgate is advisory and has NO unbypassable backstop.** Design-review
   finding (category error in the earlier draft): the CI rail-freeze gate
   enforces rail immutability, not fitness-to-build — nothing backstops
   buildgate (its depth signal is an agent-writable `.adlc/` file). Buildgate
   ships DISABLED by default behind `ADLC_BUILD_GATE_ENFORCEMENT=1`
   (mirroring `ADLC_P4_ENFORCEMENT`), its depth counter must be
   session-scoped with tested reset semantics ("a fresh session starts
   un-degraded" is an AC; pin Cursor's `conversation_id` payload field if it
   exists, else TTL/mtime staleness), and every doc surface must state the
   no-backstop fact — smoke-asserted alongside the other honesty strings
   (T19).
8. **Advisory means advisory.** `beforeShellExecution` and `afterFileEdit`
   modes never deny; the unbypassable control for RAILS remains the CI
   rail-freeze gate (and only for rails). No doc may overstate any of this.

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
  antigravity smoke scripts exit 0. Frozen rails: the base-ref CI gate is
  structurally blind to rails first declared on this branch (ADR-0006's own
  new-rail scope limit), so the binding mechanical check is
  `git diff --exit-code origin/main -- <union of T16-T19 rail paths>` run
  before each merge (exit 0 = no rail touched), PLUS
  `node scripts/rails-guard-ci.mjs origin/main` exiting 0 in CI-equivalent
  state (local runtime evidence `.adlc/manifest.jsonl` absent — it is
  gitignored and never ships, but the gate reads the working tree, so move it
  aside for the check).
- AC-S8: `.adlc/tickets.json` remains append-only relative to origin/main —
  all 15 base tickets preserved verbatim, T16-T19 appended (design-review
  finding: `rails-guard-ci` hard-denies base-ticket removal, so the earlier
  ticket-prune dogfood was reverted; the prune/CI conflict is filed as issue
  #104). Verified by `node scripts/rails-guard-ci.mjs origin/main` (same run
  as AC-S7).

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
- `packages/build-gate/**` — consumed via deep-subpath imports, never modified.

Design-review amendment: the hardened guard triple
(`plugins/adlc-cursor/hooks/adlc-rails-guard.mjs`, `rails-checker.mjs`,
`test/rails-guard.test.mjs`) is a rail on EVERY ticket T16-T19 (previously
asymmetric — absent from T17, partial on T19), since enforcement is
per-active-ticket and there is no CI backstop for branch-new rails.

## Out of scope

- Publishing `@adlc/cursor-package` to npm (release-process work).
- Live deny-proof against a real Cursor binary (remains the GA gate per
  ADR-0006; nothing here claims it).
- Shell-write *blocking* (advisory only, by design).
- MCP-based integration surfaces.
