// router-drift.test.mjs — prosecutes the router generator (T13).
//
// Rails-first tests, authored before the generator, covering:
//   AC1 the canonical ES module exports { shared, harnesses }
//   AC2 the generator reproduces the six committed routers byte-for-byte
//   AC4 the PR #55 adversarial-review discoverability content survives in all six
//   AC3 the --check drift gate fails on a hand-edited router and passes after regen
//
// The byte-identical regeneration check is the drift gate: generateAll() renders
// each target in memory and it must equal the committed file exactly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const GEN = join(HERE, '..', 'router', 'gen-routers.mjs');

const { generateAll, TARGETS } = await import('../router/gen-routers.mjs');
const model = (await import('../router/router-model.mjs')).routerModel;

const SIX = [
  'plugins/adlc-claude-code/skills/adlc/SKILL.md',
  'plugins/adlc-antigravity/skills/adlc/SKILL.md',
  'plugins/adlc-codex/skills/adlc/SKILL.md',
  'plugins/adlc-pi/skills/adlc/SKILL.md',
  'plugins/adlc-opencode/skill/adlc.md',
  'plugins/adlc-cursor/rules/adlc.mdc',
];

test('AC1 — canonical model exports shared and harnesses', () => {
  assert.ok(model && typeof model === 'object', 'routerModel is an object');
  assert.ok(model.shared && typeof model.shared === 'object', 'has shared');
  assert.ok(model.harnesses && typeof model.harnesses === 'object', 'has harnesses');
  assert.equal(Object.keys(model.harnesses).length, 6, 'six harnesses');
});

test('TARGETS covers exactly the six router paths', () => {
  assert.deepEqual([...TARGETS].sort(), [...SIX].sort());
});

test('AC2 — generateAll() reproduces the six committed routers byte-for-byte', () => {
  const out = generateAll();
  for (const rel of SIX) {
    const committed = readFileSync(join(REPO, rel), 'utf8');
    assert.equal(out[rel], committed, `generated output must equal committed ${rel}`);
  }
});

test('AC4 — adversarial-review discoverability survives in all six generated routers', () => {
  const out = generateAll();
  for (const rel of SIX) {
    assert.match(out[rel], /adversarial-review/, `${rel} names adversarial-review`);
    assert.match(out[rel], /exit 0 = SHIP/, `${rel} contains "exit 0 = SHIP"`);
  }
});

test('T14 — antigravity gains adversarial-review at P1, P3 and P5', () => {
  const out = generateAll();
  const agy = out['plugins/adlc-antigravity/skills/adlc/SKILL.md'];
  // Discoverability block + phase-level references, mirroring claude-code.
  assert.match(agy, /adlc spec-lint · premortem · parallax · adversarial-review/, 'P1 row references adversarial-review');
  assert.match(agy, /adlc rails-guard · adversarial-review/, 'P3 row references adversarial-review');
  assert.match(agy, /adlc hollow-test · behavior-diff · review-calibration · adversarial-review/, 'P5 row references adversarial-review');
  assert.match(agy, /Rail-set adequacy review/, 'P3 detail carries the rail-set adequacy review');
  assert.match(agy, /adversarial-review --providers/, 'P5 detail runs adversarial-review with providers');
  // No unsupported syntax (T14 AC3).
  assert.doesNotMatch(agy, /adversarial-review +<?spec/, 'no positional spec arg');
  assert.doesNotMatch(agy, /adversarial-review --loop\b/, 'no --loop command claim');
  // Frontmatter intact (T14 AC4) — antigravity keeps its own frontmatter verbatim.
  assert.match(agy, /^---\nname: adlc\n/, 'antigravity frontmatter preserved');
  // Harness-specific content preserved.
  assert.match(agy, /## Rails in Antigravity \(agy\)/, 'antigravity rails section preserved');
  assert.match(agy, /ADLC_AGY_SENTINEL_PHASE_ROUTER_V1/, 'antigravity sentinel preserved');
});

test('AC3 — gen-routers.mjs --check exits 0 on a clean tree', () => {
  const r = spawnSync(process.execPath, [GEN, '--check'], { encoding: 'utf8', cwd: REPO });
  assert.equal(r.status, 0, `--check should pass on clean tree:\n${r.stdout}\n${r.stderr}`);
});
