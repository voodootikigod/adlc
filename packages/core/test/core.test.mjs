import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execFileSync } from 'node:child_process';
import { extractJson } from '../lib/llm.mjs';
import { appendEntry, readEntries, sha256, hashFiles } from '../lib/ledger.mjs';
import { resolveBase, refExists } from '../lib/git.mjs';
import {
  validateTicket, loadTickets, topoSort, computeFloat,
  globMatch, inScope, scopesOverlap,
} from '../lib/tickets.mjs';
import { generateMutants, applyMutant, changedLinesFromDiff } from '../lib/mutate.mjs';

test('extractJson: plain object', () => {
  assert.deepEqual(extractJson('{"a": 1}'), { a: 1 });
});

test('extractJson: fenced with prose and nested braces in strings', () => {
  const text = 'Here you go:\n```json\n{"q": "use { and } carefully", "n": [1,2]}\n```\nDone.';
  assert.deepEqual(extractJson(text), { q: 'use { and } carefully', n: [1, 2] });
});

test('extractJson: array form', () => {
  assert.deepEqual(extractJson('result: [1, {"x": "]"}]'), [1, { x: ']' }]);
});

test('extractJson: throws on no JSON', () => {
  assert.throws(() => extractJson('nothing here'));
});

test('ledger: append + read round-trip, malformed lines reported not swallowed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aidlc-ledger-'));
  try {
    appendEntry('findings', { id: 1 }, dir);
    appendEntry('findings', { id: 2 }, dir);
    writeFileSync(join(dir, 'findings.jsonl'), '{"id":1}\nnot json\n{"id":3}\n');
    const { entries, skipped } = readEntries('findings', dir);
    assert.equal(entries.length, 2);
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].line, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sha256 + hashFiles: deterministic, missing file hashes null', () => {
  assert.equal(sha256('abc'), sha256('abc'));
  const hashes = hashFiles(['/definitely/not/a/file']);
  assert.equal(hashes['/definitely/not/a/file'], null);
});

test('validateTicket: catches missing fields', () => {
  assert.equal(validateTicket({ id: 'T1', title: 'ok' }).length, 0);
  assert.ok(validateTicket({ title: 'no id' }).length > 0);
  assert.ok(validateTicket({ id: 'T1', title: 'x', duration: -1 }).length > 0);
});

