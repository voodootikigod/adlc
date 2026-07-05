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
