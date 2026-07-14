import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, utimesSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execFileSync } from 'node:child_process';
import * as corePublic from '../index.mjs';
import { extractJson } from '../lib/llm.mjs';
import { appendEntry, canonicalJson, readEntries, sha256, hashFiles, withLedgerLock } from '../lib/ledger.mjs';
import { resolveBase, refExists } from '../lib/git.mjs';
import {
  validateTicket, loadTickets, topoSort, computeFloat,
  globMatch, inScope, scopesOverlap,
} from '../lib/tickets.mjs';
import { generateMutants, applyMutant, changedLinesFromDiff, OPERATORS } from '../lib/mutate.mjs';
import { resolveRevision as resolveWorktreeRevision } from '../lib/revision.mjs';

const repoRoot = new URL('../../../', import.meta.url).pathname;

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
  const dir = mkdtempSync(join(tmpdir(), 'adlc-ledger-'));
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

test('canonicalJson: sorts object keys recursively while preserving array order', () => {
  const left = { b: 2, a: { d: 4, c: 3 }, list: [{ y: 2, x: 1 }] };
  const right = { list: [{ x: 1, y: 2 }], a: { c: 3, d: 4 }, b: 2 };
  assert.equal(canonicalJson(left), canonicalJson(right));
  assert.notEqual(canonicalJson({ list: [1, 2] }), canonicalJson({ list: [2, 1] }));
});

test('index.d.ts: public declarations match runtime signatures used by consumers', () => {
  const types = readFileSync(join(repoRoot, 'packages/core/index.d.ts'), 'utf8');
  const rootDeclarations = new Set(
    [...types.matchAll(/^export (?:async )?function (\w+)|^export const (\w+)|^export namespace (\w+)/gm)]
      .map((match) => match[1] ?? match[2] ?? match[3])
  );
  for (const exportName of Object.keys(corePublic).sort()) {
    assert.ok(rootDeclarations.has(exportName), `missing declaration for root export ${exportName}`);
  }

  const mutateBlock = types.split('export namespace mutate {')[1]?.split('\n}')[0] ?? '';
  for (const exportName of Object.keys(corePublic.mutate).sort()) {
    assert.match(mutateBlock, new RegExp(`\\b${exportName}\\b`), `missing declaration for mutate.${exportName}`);
  }

  assert.match(types, /export function appendEntry<T = unknown>\(name: string, entry: T, dir\?: string\): T;/);
  assert.match(types, /export function gateFail\(message\?: string, details\?: unknown\): never;/);
  assert.match(types, /export function gitDiff\(base\?: string, cwd\?: string\): string;/);
  assert.match(types, /export function promptOnly\(prompts: string \| readonly string\[\]\): never;/);
});

test('validateTicket: catches missing fields', () => {
  assert.equal(validateTicket({ id: 'T1', title: 'ok' }).length, 0);
  assert.ok(validateTicket({ title: 'no id' }).length > 0);
  assert.ok(validateTicket({ id: 'T1', title: 'x', duration: -1 }).length > 0);
});

