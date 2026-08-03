// check-consolidation.test.mjs — prosecutes the consolidation-equivalence check.
//
// The check (scripts/router/check-consolidation.mjs) proves the consolidation did
// not regress any harness's routing (AC5) or frontmatter (AC8) versus the
// pre-consolidation baseline, and refuses to silently pass on an empty/unresolved
// baseline (AC9).
//
// Golden prosecution: a synthetic routing swap and a frontmatter mutation must each
// be CAUGHT — a hollow "it ran" pass is not enough.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, execSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const CHECK = join(HERE, '..', 'router', 'check-consolidation.mjs');

const { parseRouting, parseFrontmatter, compareRouting, run } = await import('../router/check-consolidation.mjs');

const PROSE = `---
name: adlc
---
# ADLC — phase routing

## The phases

### P1 — Interrogate
- \`adlc spec-lint <spec.md>\` — lint it.
- \`adlc premortem <spec.md>\` — stress it.

### P3 — Rail
- \`adlc rails-guard --base <ref>\` — freeze paths.

### P5 — Prosecute
- \`adlc hollow-test\` — mutate.
- \`adlc behavior-diff capture\` — diff.
`;

const TABLE = `---
name: adlc
---
# ADLC phase router

| You're trying to… | Phase | Gate |
| --- | --- | --- |
| Pin down a spec | P1 | \`adlc spec-lint\`, \`adlc premortem\` |
| Freeze rails | P3 | \`adlc rails-guard\` |
| Prosecute | P5 | \`adlc hollow-test\`, \`adlc behavior-diff\` |
`;

test('parseRouting (prose) keys adlc gates by phase heading', () => {
  const r = parseRouting(PROSE, 'prose');
  assert.deepEqual(r.P1, ['premortem', 'spec-lint']);
  assert.deepEqual(r.P3, ['rails-guard']);
  assert.deepEqual(r.P5, ['behavior-diff', 'hollow-test']);
});

test('parseRouting (table) keys adlc gates by phase column', () => {
  const r = parseRouting(TABLE, 'table');
  assert.deepEqual(r.P1, ['premortem', 'spec-lint']);
  assert.deepEqual(r.P3, ['rails-guard']);
  assert.deepEqual(r.P5, ['behavior-diff', 'hollow-test']);
});

test('AC5 golden — a same-phase-line swap is caught (prose)', () => {
  const base = parseRouting(PROSE, 'prose');
  // Swap: move rails-guard to P5 and hollow-test to P3 — same tokens, wrong phases.
  const swapped = parseRouting(
    PROSE.replace('### P3 — Rail\n- `adlc rails-guard --base <ref>` — freeze paths.',
                  '### P3 — Rail\n- `adlc hollow-test` — freeze paths.')
         .replace('### P5 — Prosecute\n- `adlc hollow-test` — mutate.',
                  '### P5 — Prosecute\n- `adlc rails-guard` — mutate.'),
    'prose');
  const drift = compareRouting(base, swapped);
  assert.ok(drift.length > 0, 'swap must produce ROUTING DRIFT');
});

test('AC5 golden — a table cell swap is caught', () => {
  const base = parseRouting(TABLE, 'table');
  const swapped = parseRouting(
    TABLE.replace('| Freeze rails | P3 | `adlc rails-guard` |',
                  '| Freeze rails | P3 | `adlc hollow-test` |'),
    'table');
  const drift = compareRouting(base, swapped);
  assert.ok(drift.length > 0, 'table swap must produce ROUTING DRIFT');
});

test('AC5 golden — identical routing produces no drift', () => {
  const drift = compareRouting(parseRouting(PROSE, 'prose'), parseRouting(PROSE, 'prose'));
  assert.deepEqual(drift, []);
});

test('AC8 golden — a frontmatter mutation is caught', () => {
  const a = parseFrontmatter(PROSE);
  const mutated = PROSE.replace('name: adlc', 'name: adlc-evil');
  const b = parseFrontmatter(mutated);
  assert.notEqual(a, b, 'frontmatter block differs after mutation');
  assert.match(a, /^---\n/, 'frontmatter starts with ---');
});

test('AC9 — empty BASE exits non-zero with a clear error (no silent pass)', () => {
  const r = spawnSync(process.execPath, [CHECK, ''], { encoding: 'utf8', cwd: REPO });
  assert.notEqual(r.status, 0, 'empty base must not pass');
  assert.match(`${r.stdout}${r.stderr}`, /baseline/i, 'error mentions the unresolved baseline');
});

