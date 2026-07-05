# agenticlifecycle.ai Marketing Site Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the enterprise-targeted marketing site for the ADLC inside the existing `apps/docs` Next.js app, per the approved spec at `docs/marketing/2026-07-05-adlc-marketing-site-design.md`.

**Architecture:** Marketing routes live in the existing `(home)` route group of `apps/docs`; Fumadocs keeps `/docs/**` untouched. All explanatory diagrams are React/SVG components driven by tested `.mjs` data modules (the repo's established pattern — data modules get node:test TDD; components are validated by `tsc` + `next build`, not DOM render tests). Generated atmosphere imagery is produced by a zero-dependency script from a checked-in manifest, with CSS-gradient fallbacks so the site builds and ships without any image assets.

**Tech Stack:** Next.js 16 App Router, Tailwind v4, Fumadocs v16 (existing), node:test, zero new npm dependencies.

## Global Constraints

- **Working directory:** all paths are relative to the repo root in worktree `.worktrees/adlc-site`, branch `feat/adlc-site`.
- **Zero new npm dependencies.** No GSAP, no framer-motion, no image libraries. CSS keyframes + built-in `fetch` only.
- **Dark-only theme.** Use the existing tokens from `apps/docs/app/global.css`: bg `#1c1d21`, fg `#cbcdd2`, muted-fg `#686b78`, card `#26272c`, border `#3f4044`, accent `#4fb4d8`, gate colors `var(--adlc-pass)` `#78bd65` / `var(--adlc-fail)` `#eb3d54` / `var(--adlc-wish)` `#e5cd52`, highlight `#ef7c2a`.
- **Gate states are never color-only** — always icon/glyph + text label (spec §4 accessibility criteria).
- **All motion respects `prefers-reduced-motion`** with a static fallback.
- **Explanatory content is designed components with real text**, never generated images (spec §4 rule).
- **Canonical citations:** every concept page links its theory post via `theoryLink()` from `apps/docs/lib/theory-links.mjs`. Canonical source is `https://voodootikigod.com/series/adlc`.
- **Hero headline (verbatim):** "Your agents don't fail like humans. Stop managing them like humans."
- **Primary domain for metadata:** `https://agenticlifecycle.ai`.
- **Tests:** node:test `.test.mjs` files in `apps/docs/test/` — they are already picked up by the root `npm test` glob (`node --test apps/docs/test/*.test.mjs`). Run a single file with `node --test apps/docs/test/<file>.test.mjs` from the repo root.
- **Typecheck/build:** `cd apps/docs && npx fumadocs-mdx && npx tsc --noEmit` (fast gate) and `npm run build --workspace @adlc/docs` (full gate). Do not run builds in parallel with other worktrees.
- **Hollow-test guardrails** (from P5 prosecution lessons): tests assert *structure and grounding against the filesystem/other modules* (slugs resolve to real files, ids cross-reference PHASES), not exact-value restatements of the data map being tested.
- **Commits:** conventional format, scope `site` — e.g. `feat(site): add integration facts module`.

## File Structure

```
apps/docs/
├─ lib/
│  ├─ integration-facts.mjs        (NEW  T1: 6 integrations — slug/name/status/install, grounded)
│  ├─ failure-modes.mjs            (MOD  T2: add tagline + defense per F1–F8)
│  ├─ toolkit-packages.mjs         (NEW  T3: phase-grouped package list, grounded)
│  ├─ vs-sdlc.mjs                  (NEW  T4: SDLC-vs-ADLC comparison rows)
│  ├─ routes.mjs                   (NEW  T5: marketing route list, grounded to page files)
│  └─ image-manifest.mjs           (NEW  T11: manifest loader + validator)
├─ assets/
│  └─ images.json                  (NEW  T11: generated-image manifest w/ prompts + provenance)
├─ scripts/
│  ├─ generate-images.mjs          (NEW  T11: GPT-image / Gemini generation script)
│  └─ check-links.mjs              (NEW  T13: sitemap + legacy-URL link check)
├─ components/marketing/
│  ├─ section.tsx                  (NEW  T6: section wrapper)
│  ├─ gate-badge.tsx               (NEW  T6: glyph+label gate state)
│  ├─ terminal-card.tsx            (NEW  T6: terminal-styled card)
│  ├─ backdrop.tsx                 (NEW  T6: generated image w/ gradient fallback)
│  ├─ gate-sequence.tsx            (NEW  T7: hero gate animation, CSS-only)
│  ├─ lifecycle-pipeline.tsx       (NEW  T8: P0–P7 pipeline diagram)
│  ├─ three-dials.tsx              (NEW  T8: autonomy/oversight/scope gauges)
│  ├─ failure-map.tsx              (NEW  T9: F1–F8 → defense map)
│  ├─ vs-table.tsx                 (NEW  T9: comparison diagram/table)
│  ├─ constellation.tsx            (NEW  T10: toolkit grouped by phase)
│  ├─ integration-card.tsx         (NEW  T10: agent card w/ install command)
│  └─ evidence-trail.tsx           (NEW  T12: ticket→gates→manifest→merge chain)
├─ app/
│  ├─ layout.tsx                   (MOD  T5: metadataBase + default OG metadata)
│  ├─ global.css                   (MOD  T6: marketing keyframes + reduced-motion guard)
│  ├─ sitemap.ts                   (NEW  T13: marketing + docs routes)
│  └─ (home)/
│     ├─ page.tsx                  (MOD  T7: full landing page, replaces placeholder)
│     ├─ lifecycle/page.tsx        (NEW  T8)
│     ├─ failure-modes/page.tsx    (NEW  T9)
│     ├─ vs-sdlc/page.tsx          (NEW  T9)
│     ├─ toolkit/page.tsx          (NEW  T10)
│     ├─ integrations/page.tsx     (NEW  T10: hub)
│     ├─ integrations/[slug]/page.tsx (NEW T10: per-agent)
│     └─ enterprise/page.tsx       (NEW  T12)
├─ lib/layout.shared.tsx           (MOD  T5: nav links)
└─ public/generated/               (T11 output; gitignored until assets are committed deliberately)

apps/docs/test/
├─ integration-facts.test.mjs      (NEW T1)
├─ failure-modes-defenses.test.mjs (NEW T2)
├─ toolkit-packages.test.mjs       (NEW T3)
├─ vs-sdlc.test.mjs                (NEW T4)
├─ routes.test.mjs                 (NEW T5)
├─ image-manifest.test.mjs         (NEW T11)
└─ check-links.test.mjs            (NEW T13)
```

Deployment (§6 of the spec) is a manual maintainer checklist — Task 15.

---

### Task 1: Integration facts module

The single source of truth for the six agent integrations: slug, display name, maturity status, install commands. Grounded in `docs/integrations/*.md` — the test fails if a slug has no ground-truth doc or no docs-site page, so a bad slug can't ship a 404 (spec §7).

**Files:**
- Create: `apps/docs/lib/integration-facts.mjs`
- Test: `apps/docs/test/integration-facts.test.mjs`

**Interfaces:**
- Produces: `INTEGRATIONS` — array of `{ slug, name, status, tagline, install: string[], note? }`; `integrationFor(slug)` → entry or `undefined`. `status` ∈ `'installer' | 'source' | 'local'` (installer = `npx plugins add` works; source = install from repo checkout; local = local-path plugin install).

- [ ] **Step 1: Write the failing test**

```js
// apps/docs/test/integration-facts.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { INTEGRATIONS, integrationFor } from '../lib/integration-facts.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..', '..', '..');

test('slugs are unique', () => {
  const slugs = INTEGRATIONS.map((i) => i.slug);
  assert.equal(new Set(slugs).size, INTEGRATIONS.length);
});

test('module covers every docs-site integration page (derived, not hardcoded)', () => {
  // Bidirectional grounding: a new content/docs/integrations/<slug>.mdx page
  // without a marketing entry fails here, pointing at exactly what to add.
  const pagesDir = path.join(__dirname, '..', 'content', 'docs', 'integrations');
  const pageSlugs = readdirSync(pagesDir)
    .filter((f) => f.endsWith('.mdx') && f !== 'index.mdx')
    .map((f) => f.replace(/\.mdx$/, ''))
    .sort();
  const moduleSlugs = INTEGRATIONS.map((i) => i.slug).sort();
  assert.deepEqual(moduleSlugs, pageSlugs);
});

test('every integration is grounded in a docs/integrations ground-truth file', () => {
  for (const i of INTEGRATIONS) {
    const p = path.join(repoRoot, 'docs', 'integrations', `${i.slug}.md`);
    assert.ok(existsSync(p), `${i.slug}: missing ground truth ${p}`);
  }
});

test('every integration has a name, tagline, valid status, and at least one install command', () => {
  for (const i of INTEGRATIONS) {
    assert.ok(i.name.length > 0, `${i.slug}: name`);
    assert.ok(i.tagline.length > 0, `${i.slug}: tagline`);
    assert.ok(['installer', 'source', 'local'].includes(i.status), `${i.slug}: status "${i.status}"`);
    assert.ok(Array.isArray(i.install) && i.install.length > 0, `${i.slug}: install commands`);
    for (const cmd of i.install) assert.ok(cmd.trim().length > 0, `${i.slug}: empty install command`);
  }
});

test('integrationFor resolves known slugs and returns undefined for unknown', () => {
  assert.equal(integrationFor('claude-code')?.name, 'Claude Code');
  assert.equal(integrationFor('nope'), undefined);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from repo root): `node --test apps/docs/test/integration-facts.test.mjs`
Expected: FAIL — `Cannot find module '.../lib/integration-facts.mjs'`

- [ ] **Step 3: Write the implementation**

Install commands below are copied from `docs/integrations/*.md` (§Install of each). Before finalizing, re-read each file's Install section and correct any drift — the ground-truth docs win over this plan.

```js
// apps/docs/lib/integration-facts.mjs
// Single source of truth for the native-integration marketing pages.
// Grounded in docs/integrations/<slug>.md — the test cross-checks existence.

export const INTEGRATIONS = [
  {
    slug: 'claude-code',
    name: 'Claude Code',
    status: 'installer',
    tagline: 'Full plugin: gates as slash commands, rails-guard hooks, P5 prosecutor subagent.',
    install: [
      'npx plugins add voodootikigod/adlc',
      'npm install -g @adlc/cli',
    ],
  },
  {
    slug: 'codex',
    name: 'Codex',
    status: 'source',
    tagline: 'Native skills and hooks for the Codex CLI, including the prosecute review gate.',
    install: [
      'git clone https://github.com/voodootikigod/adlc && cd adlc',
      'node scripts/codex-install-smoke.mjs .',
    ],
    note: 'Git-backed marketplace install is not yet supported — install from a repo checkout.',
  },
  {
    slug: 'cursor',
    name: 'Cursor',
    status: 'source',
    tagline: 'Hooks, rules, and commands scaffolded into .cursor/ — no plugin runtime needed.',
    install: [
      'npm install -g @adlc/cli',
      'node /path/to/adlc/plugins/adlc-cursor/lib/scaffold-cli.mjs .',
    ],
    note: '@adlc/cursor-package is not yet on npm — scaffold from a repo checkout.',
  },
  {
    slug: 'opencode',
    name: 'OpenCode',
    status: 'source',
    tagline: 'Rails-guard plugin plus /adlc-* commands and agents for OpenCode.',
    install: [
      'git clone https://github.com/voodootikigod/adlc',
      '# register plugins/adlc-opencode in .opencode/opencode.json, then /adlc-init',
    ],
    note: '@adlc/opencode-package is not yet on npm — install from source.',
  },
  {
    slug: 'pi',
    name: 'Pi',
    status: 'source',
    tagline: 'Proactive and reactive gating via Pi tool_call/tool_result hooks, with TUI gate display.',
    install: [
      'git clone https://github.com/voodootikigod/adlc',
      '# package lives at plugins/adlc-pi — see the integration guide',
    ],
  },
  {
    slug: 'antigravity',
    name: 'Google Antigravity',
    status: 'local',
    tagline: 'Advisory rails-guard PreToolUse hook plus a CI backstop for frozen rails.',
    install: [
      'agy plugin install /abs/path/to/adlc/plugins/adlc-antigravity',
    ],
    note: 'Local-checkout install is the verified path; marketplace + universal installer are planned.',
  },
];

export function integrationFor(slug) {
  return INTEGRATIONS.find((i) => i.slug === slug);
}
```

- [ ] **Step 4: Verify install-command accuracy against ground truth**

Re-read the `## Install` section of each `docs/integrations/<slug>.md` and fix any command that drifted. This is a correctness step, not optional.

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test apps/docs/test/integration-facts.test.mjs`
Expected: PASS (5 tests)

- [ ] **Step 6: Commit**

```bash
git add apps/docs/lib/integration-facts.mjs apps/docs/test/integration-facts.test.mjs
git commit -m "feat(site): add grounded integration-facts module"
```

---

### Task 2: Failure-mode defenses

Extend `FAILURE_MODES` with a `tagline` (one-liner for the landing grid) and a `defense` (which toolkit gate kills this failure mode, and in which phase). Existing tests assert the exact `name` values — do not change any `name`.

**Files:**
- Modify: `apps/docs/lib/failure-modes.mjs`
- Test: `apps/docs/test/failure-modes-defenses.test.mjs`

**Interfaces:**
- Consumes: `PHASES` from `apps/docs/lib/phase-graph.mjs` (ids `P0`–`P7`).
- Produces: each `FAILURE_MODES[Fn]` gains `tagline: string` and `defense: { tool: string, phase: string }` where `tool` is a `packages/<tool>` directory name.

- [ ] **Step 1: Write the failing test**

Structure + grounding assertions only — no exact-value restatement of the map (hollow-test guardrail).

```js
// apps/docs/test/failure-modes-defenses.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { FAILURE_MODES } from '../lib/failure-modes.mjs';
import { PHASES } from '../lib/phase-graph.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packagesDir = path.join(__dirname, '..', '..', '..', 'packages');
const phaseIds = new Set(PHASES.map((p) => p.id));

test('every failure mode F1–F8 has a non-empty tagline', () => {
  for (let i = 1; i <= 8; i++) {
    const fm = FAILURE_MODES[`F${i}`];
    assert.ok(fm?.tagline?.length > 10, `F${i}: tagline missing or too short`);
  }
});

test('every defense names a real toolkit package and a real phase', () => {
  for (let i = 1; i <= 8; i++) {
    const { defense } = FAILURE_MODES[`F${i}`];
    assert.ok(defense, `F${i}: defense missing`);
    assert.ok(
      existsSync(path.join(packagesDir, defense.tool)),
      `F${i}: defense.tool "${defense.tool}" is not a packages/ directory`
    );
    assert.ok(phaseIds.has(defense.phase), `F${i}: defense.phase "${defense.phase}" not in PHASES`);
  }
});

test('names are unchanged (guard against accidental edits)', () => {
  assert.equal(FAILURE_MODES.F1.name, 'Premature satisfaction');
  assert.equal(FAILURE_MODES.F8.name, 'Coherence loss');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test apps/docs/test/failure-modes-defenses.test.mjs`
Expected: FAIL — taglines/defenses missing

- [ ] **Step 3: Write the implementation**

Verify each mapping against the F1–F8 definitions in `ADLC.md` (repo root) before committing; adjust `tool`/`phase` if the thesis names a more direct defense. Taglines are marketing copy — keep them sharp.

```js
// apps/docs/lib/failure-modes.mjs
export const FAILURE_MODES = {
  F1: {
    name: 'Premature satisfaction',
    tagline: 'Declares victory the moment code plausibly compiles.',
    defense: { tool: 'prosecute', phase: 'P5' },
  },
  F2: {
    name: 'Sycophancy',
    tagline: 'Agrees with whatever framing the prompt implies.',
    defense: { tool: 'premortem', phase: 'P1' },
  },
  F3: {
    name: 'Context rot',
    tagline: 'Loses the plot as the session grows.',
    defense: { tool: 'coldstart', phase: 'P2' },
  },
  F4: {
    name: 'Confident hallucination',
    tagline: 'Invents APIs, files, and facts with total certainty.',
    defense: { tool: 'behavior-diff', phase: 'P6' },
  },
  F5: {
    name: 'Reward hacking',
    tagline: 'Games the check instead of doing the work.',
    defense: { tool: 'hollow-test', phase: 'P5' },
  },
  F6: {
    name: 'Finding-count prior',
    tagline: 'Manufactures findings to look thorough.',
    defense: { tool: 'review-calibration', phase: 'P6' },
  },
  F7: {
    name: 'Generative bloat',
    tagline: 'Writes ten files where a diff would do.',
    defense: { tool: 'flail-detector', phase: 'P4' },
  },
  F8: {
    name: 'Coherence loss',
    tagline: 'Parallel work drifts into contradiction.',
    defense: { tool: 'merge-forecast', phase: 'P4' },
  },
};
```

- [ ] **Step 4: Run new AND existing tests**

Run: `node --test apps/docs/test/failure-modes-defenses.test.mjs apps/docs/test/failure-mode.test.mjs`
Expected: PASS — both files (existing name assertions must still hold)

- [ ] **Step 5: Commit**

```bash
git add apps/docs/lib/failure-modes.mjs apps/docs/test/failure-modes-defenses.test.mjs
git commit -m "feat(site): map each failure mode to its defending gate"
```

---

### Task 3: Toolkit packages module

Phase-grouped package list for `/toolkit` and the constellation diagram, grounded bidirectionally against `packages/*`.

**Files:**
- Create: `apps/docs/lib/toolkit-packages.mjs`
- Test: `apps/docs/test/toolkit-packages.test.mjs`

**Interfaces:**
- Produces: `TOOLKIT_GROUPS` — `[{ group: string, packages: string[] }]` (group labels match the README table); `ALL_PACKAGES` — flat string array.

- [ ] **Step 1: Write the failing test**

```js
// apps/docs/test/toolkit-packages.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { TOOLKIT_GROUPS, ALL_PACKAGES } from '../lib/toolkit-packages.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packagesDir = path.join(__dirname, '..', '..', '..', 'packages');

test('listed packages and packages/ directories match exactly (bijective)', () => {
  const onDisk = readdirSync(packagesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  assert.deepEqual([...ALL_PACKAGES].sort(), onDisk);
});

test('no package appears in two groups', () => {
  assert.equal(new Set(ALL_PACKAGES).size, ALL_PACKAGES.length);
});

test('every package has a toolkit docs page', () => {
  for (const name of ALL_PACKAGES) {
    const p = path.join(__dirname, '..', 'content', 'docs', 'toolkit', `${name}.mdx`);
    assert.ok(existsSync(p), `missing docs page for ${name}`);
  }
});

test('groups are non-empty and labeled', () => {
  assert.ok(TOOLKIT_GROUPS.length >= 4);
  for (const g of TOOLKIT_GROUPS) {
    assert.ok(g.group.length > 0);
    assert.ok(g.packages.length > 0);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test apps/docs/test/toolkit-packages.test.mjs`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

Group labels and membership copied from the README toolkit table. The bijective test will surface any drift from `packages/` — fix the module (or flag a genuinely missing docs page) rather than weakening the test.

```js
// apps/docs/lib/toolkit-packages.mjs
export const TOOLKIT_GROUPS = [
  {
    group: 'Spec & ticket shaping',
    packages: ['parallax', 'spec-lint', 'premortem', 'coldstart'],
  },
  {
    group: 'Execution supervision & rails',
    packages: ['preflight', 'model-router', 'merge-forecast', 'rails-guard', 'flail-detector', 'consensus-fix', 'runner'],
  },
  {
    group: 'Review evidence & calibration',
    packages: ['behavior-diff', 'gate-manifest', 'hollow-test', 'prosecute', 'review-calibration', 'model-ratchet', 'gate-fuzzing'],
  },
  {
    group: 'Compounding defenses',
    packages: ['lesson-foundry', 'rejection-mining', 'skill-rot'],
  },
  {
    group: 'Shared foundation',
    packages: ['cli', 'core'],
  },
];

export const ALL_PACKAGES = TOOLKIT_GROUPS.flatMap((g) => g.packages);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test apps/docs/test/toolkit-packages.test.mjs`
Expected: PASS. If the bijective test fails, `ls packages/` and reconcile the module.

- [ ] **Step 5: Commit**

```bash
git add apps/docs/lib/toolkit-packages.mjs apps/docs/test/toolkit-packages.test.mjs
git commit -m "feat(site): add phase-grouped toolkit packages module"
```

---

### Task 4: vs-SDLC comparison data

**Files:**
- Create: `apps/docs/lib/vs-sdlc.mjs`
- Test: `apps/docs/test/vs-sdlc.test.mjs`

**Interfaces:**
- Produces: `VS_SDLC_ROWS` — `[{ dimension, sdlc, adlc }]`, all strings.

- [ ] **Step 1: Write the failing test**

```js
// apps/docs/test/vs-sdlc.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VS_SDLC_ROWS } from '../lib/vs-sdlc.mjs';

test('at least five comparison rows, unique dimensions, all cells filled', () => {
  assert.ok(VS_SDLC_ROWS.length >= 5);
  const dims = VS_SDLC_ROWS.map((r) => r.dimension);
  assert.equal(new Set(dims).size, dims.length, 'duplicate dimension');
  for (const r of VS_SDLC_ROWS) {
    assert.ok(r.dimension.length > 0 && r.sdlc.length > 0 && r.adlc.length > 0);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test apps/docs/test/vs-sdlc.test.mjs`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

Content sourced from `ADLC.md` and the adlc-8 essay framing; sharpen wording freely, keep claims true to the thesis.

```js
// apps/docs/lib/vs-sdlc.mjs
export const VS_SDLC_ROWS = [
  {
    dimension: 'Defends against',
    sdlc: 'Human failure: forgetfulness, ego, fatigue',
    adlc: 'Model failure: premature satisfaction, sycophancy, context rot, reward hacking',
  },
  {
    dimension: 'The spec',
    sdlc: 'A requirements document humans interpret',
    adlc: 'Tests are the spec — rails frozen before the build starts',
  },
  {
    dimension: 'Review',
    sdlc: 'Peer code review: does a colleague approve?',
    adlc: 'Prosecution: prove the tests are load-bearing and the change is visible',
  },
  {
    dimension: 'Unit of trust',
    sdlc: 'The engineer who wrote it',
    adlc: 'The gate evidence — machine-checkable artifacts per phase',
  },
  {
    dimension: 'Audit trail',
    sdlc: 'Commit messages and ticket comments',
    adlc: 'gate-manifest: a verdict ledger auditors can read',
  },
  {
    dimension: 'Cost over time',
    sdlc: 'Process overhead compounds',
    adlc: 'Lifecycle gets cheaper — rejections distill into permanent defenses',
  },
];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test apps/docs/test/vs-sdlc.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/docs/lib/vs-sdlc.mjs apps/docs/test/vs-sdlc.test.mjs
git commit -m "feat(site): add SDLC-vs-ADLC comparison data"
```

---

### Task 5: Routes module, nav, and site metadata

Marketing route list grounded to page files (test fails if a nav route has no page), nav links in the shared layout config, and `metadataBase` + default OG metadata in the root layout.

**Files:**
- Create: `apps/docs/lib/routes.mjs`
- Modify: `apps/docs/lib/layout.shared.tsx`
- Modify: `apps/docs/app/layout.tsx`
- Test: `apps/docs/test/routes.test.mjs`

**Interfaces:**
- Produces: `MARKETING_ROUTES` — `[{ path, title }]` for the seven static marketing routes; `SITE_URL = 'https://agenticlifecycle.ai'`. Consumed later by `sitemap.ts` (T13) and nav.

- [ ] **Step 1: Write the failing test**

Note: the grounding test will FAIL for routes whose pages don't exist yet (they arrive in T7–T12). That is intended — write the test now, implement the module now, and the test goes green as the page tasks land. Until then, run it with the later tasks' pages in place; in this task verify only the failing state and the module's unit behavior.

```js
// apps/docs/test/routes.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { MARKETING_ROUTES, SITE_URL } from '../lib/routes.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const homeDir = path.join(__dirname, '..', 'app', '(home)');

test('SITE_URL is the production apex', () => {
  assert.equal(SITE_URL, 'https://agenticlifecycle.ai');
});

test('routes are unique and well-formed', () => {
  const paths = MARKETING_ROUTES.map((r) => r.path);
  assert.equal(new Set(paths).size, paths.length);
  for (const r of MARKETING_ROUTES) {
    assert.match(r.path, /^\//);
    assert.ok(r.title.length > 0);
  }
});

test('every marketing route has a page file (no nav 404s)', () => {
  for (const r of MARKETING_ROUTES) {
    const rel = r.path === '/' ? 'page.tsx' : path.join(r.path.slice(1), 'page.tsx');
    const p = path.join(homeDir, rel);
    assert.ok(existsSync(p), `route ${r.path}: missing ${p}`);
  }
});
```

- [ ] **Step 2: Write the routes module**

```js
// apps/docs/lib/routes.mjs
export const SITE_URL = 'https://agenticlifecycle.ai';

export const MARKETING_ROUTES = [
  { path: '/', title: 'ADLC — The Agentic Development Lifecycle' },
  { path: '/lifecycle', title: 'The Lifecycle — Phases & Gates' },
  { path: '/failure-modes', title: 'Failure Modes — Why Agents Fail' },
  { path: '/vs-sdlc', title: 'ADLC vs SDLC' },
  { path: '/toolkit', title: 'The Toolkit' },
  { path: '/integrations', title: 'Integrations — Native to Your Agent' },
  { path: '/enterprise', title: 'ADLC for Enterprise' },
];
```

- [ ] **Step 3: Run the test — expect partial failure**

Run: `node --test apps/docs/test/routes.test.mjs`
Expected: first two tests PASS; the page-file test FAILS for `/lifecycle`, `/failure-modes`, `/vs-sdlc`, `/toolkit`, `/integrations`, `/enterprise` (pages arrive in T8–T12). `/` passes (placeholder exists).

- [ ] **Step 4: Add nav links**

```tsx
// apps/docs/lib/layout.shared.tsx
import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { appName, gitConfig } from './shared';

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: appName,
    },
    links: [
      { text: 'Lifecycle', url: '/lifecycle' },
      { text: 'Failure modes', url: '/failure-modes' },
      { text: 'vs SDLC', url: '/vs-sdlc' },
      { text: 'Toolkit', url: '/toolkit' },
      { text: 'Integrations', url: '/integrations' },
      { text: 'Enterprise', url: '/enterprise' },
      { text: 'Docs', url: '/docs' },
    ],
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
  };
}
```

- [ ] **Step 5: Add metadataBase and default metadata to the root layout**

```tsx
// apps/docs/app/layout.tsx
import { RootProvider } from 'fumadocs-ui/provider/next';
import './global.css';
import { Inter } from 'next/font/google';
import type { Metadata } from 'next';
import { SITE_URL } from '@/lib/routes.mjs';

const inter = Inter({
  subsets: ['latin'],
});

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: 'ADLC — The Agentic Development Lifecycle',
    template: '%s · ADLC',
  },
  description:
    'The software lifecycle designed for how frontier models actually fail — machine-checkable gates, auditable evidence, native to your coding agent.',
  openGraph: {
    siteName: 'ADLC',
    type: 'website',
  },
};

export default function Layout({ children }: LayoutProps<'/'>) {
  // dark class on <html> enforces dark mode — theme switching is disabled
  return (
    <html lang="en" className={`dark ${inter.className}`} suppressHydrationWarning>
      <body className="flex flex-col min-h-screen">
        <RootProvider theme={{ enabled: false }}>
          {children}
        </RootProvider>
      </body>
    </html>
  );
}
```

- [ ] **Step 6: Typecheck**

Run: `cd apps/docs && npx fumadocs-mdx && npx tsc --noEmit && cd ../..`
Expected: clean

- [ ] **Step 7: Commit**

```bash
git add apps/docs/lib/routes.mjs apps/docs/test/routes.test.mjs apps/docs/lib/layout.shared.tsx apps/docs/app/layout.tsx
git commit -m "feat(site): routes module, marketing nav, site metadata (route test red until pages land)"
```

---

### Task 6: Marketing UI primitives + motion CSS

The shared building blocks. No authored logic → no unit test; verified by typecheck (and by every page task's build). The accessibility constraints are enforced *by construction* here: `GateBadge` always renders glyph + label, and all keyframes sit behind a `prefers-reduced-motion` guard.

**Files:**
- Create: `apps/docs/components/marketing/section.tsx`
- Create: `apps/docs/components/marketing/gate-badge.tsx`
- Create: `apps/docs/components/marketing/terminal-card.tsx`
- Create: `apps/docs/components/marketing/backdrop.tsx`
- Modify: `apps/docs/app/global.css`

**Interfaces:**
- Produces:
  - `MarketingSection({ id?, kicker?, title, children })` — section wrapper.
  - `GateBadge({ state: 'pass' | 'fail' | 'wish', label?: string })` — glyph + label; default labels PASS/FAIL/WISH.
  - `TerminalCard({ title, children })` — terminal chrome around monospace content.
  - `Backdrop({ slug, children })` — server component; full-bleed generated image if `public/generated/<slug>.png` exists, else a token-gradient fallback.
  - CSS classes: `.mk-fade-up` (scroll-independent entrance), `.mk-pulse` (gate pulse) — both inert under reduced motion.

- [ ] **Step 1: Write the components**

```tsx
// apps/docs/components/marketing/section.tsx
import type { ReactNode } from 'react';

interface MarketingSectionProps {
  id?: string;
  kicker?: string;
  title: string;
  children: ReactNode;
}

export function MarketingSection({ id, kicker, title, children }: MarketingSectionProps) {
  return (
    <section id={id} className="mx-auto w-full max-w-5xl px-6 py-20 md:py-28">
      {kicker ? (
        <p className="mb-2 font-mono text-sm uppercase tracking-widest" style={{ color: '#4fb4d8' }}>
          {kicker}
        </p>
      ) : null}
      <h2 className="text-3xl font-bold tracking-tight md:text-4xl" style={{ color: '#cbcdd2' }}>
        {title}
      </h2>
      <div className="mt-8">{children}</div>
    </section>
  );
}
```

```tsx
// apps/docs/components/marketing/gate-badge.tsx
const STATES = {
  pass: { glyph: '✓', label: 'PASS', color: 'var(--adlc-pass)' },
  fail: { glyph: '✗', label: 'FAIL', color: 'var(--adlc-fail)' },
  wish: { glyph: '◌', label: 'WISH', color: 'var(--adlc-wish)' },
} as const;

export type GateState = keyof typeof STATES;

interface GateBadgeProps {
  state: GateState;
  label?: string;
}

// Accessibility rule (spec §4): gate state is always glyph + text, never color alone.
export function GateBadge({ state, label }: GateBadgeProps) {
  const s = STATES[state];
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded border px-2 py-0.5 font-mono text-xs font-bold"
      style={{ color: s.color, borderColor: s.color }}
    >
      <span aria-hidden>{s.glyph}</span>
      {label ?? s.label}
    </span>
  );
}
```

```tsx
// apps/docs/components/marketing/terminal-card.tsx
import type { ReactNode } from 'react';

interface TerminalCardProps {
  title: string;
  children: ReactNode;
}

export function TerminalCard({ title, children }: TerminalCardProps) {
  return (
    <div className="overflow-hidden rounded-lg border" style={{ borderColor: '#3f4044', background: '#26272c' }}>
      <div
        className="flex items-center gap-2 border-b px-4 py-2 font-mono text-xs"
        style={{ borderColor: '#3f4044', color: '#686b78' }}
      >
        <span aria-hidden className="flex gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: '#3f4044' }} />
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: '#3f4044' }} />
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: '#3f4044' }} />
        </span>
        {title}
      </div>
      <div className="overflow-x-auto p-4 font-mono text-sm leading-relaxed">{children}</div>
    </div>
  );
}
```

```tsx
// apps/docs/components/marketing/backdrop.tsx
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { ReactNode } from 'react';

interface BackdropProps {
  slug: string;
  children: ReactNode;
}

// Server component: uses the generated asset when present, else a token-gradient
// fallback — the site must build and ship with zero generated images (spec §4).
export function Backdrop({ slug, children }: BackdropProps) {
  const file = path.join(process.cwd(), 'public', 'generated', `${slug}.png`);
  const hasImage = existsSync(file);
  const style = hasImage
    ? {
        backgroundImage: `linear-gradient(rgba(28,29,33,0.72), rgba(28,29,33,0.94)), url(/generated/${slug}.png)`,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
      }
    : {
        background:
          'radial-gradient(ellipse 80% 60% at 50% -10%, rgba(79,180,216,0.18), transparent), #1c1d21',
      };
  return (
    <div className="relative" style={style}>
      {children}
    </div>
  );
}
```

- [ ] **Step 2: Add motion CSS with reduced-motion guard**

Append to `apps/docs/app/global.css`:

```css
/* Marketing motion — every animation is opt-out via prefers-reduced-motion */
@keyframes mk-fade-up {
  from { opacity: 0; transform: translateY(12px); }
  to { opacity: 1; transform: translateY(0); }
}

@keyframes mk-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.45; }
}

