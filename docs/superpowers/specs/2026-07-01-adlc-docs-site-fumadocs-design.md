---
title: ADLC Documentation Site (Fumadocs) — Design
date: 2026-07-01
status: approved-for-planning
---

# ADLC Documentation Site (Fumadocs) — Design

## Purpose

Build a communicative, illustrative documentation site for the ADLC toolkit and
its harness integrations (Claude Code, Codex, Cursor, OpenCode, Pi). The site
explains the toolkit itself and each integration, and consistently references
back to the original theory/introduction series at
<https://voodootikigod.com/series/adlc> with deep links where appropriate.

The site is a **fresh, authored presentation layer**. The existing repo-internal
markdown under `docs/*.md` is left untouched as reference; content is re-authored
as MDX for a polished narrative experience.

## Success criteria

1. `apps/docs` builds cleanly — verify: `npm run build --workspace @adlc/docs`
   exits `0`.
2. Verify: `ls apps/docs/content/docs/toolkit/meta.json apps/docs/content/docs/integrations/meta.json apps/docs/content/docs/reference/meta.json` exits `0` and `npm run build --workspace @adlc/docs` exits `0` — the navigation IA renders the full section tree (all sections present; unbuilt pages may be stubs).
3. Verify: `test -f apps/docs/content/docs/theory/index.mdx apps/docs/content/docs/lifecycle.mdx apps/docs/content/docs/toolkit/spec-lint.mdx apps/docs/content/docs/integrations/claude-code.mdx` exits `0` and `npm run build --workspace @adlc/docs` exits `0` — the first deliverable ships home, theory overview, lifecycle map, the `spec-lint` tool exemplar, and the `Claude Code` integration exemplar as complete pages.
4. Every theory deep-link resolves to a real `voodootikigod.com/series/adlc` post
   with no fabricated URLs — verify: `node --test apps/docs/test/theory-links.test.mjs`
   asserts every resolved link is an absolute `https://voodootikigod.com/` URL and
   unknown ids fall back to the series landing (exit `0`).
5. Built-in search (Orama) is enabled — verify: `apps/docs/app/api/search/route.ts`
   exists (`test -f`) and `npm run build --workspace @adlc/docs` compiles the
   `/api/search` route without error (exit `0`).
6. The published `@adlc/*` packages and their zero-dependency contract are
   unaffected — verify: `npm test` at repo root exits `0`, unchanged from `main`.

## Non-goals (YAGNI)

- No bespoke design system in the first cut — default Fumadocs theme + An Old
  Hope accent tokens. Visual polish is a later pass.
- No mirroring of the theory series essays — deep-link out; the series stays
  canonical.
- No migration or deletion of existing `docs/*.md`.
- We do not wire or trigger the Vercel deployment; we prepare config only. The
  maintainer creates/links the Vercel project.
- No i18n, no versioned docs in the first cut.
- No light theme and no theme toggle — the site is dark-only.

## Architecture & tooling

- **Stack:** Next.js (App Router) + `fumadocs-ui` + `fumadocs-mdx` +
  `fumadocs-core`, scaffolded via `create-fumadocs-app` and then adapted.
- **Location:** new `apps/docs/` workspace. Add `apps/*` to the root
  `package.json` `workspaces` array.
- **Isolation:** `apps/docs` is `"private": true` and unpublished. Its
  React/Next/Fumadocs dependencies never enter the published `@adlc/*` packages,
  so the zero-runtime-dependency contract in `CONVENTIONS.md` is preserved. The
  root `npm test` script iterates `packages/*/test` (and specific plugin test
  dirs) and does not touch `apps/`, so it is unaffected.
- **Content:** MDX under `apps/docs/content/docs/`, with Fumadocs source config
  (`source.config.ts`) and generated `.source`.
- **Deploy:** Vercel, root directory `apps/docs`. Provide `vercel.json` / a
  documented project setting and a build check. Deployment is triggered by the
  maintainer, not by this work.

## Theme — "An Old Hope"

