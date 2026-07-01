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