test('AC9 — unresolved ref exits non-zero', () => {
  const r = spawnSync(process.execPath, [CHECK, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'], { encoding: 'utf8', cwd: REPO });
  assert.notEqual(r.status, 0, 'unresolvable base must not pass');
});

test('AC5 integration — check passes against the real pre-consolidation baseline', () => {
  const base = execSync('git merge-base origin/main HEAD 2>/dev/null || git merge-base main HEAD', {
    cwd: REPO, encoding: 'utf8',
  }).trim();
  assert.ok(base.length >= 7, 'resolved a baseline commit');
  const r = spawnSync(process.execPath, [CHECK, base], { encoding: 'utf8', cwd: REPO });
  assert.equal(r.status, 0, `no ROUTING DRIFT vs baseline:\n${r.stdout}\n${r.stderr}`);
});

test('AC8 integration — --frontmatter passes against the real baseline', () => {
  const base = execSync('git merge-base origin/main HEAD 2>/dev/null || git merge-base main HEAD', {
    cwd: REPO, encoding: 'utf8',
  }).trim();
  const r = spawnSync(process.execPath, [CHECK, base, '--frontmatter'], { encoding: 'utf8', cwd: REPO });
  assert.equal(r.status, 0, `no FRONTMATTER DRIFT vs baseline:\n${r.stdout}\n${r.stderr}`);
});

// ------------------------------------------------- renamed routers (baselinePath)
//
// A router that moved since the baseline has no file at its current path in the
// baseline tree. Without `baselinePath` the check cannot resolve it and aborts,
// which would take the whole comparison out of service exactly when a rename is
// the thing most worth comparing.

const BASE = execSync('git merge-base origin/main HEAD 2>/dev/null || git merge-base main HEAD', {
  cwd: REPO, encoding: 'utf8',
}).trim();
const MOVED = 'plugins/adlc-gemini/skills/adlc/SKILL.md';
const MOVED_FROM = 'plugins/adlc-antigravity/skills/adlc/SKILL.md';
const baselineRouter = () => execSync(`git show ${BASE}:${MOVED_FROM}`, {
  cwd: REPO, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
});

test('a router with no baseline at its current path is an operational error without baselinePath', () => {
  assert.throws(
    () => run(BASE, {
      harnesses: { moved: { path: MOVED, format: 'prose' } },
      readWork: () => baselineRouter(),
    }),
    (e) => e.op === true && /baseline unresolved/.test(e.msg),
    'a missing baseline must abort, not silently pass'
  );
});

test('baselinePath follows the rename so the routing comparison still runs', () => {
  const drift = run(BASE, {
    harnesses: { moved: { path: MOVED, baselinePath: MOVED_FROM, format: 'prose' } },
    readWork: () => baselineRouter(),
  });
  assert.deepEqual(drift, [], 'identical content across the rename is not drift');
});

test('baselinePath does not disable the routing check — a gate swap is still caught', () => {
  const drift = run(BASE, {
    harnesses: { moved: { path: MOVED, baselinePath: MOVED_FROM, format: 'prose' } },
    readWork: () => baselineRouter().replace(/adlc spec-lint/g, 'adlc totally-different-gate'),
  });
  assert.equal(drift.length > 0, true, 'a routing swap across a rename must still report');
  assert.match(drift.join('\n'), /ROUTING DRIFT/);
});

// --------------------------------- superseded frontmatter (supersedesBaselineFrontmatter)

test('a replaced frontmatter is reported when the harness pins nothing', () => {
  const drift = run(BASE, {
    frontmatter: true,
    harnesses: { moved: { path: MOVED, baselinePath: MOVED_FROM, format: 'prose' } },
    readWork: () => baselineRouter().replace('name: adlc', 'name: adlc-renamed'),
  });
  assert.match(drift.join('\n'), /FRONTMATTER DRIFT/);
});

test('supersedesBaselineFrontmatter accepts the replacement only against the exact pinned baseline', () => {
  const superseded = parseFrontmatter(baselineRouter());
  assert.match(superseded, /^---\n/, 'fixture sanity: the baseline router has frontmatter');

  const accepted = run(BASE, {
    frontmatter: true,
    harnesses: {
      moved: {
        path: MOVED, baselinePath: MOVED_FROM, format: 'prose',
        supersedesBaselineFrontmatter: superseded,
      },
    },
    readWork: () => baselineRouter().replace('name: adlc', 'name: adlc-renamed'),
  });
  assert.deepEqual(accepted, [], 'the reviewed replacement is accepted');

  // The pin is load-bearing: if the baseline ever stops reading exactly the
  // recorded block, the acceptance lapses instead of silently covering it.
  const stalePin = run(BASE, {
    frontmatter: true,
    harnesses: {
      moved: {
        path: MOVED, baselinePath: MOVED_FROM, format: 'prose',
        supersedesBaselineFrontmatter: superseded.replace('name: adlc', 'name: something-else'),
      },
    },
    readWork: () => baselineRouter().replace('name: adlc', 'name: adlc-renamed'),
  });
  assert.match(stalePin.join('\n'), /FRONTMATTER DRIFT/, 'a pin that no longer matches the baseline must report');
});

test('supersedesBaselineFrontmatter does not suppress the routing check', () => {
  const drift = run(BASE, {
    frontmatter: true,
    harnesses: {
      moved: {
        path: MOVED, baselinePath: MOVED_FROM, format: 'prose',
        supersedesBaselineFrontmatter: parseFrontmatter(baselineRouter()),
      },
    },
    readWork: () => baselineRouter().replace(/adlc spec-lint/g, 'adlc totally-different-gate'),
  });
  assert.match(drift.join('\n'), /ROUTING DRIFT/, 'frontmatter supersede must not blanket-exempt the harness');
});
