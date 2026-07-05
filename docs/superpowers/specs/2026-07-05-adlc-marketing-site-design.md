# ADLC Marketing Site — agenticlifecycle.ai

**Date:** 2026-07-05
**Status:** Approved design (brainstormed with maintainer)
**Branch:** `feat/adlc-site` (worktree `.worktrees/adlc-site`)

## Decision summary

| Decision | Choice |
| --- | --- |
| Primary domain | **agenticlifecycle.ai**; devlifecycle.ai and adlc-docs.vercel.app 301 → apex |
| Architecture | **One unified Next.js app** — evolve `apps/docs` in place; marketing at `/`, Fumadocs keeps `/docs/**` |
| Conversion | **Install-first, enterprise second** — hero CTA is the agent picker; secondary path is `/enterprise` contact |
| Brand | **Extend the dark-only "An Old Hope" theme** (accent `#4fb4d8`; gate colors pass `#78bd65` / fail `#eb3d54` / wish `#e5cd52`) with marketing-grade elevation |
| Theory content | **Native concept pages** citing the canonical series at voodootikigod.com/series/adlc — no republication |
| Visual program | **Two layers**: designed data-driven diagrams for everything explanatory + generated atmosphere imagery (GPT-image / Nano Banana) for appeal |

## 1. Positioning & core message

**Audience:** engineering leaders and senior ICs at companies adopting agentic
development who suspect that "just let the agent run" is producing hollow tests,
confident hallucinations, and unreviewable merges.

**Core message:** *The SDLC defends against human failure modes. Your agents fail
differently. ADLC is the lifecycle designed for how models actually fail —
premature satisfaction, sycophancy, context rot, reward hacking — with
machine-checkable gates at every phase.*

**Tone:** confident, technical, evidence-shaped. No AI-hype gradients. The
pass/fail/wish gate colors are the visual signature.

## 2. Information architecture

```
agenticlifecycle.ai
├─ /                      Landing page
├─ /lifecycle             Phases & gates (P0–P7), lifecycle diagram, three dials
├─ /failure-modes         F1–F8 — why agents fail, what defends against each
├─ /vs-sdlc               Why 60 years of SDLC doesn't transfer
├─ /toolkit               21 packages grouped by phase, each → its /docs page
├─ /integrations          Hub: pick your agent
│   └─ /integrations/[claude-code|codex|cursor|opencode|pi|antigravity]
├─ /enterprise            The "do it right" page + contact
└─ /docs/**               Existing Fumadocs (content unchanged)
```

### Landing page narrative (scroll order)

1. **Hero** — headline ("Your agents don't fail like humans. Stop managing them
   like humans."), one-line thesis, dual CTA: *Install for your agent* (primary,
   opens the agent picker) + *Why ADLC*. Hero visual: terminal-styled gate
   animation (spec-lint → premortem → prosecute passing/failing in sequence)
   over a generated backdrop.
2. **The problem** — F1–F8 failure modes as a compact visual grid, one-liner each.
3. **The lifecycle** — designed phase diagram (data from `phase-graph.mjs`,
   rendered as a React/SVG component — not raw Mermaid).
4. **Gates, not vibes** — 3–4 hero tools as terminal cards with real output
   (spec-lint, rails-guard, prosecute, hollow-test) + the gate-funnel visual.
5. **Native to your agent** — six integration cards with one-command installs.
6. **Enterprise band** — "Rolling out agentic development across an org? Do it
   right." → `/enterprise`.
7. **Theory footer band** — "ADLC began as an essay series" → canonical link to
   voodootikigod.com/series/adlc.

### Canonical strategy

Concept pages (`/lifecycle`, `/failure-modes`, `/vs-sdlc`) are written natively
for the enterprise audience. Each carries a prominent "Read the original
essay →" citation to the corresponding series post via the existing
`theory-links.mjs` map. voodootikigod.com/series/adlc remains the canonical,
referencable source. No republication, no rel=canonical gymnastics, no sync
burden.

## 3. Architecture & mechanics

- **Evolve `apps/docs` in place.** Directory name stays `apps/docs` for v1
  (renaming to `apps/site` touches root package.json scripts, rails-guard test
  fixtures, and the lockfile — churn with no user-visible benefit; later chore
  if desired). Marketing routes live in the expanded `(home)` route group.
- Fumadocs continues to own `/docs/**` untouched.
- Shared tested data modules (`phase-graph.mjs`, `failure-modes.mjs`,
  `theory-links.mjs`) are consumed by marketing pages and diagrams, so marketing
  cannot drift from the docs.
- Integration pages source install commands and facts from
  `docs/integrations/*.md` ground truth (same rule the docs templates follow).
- `llms.txt` / OG-image routes already in the app extend to the new pages.
- Stack stays Next.js App Router + Tailwind v4. No new UI framework.

## 4. Visual program

### Layer 1 — Explanatory visualizations (designed components)

Every core concept gets a purpose-built diagram, rendered as React/SVG
components on the shared theme tokens. Data-driven where a tested data module
exists.

