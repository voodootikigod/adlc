import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildPhaseMermaid, PHASES, HUMAN_GATE_IDS } from '../lib/phase-graph.mjs';

const docsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('PHASES lists P0..P7 in order', () => {
  assert.deepEqual(PHASES.map((p) => p.id), ['P0','P1','P2','P3','P4','P5','P6','P7']);
});

test('P6 is named Integrate, not Review', () => {
  const p6 = PHASES.find((p) => p.id === 'P6');
  assert.equal(p6.name, 'Integrate');
});

test('every phase names the gate that ends it', () => {
  // The section headline promises "a gate between every one". A phase with no
  // gate would render a blank row under its name and quietly break that claim.
  for (const phase of PHASES) {
    assert.ok(
      typeof phase.gate === 'string' && phase.gate.trim().length > 0,
      `${phase.id}: missing an exit gate`,
    );
  }
});

test('exactly two gates are human, and they are P1 and P6', () => {
  // This ratio is the thesis — machines gate the other six — and it is stated
  // verbatim in the pipeline legend. If the data changes, the legend becomes a
  // lie, so pin both the count and the identities.
  assert.deepEqual(HUMAN_GATE_IDS, ['P1', 'P6']);
  assert.equal(PHASES.filter((p) => p.human).length, 2);
});

test('the pipeline legend states the real machine/human split', () => {
  const source = readFileSync(
    path.join(docsRoot, 'components/marketing/lifecycle-pipeline.tsx'),
    'utf8',
  );
  const machineCount = PHASES.length - HUMAN_GATE_IDS.length;
  assert.ok(
    new RegExp(`${machineCount === 6 ? 'Six' : String(machineCount)} gates a machine can check`).test(source),
    'the legend must match how many gates are actually machine-checked',
  );
});

test('the lifecycle page derives human gates from the shared source', () => {
  // It used to keep its own `new Set(['P1','P6'])`, so the page and the diagram
  // above it could disagree about which gates are human.
  const source = readFileSync(path.join(docsRoot, 'app/(home)/lifecycle/page.tsx'), 'utf8');
  assert.ok(source.includes('HUMAN_GATE_IDS'), 'the page must import the shared list');
  assert.ok(
    !/new Set\(\[\s*'P1'\s*,\s*'P6'\s*\]\)/.test(source),
    'the page must not re-declare which phases are human-gated',
  );
});

test('buildPhaseMermaid highlights the active phase and is a flowchart', () => {
  const out = buildPhaseMermaid('P3');
  assert.match(out, /^flowchart TD/);
  assert.ok(out.includes('  style P3 fill:#4fb4d8,stroke:#cbcdd2,color:#1c1d21'), 'active phase highlight style');
  assert.ok(out.includes('P3["P3 Rail"]'), 'P3 node label');
});

test('buildPhaseMermaid emits all eight phase nodes with canonical names', () => {
  const out = buildPhaseMermaid('P3');
  assert.ok(out.includes('  P0["P0 Triage"]'), 'P0 node');
  assert.ok(out.includes('  P1["P1 Interrogate"]'), 'P1 node');
  assert.ok(out.includes('  P2["P2 Decompose"]'), 'P2 node');
  assert.ok(out.includes('  P3["P3 Rail"]'), 'P3 node');
  assert.ok(out.includes('  P4["P4 Build"]'), 'P4 node');
  assert.ok(out.includes('  P5["P5 Prosecute"]'), 'P5 node');
  assert.ok(out.includes('  P6["P6 Integrate"]'), 'P6 node');
  assert.ok(out.includes('  P7["P7 Distill"]'), 'P7 node');
});

test('the two human gates are present, wired in, and styled with the wish token hex', () => {
  const out = buildPhaseMermaid('P0');
  // Gate 1 after P1 (spec approval)
  assert.ok(out.includes('G1{{"Human gate: Is this what I meant?"}}'), 'gate 1 node');
  assert.ok(out.includes('  P1 --> G1'), 'edge P1 to gate 1');
  assert.ok(out.includes('  G1 --> P2'), 'edge gate 1 to P2');
  // Gate 2 after P6 (behavioral acceptance)
  assert.ok(out.includes('G2{{"Human gate: Is this what I meant, running?"}}'), 'gate 2 node');
  assert.ok(out.includes('  P6 --> G2'), 'edge P6 to gate 2');
  assert.ok(out.includes('  G2 --> P7'), 'edge gate 2 to P7');
  // Gate styling mirrors --adlc-wish (#e5cd52) and differs from active highlight
  assert.ok(out.includes('style G1 fill:#e5cd52'), 'gate 1 wish styling');
  assert.ok(out.includes('style G2 fill:#e5cd52'), 'gate 2 wish styling');
  assert.ok(out.includes('style P0 fill:#4fb4d8'), 'active highlight distinct from gates');
});

test('the remaining sequential edges are present', () => {
  const out = buildPhaseMermaid('P3');
  assert.ok(out.includes('  P0 --> P1'), 'edge P0 to P1');
  assert.ok(out.includes('  P2 --> P3'), 'edge P2 to P3');
  assert.ok(out.includes('  P3 --> P4'), 'edge P3 to P4');
  assert.ok(out.includes('  P4 --> P5'), 'edge P4 to P5');
  assert.ok(out.includes('  P5 --> P6'), 'edge P5 to P6');
});

test('P5 carries the prosecution loop edge', () => {
  const out = buildPhaseMermaid('P3');
  assert.ok(out.includes('  P5 -- "loop until dry" --> P5'), 'P5 self-edge labeled loop until dry');
});

test('P7 feeds back to P0 with a dashed lessons-compound edge', () => {
  const out = buildPhaseMermaid('P3');
  assert.ok(out.includes('  P7 -. "lessons compound" .-> P0'), 'dashed P7 to P0 edge');
});

test('buildPhaseMermaid rejects unknown phases', () => {
  assert.throws(() => buildPhaseMermaid('P9'), /unknown phase/i);
  assert.throws(() => buildPhaseMermaid('Review'), /unknown phase/i);
});
