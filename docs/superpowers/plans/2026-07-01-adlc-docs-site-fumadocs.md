# ADLC Documentation Site (Fumadocs) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the first deliverable of a dark-only Fumadocs documentation site for the ADLC toolkit — scaffold + full navigation IA + An Old Hope theme + shared illustrative components + five complete exemplar pages (home, theory overview, lifecycle, `spec-lint`, Claude Code) — with `next build` passing and the published `@adlc/*` packages untouched.

**Architecture:** A new private `apps/docs` Next.js (App Router) workspace using `fumadocs-ui` + `fumadocs-mdx` + `fumadocs-core`. Content is authored MDX under `apps/docs/content/docs/`. Two shared React components (`<PhaseDiagram>`, `<FailureMode>`) and one data module (`theory-links.ts`) carry the only real logic and are TDD'd; prose/config is verified by the build gate. Theory concepts deep-link to the canonical series at voodootikigod.com/series/adlc via a single link map.

**Tech Stack:** Next.js (App Router), fumadocs-ui / fumadocs-mdx / fumadocs-core, Tailwind CSS v4, Shiki (custom An Old Hope theme), mermaid, node:test (for the pure-logic unit tests), Vercel (deploy target — maintainer-triggered).

## Global Constraints

- **Worktree:** all work happens in `/home/voodootikigod/Projects/voodootikigod/adlc/.worktrees/docs-site` on branch `feat/docs-site-fumadocs`. Use absolute paths.
- **Dark-only:** single dark theme, no light variant, no theme toggle. Force `dark` via `forcedTheme: 'dark'` and disable the switcher (`enabled: false`).
- **An Old Hope palette (exact hex):** background `#1c1d21` · foreground `#cbcdd2` · comment/muted `#686b78` · selection/surface `#2F3137` · secondary surface `#3f4044` · primary/link blue `#4fb4d8` · gate-pass green `#78bd65` · gate-fail red `#eb3d54` · warning/wish yellow `#e5cd52` · highlight orange `#ef7c2a`.
- **Gate-semantic colors:** green = exit 0 (pass), red = exit 2 (fail), yellow = "wish"/warning. Reserve these for exit-code/state UI only.
- **`apps/docs` is `"private": true` and unpublished.** React/Next deps must never enter `packages/*`. Root `npm test` (iterates `packages/*/test` + named plugin dirs) must remain green and untouched.
- **Node.js ≥ 18** (repo engines floor).
- **No fabricated theory URLs.** Concepts without a dedicated post link to the series landing `https://voodootikigod.com/series/adlc`.
- **Theory series base URL:** `https://voodootikigod.com`. Known posts:
  - `/adlc-1-models-arent-human` — thesis; failure modes F1–F8; P0
  - `/adlc-2-two-human-gates` — P0–P7 overview; human gates at P1 & P6
  - `/adlc-3-tests-are-the-spec` — P3 Rail; TDD-as-spec
  - `/adlc-4-prosecution-not-code-review` — P5 Prosecute
  - `/adlc-5-three-dials-parallel-agents` — multi-agent orchestration
  - `/adlc-6-lifecycle-gets-cheaper` — P7 Distill
  - `/adlc-7-built-with-the-lifecycle` — the toolkit
  - `/adlc-8-vs-enterprise-sdlc` — ADLC vs enterprise SDLC
- **Failure modes (F1–F8):** F1 Premature satisfaction · F2 Sycophancy · F3 Context rot · F4 Confident hallucination · F5 Reward hacking · F6 Finding-count prior · F7 Generative bloat · F8 Coherence loss. All link to `/adlc-1-models-arent-human`.
- **ADLC phases (P0–P7):** P0 Triage · P1 Interrogate · P2 Decompose · P3 Rail · P4 Build · P5 Prosecute · P6 Review · P7 Distill.

---

## File Structure

```
apps/docs/
  package.json                      # @adlc/docs, private, next/fumadocs deps
  next.config.mjs                   # withMDX wrapper
  source.config.ts                  # fumadocs-mdx source + rehypeCode (An Old Hope Shiki theme)
  tsconfig.json
  postcss.config.mjs
  app/
    layout.tsx                      # RootProvider forcedTheme dark, <html class="dark">
    global.css                      # An Old Hope CSS variables (fumadocs tokens)
    (home)/page.tsx                 # landing page
    docs/layout.tsx                 # DocsLayout (sidebar nav)
    docs/[[...slug]]/page.tsx       # MDX page renderer
    api/search/route.ts             # Orama static search
    layout.config.tsx               # shared nav options (title, links)
  lib/
    source.ts                       # loader() over content/docs
    theory-links.ts                 # concept -> series URL map (TDD)
    an-old-hope-shiki.ts            # custom Shiki theme object
  components/
    mermaid.tsx                     # client mermaid renderer
    phase-diagram.tsx               # <PhaseDiagram phase="P1" /> (TDD builder)
    failure-mode.tsx                # <FailureMode id="F1" /> (TDD lookup)
  content/docs/
    index.mdx                       # docs root / getting started
    meta.json                       # top-level order
    theory/index.mdx                # theory overview
    lifecycle.mdx                   # lifecycle map
    getting-started.mdx
    toolkit/meta.json + group stubs + spec-lint.mdx (exemplar) + tool stubs
    integrations/meta.json + claude-code.mdx (exemplar) + integration stubs
    reference/meta.json + stubs
  mdx-components.tsx                 # register PhaseDiagram, FailureMode, Mermaid
  test/
    theory-links.test.mjs
    phase-diagram.test.mjs
    failure-mode.test.mjs
  vercel.json                       # (or documented root-dir setting)
  README.md
```