.mk-fade-up { animation: mk-fade-up 0.6s ease-out both; }
.mk-pulse { animation: mk-pulse 1.6s ease-in-out infinite; }

@media (prefers-reduced-motion: reduce) {
  .mk-fade-up, .mk-pulse, .mk-gate-line {
    animation: none !important;
    opacity: 1 !important;
    transform: none !important;
  }
}
```

- [ ] **Step 3: Typecheck**

Run: `cd apps/docs && npx tsc --noEmit && cd ../..`
Expected: clean

- [ ] **Step 4: Commit**

```bash
git add apps/docs/components/marketing apps/docs/app/global.css
git commit -m "feat(site): marketing UI primitives with a11y-by-construction gate badges"
```

---

### Task 7: Hero gate animation + landing page

Replaces the placeholder homepage with the full seven-section narrative (spec §2).

**Files:**
- Create: `apps/docs/components/marketing/gate-sequence.tsx`
- Modify: `apps/docs/app/(home)/page.tsx` (full replacement)
- Modify: `apps/docs/app/global.css` (gate-line keyframes)

**Interfaces:**
- Consumes: `FAILURE_MODES` (T2), `INTEGRATIONS` (T1), `theoryLink` (existing), `MarketingSection`/`GateBadge`/`TerminalCard`/`Backdrop` (T6), `LifecyclePipeline` (T8 — see note).
- Note: the landing page imports `LifecyclePipeline` from T8. If executing strictly in order, land this task with the section stubbed as a link to `/lifecycle`, then wire the component in T8's final step. If executing T7–T8 together, wire directly.

- [ ] **Step 1: Write the gate-sequence hero animation (CSS-only)**

```tsx
// apps/docs/components/marketing/gate-sequence.tsx
import { GateBadge } from './gate-badge';
import type { GateState } from './gate-badge';