test('loadTickets: detects duplicate ids and unknown edges', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-tickets-'));
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

// ── new operators (issue #35 section B: broaden mutation operator set) ──────
// The original five operators (invert-comparison, bool-flip, null-return,
// off-by-one, logic-swap) never reach guard sub-terms (Array.isArray, a bare
// truthiness check, a loose null check), array-literal contents, or a
// recursive array-processing branch (ternary swap). For each case below we
// first assert the ORIGINAL five produce zero mutants for the line (the gap),
// then assert the new operator does.

const ORIGINAL_OPERATOR_NAMES = new Set([
  'invert-comparison', 'bool-flip', 'null-return', 'off-by-one', 'logic-swap',
]);

function mutantsFromOriginalOperators(line) {
  return OPERATORS
    .filter((op) => ORIGINAL_OPERATOR_NAMES.has(op.name))
    .map((op) => op.apply(line))
    .filter((m) => m !== null && m !== line);
}

test('negate-guard-subclause: un-negates a bare Array.isArray guard (old operators miss it)', () => {
  const line = '  if (!Array.isArray(items)) return [];';
  assert.deepEqual(mutantsFromOriginalOperators(line), [],
    'expected the original operator set to produce zero mutants for this guard line');
  const [m] = generateMutants(line, { targetLines: [1] })
    .filter((m) => m.operator === 'negate-guard-subclause');
  assert.ok(m, 'expected negate-guard-subclause to produce a mutant');
  assert.equal(m.mutated, '  if (Array.isArray(items)) return [];');
});

test('negate-guard-subclause: negates a bare identifier truthiness guard (old operators miss it)', () => {
  const line = '  if (value) return process(value);';
  assert.deepEqual(mutantsFromOriginalOperators(line), [],
    'expected the original operator set to produce zero mutants for this guard line');
  const [m] = generateMutants(line, { targetLines: [1] })
    .filter((m) => m.operator === 'negate-guard-subclause');
  assert.ok(m, 'expected negate-guard-subclause to produce a mutant');
  assert.equal(m.mutated, '  if (!value) return process(value);');
});

test('negate-guard-subclause: flips a loose (==) null check the strict-only invert-comparison misses', () => {
  const line = '  if (v == null) return doDefault();';
  assert.deepEqual(mutantsFromOriginalOperators(line), [],
    'expected the original operator set to produce zero mutants for this guard line');
  const [m] = generateMutants(line, { targetLines: [1] })
    .filter((m) => m.operator === 'negate-guard-subclause');
  assert.ok(m, 'expected negate-guard-subclause to produce a mutant');
  assert.equal(m.mutated, '  if (v != null) return doDefault();');
  // Strict equality must NOT be touched by this operator (invert-comparison's job).
  assert.equal(OPERATORS.find((op) => op.name === 'negate-guard-subclause')
    .apply('  if (v === null) return doDefault();'), null);
});

test('array-literal-shrink: drops the last element of a shrinkable array literal (old operators miss it)', () => {
  const line = "export const CORE_SHARED_FIELDS = ['id', 'title', 'scope'];";
  assert.deepEqual(mutantsFromOriginalOperators(line), [],
    'expected the original operator set to produce zero mutants for this array-literal line');
  const [m] = generateMutants(line, { targetLines: [1] })
    .filter((m) => m.operator === 'array-literal-shrink');
  assert.ok(m, 'expected array-literal-shrink to produce a mutant');
  assert.equal(m.mutated, "export const CORE_SHARED_FIELDS = ['id', 'title'];");
});

test('array-literal-shrink: does not touch a single-element array', () => {
  const op = OPERATORS.find((o) => o.name === 'array-literal-shrink');
  assert.equal(op.apply("const only = ['id'];"), null);
});

test('ternary-swap: swaps the recursive/leaf branches of an array-processing ternary (old operators miss it)', () => {
  const line = '    const result = Array.isArray(item) ? flatten(item) : item;';
  const originalMutants = mutantsFromOriginalOperators(line);
  assert.deepEqual(originalMutants, [],
    'expected the original operator set to produce zero mutants for this ternary line');
  const [m] = generateMutants(line, { targetLines: [1] })
    .filter((m) => m.operator === 'ternary-swap');
  assert.ok(m, 'expected ternary-swap to produce a mutant');
  assert.equal(m.mutated, '    const result = Array.isArray(item) ? item : flatten(item);');
});

// ── ternary-swap fail-closed on trailing content (review round 2, c0e8800) ──
// A naive `$`-anchored regex would absorb a trailing `//` comment, or the
// remainder of an enclosing array/call-argument list, into whenFalse and
// relocate it during the swap — corrupting the line. Each case below must
// produce NO mutant (fail closed) rather than a corrupted one.

test('ternary-swap: fails closed on a ternary line with a trailing // comment', () => {
  const line = '    const result = Array.isArray(item) ? flatten(item) : item; // keep going';
  const op = OPERATORS.find((o) => o.name === 'ternary-swap');
  assert.equal(op.apply(line), null,
    'a naive $-anchored regex would absorb "; // keep going" into whenFalse and relocate it on swap');
});

test('ternary-swap: fails closed on a ternary embedded as one element of an array literal', () => {
  const line = '  const arr = [cond ? a : b, other];';
  const op = OPERATORS.find((o) => o.name === 'ternary-swap');
  assert.equal(op.apply(line), null,
    'a naive $-anchored regex would absorb ", other];" into whenFalse and relocate it on swap');
});

test('ternary-swap: fails closed on a ternary embedded in a call-argument list', () => {
  const line = '  foo(cond ? a : b)';
  const op = OPERATORS.find((o) => o.name === 'ternary-swap');
  assert.equal(op.apply(line), null,
    'the unmatched closing ) belongs to the enclosing call, not to whenFalse');
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
  g('config', 'commit.gpgsign', 'false'); // never depend on the dev's signing setup in a test
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

test('resolveRevision: handles large tracked diffs without exec buffer failure', () => {
  const { dir, g } = gitRepo();
  try {
    const file = join(dir, 'large.txt');
    writeFileSync(file, 'a'.repeat(2 * 1024 * 1024));
    g('add', '-A'); g('commit', '-qm', 'large');
    writeFileSync(file, 'b'.repeat(2 * 1024 * 1024));
    const revision = resolveWorktreeRevision({ cwd: dir });
    assert.match(revision, /^git-worktree:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveRevision: touching an untracked file without content change is stable', () => {
  const { dir, g } = gitRepo();
  try {
    writeFileSync(join(dir, 'tracked.txt'), 'base\n');
    g('add', '-A'); g('commit', '-qm', 'base');
    const untracked = join(dir, 'review.txt');
    writeFileSync(untracked, 'same content\n'.repeat(10));
    const before = resolveWorktreeRevision({ cwd: dir });
    const now = new Date();
    utimesSync(untracked, now, new Date(now.getTime() + 10_000));
    const after = resolveWorktreeRevision({ cwd: dir });
    assert.equal(after, before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveRevision: untracked source content changes the fingerprint', () => {
  const { dir, g } = gitRepo();
  try {
    writeFileSync(join(dir, 'tracked.txt'), 'base\n');
    g('add', '-A'); g('commit', '-qm', 'base');
    const before = resolveWorktreeRevision({ cwd: dir });
    writeFileSync(join(dir, 'feature.mjs'), 'export const value = 1;\n');
    const after = resolveWorktreeRevision({ cwd: dir });
    assert.notEqual(after, before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveRevision: handles dirty files whose paths contain newlines', () => {
  const { dir, g } = gitRepo();
  try {
    const file = join(dir, 'multi\nline.txt');
    writeFileSync(file, 'base\n');
    g('add', '-A'); g('commit', '-qm', 'base');
    const before = resolveWorktreeRevision({ cwd: dir });
    writeFileSync(file, 'changed\n');
    const after = resolveWorktreeRevision({ cwd: dir });
    assert.match(after, /^git-worktree:/);
    assert.notEqual(after, before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveRevision: explicitly ignored review artifacts do not change the fingerprint', () => {
  const { dir, g } = gitRepo();
  try {
    writeFileSync(join(dir, 'tracked.txt'), 'base\n');
    g('add', '-A'); g('commit', '-qm', 'base');
    const before = resolveWorktreeRevision({ cwd: dir });
    writeFileSync(join(dir, 'acceptance.json'), '{"accepted":true}\n');
    const after = resolveWorktreeRevision({ cwd: dir, ignorePaths: ['acceptance.json'] });
    assert.equal(after, before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveRevision: root files with artifact basenames are fingerprinted unless explicitly ignored', () => {
  const { dir, g } = gitRepo();
  try {
    writeFileSync(join(dir, 'tracked.txt'), 'base\n');
    g('add', '-A'); g('commit', '-qm', 'base');
    const before = resolveWorktreeRevision({ cwd: dir });
    writeFileSync(join(dir, 'after.json'), '{"unreviewed":true}\n');
    assert.notEqual(resolveWorktreeRevision({ cwd: dir }), before);
    assert.equal(resolveWorktreeRevision({ cwd: dir, ignorePaths: ['after.json'] }), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveRevision: nested files with artifact basenames still change the fingerprint', () => {
  const { dir, g } = gitRepo();
  try {
    writeFileSync(join(dir, 'tracked.txt'), 'base\n');
    g('add', '-A'); g('commit', '-qm', 'base');
    const before = resolveWorktreeRevision({ cwd: dir });
    mkdirSync(join(dir, 'test/fixtures'), { recursive: true });
    writeFileSync(join(dir, 'test/fixtures/after.json'), '{"unreviewed":true}\n');
    const after = resolveWorktreeRevision({ cwd: dir });
    assert.notEqual(after, before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveRevision: .adlc runtime and ticket files are ignored by the generic worktree hash', () => {
  const { dir, g } = gitRepo();
  try {
    writeFileSync(join(dir, 'tracked.txt'), 'base\n');
    g('add', '-A'); g('commit', '-qm', 'base');
    const before = resolveWorktreeRevision({ cwd: dir });
    mkdirSync(join(dir, '.adlc'), { recursive: true });
    writeFileSync(join(dir, '.adlc/manifest.jsonl'), '{"type":"runtime"}\n');
    assert.equal(resolveWorktreeRevision({ cwd: dir }), before);
    writeFileSync(join(dir, '.adlc/tickets.json'), '{"tickets":[]}\n');
    assert.equal(resolveWorktreeRevision({ cwd: dir }), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveRevision: ignored .adlc tickets stay out of the generic worktree hash', () => {
  const { dir, g } = gitRepo();
  try {
    writeFileSync(join(dir, '.gitignore'), '.adlc/*\n!.adlc/tickets.example.json\n');
    writeFileSync(join(dir, 'tracked.txt'), 'base\n');
    g('add', '-A'); g('commit', '-qm', 'base');
    const before = resolveWorktreeRevision({ cwd: dir });
    mkdirSync(join(dir, '.adlc'), { recursive: true });
    writeFileSync(join(dir, '.adlc/tickets.json'), '{"tickets":[]}\n');
    assert.equal(resolveWorktreeRevision({ cwd: dir }), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveRevision: sharded active/archive ticket files stay out of the generic worktree hash', () => {
  const { dir, g } = gitRepo();
  try {
    writeFileSync(join(dir, 'tracked.txt'), 'base\n');
    g('add', '-A'); g('commit', '-qm', 'base');
    mkdirSync(join(dir, '.adlc/tickets'), { recursive: true });
    mkdirSync(join(dir, '.adlc/ticket-archive'), { recursive: true });
    writeFileSync(join(dir, '.adlc/tickets/.store.json'), '{}\n');
    writeFileSync(join(dir, '.adlc/ticket-archive/.store.json'), '{}\n');
    const before = resolveWorktreeRevision({ cwd: dir });
    writeFileSync(join(dir, '.adlc/tickets/t.json'), '{"id":"T"}\n');
    writeFileSync(join(dir, '.adlc/ticket-archive/a.json'), '{"id":"A"}\n');
    assert.equal(resolveWorktreeRevision({ cwd: dir }), before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
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

test('withLedgerLock: never steals an old lock from a potentially live owner', () => {
  const dir = mkdtempSync(join(tmpdir(), 'core-owner-lock-'));
  try {
    const target = join(dir, 'manifest.jsonl');
    const lock = `${target}.lock`;
    writeFileSync(lock, JSON.stringify({ token: 'existing-owner', pid: 1 }));
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    assert.throws(() => withLedgerLock(target, () => assert.fail('must not enter'), { retries: 0, delayMs: 0 }), /could not acquire ledger lock/);
    assert.equal(JSON.parse(readFileSync(lock, 'utf8')).token, 'existing-owner');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- agy provider ---

import { detectProvider, resolveModel, complete } from '../lib/llm.mjs';

test('agy provider: not auto-detected without ADLC_AGY', () => {
  const env = {};
  assert.equal(detectProvider(env), null);
});

test('agy provider: ADLC_AGY=1 enables detection, API keys still win', () => {
  const agyOnly = detectProvider({ ADLC_AGY: '1' });
  assert.equal(agyOnly.name, 'agy');
  const both = detectProvider({ ANTHROPIC_API_KEY: 'sk-x', ADLC_AGY: '1' });
  assert.equal(both.name, 'anthropic');
});

test('agy provider: ADLC_PROVIDER=agy forces without any key', () => {
  const p = detectProvider({ ADLC_PROVIDER: 'agy' });
  assert.equal(p.name, 'agy');
  assert.equal(p.apiKey, '1');
});

test('agy provider: tier map resolves to Antigravity model names', () => {
  const p = detectProvider({ ADLC_PROVIDER: 'agy' });
  assert.equal(resolveModel(p, { tier: 'cheap' }, {}), 'Gemini 3.5 Flash (Medium)');
  assert.equal(resolveModel(p, { tier: 'mid' }, {}), 'Claude Sonnet 4.6 (Thinking)');
  assert.equal(resolveModel(p, { tier: 'frontier' }, {}), 'Claude Opus 4.6 (Thinking)');
  assert.equal(
    resolveModel(p, { tier: 'cheap' }, { ADLC_MODEL_CHEAP: 'Gemini 3.5 Flash (Low)' }),
    'Gemini 3.5 Flash (Low)'
  );
});

// Live test — opt-in only (burns one Antigravity request per run):
//   ADLC_LIVE_AGY=1 node --test test/core.test.mjs
test('agy provider: live completion round-trip', { skip: process.env.ADLC_LIVE_AGY !== '1' }, async () => {
  process.env.ADLC_PROVIDER = 'agy';
  try {
    const out = await complete({ tier: 'cheap', prompt: 'Reply with exactly: ADLC-AGY-OK' });
    assert.match(out, /ADLC-AGY-OK/);
  } finally {
    delete process.env.ADLC_PROVIDER;
  }
});

import { isAgyTimeout } from '../lib/llm.mjs';

test('isAgyTimeout: matches a bare timeout line, not the phrase inside prose', () => {
  assert.equal(isAgyTimeout('Error: timed out waiting for response'), true);
  assert.equal(isAgyTimeout('Error: timed out waiting for response.\n'), true);
  // Model legitimately quoting the phrase in a longer answer must NOT trip:
  assert.equal(isAgyTimeout('The system prints: Error: timed out waiting for response when the API is slow. Here is how to fix it: increase the timeout and retry the request with backoff.'), false);
  assert.equal(isAgyTimeout('PONG'), false);
});

test('agy provider: ADLC_AGY=false/0 do NOT enable the provider', () => {
  assert.equal(detectProvider({ ADLC_AGY: 'false' }), null);
  assert.equal(detectProvider({ ADLC_AGY: '0' }), null);
  assert.equal(detectProvider({ ADLC_AGY: 'off' }), null);
  assert.equal(detectProvider({ ADLC_AGY: '1' })?.name, 'agy');
  assert.equal(detectProvider({ ADLC_AGY: '/usr/local/bin/agy' })?.apiKey, '/usr/local/bin/agy');
});

// Review-round-2 (issue #63): complete()/fan()/fanProviders() accept an
// injectable `env` but historically did not forward it to provider.send(),
// so the agy provider always fell back to process.env for ADLC_AGY_TIMEOUT /
// ADLC_AGY_SANDBOX regardless of what env was passed in. This stubs a fake
// `agy` binary (a shell script that just echoes its argv) so we can assert
// the timeout/sandbox flags actually came from the injected env, not from
// real process.env, without needing the real Antigravity CLI installed.
test('complete: injected env reaches the agy provider send() (timeout/sandbox honored, not process.env)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-agy-stub-'));
  const stubPath = join(dir, 'fake-agy.sh');
  // Drain stdin fully before exiting — otherwise the parent's stdin.end()
  // can race the child's exit and surface as an unrelated EPIPE.
  writeFileSync(stubPath, '#!/bin/sh\ncat >/dev/null\necho "ARGS: $@"\n');
  chmodSync(stubPath, 0o755);

  // Leave a DIFFERENT value in real process.env to prove it is NOT what
  // gets used — if the bug regresses, this is what `agySend` would read.
  const prevTimeout = process.env.ADLC_AGY_TIMEOUT;
  const prevSandbox = process.env.ADLC_AGY_SANDBOX;
  process.env.ADLC_AGY_TIMEOUT = '999s-WRONG-PROCESS-ENV';
  delete process.env.ADLC_AGY_SANDBOX;

  try {
    const injectedEnv = {
      ADLC_AGY: stubPath,
      ADLC_AGY_TIMEOUT: '5s',
      ADLC_AGY_SANDBOX: '1',
    };
    const out = await complete({ tier: 'mid', prompt: 'hi', provider: 'agy' }, injectedEnv);
    assert.match(out, /--print-timeout 5s/, 'should use the injected timeout, not process.env');
    assert.match(out, /--sandbox/, 'should pass --sandbox from the injected env');
    assert.ok(!out.includes('999s-WRONG-PROCESS-ENV'), 'must not fall back to process.env');
  } finally {
    if (prevTimeout === undefined) delete process.env.ADLC_AGY_TIMEOUT;
    else process.env.ADLC_AGY_TIMEOUT = prevTimeout;
    if (prevSandbox === undefined) delete process.env.ADLC_AGY_SANDBOX;
    else process.env.ADLC_AGY_SANDBOX = prevSandbox;
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- per-invocation provider selection (issue #63) ---

import { fanProviders, PROVIDER_NAMES } from '../lib/llm.mjs';

test('detectProvider: explicit override wins over ADLC_PROVIDER env and auto-detect order', () => {
  const env = {
    ADLC_PROVIDER: 'openai',
    ANTHROPIC_API_KEY: 'k-anthropic',
    OPENAI_API_KEY: 'k-openai',
    GEMINI_API_KEY: 'k-gemini',
  };
  // Without override: env's ADLC_PROVIDER wins (existing behavior).
  assert.equal(detectProvider(env).name, 'openai');
  // Explicit override beats the env var.
  assert.equal(detectProvider(env, 'gemini').name, 'gemini');
  assert.equal(detectProvider(env, 'anthropic').name, 'anthropic');
});

test('detectProvider: explicit override without ADLC_PROVIDER set still selects the named provider', () => {
  const env = { ANTHROPIC_API_KEY: 'k1', OPENAI_API_KEY: 'k2' };
  // Auto-detect default would pick anthropic (first in list) — override picks openai instead.
  assert.equal(detectProvider(env).name, 'anthropic');
  assert.equal(detectProvider(env, 'openai').name, 'openai');
});

test('detectProvider: override naming a provider with no key present returns null (fails closed)', () => {
  const env = { OPENAI_API_KEY: 'k2' };
  assert.equal(detectProvider(env, 'anthropic'), null);
});

test('detectProvider: unknown override name returns null', () => {
  assert.equal(detectProvider({ ANTHROPIC_API_KEY: 'k1' }, 'not-a-real-provider'), null);
});

test('PROVIDER_NAMES: lists all known provider names for CLI validation', () => {
  assert.deepEqual(PROVIDER_NAMES, ['anthropic', 'openai', 'gemini', 'agy']);
});

test('complete: opts.provider overrides auto-detect (mocked fetch, no real API keys/network)', async () => {
  const env = { ANTHROPIC_API_KEY: 'k-anthropic', OPENAI_API_KEY: 'k-openai' };
  const calledUrls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calledUrls.push(String(url));
    if (String(url).includes('openai.com')) {
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'from-openai' } }] }),
      };
    }
    return {
      ok: true,
      json: async () => ({ content: [{ text: 'from-anthropic' }] }),
    };
  };
  try {
    // Auto-detect would pick anthropic (first in list) — override picks openai.
    const out = await complete({ tier: 'mid', prompt: 'hi', provider: 'openai' }, env);
    assert.equal(out, 'from-openai');
    assert.ok(calledUrls.some((u) => u.includes('openai.com')));
    assert.ok(!calledUrls.some((u) => u.includes('anthropic.com')));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('complete: without opts.provider, falls back to auto-detect (unchanged default behavior)', async () => {
  const env = { ANTHROPIC_API_KEY: 'k-anthropic', OPENAI_API_KEY: 'k-openai' };
  const calledUrls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calledUrls.push(String(url));
    return { ok: true, json: async () => ({ content: [{ text: 'from-anthropic' }] }) };
  };
  try {
    const out = await complete({ tier: 'mid', prompt: 'hi' }, env);
    assert.equal(out, 'from-anthropic');
    assert.ok(calledUrls.every((u) => u.includes('anthropic.com')));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('complete: naming an unavailable provider throws a clear, provider-specific error', async () => {
  const env = { OPENAI_API_KEY: 'k-openai' };
  await assert.rejects(
    () => complete({ tier: 'mid', prompt: 'hi', provider: 'anthropic' }, env),
    /provider "anthropic"/
  );
});

test('fanProviders: issues ONE completion per distinct named provider, not N samples of one provider', async () => {
  const env = {
    ANTHROPIC_API_KEY: 'k-anthropic',
    OPENAI_API_KEY: 'k-openai',
    GEMINI_API_KEY: 'k-gemini',
  };
  const seenUrls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    seenUrls.push(String(url));
    if (String(url).includes('openai.com')) {
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'openai-out' } }] }) };
    }
    if (String(url).includes('generativelanguage.googleapis.com')) {
      return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: 'gemini-out' }] } }] }) };
    }
    return { ok: true, json: async () => ({ content: [{ text: 'anthropic-out' }] }) };
  };
  try {
    const results = await fanProviders(
      { tier: 'mid', prompt: 'find the bug' },
      ['anthropic', 'openai', 'gemini'],
      env
    );
    assert.equal(results.length, 3);
    assert.ok(results.every((r) => r.ok));
    assert.deepEqual(results.map((r) => r.provider), ['anthropic', 'openai', 'gemini']);
    assert.deepEqual(results.map((r) => r.value), ['anthropic-out', 'openai-out', 'gemini-out']);
    // Exactly one call landed on each provider's host — genuinely distinct
    // families, not N resamples of the same detected provider.
    assert.equal(seenUrls.filter((u) => u.includes('anthropic.com')).length, 1);
    assert.equal(seenUrls.filter((u) => u.includes('openai.com')).length, 1);
    assert.equal(seenUrls.filter((u) => u.includes('generativelanguage.googleapis.com')).length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fanProviders: a provider missing its API key surfaces as a per-provider failure, not a thrown exception', async () => {
  const env = { ANTHROPIC_API_KEY: 'k-anthropic' }; // no OPENAI_API_KEY
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ content: [{ text: 'anthropic-out' }] }) });
  try {
    const results = await fanProviders({ tier: 'mid', prompt: 'x' }, ['anthropic', 'openai'], env);
    assert.equal(results[0].ok, true);
    assert.equal(results[1].ok, false);
    assert.match(results[1].error, /provider "openai"/);
    assert.equal(results[1].provider, 'openai');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('parseArgs: pre-scans for --help and prints usage', () => {
  const originalExit = process.exit;
  const originalLog = console.log;
  let exitCode = null;
  let loggedMsg = null;
  
  process.exit = (code) => {
    exitCode = code;
    throw new Error('exited');
  };
  console.log = (msg) => {
    loggedMsg = msg;
  };
  
  try {
    assert.throws(() => {
      corePublic.parseArgs({
        args: ['--help'],
        usage: 'my custom usage text',
        options: {
          foo: { type: 'boolean' }
        }
      });
    }, /exited/);
    
    assert.equal(exitCode, 0);
    assert.equal(loggedMsg, 'my custom usage text');
  } finally {
    process.exit = originalExit;
    console.log = originalLog;
  }
});

test('parseArgs: calls callback usage if it is a function', () => {
  const originalExit = process.exit;
  let exitCode = null;
  let called = false;
  
  process.exit = (code) => {
    exitCode = code;
    throw new Error('exited');
  };
  
  try {
    assert.throws(() => {
      corePublic.parseArgs({
        args: ['-h'],
        usage: () => {
          called = true;
        },
        options: {
          foo: { type: 'boolean' }
        }
      });
    }, /exited/);
    
    assert.equal(exitCode, 0);
    assert.equal(called, true);
  } finally {
    process.exit = originalExit;
  }
});

test('parseArgs: does not intercept help if options explicitly declares it', () => {
  const parsed = corePublic.parseArgs({
    args: ['--help'],
    options: {
      help: { type: 'boolean' }
    }
  });
  assert.equal(parsed.values.help, true);
});