---

## Task 1: Scaffold `apps/docs` and wire it into the workspace

**Files:**
- Create: `apps/docs/**` (via scaffolder)
- Modify: `package.json` (root — add `apps/*` to `workspaces`)

**Interfaces:**
- Produces: a buildable Fumadocs app at `apps/docs` named `@adlc/docs`, private; default content renders.

- [ ] **Step 1: Scaffold into apps/docs**

From the worktree root, run the Fumadocs scaffolder and target `apps/docs`:

```bash
cd /home/voodootikigod/Projects/voodootikigod/adlc/.worktrees/docs-site
npm create fumadocs-app@latest apps/docs
```

When prompted, choose: **Next.js**, **Fumadocs MDX** (content source), **Tailwind CSS**, package manager **npm**, and **do not** install deps yet if asked (we install from root). Accept the default "Neutral" layout.

- [ ] **Step 2: Make it a private workspace package**

Edit `apps/docs/package.json`: set `"name": "@adlc/docs"` and add `"private": true`. Keep the generated `dev`/`build`/`start` scripts.

- [ ] **Step 3: Add `apps/*` to root workspaces**

In root `package.json`, change:

```json
  "workspaces": [
    "packages/*"
  ],
```
to:
```json
  "workspaces": [
    "packages/*",
    "apps/*"
  ],
```

- [ ] **Step 4: Install and build the default site**

```bash
cd /home/voodootikigod/Projects/voodootikigod/adlc/.worktrees/docs-site
npm install
npm run build --workspace @adlc/docs
```
Expected: install succeeds; `next build` completes with the default Fumadocs starter content.

- [ ] **Step 5: Confirm the packages test path is unaffected**

```bash
npm test
```
Expected: PASS (identical to `main` — the docs app is under `apps/`, not `packages/`, and is not in the test script).

- [ ] **Step 6: Commit**

```bash
git add apps/docs package.json package-lock.json
git commit -m "feat(docs): scaffold apps/docs Fumadocs site + wire workspace"
```

---

## Task 2: Apply the An Old Hope dark-only theme

**Files:**
- Modify: `apps/docs/app/global.css`, `apps/docs/app/layout.tsx`
- Create: `apps/docs/lib/an-old-hope-shiki.ts`
- Modify: `apps/docs/source.config.ts`

**Interfaces:**
- Produces: `anOldHopeShiki` (a Shiki theme object) consumed by `source.config.ts`.

- [ ] **Step 1: Set Fumadocs CSS variables to the palette**

In `apps/docs/app/global.css`, after the fumadocs-ui import, append a dark token block (Fumadocs UI reads `--color-fd-*` tokens):

```css
:root,
.dark {
  --color-fd-background: #1c1d21;
  --color-fd-foreground: #cbcdd2;
  --color-fd-muted: #2f3137;
  --color-fd-muted-foreground: #686b78;
  --color-fd-popover: #1c1d21;
  --color-fd-popover-foreground: #cbcdd2;
  --color-fd-card: #26272c;
  --color-fd-card-foreground: #cbcdd2;
  --color-fd-border: #3f4044;
  --color-fd-primary: #4fb4d8;
  --color-fd-primary-foreground: #1c1d21;
  --color-fd-secondary: #3f4044;
  --color-fd-secondary-foreground: #cbcdd2;
  --color-fd-accent: #2f3137;
  --color-fd-accent-foreground: #4fb4d8;
  --color-fd-ring: #4fb4d8;
}

/* Gate-semantic tokens (used by shared components) */
:root {
  --adlc-pass: #78bd65;
  --adlc-fail: #eb3d54;
  --adlc-wish: #e5cd52;
  --adlc-highlight: #ef7c2a;
}
```

- [ ] **Step 2: Force dark, remove the toggle**

In `apps/docs/app/layout.tsx`, ensure `<html>` carries the dark class and the provider forces dark with the switch disabled:

```tsx
<html lang="en" className="dark" suppressHydrationWarning>
  <body>
    <RootProvider theme={{ forcedTheme: 'dark', enabled: false }}>
      {children}
    </RootProvider>
  </body>
</html>
```

- [ ] **Step 3: Create the custom Shiki theme**

Create `apps/docs/lib/an-old-hope-shiki.ts`:

```ts
// Minimal Shiki theme built from the An Old Hope palette.
export const anOldHopeShiki = {
  name: 'an-old-hope',
  type: 'dark' as const,
  colors: {
    'editor.background': '#1c1d21',
    'editor.foreground': '#cbcdd2',
  },
  settings: [
    { scope: ['comment', 'punctuation.definition.comment'], settings: { foreground: '#686b78', fontStyle: 'italic' } },
    { scope: ['string', 'constant.other.symbol'], settings: { foreground: '#78bd65' } },
    { scope: ['constant.numeric', 'constant.language', 'constant.character'], settings: { foreground: '#ef7c2a' } },
    { scope: ['keyword', 'storage.type', 'storage.modifier'], settings: { foreground: '#eb3d54' } },
    { scope: ['entity.name.function', 'support.function'], settings: { foreground: '#4fb4d8' } },
    { scope: ['variable', 'variable.parameter', 'meta.definition.variable'], settings: { foreground: '#cbcdd2' } },
    { scope: ['entity.name.type', 'entity.name.class', 'support.type', 'support.class'], settings: { foreground: '#e5cd52' } },
    { scope: ['entity.name.tag'], settings: { foreground: '#eb3d54' } },
    { scope: ['entity.other.attribute-name'], settings: { foreground: '#e5cd52' } },
  ],
} as const;
```

- [ ] **Step 4: Wire the Shiki theme into the MDX pipeline**