| Visualization | Placement | Shows |
| --- | --- | --- |
| Lifecycle ring/pipeline | Hero + `/lifecycle` | P0–P7 phases with gates between them; animated gate-check sequence (pass/fail/wish states) |
| Failure-mode → defense map | `/` + `/failure-modes` | F1–F8 mapped to the gates/tools that defend against each |
| SDLC vs ADLC split | `/vs-sdlc` | Side-by-side lifecycle comparison — what transfers, what doesn't |
| Three dials | `/lifecycle` | Autonomy/oversight/scope dials (from adlc-5) as a gauge cluster |
| Evidence trail | `/enterprise` | Ticket → gates → gate-manifest artifacts → auditable merge (chain of custody) |
| Gate funnel | `/` ("Gates, not vibes") | Work flowing through gates — some blocked (fail red), some passing (green) |
| Toolkit constellation | `/toolkit` | 21 packages clustered by phase |

**Rule:** anything that *explains* (phases, gates, failure modes, data) is a
designed component with real text and ARIA — never a generated image.

### Layer 2 — Generated atmosphere imagery (GPT-image / Nano Banana)

Art-directed generated images for emotional appeal:

- **Hero backdrop** — abstract dark composition in the An Old Hope palette
  (terminal-glow aesthetic, blue `#4fb4d8` energy, gate-color accents).
- **Section header art** — one per major landing section + one per concept
  page; consistent visual world.
- **Integration card art** — stylized emblem treatments for the six agents
  (evocative, not trademark-infringing logo reproductions).
- **Enterprise imagery** — "order from chaos": chaotic agent output resolving
  into gated, auditable structure.
- **OG/social cards** — generated backgrounds + typographic overlay per page.

**Pipeline:** an image manifest checked into the repo (slug, prompt, size,
placement), a generation script that calls whichever image API has keys
available (GPT-image or Gemini/Nano Banana), and optimized outputs committed as
static assets served via `next/image` (AVIF/WebP). One shared style-guide
paragraph is embedded in every prompt so the set reads as one visual world.
Prompts live in the manifest so regeneration is reproducible.

**Provenance & rights:** the manifest records provider + model + generation
date per asset, and each provider's commercial-use terms are confirmed before
its output ships. Integration card art must pass the
evocative-not-trademark-reproduction guardrail at review time.

### Elevation on the shared tokens

Large editorial type scale for headlines, generous section spacing, monospace
accents for terminal-flavored elements, subtle motion (gate-check animations,
scroll reveals on diagrams). Dark-only, same tokens as `/docs`.

### Accessibility acceptance criteria

- Gate states never rely on color alone — pass/fail/wish always pair the color
  with an icon or text label.
- Theme tokens (text on background, gate colors where used as text) meet WCAG
  AA contrast; verified once against the palette during build-out.
- All motion (gate animations, scroll reveals) respects
  `prefers-reduced-motion` with a static fallback.

## 5. Enterprise page (`/enterprise`)

Speaks to the buyer, not the installer:

- **Risk framing** — unreviewable agent output is an audit/compliance problem.
- **What "doing it right" looks like** — gates as an evidence trail;
  `gate-manifest` produces artifacts auditors can read.
- **Rollout shape** — pilot team → rails → org-wide.
- **Contact CTA** — `mailto:` only in v1: no form, so no PII is collected and
  no privacy policy is required yet.

### Contact capture (v1.1 — after launch)

An on-brand form on `/enterprise` posting to a Next.js API route with a
**pluggable sink**. The intended sink is **Attio** (free tier — verify API
access limits before wiring); the route creates a person/company record via
Attio's REST API. Fallback sink if Attio's free tier blocks API writes:
email notification (e.g. Resend) + manual CRM entry, form unchanged.

Prerequisites before the form ships:
- Privacy policy published (form collects PII).
- Spam defense: honeypot + Cloudflare Turnstile.
- Rate limiting on the API route.

## 6. Domains & deployment

- Vercel project rooted at `apps/docs`; domain **agenticlifecycle.ai**.
- **devlifecycle.ai** and **adlc-docs.vercel.app** 301 → apex via Vercel domain
  redirect config. Redirects must be **path-preserving**
  (`adlc-docs.vercel.app/docs/x` → `agenticlifecycle.ai/docs/x`); existing docs
  links keep working because `/docs/**` paths are unchanged.
- Cutover check: crawl the deployed sitemap plus known legacy docs URLs and
  assert 200s (a small link-check script, run against preview before pointing
  domains).
- Sitemap + per-page metadata/OG for all new routes.

## 7. Testing & quality bar

- TDD on authored logic: integration-facts data module, nav config,
  redirect/metadata helpers, image-manifest validation.
- Integration routes are generated from the integration-facts module (grounded
  in `docs/integrations/*.md`); a test fails if a route's slug has no
  corresponding ground-truth doc, so a bad slug can't ship a 404.
- Component render tests for new pages; wired into root `npm test`.
- P5 prosecution before merge, pre-empting the known hollow-test classes
  (wrong-branch fixtures, swallowed error paths, exact-value assertions on data
  maps that merely restate the data).
- Copy and visual polish validated by build + human review, not fake DOM
  assertions.

## 8. Out of scope (v1)

Blog/changelog, analytics beyond Vercel defaults, light theme, pricing page,
renaming `apps/docs` → `apps/site`. Contact capture (form + Attio sink) is
specced above as v1.1 — deliberately after launch, not in v1.