const SEQUENCE: ReadonlyArray<{ cmd: string; state: GateState; detail: string }> = [
  { cmd: 'adlc spec-lint ticket.md', state: 'pass', detail: 'spec is executable' },
  { cmd: 'adlc premortem ticket.md', state: 'wish', detail: '2 assumptions flagged' },
  { cmd: 'adlc rails-guard --check', state: 'pass', detail: 'frozen rails untouched' },
  { cmd: 'adlc hollow-test suite/', state: 'fail', detail: '1 test asserts nothing' },
  { cmd: 'adlc prosecute HEAD', state: 'pass', detail: 'change is load-bearing' },
];

// Staggered entrance is pure CSS (.mk-gate-line + animation-delay), so the
// prefers-reduced-motion guard in global.css shows all lines statically.
export function GateSequence() {
  return (
    <div className="flex flex-col gap-2" role="img" aria-label="Terminal showing ADLC gates running: spec-lint pass, premortem wish, rails-guard pass, hollow-test fail, prosecute pass">
      {SEQUENCE.map((line, i) => (
        <div
          key={line.cmd}
          className="mk-gate-line flex flex-wrap items-center gap-3 font-mono text-sm"
          style={{ animationDelay: `${0.5 + i * 0.7}s` }}
        >
          <span style={{ color: '#686b78' }}>$</span>
          <span style={{ color: '#cbcdd2' }}>{line.cmd}</span>
          <GateBadge state={line.state} />
          <span style={{ color: '#686b78' }}>{line.detail}</span>
        </div>
      ))}
    </div>
  );
}
```

Append to `apps/docs/app/global.css` (the reduced-motion block from T6 already covers `.mk-gate-line`):

```css
.mk-gate-line {
  opacity: 0;
  animation: mk-fade-up 0.5s ease-out forwards;
}
```

- [ ] **Step 2: Write the landing page**

```tsx
// apps/docs/app/(home)/page.tsx
import Link from 'next/link';
import type { Metadata } from 'next';
import { FAILURE_MODES } from '@/lib/failure-modes.mjs';
import { INTEGRATIONS } from '@/lib/integration-facts.mjs';
import { theoryLink, SERIES_BASE } from '@/lib/theory-links.mjs';
import { MarketingSection } from '@/components/marketing/section';
import { GateBadge } from '@/components/marketing/gate-badge';
import { TerminalCard } from '@/components/marketing/terminal-card';
import { Backdrop } from '@/components/marketing/backdrop';
import { GateSequence } from '@/components/marketing/gate-sequence';
import { LifecyclePipeline } from '@/components/marketing/lifecycle-pipeline';