In `apps/docs/source.config.ts`, import the theme and set it for both slots (dark-only, so light === dark):

```ts
import { anOldHopeShiki } from './lib/an-old-hope-shiki';

export default defineConfig({
  mdxOptions: {
    rehypeCodeOptions: {
      themes: { light: anOldHopeShiki, dark: anOldHopeShiki },
    },
  },
});
```
(Merge into the existing `defineConfig` call rather than adding a second one.)

- [ ] **Step 5: Build and eyeball**

```bash
npm run build --workspace @adlc/docs
```
Expected: build passes. `grep -n "forcedTheme" apps/docs/app/layout.tsx` confirms dark is forced; `grep -n "4fb4d8" apps/docs/app/global.css` confirms the accent is applied.

- [ ] **Step 6: Commit**

```bash
git add apps/docs/app/global.css apps/docs/app/layout.tsx apps/docs/lib/an-old-hope-shiki.ts apps/docs/source.config.ts
git commit -m "feat(docs): An Old Hope dark-only theme + custom Shiki code theme"
```

---

## Task 3: Theory-links map (TDD)

**Files:**
- Create: `apps/docs/lib/theory-links.ts`
- Test: `apps/docs/test/theory-links.test.mjs`

**Interfaces:**
- Produces:
  - `SERIES_BASE = 'https://voodootikigod.com'`
  - `theoryLink(id: string): string` — resolves a concept id (`'P0'..'P7'`, `'F1'..'F8'`, or a named key like `'toolkit'`, `'prosecution'`, `'three-dials'`, `'vs-sdlc'`, `'gates'`) to an absolute URL; unknown ids return the series landing `https://voodootikigod.com/series/adlc`.

- [ ] **Step 1: Write the failing test**

Create `apps/docs/test/theory-links.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { theoryLink, SERIES_BASE } from '../lib/theory-links.ts';

test('phase P5 links to the prosecution post', () => {
  assert.equal(theoryLink('P5'), 'https://voodootikigod.com/adlc-4-prosecution-not-code-review');
});

test('failure modes link to the thesis post', () => {
  for (const id of ['F1', 'F4', 'F8']) {
    assert.equal(theoryLink(id), 'https://voodootikigod.com/adlc-1-models-arent-human');
  }
});

test('unknown ids fall back to the series landing', () => {
  assert.equal(theoryLink('nope'), `${SERIES_BASE}/series/adlc`);
});

test('every resolved link is an absolute https URL', () => {
  for (const id of ['P0','P1','P2','P3','P4','P5','P6','P7','F1','F8','toolkit','three-dials','vs-sdlc','gates']) {
    assert.match(theoryLink(id), /^https:\/\/voodootikigod\.com\//);
  }
});
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
node --test apps/docs/test/theory-links.test.mjs
```
Expected: FAIL (module not found).

> Note: `node --test` runs `.ts` via the import above only if a loader is present. If Node cannot import `.ts` directly, rename `theory-links.ts` → keep `.ts` for the app but add a sibling `apps/docs/lib/theory-links.mjs` re-exporting the same literal data, and import the `.mjs` in the test. Prefer a single source: author the data in `.mjs` and re-export from `.ts` (`export * from './theory-links.mjs'`). Use this single-source approach.

- [ ] **Step 3: Implement the map (single source in .mjs, .ts re-export)**

Create `apps/docs/lib/theory-links.mjs`:

```js
export const SERIES_BASE = 'https://voodootikigod.com';
const post = (slug) => `${SERIES_BASE}/${slug}`;

const LINKS = {
  P0: post('adlc-1-models-arent-human'),
  P1: post('adlc-2-two-human-gates'),
  P2: post('adlc-5-three-dials-parallel-agents'),
  P3: post('adlc-3-tests-are-the-spec'),
  P4: post('adlc-3-tests-are-the-spec'),
  P5: post('adlc-4-prosecution-not-code-review'),
  P6: post('adlc-2-two-human-gates'),
  P7: post('adlc-6-lifecycle-gets-cheaper'),
  F1: post('adlc-1-models-arent-human'),
  F2: post('adlc-1-models-arent-human'),
  F3: post('adlc-1-models-arent-human'),
  F4: post('adlc-1-models-arent-human'),
  F5: post('adlc-1-models-arent-human'),
  F6: post('adlc-1-models-arent-human'),
  F7: post('adlc-1-models-arent-human'),
  F8: post('adlc-1-models-arent-human'),
  gates: post('adlc-2-two-human-gates'),
  toolkit: post('adlc-7-built-with-the-lifecycle'),
  prosecution: post('adlc-4-prosecution-not-code-review'),
  'three-dials': post('adlc-5-three-dials-parallel-agents'),
  distill: post('adlc-6-lifecycle-gets-cheaper'),
  'vs-sdlc': post('adlc-8-vs-enterprise-sdlc'),
};

export function theoryLink(id) {
  return LINKS[id] ?? `${SERIES_BASE}/series/adlc`;
}
```

Create `apps/docs/lib/theory-links.ts`:

```ts
export * from './theory-links.mjs';
```

Update the test import in Step 1 to `../lib/theory-links.mjs`.

- [ ] **Step 4: Run the test to confirm it passes**

