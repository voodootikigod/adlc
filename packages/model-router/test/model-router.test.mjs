/**
 * Tests for model-router.
 * Runs offline; all I/O via tmp dirs. Cleans up after itself.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmp } from '@adlc/core/test-kit';

// ── helpers ──────────────────────────────────────────────────────────────────

function writeTickets(dir, tickets) {
  const adlc = join(dir, '.adlc');
  mkdirSync(adlc, { recursive: true });
  writeFileSync(join(adlc, 'tickets.json'), JSON.stringify({ tickets }));
  return join(adlc, 'tickets.json');
}

function writeManifest(dir, entries) {
  const adlc = join(dir, '.adlc');
  mkdirSync(adlc, { recursive: true });
  const lines = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
  writeFileSync(join(adlc, 'manifest.jsonl'), lines);
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

import { railDensity, isNonCodeScopePattern } from '../lib/density.mjs';

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

test('railDensity: blank or non-string rail entries do not count as coverage', () => {
  assert.equal(railDensity({ id: 'T1', title: 't', rails: [''], scope: ['src/**'] }), 0);
  assert.equal(railDensity({ id: 'T1', title: 't', rails: ['   '], scope: ['src/**'] }), 0);
  assert.equal(railDensity({ id: 'T1', title: 't', rails: [null, 42], scope: ['src/**'] }), 0);
  assert.equal(railDensity({ id: 'T1', title: 't', rails: ['', 'test/a.test.mjs'], scope: ['src/a.mjs', 'src/b.mjs'] }), 0.5);
});

test('railDensity: invisible-only patterns (zero-width, word joiner, Braille blank, Hangul filler) do not count', () => {
  for (const ghost of ['\u200b', '\u2060', '\u2800', '\u3164', '\u115f\u1160', '\ufeff', '\u0000']) {
    assert.equal(railDensity({ id: 'T1', title: 't', rails: [ghost], scope: ['src/**'] }), 0, JSON.stringify(ghost));
    assert.equal(railDensity({ id: 'T1', title: 't', rails: [ghost], scope: [ghost] }), 0, JSON.stringify(ghost));
    assert.equal(railDensity({ id: 'T1', title: 't', rails: ['test/a.mjs'], scope: [ghost] }), 0, JSON.stringify(ghost));
  }
});

test('railDensity: a glob-only pattern counts, and an invisible suffix does not make a pattern distinct', () => {
  assert.equal(railDensity({ id: 'T1', title: 't', rails: ['**'], scope: ['src/**'] }), 1);
  assert.equal(railDensity({ id: 'T1', title: 't', rails: ['test/a.mjs', 'test/a.mjs\u200b'], scope: ['src/a.mjs', 'src/b.mjs'] }), 0.5);
});

test('railDensity: duplicate rails and scope entries count once', () => {
  assert.equal(railDensity({ id: 'T1', title: 't', rails: ['a', 'a', 'a'], scope: ['x', 'y', 'z'] }), 1 / 3);
  assert.equal(railDensity({ id: 'T1', title: 't', rails: ['a', ' a '], scope: ['x', 'x'] }), 1);
  assert.equal(railDensity({ id: 'T1', title: 't', rails: ['a'], scope: ['x', 'x', 'x', 'y'] }), 0.5);
});

test('railDensity: blank-only scope → 0 (unbounded), not division by a padded length', () => {
  assert.equal(railDensity({ id: 'T1', title: 't', rails: ['a'], scope: ['', '  '] }), 0);
});

test('railDensity: rails present, no scope or empty scope → 0', () => {
  assert.equal(railDensity({ id: 'T1', title: 't', rails: ['a'] }), 0);
  assert.equal(railDensity({ id: 'T1', title: 't', rails: ['a'], scope: [] }), 0);
  assert.equal(railDensity({ id: 'T1', title: 't', rails: ['a'], scope: null }), 0);
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

// ── budget (issue #272: D1 says model-router emits {model, mode, budget}) ────

test('assign: emits a budget on every assignment (D1 promise)', () => {
  const t = { id: 'T1', title: 't', category: 'feature', rails: ['a', 'b'], scope: ['a', 'b'] };
  const a = assignTicket(t, 0, emptyPriors, 0.2);
  assert.equal(typeof a.budget, 'number');
  assert.ok(a.budget > 0);
});

test('assign: an explicit ticket.budget always wins over the tier default', () => {
  const t = { id: 'T1', title: 't', category: 'feature', rails: ['a', 'b'], scope: ['a', 'b'], budget: 12_345 };
  const a = assignTicket(t, 0, emptyPriors, 0.2);
  assert.equal(a.budget, 12_345);
});

test('assign: a non-positive or non-numeric ticket.budget is ignored, falls back to the tier default', () => {
  const withZero = { id: 'T1', title: 't', category: 'feature', rails: ['a', 'b'], scope: ['a', 'b'], budget: 0 };
  const withNegative = { ...withZero, budget: -5 };
  const withString = { ...withZero, budget: 'lots' };
  const a1 = assignTicket(withZero, 0, emptyPriors, 0.2);
  const a2 = assignTicket(withNegative, 0, emptyPriors, 0.2);
  const a3 = assignTicket(withString, 0, emptyPriors, 0.2);
  assert.equal(a1.budget, a2.budget);
  assert.equal(a1.budget, a3.budget);
  assert.ok(a1.budget > 0);
});

test('assign: direct mode budget scales with tier (frontier > mid > cheap)', () => {
  const contract = { id: 'T1', title: 't', category: 'contract', rails: ['a'], scope: ['b'] };
  const frontierAssign = assignTicket(contract, 5, emptyPriors, 0.2);
  const midTicket = { id: 'T2', title: 't', category: 'feature', rails: ['a', 'b'], scope: ['a', 'b'] };
  const midAssign = assignTicket(midTicket, 0, emptyPriors, 0.2); // no priors → 'mid' default
  assert.equal(frontierAssign.tier, 'frontier');
  assert.equal(midAssign.tier, 'mid');
  assert.ok(frontierAssign.budget > midAssign.budget, 'frontier budget must exceed mid budget');
});

test('assign: ladder mode budget covers the starting tier PLUS a frontier regeneration (worst-case escalation)', () => {
  // density = 1.0 >= 0.5 → cheap/ladder
  const t = { id: 'T1', title: 't', category: 'feature', rails: ['a', 'b'], scope: ['a', 'b'] };
  const ladderAssign = assignTicket(t, 3, emptyPriors, 0.2);
  assert.equal(ladderAssign.mode, 'ladder');
  assert.equal(ladderAssign.tier, 'cheap');

  // A direct/cheap assignment (float=0, cheap prior) for comparison — the
  // ladder's budget must be strictly larger than just the starting tier,
  // because escalation is a full regeneration, not a cheap top-up.
  const entries = Array(5).fill({ type: 'build', model: 'cheap', firstPass: true });
  const priors = buildPriors(entries);
  const directCheap = assignTicket({ ...t, id: 'T2' }, 0, priors, 0.2);
  assert.equal(directCheap.tier, 'cheap');
  assert.equal(directCheap.mode, 'direct');

  assert.ok(ladderAssign.budget > directCheap.budget, 'ladder budget must exceed a direct-cheap budget alone');
});

// ── integration: router + CPM float effect ────────────────────────────────────

import { runRouter } from '../lib/router.mjs';

test('runRouter: critical path ticket gets direct mode', async (t) => {
  const dir = tmp(t, 'model-router-test-');
  const ticketsPath = writeTickets(dir, [
    { id: 'T1', title: 'Block', category: 'feature', rails: ['a', 'b'], scope: ['a', 'b'],
      edges: [{ to: 'T2', contract: 'types.ts' }], duration: 1 },
    { id: 'T2', title: 'Dep', category: 'feature', rails: ['c', 'd'], scope: ['c', 'd'], duration: 1 },
  ]);
  const result = await runRouter({ ticketsPath, floor: 0.2, adlcDir: join(dir, '.adlc') });
  // Both T1 and T2 are on the critical path (linear chain)
  const t1 = result.assignments.find((a) => a.id === 'T1');
  const t2 = result.assignments.find((a) => a.id === 'T2');
  assert.equal(t1.mode, 'direct');
  assert.equal(t2.mode, 'direct');
});

test('runRouter: ticket with float uses ladder mode', async (t) => {
  const dir = tmp(t, 'model-router-test-');
  // T1 and T2 both depend on T3; T1 has duration 1, T2 has duration 3
  // T1 has float 2 (T3 must wait for T2 to finish)
  const ticketsPath = writeTickets(dir, [
    { id: 'T1', title: 'Short', category: 'feature',
      rails: ['a', 'b', 'c', 'd'], scope: ['a', 'b', 'c', 'd'],
      edges: [{ to: 'T3', contract: 'x.ts' }], duration: 1 },
    { id: 'T2', title: 'Long', category: 'feature',
      rails: ['e', 'f', 'g', 'h'], scope: ['e', 'f', 'g', 'h'],
      edges: [{ to: 'T3', contract: 'y.ts' }], duration: 3 },
    { id: 'T3', title: 'Gate', category: 'feature',
      rails: ['i', 'j', 'k', 'l'], scope: ['i', 'j', 'k', 'l'], duration: 1 },
  ]);
  const result = await runRouter({ ticketsPath, floor: 0.2, adlcDir: join(dir, '.adlc') });
  const t1 = result.assignments.find((a) => a.id === 'T1');
  const t2 = result.assignments.find((a) => a.id === 'T2');
  // T1 has float 2, T2 has float 0 (critical), T3 has float 0
  assert.equal(t1.float, 2);
  assert.equal(t1.mode, 'ladder');
  assert.equal(t2.float, 0);
  assert.equal(t2.mode, 'direct');
});

// ── integration: cycle detection ──────────────────────────────────────────────

test('runRouter: cycle → opError', async (t) => {
  const dir = tmp(t, 'model-router-test-');
  const ticketsPath = writeTickets(dir, [
    { id: 'T1', title: 'A', category: 'feature', edges: [{ to: 'T2', contract: 'x' }] },
    { id: 'T2', title: 'B', category: 'feature', edges: [{ to: 'T1', contract: 'y' }] },
  ]);
  await assert.rejects(
    () => runRouter({ ticketsPath, floor: 0.2, adlcDir: join(dir, '.adlc') }),
    (err) => {
      assert.ok(err.message.includes('cycle'), `expected 'cycle' in: ${err.message}`);
      return true;
    }
  );
});

// ── integration: prior influence ──────────────────────────────────────────────

test('runRouter: priors influence critical path tier', async (t) => {
  const dir = tmp(t, 'model-router-test-');
  writeManifest(dir, [
    { type: 'build', model: 'cheap', firstPass: true },
    { type: 'build', model: 'cheap', firstPass: true },
    { type: 'build', model: 'cheap', firstPass: true },
    { type: 'build', model: 'cheap', firstPass: true },
    { type: 'build', model: 'cheap', firstPass: true },
  ]);
  const ticketsPath = writeTickets(dir, [
    { id: 'T1', title: 'Solo', category: 'feature',
      rails: ['a', 'b'], scope: ['a', 'b'] },
  ]);
  const result = await runRouter({ ticketsPath, floor: 0.2, adlcDir: join(dir, '.adlc') });
  const t1 = result.assignments.find((a) => a.id === 'T1');
  // T1 is on critical path (only ticket); priors say 'cheap' is best
  assert.equal(t1.tier, 'cheap');
  assert.equal(t1.mode, 'direct');
});

// T-MANIFEST-FOREST (adversarial-review finding): priors must reflect
// evidence recorded post-cutover in a segment, not just root.
test('runRouter: priors reflect entries recorded in a manifest.d/ segment, not just root', async (t) => {
  const dir = tmp(t, 'model-router-test-');
  const adlc = join(dir, '.adlc');
  mkdirSync(join(adlc, 'manifest.d'), { recursive: true });
  const lines = [
    { type: 'build', model: 'cheap', firstPass: true },
    { type: 'build', model: 'cheap', firstPass: true },
    { type: 'build', model: 'cheap', firstPass: true },
    { type: 'build', model: 'cheap', firstPass: true },
    { type: 'build', model: 'cheap', firstPass: true },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n';
  writeFileSync(join(adlc, 'manifest.d', 'feat-01ARZ3NDEKTSV4RRFFQ69G5FAV.jsonl'), lines);
  const ticketsPath = writeTickets(dir, [
    { id: 'T1', title: 'Solo', category: 'feature', rails: ['a', 'b'], scope: ['a', 'b'] },
  ]);
  const result = await runRouter({ ticketsPath, floor: 0.2, adlcDir: adlc });
  const t1 = result.assignments.find((a) => a.id === 'T1');
  assert.equal(t1.tier, 'cheap', 'priors from the segment must count toward routing, same as root would');
  assert.equal(t1.mode, 'direct');
});

// ── integration: floor gate (exit 2) via CLI ──────────────────────────────────

test('CLI: exit 2 when ticket below floor', (t) => {
  const dir = tmp(t, 'model-router-test-');
  const adlc = join(dir, '.adlc');
  mkdirSync(adlc, { recursive: true });
  const ticketsPath = join(adlc, 'tickets.json');
  writeFileSync(ticketsPath, JSON.stringify({
    tickets: [
      { id: 'T1', title: 'Unreiled', category: 'feature', scope: ['a', 'b'] },
    ],
  }));
  const r = runCLI(['--tickets', ticketsPath, '--floor', '0.2'], dir);
  assert.equal(r.code, 2, `expected exit 2, got ${r.code}\nstdout:${r.stdout}\nstderr:${r.stderr}`);
  assert.ok(r.stderr.includes('P3 finding') || r.stdout.includes('P3 finding'),
    `expected P3 finding in output:\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
});

test('CLI: exit 0 when all tickets railed above floor', (t) => {
  const dir = tmp(t, 'model-router-test-');
  const adlc = join(dir, '.adlc');
  mkdirSync(adlc, { recursive: true });
  const ticketsPath = join(adlc, 'tickets.json');
  writeFileSync(ticketsPath, JSON.stringify({
    tickets: [
      { id: 'T1', title: 'Railed', category: 'feature',
        rails: ['a', 'b'], scope: ['a', 'b'] },
    ],
  }));
  const r = runCLI(['--tickets', ticketsPath, '--floor', '0.2'], dir);
  assert.equal(r.code, 0, `expected exit 0, got ${r.code}\nstdout:${r.stdout}\nstderr:${r.stderr}`);
});

test('CLI: exit 0 for frontier category even below floor', (t) => {
  const dir = tmp(t, 'model-router-test-');
  const adlc = join(dir, '.adlc');
  mkdirSync(adlc, { recursive: true });
  const ticketsPath = join(adlc, 'tickets.json');
  writeFileSync(ticketsPath, JSON.stringify({
    tickets: [
      // contract category → frontier anyway, no gate fail
      { id: 'T1', title: 'ContractTicket', category: 'contract', scope: ['a', 'b'] },
    ],
  }));
  const r = runCLI(['--tickets', ticketsPath, '--floor', '0.2'], dir);
  assert.equal(r.code, 0, `expected exit 0, got ${r.code}\n${r.stderr}`);
});

test('CLI: exit 1 on missing tickets file', (t) => {
  const dir = tmp(t, 'model-router-test-');
  const r = runCLI(['--tickets', join(dir, 'nonexistent.json')], dir);
  assert.equal(r.code, 1, `expected exit 1, got ${r.code}`);
});

test('CLI: --json flag produces valid JSON', (t) => {
  const dir = tmp(t, 'model-router-test-');
  const adlc = join(dir, '.adlc');
  mkdirSync(adlc, { recursive: true });
  const ticketsPath = join(adlc, 'tickets.json');
  writeFileSync(ticketsPath, JSON.stringify({
    tickets: [
      { id: 'T1', title: 'Railed', category: 'feature',
        rails: ['a', 'b', 'c', 'd'], scope: ['a', 'b', 'c', 'd'] },
    ],
  }));
  const r = runCLI(['--tickets', ticketsPath, '--json'], dir);
  assert.equal(r.code, 0);
  const parsed = JSON.parse(r.stdout);
  assert.ok(Array.isArray(parsed.assignments));
  assert.ok(Array.isArray(parsed.p3Findings));
  assert.equal(parsed.assignments[0].id, 'T1');
});

test('CLI: no-args smoke (missing default tickets file → exit 1)', (t) => {
  const dir = tmp(t, 'model-router-test-');
  const r = runCLI([], dir);
  // .adlc/tickets.json doesn't exist → operational error → exit 1
  assert.equal(r.code, 1, `expected exit 1, got ${r.code}`);
});

// ── integration: full fixture run ─────────────────────────────────────────────

test('CLI: realistic fixture run', (t) => {
  const dir = tmp(t, 'model-router-test-');
  writeManifest(dir, [
    { type: 'build', model: 'cheap', category: 'feature', firstPass: true },
    { type: 'build', model: 'cheap', category: 'feature', firstPass: true },
    { type: 'build', model: 'cheap', category: 'feature', firstPass: true },
    { type: 'build', model: 'mid', category: 'feature', firstPass: false },
    { type: 'build', model: 'mid', category: 'feature', firstPass: false },
    { type: 'build', model: 'mid', category: 'feature', firstPass: false },
  ]);
  const ticketsPath = writeTickets(dir, [
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
  const r = runCLI(['--tickets', ticketsPath, '--json'], dir);
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
});

test('runRouter: completed ticket is not assigned, but active ticket depending on it routes', async (t) => {
  const dir = tmp(t, 'model-router-test-');
  const ticketsPath = writeTickets(dir, [
    { id: 'T1', title: 'shipped', completed: true, scope: ['a/**'], rails: ['test/a/**'], edges: [{ to: 'T2' }] },
    { id: 'T2', title: 'still open', scope: ['b/**'], rails: ['test/b/**'] },
  ]);
  const { assignments } = await runRouter({ ticketsPath, adlcDir: join(dir, '.adlc') });
  const ids = assignments.map((a) => a.id);
  assert.ok(!ids.includes('T1'), 'completed T1 must not be assigned');
  assert.ok(ids.includes('T2'), 'active T2 must still be assigned');
});

test('runRouter: ticketId scopes assignments and p3Findings to one ticket while preserving full-DAG CPM float', async (t) => {
  const dir = tmp(t, 'model-router-test-');
  const adlcDir = join(dir, '.adlc');
  // T1 and T2 both block T3; T1 has duration 1 (float 2 -> ladder), T2 has duration 3 (float 0 -> direct) and is unrailed.
  const ticketsPath = writeTickets(dir, [
    {
      id: 'T1',
      title: 'RailedWithFloat',
      category: 'feature',
      rails: ['a', 'b', 'c', 'd'],
      scope: ['a', 'b', 'c', 'd'],
      edges: [{ to: 'T3', contract: 'x.ts' }],
      duration: 1,
    },
    {
      id: 'T2',
      title: 'UnrailedCritical',
      category: 'feature',
      rails: [],
      scope: ['e', 'f'],
      edges: [{ to: 'T3', contract: 'y.ts' }],
      duration: 3,
    },
    {
      id: 'T3',
      title: 'Gate',
      category: 'feature',
      rails: ['i', 'j'],
      scope: ['i', 'j'],
      duration: 1,
    },
  ]);

  const scopedT1 = await runRouter({ ticketsPath, floor: 0.2, ticketId: 'T1', adlcDir });
  assert.equal(scopedT1.assignments.length, 1);
  assert.equal(scopedT1.assignments[0].id, 'T1');
  assert.equal(scopedT1.assignments[0].float, 2, 'CPM float must be computed across the full DAG');
  assert.equal(scopedT1.assignments[0].mode, 'ladder');
  assert.deepEqual(scopedT1.p3Findings, [], 'unrelated unrailed ticket T2 must not fail scoped T1');

  const scopedT2 = await runRouter({ ticketsPath, floor: 0.2, ticketId: 'T2', adlcDir });
  assert.equal(scopedT2.assignments.length, 1);
  assert.equal(scopedT2.assignments[0].id, 'T2');
  assert.equal(scopedT2.p3Findings.length, 1);
  assert.equal(scopedT2.p3Findings[0].id, 'T2');
});

test('runRouter: ticketId throws isOpError when ticket is missing or completed', async (t) => {
  const dir = tmp(t, 'model-router-test-');
  const adlcDir = join(dir, '.adlc');
  const ticketsPath = writeTickets(dir, [
    { id: 'T1', title: 'Active', category: 'feature', rails: ['a'], scope: ['a'] },
    { id: 'T2', title: 'Completed', category: 'feature', completed: true, rails: ['b'], scope: ['b'] },
  ]);

  await assert.rejects(
    () => runRouter({ ticketsPath, ticketId: 'NO_SUCH_TICKET', adlcDir }),
    (err) => {
      assert.equal(err.isOpError, true);
      assert.equal(err.message, 'Ticket not found: NO_SUCH_TICKET');
      return true;
    },
  );

  await assert.rejects(
    () => runRouter({ ticketsPath, ticketId: 'T2', adlcDir }),
    (err) => {
      assert.equal(err.isOpError, true);
      assert.equal(err.message, 'Ticket not found: T2');
      return true;
    },
  );
});

test('CLI: --ticket <id> scopes output and exit code to the requested ticket', (t) => {
  const dir = tmp(t, 'model-router-test-');
  const ticketsPath = writeTickets(dir, [
    { id: 'T1', title: 'RailedTarget', category: 'feature', rails: ['a', 'b'], scope: ['a', 'b'] },
    { id: 'T2', title: 'UnrailedSibling', category: 'feature', rails: [], scope: ['c', 'd'] },
  ]);

  const unalleviated = runCLI(['--tickets', ticketsPath], dir);
  assert.equal(unalleviated.code, 2, 'whole-store run exits 2 because T2 is under-railed');

  const humanScoped = runCLI(['--tickets', ticketsPath, '--ticket', 'T1'], dir);
  assert.equal(humanScoped.code, 0, `expected exit 0, got ${humanScoped.code}\nstderr: ${humanScoped.stderr}`);
  assert.ok(humanScoped.stdout.includes('T1'));
  assert.ok(!humanScoped.stdout.includes('T2'));

  const jsonScoped = runCLI(['--tickets', ticketsPath, '--ticket', 'T1', '--json'], dir);
  assert.equal(jsonScoped.code, 0);
  const parsed = JSON.parse(jsonScoped.stdout);
  assert.deepEqual(parsed.assignments.map((a) => a.id), ['T1']);
  assert.deepEqual(parsed.p3Findings, []);

  const failingScoped = runCLI(['--tickets', ticketsPath, '--ticket', 'T2'], dir);
  assert.equal(failingScoped.code, 2);
  assert.match(failingScoped.stderr, /P3 finding: ticket T2/);
});

test('CLI: --ticket exits 1 on unknown or empty ticket id', (t) => {
  const dir = tmp(t, 'model-router-test-');
  const ticketsPath = writeTickets(dir, [
    { id: 'T1', title: 'RailedTarget', category: 'feature', rails: ['a', 'b'], scope: ['a', 'b'] },
  ]);

  const unknown = runCLI(['--tickets', ticketsPath, '--ticket', 'UNKNOWN_ID'], dir);
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /Ticket not found: UNKNOWN_ID/);

  const empty = runCLI(['--tickets', ticketsPath, '--ticket', ''], dir);
  assert.equal(empty.code, 1);
  assert.match(empty.stderr, /--ticket requires a non-empty ticket id/);

  const blank = runCLI(['--tickets', ticketsPath, '--ticket', '   '], dir);
  assert.equal(blank.code, 1);
  assert.match(blank.stderr, /--ticket requires a non-empty ticket id/);
});

// ── issue #1184: non-code config/doc scope exclusion in railDensity ──────────

test('isNonCodeScopePattern: identifies config, documentation, lockfile, and workflow paths vs code paths', () => {
  for (const nonCode of [
    'package.json',
    'tsconfig.jsonc',
    'README.md',
    'docs/guide.markdown',
    'notes.mdx',
    'notes.txt',
    '.github/workflows/ci.yml',
    'config.yaml',
    'Cargo.toml',
    'package-lock.json',
    'yarn.lock',
    'fixture.snap',
    'fix.diff',
    'fix.patch',
    'README',
    'packages/foo/README.rst',
    'CHANGELOG',
    'CHANGELOG.txt',
    'LICENSE',
    'LICENSE.MIT',
    'CODEOWNERS',
    'Dockerfile',
    'Makefile',
    '.gitignore',
    '.nvmrc',
    '.npmrc',
    '.editorconfig',
    'docs/architecture/overview.rst',
    '  package.json\u200b  ',
  ]) {
    assert.equal(isNonCodeScopePattern(nonCode), true, `expected non-code for ${nonCode}`);
  }

  for (const code of [
    'src/index.mjs',
    'packages/model-router/lib/density.mjs',
    'lib/router.ts',
    'bin/cli.js',
    'src/**',
    'packages/foo/src/json-parser.mjs',
    'packages/foo/src/markdown-renderer.ts',
    '  src/index.mjs\u200b  ',
  ]) {
    assert.equal(isNonCodeScopePattern(code), false, `expected code for ${code}`);
  }
});

test('railDensity: excludes non-code config and doc scope paths when code paths exist (#1184)', () => {
  const configHeavyOneCode = {
    id: 'T-CFG-1',
    title: 'One code file plus five config/doc files',
    category: 'feature',
    rails: ['test/index.test.mjs'],
    scope: [
      'src/index.mjs',
      'package.json',
      'tsconfig.json',
      'README.md',
      '.github/workflows/ci.yml',
      'CHANGELOG.md',
    ],
  };
  assert.equal(railDensity(configHeavyOneCode), 1);

  const configHeavyTwoCode = {
    id: 'T-CFG-2',
    title: 'Two code files plus four config/doc files',
    category: 'feature',
    rails: ['test/index.test.mjs'],
    scope: [
      'src/index.mjs',
      'src/helper.mjs',
      'package.json',
      'tsconfig.json',
      'README.md',
      'CHANGELOG.md',
    ],
  };
  assert.equal(railDensity(configHeavyTwoCode), 0.5);
});

test('railDensity: falls back to total scope length when all scope entries are non-code (#1184)', () => {
  const allNonCode = {
    id: 'T-DOC-ONLY',
    title: 'Config and docs only',
    category: 'feature',
    rails: ['test/config.test.mjs'],
    scope: ['package.json', 'README.md', 'tsconfig.json', 'CHANGELOG.md'],
  };
  assert.equal(railDensity(allNonCode), 0.25);
});

test('runRouter & assignTicket: config-heavy ticket with 1 railed code file passes P3 floor and routes to cheap/ladder (#1184)', async (t) => {
  const dir = tmp(t, 'model-router-1184-');
  const adlcDir = join(dir, '.adlc');
  const configHeavy = {
    id: 'T1',
    title: 'ConfigHeavyFeature',
    category: 'feature',
    rails: ['packages/foo/test/foo.test.mjs'],
    scope: [
      'packages/foo/lib/foo.mjs',
      'packages/foo/package.json',
      'packages/foo/tsconfig.json',
      'packages/foo/README.md',
      '.github/workflows/ci.yml',
      'CHANGELOG.md',
    ],
    edges: [{ to: 'T3', contract: 'types.ts' }],
    duration: 1,
  };
  const criticalSibling = {
    id: 'T2',
    title: 'LongCritical',
    category: 'feature',
    rails: ['packages/bar/test/bar.test.mjs'],
    scope: ['packages/bar/lib/bar.mjs'],
    edges: [{ to: 'T3', contract: 'bar.ts' }],
    duration: 3,
  };
  const gateTicket = {
    id: 'T3',
    title: 'Gate',
    category: 'feature',
    rails: ['packages/gate/test/gate.test.mjs'],
    scope: ['packages/gate/lib/gate.mjs'],
    duration: 1,
  };

  const directAssignment = assignTicket(configHeavy, 2, emptyPriors, 0.2);
  assert.equal(directAssignment.railDensity, 1);
  assert.equal(directAssignment.tier, 'cheap');
  assert.equal(directAssignment.mode, 'ladder');

  const ticketsPath = writeTickets(dir, [configHeavy, criticalSibling, gateTicket]);
  const res = await runRouter({ ticketsPath, floor: 0.2, adlcDir });
  assert.deepEqual(res.p3Findings, [], 'config-heavy ticket with railed code file must not trigger P3 floor finding');
  const t1 = res.assignments.find((a) => a.id === 'T1');
  assert.equal(t1.railDensity, 1);
  assert.equal(t1.tier, 'cheap');
  assert.equal(t1.mode, 'ladder');
});