export const metadata: Metadata = {
  description:
    'The SDLC defends against human failure modes. Your agents fail differently. ADLC is the lifecycle designed for how models actually fail — with machine-checkable gates at every phase.',
};

const HERO_TOOLS = [
  { name: 'spec-lint', gate: 'Is the spec executable?', output: '$ adlc spec-lint ticket.md\n✓ PASS — 0 ambiguities, acceptance criteria machine-checkable' },
  { name: 'rails-guard', gate: 'Are the frozen tests untouched?', output: '$ adlc rails-guard --check\n✗ FAIL — test/auth.test.mjs modified after freeze' },
  { name: 'hollow-test', gate: 'Do the tests assert anything?', output: '$ adlc hollow-test suite/\n✗ FAIL — 1 hollow test: asserts its own fixture' },
  { name: 'prosecute', gate: 'Would review catch a planted defect?', output: '$ adlc prosecute HEAD\n✓ PASS — 3 probes, all caught by the suite' },
];

export default function HomePage() {
  return (
    <main>
      {/* 1 — Hero */}
      <Backdrop slug="hero-backdrop">
        <div className="mx-auto flex max-w-5xl flex-col gap-8 px-6 pb-24 pt-20 md:pt-32">
          <h1 className="mk-fade-up max-w-3xl text-4xl font-bold leading-tight tracking-tight md:text-6xl" style={{ color: '#cbcdd2' }}>
            Your agents don&apos;t fail like humans.{' '}
            <span style={{ color: '#4fb4d8' }}>Stop managing them like humans.</span>
          </h1>
          <p className="max-w-2xl text-lg" style={{ color: '#686b78' }}>
            The Agentic Development Lifecycle rebuilds every phase, gate, and loop of software
            delivery around how frontier models actually fail — with machine-checkable gates
            and evidence you can audit.
          </p>
          <div className="flex flex-wrap gap-4">
            <Link
              href="/integrations"
              className="rounded-md px-5 py-2.5 font-medium"
              style={{ background: '#4fb4d8', color: '#1c1d21' }}
            >
              Install for your agent
            </Link>
            <Link
              href="/vs-sdlc"
              className="rounded-md border px-5 py-2.5 font-medium"
              style={{ borderColor: '#3f4044', color: '#cbcdd2' }}
            >
              Why ADLC
            </Link>
          </div>
          <div className="mt-4 max-w-2xl rounded-lg border p-6" style={{ borderColor: '#3f4044', background: 'rgba(38,39,44,0.85)' }}>
            <GateSequence />
          </div>
        </div>
      </Backdrop>

      {/* 2 — The problem */}
      <MarketingSection kicker="The problem" title="Eight ways agents fail — none of them human">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Object.entries(FAILURE_MODES).map(([id, fm]) => (
            <div key={id} className="rounded-lg border p-4" style={{ borderColor: '#3f4044', background: '#26272c' }}>
              <p className="font-mono text-xs" style={{ color: '#ef7c2a' }}>{id}</p>
              <p className="mt-1 font-semibold" style={{ color: '#cbcdd2' }}>{fm.name}</p>
              <p className="mt-2 text-sm" style={{ color: '#686b78' }}>{fm.tagline}</p>
            </div>
          ))}
        </div>
        <p className="mt-6 text-sm" style={{ color: '#686b78' }}>
          <Link href="/failure-modes" style={{ color: '#4fb4d8' }}>See which gate kills each one →</Link>
        </p>
      </MarketingSection>

      {/* 3 — The lifecycle */}
      <MarketingSection kicker="The lifecycle" title="Eight phases. A gate between every one.">
        <LifecyclePipeline />
        <p className="mt-6 text-sm" style={{ color: '#686b78' }}>
          <Link href="/lifecycle" style={{ color: '#4fb4d8' }}>Explore the phases and gates →</Link>
        </p>
      </MarketingSection>

      {/* 4 — Gates, not vibes */}
      <MarketingSection kicker="Gates, not vibes" title="Every claim gets checked by a machine">
        <div className="grid gap-4 md:grid-cols-2">
          {HERO_TOOLS.map((t) => (
            <TerminalCard key={t.name} title={`${t.name} — ${t.gate}`}>
              <pre className="whitespace-pre-wrap">{t.output}</pre>
            </TerminalCard>
          ))}
        </div>
        <p className="mt-6 text-sm" style={{ color: '#686b78' }}>
          <Link href="/toolkit" style={{ color: '#4fb4d8' }}>All 23 packages, grouped by phase →</Link>
        </p>
      </MarketingSection>

      {/* 5 — Native to your agent */}
      <MarketingSection kicker="Integrations" title="Native to the agent you already use">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {INTEGRATIONS.map((i) => (
            <Link
              key={i.slug}
              href={`/integrations/${i.slug}`}
              className="rounded-lg border p-4 transition-colors hover:border-[#4fb4d8]"
              style={{ borderColor: '#3f4044', background: '#26272c' }}
            >
              <p className="font-semibold" style={{ color: '#cbcdd2' }}>{i.name}</p>
              <p className="mt-2 text-sm" style={{ color: '#686b78' }}>{i.tagline}</p>
            </Link>
          ))}
        </div>
      </MarketingSection>

      {/* 6 — Enterprise band */}
      <MarketingSection kicker="Enterprise" title="Rolling out agentic development across an org?">
        <p className="max-w-2xl text-lg" style={{ color: '#686b78' }}>
          Unreviewable agent output is an audit problem, not just an engineering problem.
          ADLC produces a gate-by-gate evidence trail your auditors can actually read.
        </p>
        <Link
          href="/enterprise"
          className="mt-6 inline-block rounded-md border px-5 py-2.5 font-medium"
          style={{ borderColor: '#4fb4d8', color: '#4fb4d8' }}
        >
          Do it right →
        </Link>
      </MarketingSection>

      {/* 7 — Theory footer band */}
      <div className="border-t" style={{ borderColor: '#3f4044' }}>
        <div className="mx-auto max-w-5xl px-6 py-12">
          <p className="text-sm" style={{ color: '#686b78' }}>
            ADLC began as an essay series.{' '}
            <a href={`${SERIES_BASE}/series/adlc`} style={{ color: '#4fb4d8' }}>
              Read the original theory at voodootikigod.com ↗
            </a>
          </p>
        </div>
      </div>
    </main>
  );
}
```

- [ ] **Step 3: Typecheck and build**

Run: `cd apps/docs && npx fumadocs-mdx && npx tsc --noEmit && cd ../.. && npm run build --workspace @adlc/docs`
Expected: clean (if `LifecyclePipeline` is not yet built, stub per the interface note and re-wire in T8)

- [ ] **Step 4: Commit**

```bash
git add apps/docs/app/\(home\)/page.tsx apps/docs/components/marketing/gate-sequence.tsx apps/docs/app/global.css
git commit -m "feat(site): landing page with hero gate animation and seven-section narrative"
```

---

### Task 8: Lifecycle pipeline diagram, three dials, /lifecycle page

**Files:**
- Create: `apps/docs/components/marketing/lifecycle-pipeline.tsx`
- Create: `apps/docs/components/marketing/three-dials.tsx`
- Create: `apps/docs/app/(home)/lifecycle/page.tsx`

**Interfaces:**
- Consumes: `PHASES` from `apps/docs/lib/phase-graph.mjs`; `theoryLink`; T6 primitives.
- Produces: `LifecyclePipeline()` (no props), `ThreeDials()` (no props) — consumed by the landing page (T7) and this page.

- [ ] **Step 1: Write the pipeline component**

```tsx
// apps/docs/components/marketing/lifecycle-pipeline.tsx
import { PHASES } from '@/lib/phase-graph.mjs';