```bash
node --test apps/docs/test/theory-links.test.mjs
```
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/docs/lib/theory-links.mjs apps/docs/lib/theory-links.ts apps/docs/test/theory-links.test.mjs
git commit -m "feat(docs): theory-links map to voodootikigod.com/series/adlc (TDD)"
```

---

## Task 4: Shared illustrative components (TDD the pure logic)

**Files:**
- Create: `apps/docs/lib/phase-graph.mjs`, `apps/docs/lib/failure-modes.mjs`
- Create: `apps/docs/components/mermaid.tsx`, `apps/docs/components/phase-diagram.tsx`, `apps/docs/components/failure-mode.tsx`
- Modify: `apps/docs/mdx-components.tsx`
- Test: `apps/docs/test/phase-diagram.test.mjs`, `apps/docs/test/failure-mode.test.mjs`

**Interfaces:**
- Consumes: `theoryLink` (Task 3).
- Produces:
  - `buildPhaseMermaid(active: string): string` — returns a mermaid `flowchart` for P0→P7 with `active` styled; throws on an unknown phase id.
  - `PHASES: { id, name }[]` (P0–P7 in order).
  - `FAILURE_MODES: Record<'F1'..'F8', { name: string }>`.
  - `<PhaseDiagram phase="P3" />`, `<FailureMode id="F1" />`, `<Mermaid chart="..." />` MDX components.

- [ ] **Step 1: Write the failing tests**

Create `apps/docs/test/phase-diagram.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPhaseMermaid, PHASES } from '../lib/phase-graph.mjs';

test('PHASES lists P0..P7 in order', () => {
  assert.deepEqual(PHASES.map((p) => p.id), ['P0','P1','P2','P3','P4','P5','P6','P7']);
});

test('buildPhaseMermaid highlights the active phase and is a flowchart', () => {
  const out = buildPhaseMermaid('P3');
  assert.match(out, /^flowchart/);
  assert.match(out, /style P3 /);
  assert.ok(out.includes('P3["P3 Rail"]'));
});

test('buildPhaseMermaid rejects unknown phases', () => {
  assert.throws(() => buildPhaseMermaid('P9'), /unknown phase/i);
});
```

Create `apps/docs/test/failure-mode.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FAILURE_MODES } from '../lib/failure-modes.mjs';
import { theoryLink } from '../lib/theory-links.mjs';

test('all eight failure modes F1..F8 are defined with names', () => {
  for (let i = 1; i <= 8; i++) {
    const fm = FAILURE_MODES[`F${i}`];
    assert.ok(fm && typeof fm.name === 'string' && fm.name.length > 0, `F${i} missing`);
  }
});

test('F2 is Sycophancy and links to the thesis post', () => {
  assert.equal(FAILURE_MODES.F2.name, 'Sycophancy');
  assert.equal(theoryLink('F2'), 'https://voodootikigod.com/adlc-1-models-arent-human');
});
```

- [ ] **Step 2: Run them to confirm they fail**

```bash
node --test apps/docs/test/phase-diagram.test.mjs apps/docs/test/failure-mode.test.mjs
```
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement the pure-logic modules**

Create `apps/docs/lib/phase-graph.mjs`:

```js
export const PHASES = [
  { id: 'P0', name: 'Triage' },
  { id: 'P1', name: 'Interrogate' },
  { id: 'P2', name: 'Decompose' },
  { id: 'P3', name: 'Rail' },
  { id: 'P4', name: 'Build' },
  { id: 'P5', name: 'Prosecute' },
  { id: 'P6', name: 'Review' },
  { id: 'P7', name: 'Distill' },
];

export function buildPhaseMermaid(active) {
  if (!PHASES.some((p) => p.id === active)) {
    throw new Error(`unknown phase: ${active}`);
  }
  const nodes = PHASES.map((p) => `  ${p.id}["${p.id} ${p.name}"]`).join('\n');
  const edges = PHASES.slice(1)
    .map((p, i) => `  ${PHASES[i].id} --> ${p.id}`)
    .join('\n');
  const style = `  style ${active} fill:#4fb4d8,stroke:#cbcdd2,color:#1c1d21`;
  return `flowchart TD\n${nodes}\n${edges}\n${style}`;
}
```

Create `apps/docs/lib/failure-modes.mjs`:

```js
export const FAILURE_MODES = {
  F1: { name: 'Premature satisfaction' },
  F2: { name: 'Sycophancy' },
  F3: { name: 'Context rot' },
  F4: { name: 'Confident hallucination' },
  F5: { name: 'Reward hacking' },
  F6: { name: 'Finding-count prior' },
  F7: { name: 'Generative bloat' },
  F8: { name: 'Coherence loss' },
};
```

- [ ] **Step 4: Run the tests to confirm they pass**

```bash
node --test apps/docs/test/phase-diagram.test.mjs apps/docs/test/failure-mode.test.mjs
```
Expected: PASS (5 tests total).

- [ ] **Step 5: Create the client Mermaid component**

Create `apps/docs/components/mermaid.tsx`:

```tsx
'use client';
import { useEffect, useId, useRef, useState } from 'react';

export function Mermaid({ chart }: { chart: string }) {
  const id = useId().replace(/[:]/g, '');
  const ref = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = useState('');

  useEffect(() => {
    let active = true;
    import('mermaid').then(async ({ default: mermaid }) => {
      mermaid.initialize({ startOnLoad: false, theme: 'dark', darkMode: true });
      const { svg } = await mermaid.render(`m${id}`, chart);
      if (active) setSvg(svg);
    });
    return () => {
      active = false;
    };
  }, [chart, id]);

  return <div ref={ref} dangerouslySetInnerHTML={{ __html: svg }} />;
}
```

Install the runtime dep for the docs app only:

```bash
npm install mermaid --workspace @adlc/docs
```

- [ ] **Step 6: Create PhaseDiagram and FailureMode components**

Create `apps/docs/components/phase-diagram.tsx`:

```tsx
import { buildPhaseMermaid } from '@/lib/phase-graph.mjs';
import { theoryLink } from '@/lib/theory-links.mjs';
import { Mermaid } from './mermaid';