Dark-default theme derived from the An Old Hope VS Code theme
(<https://github.com/dustinsanders/an-old-hope-theme-vscode>). Applied via
Fumadocs/Tailwind CSS variables and a matching Shiki code-block theme.

| Role | Hex |
|---|---|
| background | `#1c1d21` |
| foreground | `#cbcdd2` |
| comment / muted | `#686b78` |
| selection / surface | `#2F3137` |
| secondary surface | `#3f4044` |
| **primary accent / links** | blue `#4fb4d8` |
| gate pass (exit 0) | green `#78bd65` |
| gate fail (exit 2) | red `#eb3d54` |
| warning / "wish" | yellow `#e5cd52` |
| highlight / callout | orange `#ef7c2a` |

**Gate-semantic color usage:** because the toolkit's identity is exit codes,
green/red/yellow are reserved for pass/fail/wish states in exit-code tables,
callouts, and the `<FailureMode>` / `<PhaseDiagram>` components. Code blocks use
a Shiki theme built from the An Old Hope token colors (the upstream repo
generates a compatible theme JSON; we import/adapt it as a custom Shiki theme, or
map its token scopes to the palette above).

**Dark-only.** The site ships a single dark theme (An Old Hope). No light
variant and no theme toggle — the theme switcher is disabled/removed so the
palette is always applied.

## Information architecture (navigation tree)

```
Home (landing)
Theory & Introduction
  └─ Overview (P0–P7 phases + F1–F5 failure modes mapped to the toolkit;
     deep-links to voodootikigod.com/series/adlc)
Getting Started (install @adlc/cli, adlc-init, run your first gate)
The Lifecycle (phase/gate map; connective tissue)
Toolkit (grouped by phase)
  • Spec & ticket shaping: parallax, spec-lint, premortem, coldstart
  • Execution supervision & rails: preflight, model-router, merge-forecast,
    rails-guard, flail-detector, consensus-fix, runner
  • Review evidence & calibration: behavior-diff, gate-manifest, hollow-test,
    prosecute, review-calibration, model-ratchet, gate-fuzzing
  • Compounding defenses: lesson-foundry, rejection-mining, skill-rot
  • Shared foundation: @adlc/cli, @adlc/core
Integrations: Claude Code · Codex · Cursor · OpenCode · Pi
Reference: CONVENTIONS contract, exit-code semantics, .adlc/ runtime, ADR index
```

Fumadocs `meta.json` files define per-section ordering and grouping.

## Reusable page templates

These templates are the "communicative + illustrative" core. They are locked by
the two exemplar pages in the first cut, then cloned for the fan-out.

### Tool page template
1. One-line "what gate it enforces".
2. **Failure mode defended** (F1–F5) via a `<FailureMode>` callout component.
3. **Lifecycle-context diagram** (mermaid) highlighting the tool's ADLC phase.
4. Usage (command form) + flags table.
5. **Exit-code semantics** (0 pass / 1 error / 2 fail) with gate colors.
6. Worked example (input → output, `--json` and `--prompt-only` where relevant).
7. "Go deeper" — deep-link into the theory series for the underlying concept.

### Integration page template
1. Philosophy / synergy with the harness.
2. Install — Fumadocs **Tabs** per install path.
3. **Phase → mechanism mapping table** (ADLC phase → harness extension vector),
   modeled on the existing `docs/integrations/pi.md`.
4. Hooks / commands / subagent reference.
5. Link to the source plugin directory in the repo.

### Shared components / illustrative elements
- `<PhaseDiagram phase="P1" />` — renders the ADLC lifecycle mermaid with the
  active phase highlighted (single source, reused across pages).
- `<FailureMode id="F1" />` — a styled callout naming the model failure mode and
  linking to its theory post.
- Fumadocs **Cards** (phase-group grids, integration grid), **Callouts**,
  **Tabs** (install variants), mermaid (via `rehype`/Fumadocs mermaid support).

## Theory deep-linking

A single source-of-truth map, `apps/docs/lib/theory-links.ts`, mapping ADLC
concepts (phases P0–P7, failure modes F1–F5, key gate names) → the exact
`voodootikigod.com/series/adlc` post URL and anchor. All pages and the
`<FailureMode>`/`<PhaseDiagram>` components consume this map so links stay
consistent and are updated in one place.

**Implementation note:** the live series index at
<https://voodootikigod.com/series/adlc> is fetched during implementation to
populate real post URLs. If a concept has no dedicated post, it links to the
series landing page rather than fabricating a URL.

## First deliverable (scaffold + exemplars)

1. Fumadocs shell + full nav IA (all sections present; fan-out pages stubbed).
2. **Home** landing page (what ADLC is, failure-mode thesis, install CTA, theory
   links).
3. **Theory & Introduction** overview page (real deep-links).
4. **The Lifecycle** phase-map page (connective tissue; `<PhaseDiagram>`).
5. **Tool exemplar:** `spec-lint` — locks the tool template.
6. **Integration exemplar:** `Claude Code` — locks the integration template.
7. An Old Hope theme applied; search enabled; `next build` passes locally.

Remaining 23 tools + 4 integrations + Reference pages fan out afterward as
per-page ADLC tickets, each cloning the locked templates.

## Testing & verification

- **Build gate:** `next build` (and `next lint`) must pass — the primary
  machine-checkable gate for a docs site.
- **Link integrity:** a small check that every `theory-links` entry resolves to a
  non-empty URL, and that internal doc links are not dangling (Fumadocs build
  surfaces broken internal refs).
- **Component unit tests:** `<PhaseDiagram>` and `<FailureMode>` render the
  expected phase/failure id (lightweight React test; these are the only real
  logic, so they get real coverage — no hollow tests).
- **Isolation check:** root `npm test` continues to pass unchanged.
- Prose pages are verified by build + review, not unit tests.

## ADLC process wrapper

Per the request to build this "using the ADLC":
- This design doc is the spec; run it through **`spec-lint`**.
- Open a **P0 ticket** (`adlc-ticket`) for the scaffold + exemplar cut; the
  fan-out becomes per-page tickets.
- **Rails/prosecution (P5)** applies to the real logic — the shared components
  and the `theory-links` map — not to prose pages.

## Risks & mitigations

- **Heavy React/Next workspace in a zero-dep monorepo.** Mitigated by keeping
  `apps/docs` private/unpublished and out of the packages test path.
- **Theory deep-links drifting** if the series is reorganized. Mitigated by the
  single `theory-links.ts` map (one place to update) and the no-fabrication rule.
- **Mermaid + Shiki (An Old Hope) rendering in Fumadocs.** Validate early in the
  scaffold; fall back to a bundled Shiki theme if a custom theme import is
  troublesome.
- **Vercel monorepo root-dir config.** Documented explicitly; deployment left to
  the maintainer.
