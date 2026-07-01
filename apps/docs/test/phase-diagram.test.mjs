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

test('buildPhaseMermaid highlights with exact colors and all nodes present', () => {
  const out = buildPhaseMermaid('P3');
  // Exact style with precise hex colors (load-bearing)
  assert.ok(out.includes('  style P3 fill:#4fb4d8,stroke:#cbcdd2,color:#1c1d21'), 'active phase highlight style');
  // All 8 node labels present
  assert.ok(out.includes('  P0["P0 Triage"]'), 'P0 node');
  assert.ok(out.includes('  P1["P1 Interrogate"]'), 'P1 node');
  assert.ok(out.includes('  P2["P2 Decompose"]'), 'P2 node');
  assert.ok(out.includes('  P3["P3 Rail"]'), 'P3 node');
  assert.ok(out.includes('  P4["P4 Build"]'), 'P4 node');
  assert.ok(out.includes('  P5["P5 Prosecute"]'), 'P5 node');
  assert.ok(out.includes('  P6["P6 Review"]'), 'P6 node');
  assert.ok(out.includes('  P7["P7 Distill"]'), 'P7 node');
  // All 7 sequential edges
  assert.ok(out.includes('  P0 --> P1'), 'edge P0 to P1');
  assert.ok(out.includes('  P1 --> P2'), 'edge P1 to P2');
  assert.ok(out.includes('  P2 --> P3'), 'edge P2 to P3');
  assert.ok(out.includes('  P3 --> P4'), 'edge P3 to P4');
  assert.ok(out.includes('  P4 --> P5'), 'edge P4 to P5');
  assert.ok(out.includes('  P5 --> P6'), 'edge P5 to P6');
  assert.ok(out.includes('  P6 --> P7'), 'edge P6 to P7');
});

test('buildPhaseMermaid rejects unknown phases', () => {
  assert.throws(() => buildPhaseMermaid('P9'), /unknown phase/i);
});