// Designed component (not Mermaid) — data-driven from the tested PHASES module.
export function LifecyclePipeline() {
  return (
    <ol className="flex flex-wrap items-center gap-y-4" aria-label="ADLC phases P0 through P7 with a gate after each phase">
      {PHASES.map((p, i) => (
        <li key={p.id} className="flex items-center">
          <span
            className="flex flex-col rounded-lg border px-4 py-3"
            style={{ borderColor: '#3f4044', background: '#26272c' }}
          >
            <span className="font-mono text-xs" style={{ color: '#4fb4d8' }}>{p.id}</span>
            <span className="text-sm font-semibold" style={{ color: '#cbcdd2' }}>{p.name}</span>
          </span>
          {i < PHASES.length - 1 ? (
            <span aria-hidden className="mx-2 font-mono text-lg" style={{ color: 'var(--adlc-pass)' }}>
              —⌾→
            </span>
          ) : null}
        </li>
      ))}
    </ol>
  );
}
```

- [ ] **Step 2: Write the three-dials component**

```tsx
// apps/docs/components/marketing/three-dials.tsx
const DIALS = [
  { name: 'Autonomy', value: 0.7, note: 'How long the agent runs unsupervised' },
  { name: 'Oversight', value: 0.5, note: 'How much of the output humans gate' },
  { name: 'Scope', value: 0.35, note: 'How much surface one ticket may touch' },
] as const;

function Dial({ name, value, note }: (typeof DIALS)[number]) {
  // Semi-circle gauge: needle angle from -90° (0) to +90° (1)
  const angle = -90 + value * 180;
  return (
    <figure className="flex flex-col items-center gap-2">
      <svg viewBox="0 0 100 60" className="w-40" role="img" aria-label={`${name} dial set to ${Math.round(value * 100)}%`}>
        <path d="M 10 55 A 40 40 0 0 1 90 55" fill="none" stroke="#3f4044" strokeWidth="6" strokeLinecap="round" />
        <line
          x1="50" y1="55" x2="50" y2="20"
          stroke="#4fb4d8" strokeWidth="3" strokeLinecap="round"
          transform={`rotate(${angle} 50 55)`}
        />
        <circle cx="50" cy="55" r="4" fill="#4fb4d8" />
      </svg>
      <figcaption className="text-center">
        <span className="block font-semibold" style={{ color: '#cbcdd2' }}>{name}</span>
        <span className="block max-w-44 text-xs" style={{ color: '#686b78' }}>{note}</span>
      </figcaption>
    </figure>
  );
}