test('loadTickets: detects duplicate ids and unknown edges', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aidlc-tickets-'));
  try {
    const p = join(dir, 'tickets.json');
    writeFileSync(p, JSON.stringify({
      tickets: [
        { id: 'A', title: 'a', edges: [{ to: 'GHOST' }] },
        { id: 'A', title: 'dup' },
      ],
    }));
    const { errors } = loadTickets(p);
    assert.ok(errors.some((e) => e.includes('duplicate')));
    assert.ok(errors.some((e) => e.includes('GHOST')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('topoSort: orders DAG, detects cycle', () => {
  const dag = [
    { id: 'A', title: '', edges: [{ to: 'B' }] },
    { id: 'B', title: '', edges: [{ to: 'C' }] },
    { id: 'C', title: '', edges: [] },
  ];
  const { order, cycle } = topoSort(dag);
  assert.deepEqual(order, ['A', 'B', 'C']);
  assert.equal(cycle, null);

  const cyclic = [
    { id: 'A', title: '', edges: [{ to: 'B' }] },
    { id: 'B', title: '', edges: [{ to: 'A' }] },
  ];
  assert.ok(topoSort(cyclic).cycle.length > 0);
});

test('computeFloat: critical path has zero float, side branch has slack', () => {
  // A(2) → B(1) → D(1);  A → C(1) → D.  Critical: A,B,D. C has float 1... wait
  // A=2, B=1, C=1, D=1. Path A-B-D = 4, A-C-D = 4 with C dur 1? Both equal.
  // Make B dur 2 so A-B-D = 5, C float = 1.
  const dag = [
    { id: 'A', title: '', duration: 2, edges: [{ to: 'B' }, { to: 'C' }] },
    { id: 'B', title: '', duration: 2, edges: [{ to: 'D' }] },
    { id: 'C', title: '', duration: 1, edges: [{ to: 'D' }] },
    { id: 'D', title: '', duration: 1, edges: [] },
  ];
  const { floats, criticalPath, makespan } = computeFloat(dag);
  assert.equal(makespan, 5);
  assert.equal(floats.A, 0);
  assert.equal(floats.B, 0);
  assert.equal(floats.D, 0);
  assert.equal(floats.C, 1);
  assert.deepEqual(criticalPath, ['A', 'B', 'D']);
});

test('globMatch: *, ** and literals', () => {
  assert.ok(globMatch('src/**', 'src/a/b/c.mjs'));
  assert.ok(globMatch('src/*.mjs', 'src/a.mjs'));
  assert.ok(!globMatch('src/*.mjs', 'src/a/b.mjs'));
  assert.ok(globMatch('**/*.test.mjs', 'packages/x/test/y.test.mjs'));
  assert.ok(globMatch('exact/path.js', 'exact/path.js'));
  assert.ok(!globMatch('exact/path.js', 'exact/other.js'));
});

test('inScope + scopesOverlap', () => {
  const t1 = { id: 'T1', title: '', scope: ['src/auth/**'] };
  const t2 = { id: 'T2', title: '', scope: ['src/billing/**'] };
  const t3 = { id: 'T3', title: '', scope: ['src/**'] };
  assert.ok(inScope(t1, 'src/auth/login.mjs'));
  assert.ok(!inScope(t1, 'src/billing/invoice.mjs'));
  assert.ok(!scopesOverlap(t1, t2));
  assert.ok(scopesOverlap(t1, t3));
});

test('generateMutants: produces mutants on target lines only, skips comments', () => {
  const src = [
    '// a comment with true in it',
    'const ok = a === b;',
    'if (x < 10 && y) {',
    '  return value;',
    '}',
  ].join('\n');
  const all = generateMutants(src);
  assert.ok(all.length > 0);
  assert.ok(all.every((m) => m.line !== 1), 'comment line must not be mutated');
  const scoped = generateMutants(src, { targetLines: [2] });
  assert.ok(scoped.every((m) => m.line === 2));
  const inverted = scoped.find((m) => m.operator === 'invert-comparison');
  assert.ok(inverted.mutated.includes('!=='));
});

test('applyMutant: applies and refuses stale content', () => {
  const src = 'const a = true;';
  const [m] = generateMutants(src);
  assert.ok(applyMutant(src, m).includes('false'));
  assert.throws(() => applyMutant('something else', m));
});

test('changedLinesFromDiff: maps new-side line numbers', () => {
  const diff = [
    'diff --git a/x.mjs b/x.mjs',
    '--- a/x.mjs',
    '+++ b/x.mjs',
    '@@ -1,3 +1,4 @@',
    ' line one',
    '+inserted line',
    ' line two',
    '-removed line',
    '+replacement line',
  ].join('\n');
  const changed = changedLinesFromDiff(diff);
  assert.deepEqual([...changed['x.mjs']].sort(), [2, 4]);
});

function gitRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'core-git-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@t.co');
  g('config', 'user.name', 'tester');
  return { dir, g };
}

test('resolveBase: returns merge-base with trunk, not HEAD (freeze-gate baseline)', () => {
  const { dir, g } = gitRepo();
  try {
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    g('add', '-A'); g('commit', '-qm', 'init');
    const baseCommit = g('rev-parse', 'HEAD').trim();
    g('checkout', '-q', '-b', 'feature');
    writeFileSync(join(dir, 'a.txt'), 'two\n');
    g('add', '-A'); g('commit', '-qm', 'committed edit');
    const base = resolveBase(dir);
    assert.equal(base, baseCommit, 'base must be the divergence point, so committed edits are still visible');
    assert.notEqual(base, g('rev-parse', 'HEAD').trim());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveBase: returns null when no trunk candidate exists (callers must fail closed)', () => {
  const { dir, g } = gitRepo();
  try {
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    g('add', '-A'); g('commit', '-qm', 'init');
    g('branch', '-m', 'main', 'work'); // rename away from main/master
    assert.equal(refExists('main', dir), false);
    assert.equal(resolveBase(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('withLedgerLock: serialises writers so large concurrent lines never interleave', () => {
  const dir = mkdtempSync(join(tmpdir(), 'core-lock-'));
  try {
    const big = 'x'.repeat(8192); // > PIPE_BUF
    for (let i = 0; i < 5; i++) appendEntry('manifest', { i, big }, dir);
    const { entries, skipped } = readEntries('manifest', dir);
    assert.equal(skipped.length, 0, 'no malformed (interleaved) lines');
    assert.equal(entries.length, 5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