export function PhaseDiagram({ phase }: { phase: string }) {
  return (
    <figure className="my-4">
      <Mermaid chart={buildPhaseMermaid(phase)} />
      <figcaption className="text-sm" style={{ color: '#686b78' }}>
        ADLC lifecycle — <a href={theoryLink(phase)}>read the theory for {phase}</a>
      </figcaption>
    </figure>
  );
}
```

Create `apps/docs/components/failure-mode.tsx`:

```tsx
import { FAILURE_MODES } from '@/lib/failure-modes.mjs';
import { theoryLink } from '@/lib/theory-links.mjs';

export function FailureMode({ id }: { id: keyof typeof FAILURE_MODES }) {
  const fm = FAILURE_MODES[id];
  if (!fm) return null;
  return (
    <div
      className="my-4 rounded-md border-l-4 p-3"
      style={{ borderColor: '#ef7c2a', background: '#2f3137' }}
    >
      <strong>{id} — {fm.name}</strong>{' '}
      <a href={theoryLink(id)} className="text-sm">(theory ↗)</a>
    </div>
  );
}
```

(Confirm the `@/` path alias exists in `tsconfig.json` from the scaffold; if not, use relative imports.)

- [ ] **Step 7: Register components for MDX**

In `apps/docs/mdx-components.tsx`, merge these into the returned components map:

```tsx
import { PhaseDiagram } from '@/components/phase-diagram';
import { FailureMode } from '@/components/failure-mode';
import { Mermaid } from '@/components/mermaid';
// ...
export function getMDXComponents(components?) {
  return { ...defaultMdxComponents, PhaseDiagram, FailureMode, Mermaid, ...components };
}
```

- [ ] **Step 8: Build to confirm components compile**

```bash
npm run build --workspace @adlc/docs
```
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/docs/lib/phase-graph.mjs apps/docs/lib/failure-modes.mjs apps/docs/components apps/docs/mdx-components.tsx apps/docs/test/phase-diagram.test.mjs apps/docs/test/failure-mode.test.mjs apps/docs/package.json apps/docs/package-lock.json
git commit -m "feat(docs): PhaseDiagram + FailureMode + Mermaid components (TDD logic)"
```

---

## Task 5: Navigation IA — meta.json + section stubs

**Files:**
- Create/modify: `apps/docs/content/docs/meta.json` and section trees under `toolkit/`, `integrations/`, `reference/`.

**Interfaces:**
- Produces: the full sidebar IA; every section present, fan-out pages are stubs.

- [ ] **Step 1: Top-level order**

Create `apps/docs/content/docs/meta.json`:

```json
{
  "title": "Docs",
  "pages": ["index", "getting-started", "theory", "lifecycle", "toolkit", "integrations", "reference"]
}
```

- [ ] **Step 2: Toolkit group meta**

Create `apps/docs/content/docs/toolkit/meta.json`:

```json
{
  "title": "Toolkit",
  "pages": [
    "index",
    "---Spec & ticket shaping---",
    "parallax", "spec-lint", "premortem", "coldstart",
    "---Execution supervision & rails---",
    "preflight", "model-router", "merge-forecast", "rails-guard", "flail-detector", "consensus-fix", "runner",
    "---Review evidence & calibration---",
    "behavior-diff", "gate-manifest", "hollow-test", "prosecute", "review-calibration", "model-ratchet", "gate-fuzzing",
    "---Compounding defenses---",
    "lesson-foundry", "rejection-mining", "skill-rot",
    "---Shared foundation---",
    "cli", "core"
  ]
}
```

- [ ] **Step 3: Integrations + reference meta**

Create `apps/docs/content/docs/integrations/meta.json`:

```json
{ "title": "Integrations", "pages": ["index", "claude-code", "codex", "cursor", "opencode", "pi"] }
```

Create `apps/docs/content/docs/reference/meta.json`:

```json
{ "title": "Reference", "pages": ["index", "conventions", "exit-codes", "adlc-runtime", "adrs"] }
```

- [ ] **Step 4: Generate stub pages for fan-out**

Run this script from `apps/docs` to create stubs for every not-yet-authored page (the exemplar pages `spec-lint` and `claude-code` and the hand-authored pages are created in later tasks and must NOT be overwritten — the script skips existing files):

```bash
cd /home/voodootikigod/Projects/voodootikigod/adlc/.worktrees/docs-site/apps/docs
mkstub() { # $1 = path, $2 = title
  [ -f "$1" ] && return 0
  mkdir -p "$(dirname "$1")"
  printf -- '---\ntitle: %s\ndescription: %s documentation (coming soon).\n---\n\n# %s\n\nThis page is being written. In the meantime, see the [toolkit overview](/docs/toolkit) and the [ADLC theory](/docs/theory).\n' "$2" "$2" "$2" > "$1"
}
# toolkit stubs (spec-lint authored in Task 9 — skipped if present)
for t in parallax spec-lint premortem coldstart preflight model-router merge-forecast rails-guard flail-detector consensus-fix runner behavior-diff gate-manifest hollow-test prosecute review-calibration model-ratchet gate-fuzzing lesson-foundry rejection-mining skill-rot cli core; do
  mkstub "content/docs/toolkit/$t.mdx" "$t"
done
# integration stubs (claude-code authored in Task 10 — skipped if present)
for i in claude-code codex cursor opencode pi; do
  mkstub "content/docs/integrations/$i.mdx" "$i"
done
# reference stubs
mkstub content/docs/reference/conventions.mdx "Conventions"
mkstub content/docs/reference/exit-codes.mdx "Exit codes"
mkstub content/docs/reference/adlc-runtime.mdx ".adlc/ runtime"
mkstub content/docs/reference/adrs.mdx "ADRs"
# section index stubs
mkstub content/docs/toolkit/index.mdx "Toolkit"
mkstub content/docs/integrations/index.mdx "Integrations"
mkstub content/docs/reference/index.mdx "Reference"
mkstub content/docs/getting-started.mdx "Getting started"
```

