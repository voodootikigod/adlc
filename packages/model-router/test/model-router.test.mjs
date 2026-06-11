/**
 * Tests for model-router.
 * Runs offline; all I/O via tmp dirs. Cleans up after itself.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

// ── helpers ──────────────────────────────────────────────────────────────────

function makeTmp() {
  return mkdtempSync(join(tmpdir(), 'model-router-test-'));
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

function writeTickets(dir, tickets) {
  const aidlc = join(dir, '.aidlc');
  mkdirSync(aidlc, { recursive: true });
  writeFileSync(join(aidlc, 'tickets.json'), JSON.stringify({ tickets }));
  return join(aidlc, 'tickets.json');
}

function writeManifest(dir, entries) {
  const aidlc = join(dir, '.aidlc');
  mkdirSync(aidlc, { recursive: true });
  const lines = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
  writeFileSync(join(aidlc, 'manifest.jsonl'), lines);
}

function runCLI(args, cwd) {
  const cli = new URL('../bin/model-router.mjs', import.meta.url).pathname;
  try {
    const out = execFileSync(process.execPath, [cli, ...args], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env },
    });
    return { code: 0, stdout: out, stderr: '' };
  } catch (err) {
    return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

// ── unit: rail density ────────────────────────────────────────────────────────

import { railDensity } from '../lib/density.mjs';

test('railDensity: no rails → 0', () => {
  assert.equal(railDensity({ id: 'T1', title: 't' }), 0);
  assert.equal(railDensity({ id: 'T1', title: 't', rails: [] }), 0);
});

test('railDensity: rails and scope same length → 1', () => {
  const t = { id: 'T1', title: 't', rails: ['a', 'b'], scope: ['x', 'y'] };
  assert.equal(railDensity(t), 1);
});

test('railDensity: more rails than scope → clamped to 1', () => {
  const t = { id: 'T1', title: 't', rails: ['a', 'b', 'c'], scope: ['x'] };
  assert.equal(railDensity(t), 1);
});

test('railDensity: 1 rail, 4 scope → 0.25', () => {
  const t = { id: 'T1', title: 't', rails: ['a'], scope: ['x', 'y', 'z', 'w'] };
  assert.equal(railDensity(t), 0.25);
});

test('railDensity: rails present, no scope → denominator is 1 → 1', () => {
  const t = { id: 'T1', title: 't', rails: ['a'] };
  assert.equal(railDensity(t), 1);
});

// ── unit: priors ──────────────────────────────────────────────────────────────

import { buildPriors, bestTierFromPriors } from '../lib/priors.mjs';

test('buildPriors: ignores non-build entries', () => {
  const entries = [
    { type: 'audit', model: 'mid', category: 'feature', firstPass: true },
    { type: 'build', model: 'cheap', firstPass: true },
  ];
  const p = buildPriors(entries);
  assert.ok(!p.global['mid']);
  assert.ok(p.global['cheap']);
});

test('buildPriors: Laplace smoothing correct', () => {
  const entries = [
    { type: 'build', model: 'mid', firstPass: true },
    { type: 'build', model: 'mid', firstPass: false },
    { type: 'build', model: 'mid', firstPass: true },
  ];
  const p = buildPriors(entries);
  // passes=2, n=3 → (2+1)/(3+2) = 3/5 = 0.6
  assert.equal(p.global['mid'].rate, 3 / 5);
});

test('bestTierFromPriors: returns mid if no tier-named models', () => {
  const priors = { global: {}, byCategory: {} };
  assert.equal(bestTierFromPriors(priors), 'mid');
});

test('bestTierFromPriors: picks highest-rate tier', () => {
  const entries = [
    ...Array(5).fill({ type: 'build', model: 'cheap', firstPass: true }),
    ...Array(5).fill({ type: 'build', model: 'mid', firstPass: false }),
  ];
  const p = buildPriors(entries);
  const best = bestTierFromPriors(p);
  assert.equal(best, 'cheap');
});

test('bestTierFromPriors: uses category data when >= 3 samples', () => {
  const entries = [
    { type: 'build', model: 'cheap', category: 'feature', firstPass: true },
    { type: 'build', model: 'cheap', category: 'feature', firstPass: true },
    { type: 'build', model: 'cheap', category: 'feature', firstPass: true },
    { type: 'build', model: 'mid', category: 'feature', firstPass: false },
    { type: 'build', model: 'mid', category: 'feature', firstPass: false },
    { type: 'build', model: 'mid', category: 'feature', firstPass: false },
  ];
  const p = buildPriors(entries);
  // cheap: (3+1)/(3+2) = 0.8; mid: (0+1)/(3+2) = 0.2 → cheap wins
  const best = bestTierFromPriors(p, 'feature');
  assert.equal(best, 'cheap');
});

test('bestTierFromPriors: skips category with < 3 samples, uses global', () => {
  const entries = [
    { type: 'build', model: 'cheap', category: 'feature', firstPass: true },
    { type: 'build', model: 'cheap', category: 'feature', firstPass: true },
    // Only 2 samples for category → not used
    { type: 'build', model: 'mid', firstPass: true },
    { type: 'build', model: 'mid', firstPass: true },
    { type: 'build', model: 'mid', firstPass: true },
  ];
  const p = buildPriors(entries);
  // category data skipped (n=2); global: cheap has 2 samples, mid has 3
  // cheap: (2+1)/(2+2) = 0.75; mid: (3+1)/(3+2) = 0.8 → mid wins globally
  const best = bestTierFromPriors(p, 'feature');
  assert.equal(best, 'mid');
});

// ── unit: assignment rules ────────────────────────────────────────────────────

import { assignTicket } from '../lib/assign.mjs';

const emptyPriors = { global: {}, byCategory: {} };

test('assign: contract category → frontier/direct', () => {
  const t = { id: 'T1', title: 't', category: 'contract', rails: ['a'], scope: ['b'] };
  const a = assignTicket(t, 5, emptyPriors, 0.2);
  assert.equal(a.tier, 'frontier');
  assert.equal(a.mode, 'direct');
  assert.ok(a.reason.includes('contract'));
});

test('assign: spec category → frontier/direct', () => {
  const t = { id: 'T1', title: 't', category: 'spec', rails: ['a'], scope: ['b'] };
  const a = assignTicket(t, 5, emptyPriors, 0.2);
  assert.equal(a.tier, 'frontier');
  assert.equal(a.mode, 'direct');
});

test('assign: architecture category → frontier/direct', () => {
  const t = { id: 'T1', title: 't', category: 'architecture', rails: ['a'], scope: ['b'] };
  const a = assignTicket(t, 5, emptyPriors, 0.2);
  assert.equal(a.tier, 'frontier');
  assert.equal(a.mode, 'direct');
});

test('assign: below floor → frontier/direct', () => {
  const t = { id: 'T1', title: 't', category: 'feature', rails: [], scope: ['a', 'b', 'c', 'a', 'b'] };
  const a = assignTicket(t, 5, emptyPriors, 0.2);
  // railDensity = 0 < 0.2
  assert.equal(a.tier, 'frontier');
  assert.equal(a.mode, 'direct');
  assert.ok(a.reason.includes('floor'));
});

test('assign: critical path (float=0) no priors → mid/direct', () => {
  const t = { id: 'T1', title: 't', category: 'feature', rails: ['a', 'b'], scope: ['a', 'b'] };
  const a = assignTicket(t, 0, emptyPriors, 0.2);
  assert.equal(a.tier, 'mid');
  assert.equal(a.mode, 'direct');
  assert.ok(a.reason.includes('float=0'));
});

test('assign: critical path with good prior → prior tier used', () => {
  const entries = Array(5).fill({ type: 'build', model: 'cheap', firstPass: true });
  const priors = buildPriors(entries);
  const t = { id: 'T1', title: 't', category: 'feature', rails: ['a', 'b'], scope: ['a', 'b'] };
  const a = assignTicket(t, 0, priors, 0.2);
  assert.equal(a.tier, 'cheap');
  assert.equal(a.mode, 'direct');
});

test('assign: float > 0 + high density → cheap/ladder', () => {
  const t = { id: 'T1', title: 't', category: 'feature', rails: ['a', 'b'], scope: ['a', 'b'] };
  // density = 1.0 >= 0.5
  const a = assignTicket(t, 3, emptyPriors, 0.2);
  assert.equal(a.tier, 'cheap');
  assert.equal(a.mode, 'ladder');
});

test('assign: float > 0 + low-mid density → mid/ladder', () => {
  // density = 1/4 = 0.25 (< 0.5)
  const t = { id: 'T1', title: 't', category: 'feature', rails: ['a'], scope: ['a', 'b', 'c', 'd'] };
  const a = assignTicket(t, 3, emptyPriors, 0.2);
  assert.equal(a.tier, 'mid');
  assert.equal(a.mode, 'ladder');
});

// ── integration: router + CPM float effect ────────────────────────────────────

import { runRouter } from '../lib/router.mjs';

test('runRouter: critical path ticket gets direct mode', async () => {
  const tmp = makeTmp();
  try {
    const ticketsPath = writeTickets(tmp, [
      { id: 'T1', title: 'Block', category: 'feature', rails: ['a', 'b'], scope: ['a', 'b'],
        edges: [{ to: 'T2', contract: 'types.ts' }], duration: 1 },
      { id: 'T2', title: 'Dep', category: 'feature', rails: ['c', 'd'], scope: ['c', 'd'], duration: 1 },
    ]);
    const result = await runRouter({ ticketsPath, floor: 0.2, aidlcDir: join(tmp, '.aidlc') });
    // Both T1 and T2 are on the critical path (linear chain)
    const t1 = result.assignments.find((a) => a.id === 'T1');
    const t2 = result.assignments.find((a) => a.id === 'T2');
    assert.equal(t1.mode, 'direct');
    assert.equal(t2.mode, 'direct');
  } finally {
    cleanup(tmp);
  }
});

test('runRouter: ticket with float uses ladder mode', async () => {
  const tmp = makeTmp();
  try {
    // T1 and T2 both depend on T3; T1 has duration 1, T2 has duration 3
    // T1 has float 2 (T3 must wait for T2 to finish)
    const ticketsPath = writeTickets(tmp, [
      { id: 'T1', title: 'Short', category: 'feature',
        rails: ['a', 'b', 'c', 'd'], scope: ['a', 'b', 'c', 'd'],
        edges: [{ to: 'T3', contract: 'x.ts' }], duration: 1 },
      { id: 'T2', title: 'Long', category: 'feature',
        rails: ['e', 'f', 'g', 'h'], scope: ['e', 'f', 'g', 'h'],
        edges: [{ to: 'T3', contract: 'y.ts' }], duration: 3 },
      { id: 'T3', title: 'Gate', category: 'feature',
        rails: ['i', 'j', 'k', 'l'], scope: ['i', 'j', 'k', 'l'], duration: 1 },
    ]);
    const result = await runRouter({ ticketsPath, floor: 0.2, aidlcDir: join(tmp, '.aidlc') });
    const t1 = result.assignments.find((a) => a.id === 'T1');
    const t2 = result.assignments.find((a) => a.id === 'T2');
    // T1 has float 2, T2 has float 0 (critical), T3 has float 0
    assert.equal(t1.float, 2);
    assert.equal(t1.mode, 'ladder');
    assert.equal(t2.float, 0);
    assert.equal(t2.mode, 'direct');
  } finally {
    cleanup(tmp);
  }
});

// ── integration: cycle detection ──────────────────────────────────────────────

test('runRouter: cycle → opError', async () => {
  const tmp = makeTmp();
  try {
    const ticketsPath = writeTickets(tmp, [
      { id: 'T1', title: 'A', category: 'feature', edges: [{ to: 'T2', contract: 'x' }] },
      { id: 'T2', title: 'B', category: 'feature', edges: [{ to: 'T1', contract: 'y' }] },
    ]);
    await assert.rejects(
      () => runRouter({ ticketsPath, floor: 0.2, aidlcDir: join(tmp, '.aidlc') }),
      (err) => {
        assert.ok(err.message.includes('cycle'), `expected 'cycle' in: ${err.message}`);
        return true;
      }
    );
  } finally {
    cleanup(tmp);
  }
});

// ── integration: prior influence ──────────────────────────────────────────────

test('runRouter: priors influence critical path tier', async () => {
  const tmp = makeTmp();
  try {
    writeManifest(tmp, [
      { type: 'build', model: 'cheap', firstPass: true },
      { type: 'build', model: 'cheap', firstPass: true },
      { type: 'build', model: 'cheap', firstPass: true },
      { type: 'build', model: 'cheap', firstPass: true },
      { type: 'build', model: 'cheap', firstPass: true },
    ]);
    const ticketsPath = writeTickets(tmp, [
      { id: 'T1', title: 'Solo', category: 'feature',
        rails: ['a', 'b'], scope: ['a', 'b'] },
    ]);
    const result = await runRouter({ ticketsPath, floor: 0.2, aidlcDir: join(tmp, '.aidlc') });
    const t1 = result.assignments.find((a) => a.id === 'T1');
    // T1 is on critical path (only ticket); priors say 'cheap' is best
    assert.equal(t1.tier, 'cheap');
    assert.equal(t1.mode, 'direct');
  } finally {
    cleanup(tmp);
  }
});

// ── integration: floor gate (exit 2) via CLI ──────────────────────────────────

test('CLI: exit 2 when ticket below floor', () => {
  const tmp = makeTmp();
  try {
    const aidlc = join(tmp, '.aidlc');
    mkdirSync(aidlc, { recursive: true });
    const ticketsPath = join(aidlc, 'tickets.json');
    writeFileSync(ticketsPath, JSON.stringify({
      tickets: [
        { id: 'T1', title: 'Unreiled', category: 'feature', scope: ['a', 'b'] },
      ],
    }));
    const r = runCLI(['--tickets', ticketsPath, '--floor', '0.2'], tmp);
    assert.equal(r.code, 2, `expected exit 2, got ${r.code}\nstdout:${r.stdout}\nstderr:${r.stderr}`);
    assert.ok(r.stderr.includes('P3 finding') || r.stdout.includes('P3 finding'),
      `expected P3 finding in output:\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  } finally {
    cleanup(tmp);
  }
});

test('CLI: exit 0 when all tickets railed above floor', () => {
  const tmp = makeTmp();
  try {
    const aidlc = join(tmp, '.aidlc');
    mkdirSync(aidlc, { recursive: true });
    const ticketsPath = join(aidlc, 'tickets.json');
    writeFileSync(ticketsPath, JSON.stringify({
      tickets: [
        { id: 'T1', title: 'Railed', category: 'feature',
          rails: ['a', 'b'], scope: ['a', 'b'] },
      ],
    }));
    const r = runCLI(['--tickets', ticketsPath, '--floor', '0.2'], tmp);
    assert.equal(r.code, 0, `expected exit 0, got ${r.code}\nstdout:${r.stdout}\nstderr:${r.stderr}`);
  } finally {
    cleanup(tmp);
  }
});

test('CLI: exit 0 for frontier category even below floor', () => {
  const tmp = makeTmp();
  try {
    const aidlc = join(tmp, '.aidlc');
    mkdirSync(aidlc, { recursive: true });
    const ticketsPath = join(aidlc, 'tickets.json');
    writeFileSync(ticketsPath, JSON.stringify({
      tickets: [
        // contract category → frontier anyway, no gate fail
        { id: 'T1', title: 'ContractTicket', category: 'contract', scope: ['a', 'b'] },
      ],
    }));
    const r = runCLI(['--tickets', ticketsPath, '--floor', '0.2'], tmp);
    assert.equal(r.code, 0, `expected exit 0, got ${r.code}\n${r.stderr}`);
  } finally {
    cleanup(tmp);
  }
});

test('CLI: exit 1 on missing tickets file', () => {
  const tmp = makeTmp();
  try {
    const r = runCLI(['--tickets', join(tmp, 'nonexistent.json')], tmp);
    assert.equal(r.code, 1, `expected exit 1, got ${r.code}`);
  } finally {
    cleanup(tmp);
  }
});

test('CLI: --json flag produces valid JSON', () => {
  const tmp = makeTmp();
  try {
    const aidlc = join(tmp, '.aidlc');
    mkdirSync(aidlc, { recursive: true });
    const ticketsPath = join(aidlc, 'tickets.json');
    writeFileSync(ticketsPath, JSON.stringify({
      tickets: [
        { id: 'T1', title: 'Railed', category: 'feature',
          rails: ['a', 'b', 'c', 'd'], scope: ['a', 'b', 'c', 'd'] },
      ],
    }));
    const r = runCLI(['--tickets', ticketsPath, '--json'], tmp);
    assert.equal(r.code, 0);
    const parsed = JSON.parse(r.stdout);
    assert.ok(Array.isArray(parsed.assignments));
    assert.ok(Array.isArray(parsed.p3Findings));
    assert.equal(parsed.assignments[0].id, 'T1');
  } finally {
    cleanup(tmp);
  }
});

test('CLI: no-args smoke (missing default tickets file → exit 1)', () => {
  const tmp = makeTmp();
  try {
    const r = runCLI([], tmp);
    // .aidlc/tickets.json doesn't exist → operational error → exit 1
    assert.equal(r.code, 1, `expected exit 1, got ${r.code}`);
  } finally {
    cleanup(tmp);
  }
});

// ── integration: full fixture run ─────────────────────────────────────────────

test('CLI: realistic fixture run', () => {
  const tmp = makeTmp();
  try {
    writeManifest(tmp, [
      { type: 'build', model: 'cheap', category: 'feature', firstPass: true },
      { type: 'build', model: 'cheap', category: 'feature', firstPass: true },
      { type: 'build', model: 'cheap', category: 'feature', firstPass: true },
      { type: 'build', model: 'mid', category: 'feature', firstPass: false },
      { type: 'build', model: 'mid', category: 'feature', firstPass: false },
      { type: 'build', model: 'mid', category: 'feature', firstPass: false },
    ]);
    const ticketsPath = writeTickets(tmp, [
      // On critical path, well railed, feature → direct, priors say cheap
      { id: 'T1', title: 'AuthModule', category: 'feature',
        rails: ['test/auth/login.test.ts', 'test/auth/signup.test.ts'],
        scope: ['src/auth/login.ts', 'src/auth/signup.ts'],
        edges: [{ to: 'T3', contract: 'src/types/auth.d.ts' }], duration: 2 },
      // Has float, high density → ladder cheap
      { id: 'T2', title: 'UIComponents', category: 'feature',
        rails: ['test/ui/button.test.ts', 'test/ui/form.test.ts'],
        scope: ['src/ui/button.ts', 'src/ui/form.ts'],
        edges: [{ to: 'T3', contract: 'src/types/ui.d.ts' }], duration: 1 },
      // Gate ticket, critical path end
      { id: 'T3', title: 'IntegrationSpec', category: 'spec',
        scope: ['docs/spec.md'], duration: 1 },
    ]);
    const r = runCLI(['--tickets', ticketsPath, '--json'], tmp);
    assert.equal(r.code, 0, `expected exit 0\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    const t3 = parsed.assignments.find((a) => a.id === 'T3');
    assert.equal(t3.tier, 'frontier', 'spec category should be frontier');
    assert.equal(t3.mode, 'direct');

    const t2 = parsed.assignments.find((a) => a.id === 'T2');
    // T2 has float (shorter duration than T1 for same gate), high density
    assert.equal(t2.mode, 'ladder');
    assert.equal(t2.tier, 'cheap');

    const t1 = parsed.assignments.find((a) => a.id === 'T1');
    assert.equal(t1.mode, 'direct'); // critical path
  } finally {
    cleanup(tmp);
  }
});