export function ThreeDials() {
  return (
    <div className="flex flex-wrap justify-center gap-10">
      {DIALS.map((d) => (
        <Dial key={d.name} {...d} />
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Write the /lifecycle page**

```tsx
// apps/docs/app/(home)/lifecycle/page.tsx
import type { Metadata } from 'next';
import Link from 'next/link';
import { PHASES } from '@/lib/phase-graph.mjs';
import { theoryLink } from '@/lib/theory-links.mjs';
import { MarketingSection } from '@/components/marketing/section';
import { LifecyclePipeline } from '@/components/marketing/lifecycle-pipeline';
import { ThreeDials } from '@/components/marketing/three-dials';

export const metadata: Metadata = {
  title: 'The Lifecycle — Phases & Gates',
  description: 'Eight phases, P0–P7, each ending in a machine-checkable gate. The ADLC pipeline from triage to distillation.',
};

const PHASE_DETAIL: Record<string, string> = {
  P0: 'Triage the ticket: is this executable by an agent at all, and at what dial settings?',
  P1: 'Interrogate the spec until it is unambiguous. Human gate one.',
  P2: 'Decompose into cold-startable units — an agent with zero context can pick each up.',
  P3: 'Rail the work: write and freeze the tests that define done.',
  P4: 'Build inside the rails. Supervision tooling watches for flailing and drift.',
  P5: 'Prosecute the change: prove the tests are load-bearing, not hollow.',
  P6: 'Review the evidence, not the diff. Human gate two.',
  P7: 'Distill what the review found into permanent, deterministic defenses.',
};

export default function LifecyclePage() {
  return (
    <main>
      <MarketingSection kicker="The lifecycle" title="Eight phases. A gate between every one.">
        <LifecyclePipeline />
        <div className="mt-12 grid gap-4 md:grid-cols-2">
          {PHASES.map((p) => (
            <div key={p.id} className="rounded-lg border p-5" style={{ borderColor: '#3f4044', background: '#26272c' }}>
              <p className="font-mono text-xs" style={{ color: '#4fb4d8' }}>{p.id}</p>
              <p className="mt-1 font-semibold" style={{ color: '#cbcdd2' }}>{p.name}</p>
              <p className="mt-2 text-sm" style={{ color: '#686b78' }}>{PHASE_DETAIL[p.id]}</p>
              <a href={theoryLink(p.id)} className="mt-3 inline-block text-sm" style={{ color: '#4fb4d8' }}>
                Read the original essay ↗
              </a>
            </div>
          ))}
        </div>
      </MarketingSection>

      <MarketingSection kicker="Calibration" title="Three dials, set per ticket">
        <p className="mb-10 max-w-2xl" style={{ color: '#686b78' }}>
          Not every ticket deserves the same autonomy. ADLC sets three dials at triage —
          and the gates enforce whatever you chose.
        </p>
        <ThreeDials />
        <p className="mt-8 text-sm" style={{ color: '#686b78' }}>
          <a href={theoryLink('three-dials')} style={{ color: '#4fb4d8' }}>Read the original essay ↗</a>
          {' · '}
          <Link href="/docs" style={{ color: '#4fb4d8' }}>Full reference in the docs</Link>
        </p>
      </MarketingSection>
    </main>
  );
}
```

- [ ] **Step 4: Wire `LifecyclePipeline` into the landing page** if it was stubbed in T7.

- [ ] **Step 5: Typecheck, build, and re-run the routes test**

Run: `cd apps/docs && npx tsc --noEmit && cd ../.. && node --test apps/docs/test/routes.test.mjs`
Expected: typecheck clean; routes test — `/lifecycle` now passes (others still red until their tasks)

- [ ] **Step 6: Commit**

```bash
git add apps/docs/components/marketing/lifecycle-pipeline.tsx apps/docs/components/marketing/three-dials.tsx "apps/docs/app/(home)/lifecycle" apps/docs/app/\(home\)/page.tsx
git commit -m "feat(site): lifecycle pipeline diagram, three dials, /lifecycle page"
```

---

### Task 9: Failure-mode map, vs-SDLC — pages + diagrams

**Files:**
- Create: `apps/docs/components/marketing/failure-map.tsx`
- Create: `apps/docs/components/marketing/vs-table.tsx`
- Create: `apps/docs/app/(home)/failure-modes/page.tsx`
- Create: `apps/docs/app/(home)/vs-sdlc/page.tsx`

**Interfaces:**
- Consumes: `FAILURE_MODES` w/ `defense` (T2), `VS_SDLC_ROWS` (T4), `theoryLink`, T6 primitives.
- Produces: `FailureMap()`, `VsTable()` — no props.

- [ ] **Step 1: Write the failure-map component**

```tsx
// apps/docs/components/marketing/failure-map.tsx
import Link from 'next/link';
import { FAILURE_MODES } from '@/lib/failure-modes.mjs';

// F1–F8 on the left, the defending gate on the right — the core ADLC claim
// (every defense traces to a failure mode) made visual.
export function FailureMap() {
  return (
    <div className="flex flex-col gap-3">
      {Object.entries(FAILURE_MODES).map(([id, fm]) => (
        <div
          key={id}
          className="grid items-center gap-3 rounded-lg border p-4 md:grid-cols-[1fr_auto_1fr]"
          style={{ borderColor: '#3f4044', background: '#26272c' }}
        >
          <div>
            <span className="font-mono text-xs" style={{ color: '#ef7c2a' }}>{id}</span>
            <p className="font-semibold" style={{ color: '#cbcdd2' }}>{fm.name}</p>
            <p className="text-sm" style={{ color: '#686b78' }}>{fm.tagline}</p>
          </div>
          <span aria-hidden className="hidden font-mono md:block" style={{ color: 'var(--adlc-pass)' }}>
            ──✓──▶
          </span>
          <div className="md:text-right">
            <Link href={`/docs/toolkit/${fm.defense.tool}`} className="font-mono font-semibold" style={{ color: '#4fb4d8' }}>
              {fm.defense.tool}
            </Link>
            <p className="text-xs" style={{ color: '#686b78' }}>gate at {fm.defense.phase}</p>
          </div>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Write the vs-table component**

```tsx
// apps/docs/components/marketing/vs-table.tsx
import { VS_SDLC_ROWS } from '@/lib/vs-sdlc.mjs';

export function VsTable() {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr>
            <th className="p-3 text-left font-mono text-xs uppercase tracking-wider" style={{ color: '#686b78' }}>Dimension</th>
            <th className="p-3 text-left font-mono text-xs uppercase tracking-wider" style={{ color: '#686b78' }}>SDLC (built for humans)</th>
            <th className="p-3 text-left font-mono text-xs uppercase tracking-wider" style={{ color: '#4fb4d8' }}>ADLC (built for models)</th>
          </tr>
        </thead>
        <tbody>
          {VS_SDLC_ROWS.map((r) => (
            <tr key={r.dimension} className="border-t" style={{ borderColor: '#3f4044' }}>
              <td className="p-3 font-semibold" style={{ color: '#cbcdd2' }}>{r.dimension}</td>
              <td className="p-3" style={{ color: '#686b78' }}>{r.sdlc}</td>
              <td className="p-3" style={{ color: '#cbcdd2' }}>{r.adlc}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 3: Write both pages**

```tsx
// apps/docs/app/(home)/failure-modes/page.tsx
import type { Metadata } from 'next';
import { theoryLink } from '@/lib/theory-links.mjs';
import { MarketingSection } from '@/components/marketing/section';
import { FailureMap } from '@/components/marketing/failure-map';

export const metadata: Metadata = {
  title: 'Failure Modes — Why Agents Fail',
  description: 'The eight model failure modes F1–F8, and the machine-checkable gate that defends against each one.',
};

export default function FailureModesPage() {
  return (
    <main>
      <MarketingSection kicker="The problem" title="Every defense traces to a failure mode">
        <p className="mb-10 max-w-2xl" style={{ color: '#686b78' }}>
          The ADLC design rule: every phase, gate, and loop must trace to a specific model
          failure mode it defends against — or be cut. Here is the full map.
        </p>
        <FailureMap />
        <p className="mt-8 text-sm" style={{ color: '#686b78' }}>
          <a href={theoryLink('F1')} style={{ color: '#4fb4d8' }}>Read the original essay ↗</a>
        </p>
      </MarketingSection>
    </main>
  );
}
```

```tsx
// apps/docs/app/(home)/vs-sdlc/page.tsx
import type { Metadata } from 'next';
import { theoryLink } from '@/lib/theory-links.mjs';
import { MarketingSection } from '@/components/marketing/section';
import { VsTable } from '@/components/marketing/vs-table';

export const metadata: Metadata = {
  title: 'ADLC vs SDLC',
  description: 'The SDLC is 60 years of defenses against human failure modes. Models fail differently — what transfers, and what has to be rebuilt.',
};

export default function VsSdlcPage() {
  return (
    <main>
      <MarketingSection kicker="The argument" title="60 years of process, built for the wrong failure modes">
        <p className="mb-10 max-w-2xl" style={{ color: '#686b78' }}>
          Code review, standups, sprint ceremonies — each exists because humans forget, tire,
          and protect their egos. Models do none of that. They fail in their own ways, and a
          lifecycle that doesn&apos;t defend against <em>those</em> failures is theater.
        </p>
        <VsTable />
        <p className="mt-8 text-sm" style={{ color: '#686b78' }}>
          <a href={theoryLink('vs-sdlc')} style={{ color: '#4fb4d8' }}>Read the original essay ↗</a>
        </p>
      </MarketingSection>
    </main>
  );
}
```

- [ ] **Step 4: Typecheck + routes test**

Run: `cd apps/docs && npx tsc --noEmit && cd ../.. && node --test apps/docs/test/routes.test.mjs`
Expected: typecheck clean; `/failure-modes` and `/vs-sdlc` route checks now pass

- [ ] **Step 5: Commit**

```bash
git add apps/docs/components/marketing/failure-map.tsx apps/docs/components/marketing/vs-table.tsx "apps/docs/app/(home)/failure-modes" "apps/docs/app/(home)/vs-sdlc"
git commit -m "feat(site): failure-mode map and vs-SDLC pages"
```

---

### Task 10: Toolkit constellation + integrations hub and detail pages

**Files:**
- Create: `apps/docs/components/marketing/constellation.tsx`
- Create: `apps/docs/components/marketing/integration-card.tsx`
- Create: `apps/docs/app/(home)/toolkit/page.tsx`
- Create: `apps/docs/app/(home)/integrations/page.tsx`
- Create: `apps/docs/app/(home)/integrations/[slug]/page.tsx`

**Interfaces:**
- Consumes: `TOOLKIT_GROUPS` (T3), `INTEGRATIONS`/`integrationFor` (T1), T6 primitives.
- Produces: `Constellation()`, `IntegrationCard({ integration })`.

- [ ] **Step 1: Write the constellation component**

```tsx
// apps/docs/components/marketing/constellation.tsx
import Link from 'next/link';
import { TOOLKIT_GROUPS } from '@/lib/toolkit-packages.mjs';

export function Constellation() {
  return (
    <div className="flex flex-col gap-8">
      {TOOLKIT_GROUPS.map((g) => (
        <div key={g.group}>
          <h3 className="mb-3 font-mono text-sm uppercase tracking-widest" style={{ color: '#686b78' }}>
            {g.group}
          </h3>
          <div className="flex flex-wrap gap-2">
            {g.packages.map((name) => (
              <Link
                key={name}
                href={`/docs/toolkit/${name}`}
                className="rounded-full border px-4 py-1.5 font-mono text-sm transition-colors hover:border-[#4fb4d8] hover:text-[#4fb4d8]"
                style={{ borderColor: '#3f4044', color: '#cbcdd2' }}
              >
                {name}
              </Link>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Write the integration card**

```tsx
// apps/docs/components/marketing/integration-card.tsx
import type { INTEGRATIONS } from '@/lib/integration-facts.mjs';
import { TerminalCard } from './terminal-card';

const STATUS_LABEL: Record<string, string> = {
  installer: 'One-line install',
  source: 'Install from source',
  local: 'Local plugin install',
};

interface IntegrationCardProps {
  integration: (typeof INTEGRATIONS)[number];
}

export function IntegrationCard({ integration }: IntegrationCardProps) {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <span
          className="rounded border px-2 py-0.5 font-mono text-xs"
          style={{ borderColor: '#3f4044', color: '#686b78' }}
        >
          {STATUS_LABEL[integration.status]}
        </span>
      </div>
      <TerminalCard title={`install — ${integration.name}`}>
        <pre className="whitespace-pre-wrap">{integration.install.join('\n')}</pre>
      </TerminalCard>
      {integration.note ? (
        <p className="text-sm" style={{ color: '#e5cd52' }}>
          <span aria-hidden>◌ </span>{integration.note}
        </p>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 3: Write the three pages**

```tsx
// apps/docs/app/(home)/toolkit/page.tsx
import type { Metadata } from 'next';
import { theoryLink } from '@/lib/theory-links.mjs';
import { MarketingSection } from '@/components/marketing/section';
import { Constellation } from '@/components/marketing/constellation';

export const metadata: Metadata = {
  title: 'The Toolkit',
  description: 'Zero-dependency, gate-shaped CLIs — one machine-checkable gate each, grouped by lifecycle phase.',
};

export default function ToolkitPage() {
  return (
    <main>
      <MarketingSection kicker="The toolkit" title="Small CLIs. One gate each. Zero dependencies.">
        <p className="mb-10 max-w-2xl" style={{ color: '#686b78' }}>
          Every package enforces one machine-checkable gate and shares a runtime convention,
          so independently built tools feel like one product. Click any package for its docs.
        </p>
        <Constellation />
        <p className="mt-8 text-sm" style={{ color: '#686b78' }}>
          <a href={theoryLink('toolkit')} style={{ color: '#4fb4d8' }}>Read the original essay ↗</a>
        </p>
      </MarketingSection>
    </main>
  );
}
```

```tsx
// apps/docs/app/(home)/integrations/page.tsx
import type { Metadata } from 'next';
import Link from 'next/link';
import { INTEGRATIONS } from '@/lib/integration-facts.mjs';
import { MarketingSection } from '@/components/marketing/section';

export const metadata: Metadata = {
  title: 'Integrations — Native to Your Agent',
  description: 'Install the ADLC natively in Claude Code, Codex, Cursor, OpenCode, Pi, or Google Antigravity.',
};

export default function IntegrationsPage() {
  return (
    <main>
      <MarketingSection kicker="Integrations" title="Pick your agent">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {INTEGRATIONS.map((i) => (
            <Link
              key={i.slug}
              href={`/integrations/${i.slug}`}
              className="rounded-lg border p-5 transition-colors hover:border-[#4fb4d8]"
              style={{ borderColor: '#3f4044', background: '#26272c' }}
            >
              <p className="text-lg font-semibold" style={{ color: '#cbcdd2' }}>{i.name}</p>
              <p className="mt-2 text-sm" style={{ color: '#686b78' }}>{i.tagline}</p>
            </Link>
          ))}
        </div>
      </MarketingSection>
    </main>
  );
}
```

```tsx
// apps/docs/app/(home)/integrations/[slug]/page.tsx
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { INTEGRATIONS, integrationFor } from '@/lib/integration-facts.mjs';
import { MarketingSection } from '@/components/marketing/section';
import { IntegrationCard } from '@/components/marketing/integration-card';

export function generateStaticParams() {
  return INTEGRATIONS.map((i) => ({ slug: i.slug }));
}

export const dynamicParams = false;

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const integration = integrationFor(slug);
  if (!integration) return {};
  return {
    title: `ADLC for ${integration.name}`,
    description: integration.tagline,
  };
}

export default async function IntegrationPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const integration = integrationFor(slug);
  if (!integration) notFound();

  return (
    <main>
      <MarketingSection kicker="Integrations" title={`ADLC, native in ${integration.name}`}>
        <p className="mb-8 max-w-2xl" style={{ color: '#686b78' }}>{integration.tagline}</p>
        <IntegrationCard integration={integration} />
        <p className="mt-8 text-sm" style={{ color: '#686b78' }}>
          <Link href={`/docs/integrations/${integration.slug}`} style={{ color: '#4fb4d8' }}>
            Full {integration.name} guide in the docs →
          </Link>
        </p>
      </MarketingSection>
    </main>
  );
}
```

- [ ] **Step 4: Typecheck + integration-facts + routes tests**

Run: `cd apps/docs && npx tsc --noEmit && cd ../.. && node --test apps/docs/test/integration-facts.test.mjs apps/docs/test/routes.test.mjs`
Expected: clean; `/toolkit` and `/integrations` route checks now pass

- [ ] **Step 5: Commit**

```bash
git add apps/docs/components/marketing/constellation.tsx apps/docs/components/marketing/integration-card.tsx "apps/docs/app/(home)/toolkit" "apps/docs/app/(home)/integrations"
git commit -m "feat(site): toolkit constellation, integrations hub and per-agent pages"
```

---

### Task 11: Evidence trail + /enterprise page

**Files:**
- Create: `apps/docs/components/marketing/evidence-trail.tsx`
- Create: `apps/docs/app/(home)/enterprise/page.tsx`

**Interfaces:**
- Consumes: T6 primitives, `GateBadge`.
- Produces: `EvidenceTrail()` — no props.

- [ ] **Step 1: Write the evidence-trail component**

```tsx
// apps/docs/components/marketing/evidence-trail.tsx
import { GateBadge } from './gate-badge';

const STEPS = [
  { label: 'Ticket', detail: 'Executable spec, dials set at triage' },
  { label: 'Gates', detail: 'spec-lint · premortem · rails-guard · hollow-test · prosecute' },
  { label: 'gate-manifest', detail: 'Every verdict recorded as a machine-readable artifact' },
  { label: 'Merge', detail: 'Approved on evidence, not vibes' },
] as const;

// Chain-of-custody diagram: how a change becomes auditable (spec §4 table).
export function EvidenceTrail() {
  return (
    <ol className="flex flex-col gap-2 md:flex-row md:items-stretch md:gap-0" aria-label="Evidence trail from ticket through gates and gate-manifest to merge">
      {STEPS.map((s, i) => (
        <li key={s.label} className="flex items-center md:flex-1">
          <div className="flex-1 rounded-lg border p-4" style={{ borderColor: '#3f4044', background: '#26272c' }}>
            <p className="font-mono text-sm font-semibold" style={{ color: '#4fb4d8' }}>{s.label}</p>
            <p className="mt-1 text-xs" style={{ color: '#686b78' }}>{s.detail}</p>
          </div>
          {i < STEPS.length - 1 ? (
            <span aria-hidden className="mx-2 hidden font-mono md:block" style={{ color: 'var(--adlc-pass)' }}>→</span>
          ) : null}
        </li>
      ))}
    </ol>
  );
}
```

- [ ] **Step 2: Write the /enterprise page**

Contact is `mailto:` only (spec §5 v1) — the form + Attio sink is v1.1, not this plan.

```tsx
// apps/docs/app/(home)/enterprise/page.tsx
import type { Metadata } from 'next';
import { MarketingSection } from '@/components/marketing/section';
import { GateBadge } from '@/components/marketing/gate-badge';
import { EvidenceTrail } from '@/components/marketing/evidence-trail';

export const metadata: Metadata = {
  title: 'ADLC for Enterprise',
  description: 'Roll out agentic development with an audit trail: machine-checkable gates, evidence artifacts, and a lifecycle your compliance team can read.',
};

const ROLLOUT = [
  { phase: 'Pilot', detail: 'One team, full gates, dials conservative. Two weeks to first prosecuted merge.' },
  { phase: 'Rails', detail: 'Freeze org-wide conventions as rails: CI gates, protected specs, calibrated review.' },
  { phase: 'Org-wide', detail: 'Native integrations for every agent your teams use. Same gates everywhere.' },
] as const;

export default function EnterprisePage() {
  return (
    <main>
      <MarketingSection kicker="Enterprise" title="Unreviewable agent output is an audit problem">
        <p className="max-w-2xl text-lg" style={{ color: '#686b78' }}>
          When agents write most of the code, &ldquo;a human approved the PR&rdquo; stops being
          evidence of anything. Regulators, auditors, and your own security team will ask what
          the approval was based on. ADLC gives you an answer: a gate-by-gate evidence trail,
          produced by machines, readable by humans.
        </p>
      </MarketingSection>

      <MarketingSection kicker="The evidence" title="From ticket to merge, every verdict recorded">
        <EvidenceTrail />
        <div className="mt-8 flex flex-wrap items-center gap-3 text-sm" style={{ color: '#686b78' }}>
          <span>Every gate emits</span>
          <GateBadge state="pass" />
          <GateBadge state="fail" />
          <GateBadge state="wish" />
          <span>— artifacts your auditors can read without an engineer translating.</span>
        </div>
      </MarketingSection>

      <MarketingSection kicker="Rollout" title="Pilot → rails → org-wide">
        <div className="grid gap-4 md:grid-cols-3">
          {ROLLOUT.map((r) => (
            <div key={r.phase} className="rounded-lg border p-5" style={{ borderColor: '#3f4044', background: '#26272c' }}>
              <p className="font-semibold" style={{ color: '#4fb4d8' }}>{r.phase}</p>
              <p className="mt-2 text-sm" style={{ color: '#686b78' }}>{r.detail}</p>
            </div>
          ))}
        </div>
      </MarketingSection>

      <MarketingSection kicker="Talk to us" title="Doing agentic development right?">
        <p className="max-w-2xl" style={{ color: '#686b78' }}>
          If you&apos;re rolling agentic development out across an organization and want it
          gated, auditable, and defensible — get in touch.
        </p>
        <a
          href="mailto:chris@voodootikigod.com?subject=ADLC%20enterprise"
          className="mt-6 inline-block rounded-md px-5 py-2.5 font-medium"
          style={{ background: '#4fb4d8', color: '#1c1d21' }}
        >
          chris@voodootikigod.com
        </a>
      </MarketingSection>
    </main>
  );
}
```

- [ ] **Step 3: Typecheck + full routes test**

Run: `cd apps/docs && npx tsc --noEmit && cd ../.. && node --test apps/docs/test/routes.test.mjs`
Expected: routes test fully GREEN — all seven marketing routes have pages now

- [ ] **Step 4: Commit**

```bash
git add apps/docs/components/marketing/evidence-trail.tsx "apps/docs/app/(home)/enterprise"
git commit -m "feat(site): enterprise page with evidence-trail diagram and mailto CTA"
```

---

### Task 12: Image manifest, validator, and generation script

Manifest + provenance per spec §4 Layer 2. The site never *requires* these assets (Backdrop falls back to gradients), so this task is about the reproducible pipeline. Committing actual PNGs is a separate, deliberate maintainer action.

**Files:**
- Create: `apps/docs/assets/images.json`
- Create: `apps/docs/lib/image-manifest.mjs`
- Create: `apps/docs/scripts/generate-images.mjs`
- Test: `apps/docs/test/image-manifest.test.mjs`
- Modify: `apps/docs/.gitignore` (add `public/generated/`)

**Interfaces:**
- Produces: `loadManifest()` → parsed manifest; `validateManifest(manifest)` → `{ ok: boolean, errors: string[] }`. Manifest shape: `{ styleGuide: string, images: [{ slug, size, placement, prompt, provenance?: { provider, model, generatedAt } }] }`.

- [ ] **Step 1: Write the failing test**

```js
// apps/docs/test/image-manifest.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadManifest, validateManifest } from '../lib/image-manifest.mjs';

test('checked-in manifest is valid', () => {
  const result = validateManifest(loadManifest());
  assert.deepEqual(result, { ok: true, errors: [] });
});

test('validator rejects duplicate slugs', () => {
  const bad = {
    styleGuide: 'x'.repeat(60),
    images: [
      { slug: 'a', size: '1024x1024', placement: 'p', prompt: 'y'.repeat(30) },
      { slug: 'a', size: '1024x1024', placement: 'p', prompt: 'y'.repeat(30) },
    ],
  };
  const result = validateManifest(bad);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('duplicate slug')));
});

test('validator rejects malformed sizes and empty prompts', () => {
  const bad = {
    styleGuide: 'x'.repeat(60),
    images: [{ slug: 'b', size: 'huge', placement: 'p', prompt: '' }],
  };
  const result = validateManifest(bad);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('size')));
  assert.ok(result.errors.some((e) => e.includes('prompt')));
});

test('hero-backdrop is present (landing page depends on the slug)', () => {
  const manifest = loadManifest();
  assert.ok(manifest.images.some((i) => i.slug === 'hero-backdrop'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test apps/docs/test/image-manifest.test.mjs`
Expected: FAIL — module not found

- [ ] **Step 3: Write the manifest**

The shared style guide is embedded once and prepended to every prompt at generation time (spec: one visual world). Placements cover: hero, one per concept page, enterprise, OG background.

```json
{
  "styleGuide": "Abstract dark composition on a near-black #1c1d21 field. Terminal-glow aesthetic: thin luminous circuit-like traces and soft volumetric light in cyan-blue #4fb4d8, with sparse accent glints of green #78bd65, red #eb3d54, and yellow #e5cd52. Cinematic, slightly grainy, high contrast, generous negative space. No text, no letters, no logos, no people, no hands, no UI screenshots.",
  "images": [
    { "slug": "hero-backdrop", "size": "1536x1024", "placement": "landing hero background", "prompt": "A wide horizon of ordered light: five glowing gate arches in a row receding into darkness, a single continuous blue trace passing through each gate, the middle arch flaring red where the trace is blocked and rerouted" },
    { "slug": "lifecycle-backdrop", "size": "1536x1024", "placement": "/lifecycle header", "prompt": "Eight luminous nodes connected left to right by a pulsing blue line, small diamond-shaped gates between nodes glowing faint green, deep dark background with subtle grid" },
    { "slug": "failure-modes-backdrop", "size": "1536x1024", "placement": "/failure-modes header", "prompt": "Eight erratic fractured light filaments in warm orange and red drifting from the left, each dissolving as it meets a calm vertical wall of blue light on the right" },
    { "slug": "vs-sdlc-backdrop", "size": "1536x1024", "placement": "/vs-sdlc header", "prompt": "A split composition: left half faded sepia blueprint scaffolding, geometric and paper-like; right half the same structure reborn as luminous blue circuitry, the seam between them sharp and vertical" },
    { "slug": "toolkit-backdrop", "size": "1536x1024", "placement": "/toolkit header", "prompt": "A constellation of small bright instrument-like points grouped into five loose clusters, connected by faint lines, one cluster glowing brighter, like a star map of tools" },
    { "slug": "enterprise-backdrop", "size": "1536x1024", "placement": "/enterprise header", "prompt": "Chaotic scattered particles of light on the left funneling through three successive glowing gate frames, emerging on the right as a perfectly ordered lattice, blue dominant with a green terminal glint" },
    { "slug": "og-base", "size": "1536x1024", "placement": "OG/social card background (crop to 1200x630 at use)", "prompt": "A minimal dark banner: one elegant blue light trace crossing a single glowing gate arch, heavy negative space on the left for typographic overlay" }
  ]
}
```

- [ ] **Step 4: Write the loader/validator**

```js
// apps/docs/lib/image-manifest.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const MANIFEST_PATH = path.join(__dirname, '..', 'assets', 'images.json');

export function loadManifest() {
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
}

export function validateManifest(manifest) {
  const errors = [];
  if (typeof manifest?.styleGuide !== 'string' || manifest.styleGuide.length < 40) {
    errors.push('styleGuide missing or too short to art-direct anything');
  }
  const images = Array.isArray(manifest?.images) ? manifest.images : [];
  if (images.length === 0) errors.push('images array empty');
  const seen = new Set();
  for (const img of images) {
    const tag = img?.slug ?? '<missing slug>';
    if (!img?.slug || !/^[a-z0-9-]+$/.test(img.slug)) errors.push(`${tag}: bad slug`);
    if (seen.has(img?.slug)) errors.push(`duplicate slug: ${tag}`);
    seen.add(img?.slug);
    if (!/^\d{3,4}x\d{3,4}$/.test(img?.size ?? '')) errors.push(`${tag}: bad size`);
    if (typeof img?.placement !== 'string' || img.placement.length === 0) errors.push(`${tag}: missing placement`);
    if (typeof img?.prompt !== 'string' || img.prompt.length < 20) errors.push(`${tag}: prompt missing or too short`);
  }
  return { ok: errors.length === 0, errors };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test apps/docs/test/image-manifest.test.mjs`
Expected: PASS (4 tests)

- [ ] **Step 6: Write the generation script**

Zero-dependency; provider picked by available key (OpenAI first, then Gemini); writes provenance back into the manifest. Skips existing files unless `--force`.

```js
// apps/docs/scripts/generate-images.mjs
// Usage: node apps/docs/scripts/generate-images.mjs [--force] [--only <slug>]
// Requires OPENAI_API_KEY (gpt-image-1) or GEMINI_API_KEY (Nano Banana / Gemini image).
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadManifest, validateManifest, MANIFEST_PATH } from '../lib/image-manifest.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, '..', 'public', 'generated');

const force = process.argv.includes('--force');
const onlyIdx = process.argv.indexOf('--only');
const only = onlyIdx === -1 ? null : process.argv[onlyIdx + 1];

const OPENAI_MODEL = 'gpt-image-1';
const GEMINI_MODEL = 'gemini-2.5-flash-image';

function pickProvider() {
  if (process.env.OPENAI_API_KEY) return { provider: 'openai', model: OPENAI_MODEL };
  if (process.env.GEMINI_API_KEY) return { provider: 'gemini', model: GEMINI_MODEL };
  console.error('No OPENAI_API_KEY or GEMINI_API_KEY set — cannot generate. The site builds fine without images (gradient fallbacks).');
  process.exit(1);
}

async function generateOpenAI(prompt, size) {
  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    // gpt-image-1 accepts only 1024x1024, 1536x1024, 1024x1536 — the manifest sticks to these.
    body: JSON.stringify({ model: OPENAI_MODEL, prompt, size, n: 1 }),
  });
  if (!res.ok) throw new Error(`openai ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return Buffer.from(data.data[0].b64_json, 'base64');
}

async function generateGemini(prompt) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    }
  );
  if (!res.ok) throw new Error(`gemini ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const part = data.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
  if (!part) throw new Error('gemini returned no image data');
  return Buffer.from(part.inlineData.data, 'base64');
}

const manifest = loadManifest();
const check = validateManifest(manifest);
if (!check.ok) {
  console.error('Manifest invalid:\n' + check.errors.join('\n'));
  process.exit(1);
}

const { provider, model } = pickProvider();
mkdirSync(outDir, { recursive: true });

for (const img of manifest.images) {
  if (only && img.slug !== only) continue;
  const outFile = path.join(outDir, `${img.slug}.png`);
  if (existsSync(outFile) && !force) {
    console.log(`skip ${img.slug} (exists; --force to regenerate)`);
    continue;
  }
  const prompt = `${manifest.styleGuide}\n\n${img.prompt}`;
  console.log(`generating ${img.slug} via ${provider}/${model}...`);
  const buf = provider === 'openai' ? await generateOpenAI(prompt, img.size) : await generateGemini(prompt);
  writeFileSync(outFile, buf);
  img.provenance = { provider, model, generatedAt: new Date().toISOString().slice(0, 10) };
  console.log(`wrote ${outFile} (${buf.length} bytes)`);
}

writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n');
console.log('manifest provenance updated');
```

- [ ] **Step 7: Gitignore the output + dry-run the script without keys**

Append `public/generated/` to `apps/docs/.gitignore`.

Run: `env -u OPENAI_API_KEY -u GEMINI_API_KEY node apps/docs/scripts/generate-images.mjs`
Expected: exits 1 with the clear no-keys message (this is the deliberate fail-fast path).

If a key IS available in the environment, optionally run `node apps/docs/scripts/generate-images.mjs --only hero-backdrop` and eyeball the output; do NOT commit PNGs in this task.

- [ ] **Step 8: Commit**

```bash
git add apps/docs/assets/images.json apps/docs/lib/image-manifest.mjs apps/docs/scripts/generate-images.mjs apps/docs/test/image-manifest.test.mjs apps/docs/.gitignore
git commit -m "feat(site): reproducible image-generation pipeline with provenance manifest"
```

---

### Task 13: Sitemap + link-check script

**Files:**
- Create: `apps/docs/app/sitemap.ts`
- Create: `apps/docs/scripts/check-links.mjs`
- Test: `apps/docs/test/check-links.test.mjs`

**Interfaces:**
- Consumes: `MARKETING_ROUTES`, `SITE_URL` (T5), `INTEGRATIONS` (T1), `source` from `apps/docs/lib/source.ts` (existing Fumadocs loader — check its exact export shape before use; docs pages expose `page.url`).
- Produces: `buildUrlList(sitemapXml, base)` in check-links (exported for tests) → array of same-origin URLs.

- [ ] **Step 1: Write the sitemap**

```ts
// apps/docs/app/sitemap.ts
import type { MetadataRoute } from 'next';
import { MARKETING_ROUTES, SITE_URL } from '@/lib/routes.mjs';
import { INTEGRATIONS } from '@/lib/integration-facts.mjs';
import { source } from '@/lib/source';

export default function sitemap(): MetadataRoute.Sitemap {
  const marketing = MARKETING_ROUTES.map((r) => ({ url: `${SITE_URL}${r.path === '/' ? '' : r.path}` }));
  const integrations = INTEGRATIONS.map((i) => ({ url: `${SITE_URL}/integrations/${i.slug}` }));
  const docs = source.getPages().map((p) => ({ url: `${SITE_URL}${p.url}` }));
  return [...marketing, ...integrations, ...docs];
}
```

(Verify `source.getPages()` against `apps/docs/lib/source.ts` — if the loader exposes a different accessor, adapt; the intent is one sitemap URL per docs page.)

- [ ] **Step 2: Write the failing test for the URL-list builder**

```js
// apps/docs/test/check-links.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildUrlList } from '../scripts/check-links.mjs';

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>https://agenticlifecycle.ai</loc></url>
<url><loc>https://agenticlifecycle.ai/lifecycle</loc></url>
<url><loc>https://agenticlifecycle.ai/docs/toolkit/spec-lint</loc></url>
</urlset>`;

test('extracts every loc and rebases onto the target origin', () => {
  const urls = buildUrlList(XML, 'http://localhost:3000');
  assert.deepEqual(urls, [
    'http://localhost:3000/',
    'http://localhost:3000/lifecycle',
    'http://localhost:3000/docs/toolkit/spec-lint',
  ]);
});

test('empty sitemap yields empty list', () => {
  assert.deepEqual(buildUrlList('<urlset></urlset>', 'http://localhost:3000'), []);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test apps/docs/test/check-links.test.mjs`
Expected: FAIL — module not found

- [ ] **Step 4: Write the link-check script**

```js
// apps/docs/scripts/check-links.mjs
// Cutover gate (spec §6): crawl the sitemap of a running deployment and assert
// every URL (plus known legacy docs paths) returns 200.
// Usage: node apps/docs/scripts/check-links.mjs <base-url>
//   e.g. node apps/docs/scripts/check-links.mjs http://localhost:3000
//        node apps/docs/scripts/check-links.mjs https://<preview>.vercel.app

export const LEGACY_PATHS = [
  '/docs',
  '/docs/getting-started',
  '/docs/toolkit/spec-lint',
  '/docs/integrations/claude-code',
];

export function buildUrlList(sitemapXml, base) {
  const origin = new URL(base).origin;
  const locs = [...sitemapXml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  return locs.map((loc) => {
    const u = new URL(loc);
    return `${origin}${u.pathname === '/' ? '/' : u.pathname}`;
  });
}

async function main(base) {
  const res = await fetch(`${base.replace(/\/$/, '')}/sitemap.xml`);
  if (!res.ok) {
    console.error(`sitemap.xml fetch failed: ${res.status}`);
    process.exit(1);
  }
  const urls = new Set([
    ...buildUrlList(await res.text(), base),
    ...LEGACY_PATHS.map((p) => `${new URL(base).origin}${p}`),
  ]);
  let failed = 0;
  for (const url of urls) {
    const r = await fetch(url, { redirect: 'follow' });
    if (r.ok) {
      console.log(`  ok ${url}`);
    } else {
      console.error(`FAIL ${r.status} ${url}`);
      failed++;
    }
  }
  console.log(`${urls.size} URLs checked, ${failed} failures`);
  process.exit(failed === 0 ? 0 : 1);
}

const base = process.argv[2];
if (base) {
  await main(base);
} else if (import.meta.url === `file://${process.argv[1]}`) {
  console.error('usage: node apps/docs/scripts/check-links.mjs <base-url>');
  process.exit(1);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test apps/docs/test/check-links.test.mjs`
Expected: PASS

- [ ] **Step 6: Verify the sitemap builds and the crawler works end-to-end**

```bash
npm run build --workspace @adlc/docs
(cd apps/docs && npx next start -p 3100 &) && sleep 3
node apps/docs/scripts/check-links.mjs http://localhost:3100
kill %1
```
Expected: `0 failures`, exit 0

- [ ] **Step 7: Commit**

```bash
git add apps/docs/app/sitemap.ts apps/docs/scripts/check-links.mjs apps/docs/test/check-links.test.mjs
git commit -m "feat(site): sitemap and cutover link-check script"
```

---

### Task 14: Full verification sweep

**Files:** none new — this is the gate before review.

- [ ] **Step 1: Full test suite from the repo root**

Run: `npm test`
Expected: every suite green, including all seven new `apps/docs/test/*.test.mjs` files

- [ ] **Step 2: Typecheck + production build**

Run: `cd apps/docs && npm run types:check && cd ../.. && npm run build --workspace @adlc/docs`
Expected: clean build; note the route list in the build output includes `/`, `/lifecycle`, `/failure-modes`, `/vs-sdlc`, `/toolkit`, `/integrations`, `/integrations/[slug]` (6 static), `/enterprise`, `/docs/**`, `/sitemap.xml`

- [ ] **Step 3: Manual smoke pass**

```bash
(cd apps/docs && npx next start -p 3100 &) && sleep 3
node apps/docs/scripts/check-links.mjs http://localhost:3100
kill %1
```
Then eyeball in a browser: hero animation staggers in (and is static under OS reduced-motion), every nav link lands, gate badges show glyph+label, docs at `/docs` unaffected.

- [ ] **Step 4: Update apps/docs/README.md**

Add a short "Marketing site" section: the app now serves the marketing pages at `/` plus Fumadocs at `/docs`; mention `scripts/generate-images.mjs` (needs `OPENAI_API_KEY` or `GEMINI_API_KEY`; output gitignored) and `scripts/check-links.mjs <base-url>` as the cutover gate.

- [ ] **Step 5: Commit**

```bash
git add apps/docs/README.md
git commit -m "docs(site): document marketing routes, imagegen and link-check scripts"
```

---

### Task 15: Deployment checklist (manual, maintainer)

Not agent-executable — record here so the merge PR can link it.

- [ ] Vercel: link the project, Root Directory = `apps/docs`.
- [ ] Add domain `agenticlifecycle.ai` (primary).
- [ ] Add `devlifecycle.ai` and configure 301 redirect → `agenticlifecycle.ai` (path-preserving).
- [ ] Keep `adlc-docs.vercel.app` attached and 301 → apex (path-preserving) after DNS settles.
- [ ] Run `node apps/docs/scripts/check-links.mjs https://<preview-url>` against the preview before pointing DNS.
- [ ] Optionally: generate + commit the image assets (`node apps/docs/scripts/generate-images.mjs`, then remove `public/generated/` from `apps/docs/.gitignore` and commit the PNGs deliberately, checking each against the emblem/trademark guardrail).

---

## Plan Self-Review Notes

- **Spec coverage:** §1 positioning → T7 copy; §2 IA + landing narrative → T5, T7–T11; §2 canonical strategy → theoryLink citations in T8–T10; §3 mechanics → T1/T3 grounding, unchanged `/docs`; §4 Layer 1 diagrams → T7 (gate sequence, terminal cards), T8 (pipeline, dials), T9 (failure map, vs split), T10 (constellation), T11 (evidence trail); §4 Layer 2 imagery + provenance → T12; §4 accessibility criteria → T6 (by construction) + T14 smoke; §5 enterprise → T11 (mailto-only; v1.1 Attio explicitly out of this plan); §6 domains → T13 (link check) + T15 (manual); §7 testing → T1–T5, T12–T13 TDD, T14 sweep; §8 out of scope respected.
- **Known intentional deviation:** spec §4 Layer 2 lists per-page OG cards (generated background + typographic overlay). This plan ships text OG metadata plus a single generated `og-base` background; per-page typographic OG routes (the pattern exists at `app/og/docs/[...slug]/route.tsx`) are deferred to T15, when the generated assets are actually committed — overlay routes before the backgrounds exist would be dead code.
- **WCAG contrast note (spec §4):** measured, the original tokens fail AA as text — `#686b78` computes 3.18:1 on `#1c1d21` and 2.81:1 on `#26272c`, and `#eb3d54` (`--adlc-fail`) computes 3.78:1 on `#26272c` (all below the 4.5:1 normal-text threshold). Marketing surfaces now use two AA-verified text tokens instead: `--mk-muted: #9093a0` (5.51:1 on `#1c1d21`, 4.87:1 on `#26272c`) for secondary copy and `--mk-fail-text: #f2788a` (6.28:1 / 5.56:1) for FAIL text. `#686b78` and `--adlc-fail` remain for non-text uses (borders, backgrounds, the cursor block), where 3:1 suffices.
- **Task-order note:** T5's route test goes fully green only at T11 — expected and called out in both tasks.
- **Gate-funnel visual (spec §4 Layer 1):** substituted by the hero gate-sequence animation plus the terminal verdict cards; recorded as a deliberate deviation.
- **Image manifest:** only `hero-backdrop` currently has a consuming `Backdrop`; the 5 other page backdrops and `og-base` need pages wired for `Backdrop` (or OG routes) before committed PNGs become visible — T15 checklist item.
- **llms.txt** now leads with the marketing pages and integrations, then the docs index (reversed during the SEO/GEO pass; the original docs-only decision predated that work).