- [ ] **Step 5: Build and verify the sidebar renders all sections**

```bash
npm run build --workspace @adlc/docs
```
Expected: PASS; build output lists routes for all toolkit/integration/reference pages.

- [ ] **Step 6: Commit**

```bash
git add apps/docs/content/docs
git commit -m "feat(docs): navigation IA + fan-out stub pages"
```

---

## Task 6: Home landing page

**Files:**
- Modify: `apps/docs/app/(home)/page.tsx`
- Modify: `apps/docs/app/layout.config.tsx` (nav title + GitHub link)

**Interfaces:**
- Consumes: `theoryLink`.

- [ ] **Step 1: Set the nav title and repo link**

In `apps/docs/app/layout.config.tsx`, set `nav.title` to `ADLC` and add a GitHub link to `https://github.com/voodootikigod/adlc`.

- [ ] **Step 2: Write the landing page**

Replace `apps/docs/app/(home)/page.tsx` with a hero that states the thesis and links out. Use the palette inline; keep it a server component:

```tsx
import Link from 'next/link';
import { theoryLink } from '@/lib/theory-links.mjs';

export default function HomePage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="text-4xl font-bold" style={{ color: '#4fb4d8' }}>
        The Agentic Development Lifecycle
      </h1>
      <p className="mt-4 text-lg">
        The SDLC is 60 years of defenses against <em>human</em> failure modes.
        Models fail differently — premature satisfaction, sycophancy, context rot,
        confident hallucination, reward hacking. ADLC redesigns every phase, gate,
        and loop around <em>those</em> flaws.
      </p>
      <div className="mt-8 flex gap-4">
        <Link href="/docs" className="rounded-md px-4 py-2 font-medium"
          style={{ background: '#4fb4d8', color: '#1c1d21' }}>
          Read the docs
        </Link>
        <a href={theoryLink('toolkit')} className="rounded-md px-4 py-2 font-medium"
          style={{ border: '1px solid #3f4044' }}>
          The theory ↗
        </a>
      </div>
      <pre className="mt-8 rounded-md p-4" style={{ background: '#2f3137' }}>
{`npm install -g @adlc/cli
npx plugins add voodootikigod/adlc
adlc spec-lint <spec.md>`}
      </pre>
    </main>
  );
}
```

- [ ] **Step 3: Build and verify**

```bash
npm run build --workspace @adlc/docs
```
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add "apps/docs/app/(home)/page.tsx" apps/docs/app/layout.config.tsx
git commit -m "feat(docs): home landing page"
```

---

## Task 7: Theory & Introduction overview page

**Files:**
- Create: `apps/docs/content/docs/theory/index.mdx`

**Interfaces:**
- Consumes: `<PhaseDiagram>`, `<FailureMode>`.

- [ ] **Step 1: Author the overview**

Create `apps/docs/content/docs/theory/index.mdx`:

```mdx
---
title: Theory & Introduction
description: How the ADLC phases and model failure modes map to the toolkit, with deep links to the original series.
---

# Theory & Introduction

ADLC starts from one claim: agentic development should defend against **model**
failure modes, not human ones. The full argument lives in the
[ADLC series](https://voodootikigod.com/series/adlc) — this page is the map.

## The eight phases, two human gates

<PhaseDiagram phase="P0" />

Eight phases (P0–P7), two human gates (P1 and P6), deterministic checks between
everything. Read [Two Human Gates and Everything Between Is Machine-Checked](https://voodootikigod.com/adlc-2-two-human-gates).

## The model failure modes

<FailureMode id="F1" />
<FailureMode id="F2" />
<FailureMode id="F3" />
<FailureMode id="F4" />
<FailureMode id="F5" />
<FailureMode id="F6" />
<FailureMode id="F7" />
<FailureMode id="F8" />

Every phase, gate, and loop traces to one of these — see
[Stop Running the SDLC on Models That Aren't Human](https://voodootikigod.com/adlc-1-models-arent-human).

## Where to go next

- [The Lifecycle](/docs/lifecycle) — the phase/gate map and which tool runs where.
- [Prosecution, Not Code Review](https://voodootikigod.com/adlc-4-prosecution-not-code-review) — the P5 gate in depth.
- [The ADLC Toolkit](https://voodootikigod.com/adlc-7-built-with-the-lifecycle) — the tools, by phase.
```

- [ ] **Step 2: Build and verify links resolve**

```bash
npm run build --workspace @adlc/docs
```
Expected: PASS; no broken internal-link warnings for `/docs/lifecycle`.

- [ ] **Step 3: Commit**

```bash
git add apps/docs/content/docs/theory/index.mdx
git commit -m "feat(docs): theory & introduction overview with deep links"
```

---

## Task 8: The Lifecycle page

**Files:**
- Create: `apps/docs/content/docs/lifecycle.mdx`

- [ ] **Step 1: Author the lifecycle map**

Create `apps/docs/content/docs/lifecycle.mdx`:

```mdx
---
title: The Lifecycle
description: The ADLC phase and gate map, and which toolkit CLI enforces each gate.
---

# The Lifecycle

<PhaseDiagram phase="P5" />

Each phase has a machine-checkable gate. The toolkit makes those gates concrete.

| Phase | Question the gate answers | Primary tools |
| --- | --- | --- |
| **P0 Triage** | Is the workspace ready for fan-out? | [preflight](/docs/toolkit/preflight) |
| **P1 Interrogate** | Is the spec testable and stress-tested? | [spec-lint](/docs/toolkit/spec-lint), [premortem](/docs/toolkit/premortem), [parallax](/docs/toolkit/parallax) |
| **P2 Decompose** | Can an agent execute this ticket without guessing? | [coldstart](/docs/toolkit/coldstart), [model-router](/docs/toolkit/model-router), [merge-forecast](/docs/toolkit/merge-forecast) |
| **P3–P4 Rail & Build** | Are frozen rails protected; is an agent flailing? | [rails-guard](/docs/toolkit/rails-guard), [flail-detector](/docs/toolkit/flail-detector), [consensus-fix](/docs/toolkit/consensus-fix) |
| **P5 Prosecute** | Did prosecution dry out; did behavior change? | [prosecute](/docs/toolkit/prosecute), [behavior-diff](/docs/toolkit/behavior-diff), [hollow-test](/docs/toolkit/hollow-test), [gate-manifest](/docs/toolkit/gate-manifest) |
| **Calibration** | What must be re-prosecuted after drift? | [model-ratchet](/docs/toolkit/model-ratchet), [review-calibration](/docs/toolkit/review-calibration), [skill-rot](/docs/toolkit/skill-rot), [gate-fuzzing](/docs/toolkit/gate-fuzzing) |
| **P7 Distill** | Which findings become permanent defenses? | [lesson-foundry](/docs/toolkit/lesson-foundry), [rejection-mining](/docs/toolkit/rejection-mining) |

The two human gates sit at **P1** (spec approval) and **P6** (review). Everything
between is deterministic — read
[the full argument](https://voodootikigod.com/adlc-2-two-human-gates).
```

- [ ] **Step 2: Build and verify**

```bash
npm run build --workspace @adlc/docs
```
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/docs/content/docs/lifecycle.mdx
git commit -m "feat(docs): lifecycle phase/gate map page"
```

---

## Task 9: Tool exemplar — `spec-lint` (locks the tool template)

**Files:**
- Create/overwrite: `apps/docs/content/docs/toolkit/spec-lint.mdx`

**Interfaces:**
- Consumes: `<PhaseDiagram>`, `<FailureMode>`. Source content: `docs/tools/spec-lint.md` (repo reference).

- [ ] **Step 1: Author the exemplar tool page**

Overwrite `apps/docs/content/docs/toolkit/spec-lint.mdx` (replacing the Task-5 stub):

```mdx
---
title: spec-lint
description: Audits a spec for acceptance criteria that lack a concrete verification method.
---

# spec-lint

**ADLC phase: P1 Interrogate** · **Gate:** every acceptance criterion names how it will be checked.

<PhaseDiagram phase="P1" />

## What it defends against

<FailureMode id="F1" />

A spec whose criteria can't be checked lets a model declare victory early. `spec-lint`
turns unverifiable criteria into blocking failures.

## Usage

```sh
spec-lint <spec.md> [--llm] [--json] [--prompt-only]
```

| Flag | Description |
| --- | --- |
| `--llm` | Cheap-tier LLM pass on VERIFIED criteria to catch vacuous methods ("works correctly"). Demoted criteria become WISH. |
| `--json` | Machine-readable output for orchestrators. |
| `--prompt-only` | Print the exact LLM prompt and exit 0 — works with zero API keys. |

## Exit codes

<div style={{ display: 'grid', gap: '0.25rem' }}>
  <span style={{ color: '#78bd65' }}>**0** — gate passes: every criterion names a verification method.</span>
  <span style={{ color: '#e5cd52' }}>**1** — operational error (bad input, unreadable file).</span>
  <span style={{ color: '#eb3d54' }}>**2** — gate fails: one or more criteria are wishes.</span>
</div>

## Example

```sh
$ adlc spec-lint spec.md
✗ 2 criteria have no verification method (lines 14, 22)
exit 2
```

## Go deeper

Specs-as-tests and why unverifiable criteria are dangerous:
[Tests Are the Spec](https://voodootikigod.com/adlc-3-tests-are-the-spec).
```

- [ ] **Step 2: Build and verify**

```bash
npm run build --workspace @adlc/docs
```
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/docs/content/docs/toolkit/spec-lint.mdx
git commit -m "feat(docs): spec-lint exemplar page (tool template)"
```

---

## Task 10: Integration exemplar — Claude Code (locks the integration template)

**Files:**
- Create/overwrite: `apps/docs/content/docs/integrations/claude-code.mdx`

**Interfaces:**
- Source content: `docs/integrations/claude-code.md`, `plugins/adlc-claude-code/` (repo reference).

- [ ] **Step 1: Author the exemplar integration page**

Overwrite `apps/docs/content/docs/integrations/claude-code.mdx` (replacing the Task-5 stub). Use Fumadocs `Tabs` for install variants:

```mdx
---
title: Claude Code
description: Adopt the ADLC inside Claude Code — phase-routing skill, gate commands, prosecutor subagent, and hooks that fire the gates automatically.
---

import { Tab, Tabs } from 'fumadocs-ui/components/tabs';

# ADLC in Claude Code

Claude Code runs the whole lifecycle from inside the editor: a phase-routing
skill, ticket/distill/maintain commands, a prosecutor subagent, and hooks that
fire the gates automatically. No API keys — Claude is the model via `--prompt-only`.

## Install

<Tabs items={['plugins (recommended)', 'Native marketplace']}>
  <Tab value="plugins (recommended)">

```sh
npx plugins add voodootikigod/adlc   # install the plugin into your agent tool(s)
npm install -g @adlc/cli             # the gate toolkit the plugin shells out to
/adlc-init                           # bootstrap .adlc/ in your repo (once)
```

  </Tab>
  <Tab value="Native marketplace">

```sh
npm install -g @adlc/cli
/plugin marketplace add voodootikigod/adlc
/plugin install adlc@adlc
/adlc-init
```

  </Tab>
</Tabs>

## How each phase maps into Claude Code

| ADLC phase | Mechanism | Claude Code vector |
| --- | --- | --- |
| **P0 Triage** | `/adlc-ticket` | Slash command authors & triages a ticket into `.adlc/tickets.json`. |
| **P1 Interrogate** | `adlc spec-lint`, `parallax` | Phase-routing skill runs the spec gates. |
| **P2 Decompose** | `adlc coldstart`, `model-router` | Skill resolves ticket scope and routes work by tier. |
| **P3–P4 Rail & Build** | `adlc rails-guard` | Hook blocks edits to frozen rails on every structured edit. |
| **P5 Prosecute** | `prosecute` + prosecutor subagent | Fresh-context, refute-chartered review before merge. |
| **P7 Distill** | `/adlc-distill` | Turns repeated findings into deterministic defenses. |

## What gets installed

- **Skill:** phase router (`/adlc`) that picks the right gate.
- **Commands:** `/adlc-init`, `/adlc-ticket`, `/adlc-distill`, `/adlc-maintain`.
- **Subagent:** `adlc:prosecutor` — the P5 pre-merge gate.
- **Hooks:** structured-edit rails-guard + CI backstop.

Source: [`plugins/adlc-claude-code/`](https://github.com/voodootikigod/adlc/tree/main/plugins/adlc-claude-code).

## Go deeper

The prosecution gate this integration automates:
[Prosecution, Not Code Review](https://voodootikigod.com/adlc-4-prosecution-not-code-review).
```

- [ ] **Step 2: Build and verify Tabs render**

```bash
npm run build --workspace @adlc/docs
```
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/docs/content/docs/integrations/claude-code.mdx
git commit -m "feat(docs): Claude Code exemplar page (integration template)"
```

---

## Task 11: Deploy config + final gates

**Files:**
- Create: `apps/docs/vercel.json`, `apps/docs/README.md`

- [ ] **Step 1: Document the Vercel root directory**

Create `apps/docs/vercel.json`:

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "framework": "nextjs",
  "buildCommand": "next build"
}
```

Create `apps/docs/README.md` explaining: this is the private `@adlc/docs` site; on Vercel set **Root Directory = `apps/docs`**; local dev is `npm run dev --workspace @adlc/docs`; deployment is maintainer-triggered.

- [ ] **Step 2: Run the docs unit tests**

```bash
cd /home/voodootikigod/Projects/voodootikigod/adlc/.worktrees/docs-site
node --test apps/docs/test/*.test.mjs
```
Expected: PASS (theory-links + phase-diagram + failure-mode).

- [ ] **Step 3: Final build gate**

```bash
npm run build --workspace @adlc/docs
```
Expected: PASS.

- [ ] **Step 4: Isolation gate — packages tests still green**

```bash
npm test
```
Expected: PASS, unchanged from `main`.

- [ ] **Step 5: Commit**

```bash
git add apps/docs/vercel.json apps/docs/README.md
git commit -m "chore(docs): vercel config + docs README"
```

- [ ] **Step 6: Wire docs tests into the repo test script (optional, recommend)**

If the maintainer wants the docs logic tests in CI, append to root `package.json` `test` script: `&& node --test apps/docs/test/*.test.mjs`. Verify `npm test` still passes. Commit as `chore(docs): run docs unit tests in npm test`.

---

## Self-Review

**Spec coverage:**
- Fresh authored MDX, apps/docs on Vercel → Task 1, 11. ✓
- Dark-only An Old Hope theme → Task 2 (+ Global Constraints). ✓
- Full nav IA with stubs → Task 5. ✓
- Home / theory / lifecycle / spec-lint / Claude Code exemplars → Tasks 6–10. ✓
- Theory deep-links via single map → Task 3, consumed in 4/6/7/8/9/10. ✓
- Shared illustrative components (PhaseDiagram, FailureMode, mermaid) → Task 4. ✓
- Search (Orama) → default from scaffold (Task 1); no removal step needed. ✓
- Build gate + isolation (root npm test unchanged) → Task 1 Step 5, Task 11. ✓
- Gate-semantic colors → Task 2 tokens + Task 9 exit-code block. ✓
- No fabricated URLs → Task 3 fallback + verified series slugs. ✓

**Placeholder scan:** No "TBD"/"handle edge cases"/"similar to Task N" — code and content are shown in full. The only "coming soon" text is the *intended product content* of fan-out stubs (Task 5), which is deliberate, not a plan placeholder.

**Type consistency:** `theoryLink(id)` / `SERIES_BASE` (Task 3) used consistently in Tasks 4/6/7. `buildPhaseMermaid(active)` / `PHASES` (Task 4) match their tests. `FAILURE_MODES['F1'..'F8']` shape consistent across Task 4 test, module, and component. `<PhaseDiagram phase>` / `<FailureMode id>` props consistent across component defs and MDX usage (Tasks 7–9).

**Note on F-count:** the spec text referenced F1–F5; the canonical series defines **F1–F8**. The plan implements the full F1–F8 set (Global Constraints + Task 4), a superset that satisfies the spec.

**Fan-out (post-first-cut):** remaining 22 tool pages + 4 integration pages + 4 reference pages become per-page ADLC tickets, each cloning the Task 9 / Task 10 templates. Out of scope for this plan.
