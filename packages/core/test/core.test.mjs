import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, utimesSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execFileSync } from 'node:child_process';
import * as corePublic from '../index.mjs';
import { extractJson } from '../lib/llm.mjs';
import { appendEntry, canonicalJson, readEntries, sha256, hashFiles, withLedgerLock } from '../lib/ledger.mjs';
import { resolveBase, refExists, changedFiles } from '../lib/git.mjs';
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
    // A GENERIC ledger name — `findings` now carries a publishability boundary that
    // rejects non-finding entries, so this generic round-trip uses a neutral name.
    appendEntry('scratch', { id: 1 }, dir);
    appendEntry('scratch', { id: 2 }, dir);
    writeFileSync(join(dir, 'scratch.jsonl'), '{"id":1}\nnot json\n{"id":3}\n');
    const { entries, skipped } = readEntries('scratch', dir);
    assert.equal(entries.length, 2);
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].line, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ledger: the `findings` ledger enforces the finding boundary on append', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-ledger-findings-'));
  try {
    // A valid finding round-trips; a non-finding entry is rejected AT append.
    appendEntry('findings', { tool: 't', file: 'a.mjs', desc: 'a real finding', verdict: 'open' }, dir);
    assert.equal(readEntries('findings', dir).entries.length, 1);
    assert.throws(() => appendEntry('findings', { id: 1 }, dir), /desc/);
    assert.throws(() => appendEntry('findings', null, dir), /finding object/);
    assert.equal(readEntries('findings', dir).entries.length, 1, 'a rejected entry never lands');
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

// ── off-by-one: a tuning constant is not a boundary (#359) ──────────────────
// off-by-one exists to catch BOUNDARY mistakes. A duration in milliseconds or a
// size in bytes is a tuning knob: +1 there is an EQUIVALENT mutant that no test
// can observe, so the gate demanded a test that cannot exist and the only way to
// satisfy it was a source-text pin — a hollow test added to placate the
// anti-hollow-test gate. Counts stay mutable: +1 on a retry/limit IS observable.

const offByOne = () => OPERATORS.find((o) => o.name === 'off-by-one');

test('off-by-one: does not mutate a duration or size tuning constant (#359)', () => {
  const line = "  const result = spawnSync('git', args, { encoding: 'utf8', timeout: 60000, maxBuffer: 512 * 1024 * 1024 });";
  assert.equal(offByOne().apply(line), null,
    '+1 ms on a 60 s timeout is unobservable by any test — an equivalent mutant, not a coverage gap');
});

test('off-by-one: masks the WHOLE tuning value expression, not just its first number', () => {
  // Skipping only `512` would fall through to `1024` and reproduce the same
  // unkillable mutant one factor to the right.
  assert.equal(offByOne().apply('  const opts = { maxBuffer: 512 * 1024 * 1024 };'), null);
});

test('off-by-one: still mutates a real boundary sharing a line with a tuning constant', () => {
  assert.equal(
    offByOne().apply('  if (index < items.length - 1) retry({ timeout: 30000 });'),
    '  if (index < items.length - 2) retry({ timeout: 30000 });'
  );
});

test('off-by-one: still mutates counts — a retry or limit count is an observable boundary', () => {
  assert.equal(offByOne().apply('  const opts = { maxRetries: 3 };'), '  const opts = { maxRetries: 4 };');
  assert.equal(offByOne().apply('  const opts = { limit: 10 };'), '  const opts = { limit: 11 };');
});

test('off-by-one: mutates the boundary at its own index, not the first matching digit run', () => {
  // A masked tuning value whose digits repeat the boundary's digits must not be
  // corrupted: a `line.replace(digits, ...)` would rewrite `timeout: 3` instead.
  assert.equal(
    offByOne().apply('  const o = { timeout: 3, limit: 3 };'),
    '  const o = { timeout: 3, limit: 4 };'
  );
});

test('off-by-one: an ordinary boundary is still mutated', () => {
  assert.equal(offByOne().apply('  for (let i = 0; i < n; i++) {'), '  for (let i = 1; i < n; i++) {');
});

// ── zero is a sentinel, not a magnitude (cross-model review finding, HIGH) ───
// The masking rationale is "±1 is unobservable", which holds at MAGNITUDE and fails
// at 0: across every key here, 0 means disabled / none / immediate, so 0 -> 1 is a
// real semantic change a test must catch. Masking it would let a discrete boundary
// escape prosecution — the exact over-suppression this operator must not do.

test('off-by-one: still mutates a ZERO tuning value — 0 is a discrete sentinel', () => {
  assert.equal(offByOne().apply('  const sessionOpts = { ttl: 0 };'), '  const sessionOpts = { ttl: 1 };');
  assert.equal(offByOne().apply('  const headers = { maxAge: 0 };'), '  const headers = { maxAge: 1 };');
  assert.equal(offByOne().apply('  const task = { delay: 0 };'), '  const task = { delay: 1 };');
  assert.equal(offByOne().apply('  const t = { timeout: 0 };'), '  const t = { timeout: 1 };');
});

test('off-by-one: masks a NEGATIVE tuning sentinel — timeout: -1 means disabled', () => {
  // Without the optional sign the mask misses `-1` entirely, off-by-one produces
  // `-2`, and that is unkillable for the same reason 60001 was: a negative duration
  // is a sentinel, so both values take the same disabled branch.
  assert.equal(offByOne().apply('  const opts = { timeout: -1 };'), null);
  assert.equal(offByOne().apply('  const opts = { delay: -1 };'), null);
});

test('off-by-one: a padded integer zero (00) still prosecutes — the carve-out is by VALUE', () => {
  assert.equal(offByOne().apply('  const s = { ttl: 00 };'), '  const s = { ttl: 1 };');
});

// A cross-model review round 2 claimed masking let `ttl: 0.0` escape prosecution and
// so re-opened the zero-sentinel hole. It does not: off-by-one cannot mutate ANY float,
// masked or not, because its digit-run pattern rejects a run adjacent to `.`. Pinned
// here with a NON-tuning key beside the tuning one — if the two ever diverge, masking
// really has started deciding float behavior and this test says so.
test('off-by-one: floats are unmutatable independent of masking (not a mask carve-out)', () => {
  assert.equal(offByOne().apply('  const s = { foo: 0.0 };'), null, 'non-tuning key: no mask involved');
  assert.equal(offByOne().apply('  const s = { foo: 1.5 };'), null, 'non-tuning key: no mask involved');
  assert.equal(offByOne().apply('  const s = { ttl: 0.0 };'), null, 'tuning key: same outcome, same cause');
});

test('off-by-one: a magnitude is still masked after the zero/sign carve-outs', () => {
  assert.equal(offByOne().apply('  const o = { timeout: 60000 };'), null);
  assert.equal(offByOne().apply('  const o = { maxBuffer: 512 * 1024 * 1024 };'), null);
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

test('changedFiles: an ordinary unstaged working-tree edit is reported', () => {
  const { dir, g } = gitRepo();
  try {
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    g('add', '-A'); g('commit', '-qm', 'init');
    const base = g('rev-parse', 'HEAD').trim();
    writeFileSync(join(dir, 'a.txt'), 'two\n'); // edited, never staged
    assert.deepEqual(changedFiles(base, dir), ['a.txt']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('changedFiles: a staged-then-reverted edit is still reported (#244 bypass)', () => {
  // Stage a change, then restore the working-tree copy to baseline. base-vs-worktree
  // diff sees nothing, but the index still holds the change and it is what a commit
  // would record — so the changed-file SET must include it, or a rail check reading
  // this set is deciding about a tree that is not the one being committed.
  const { dir, g } = gitRepo();
  try {
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    g('add', '-A'); g('commit', '-qm', 'init');
    const base = g('rev-parse', 'HEAD').trim();
    writeFileSync(join(dir, 'a.txt'), 'staged violation\n');
    g('add', 'a.txt');            // change now lives in the index
    writeFileSync(join(dir, 'a.txt'), 'one\n'); // working tree restored to baseline
    // Sanity: the working-tree-only diff is empty, so the old contract missed this.
    assert.equal(
      g('diff', '--name-only', base, '--').trim(), '',
      'fixture must have an empty base-vs-worktree diff to exercise the bypass'
    );
    assert.deepEqual(changedFiles(base, dir), ['a.txt']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('changedFiles: a file changed in BOTH index and worktree is reported once', () => {
  const { dir, g } = gitRepo();
  try {
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    g('add', '-A'); g('commit', '-qm', 'init');
    const base = g('rev-parse', 'HEAD').trim();
    writeFileSync(join(dir, 'a.txt'), 'staged\n');
    g('add', 'a.txt');
    writeFileSync(join(dir, 'a.txt'), 'staged then edited again\n'); // differs in both
    assert.deepEqual(changedFiles(base, dir), ['a.txt'], 'union must de-duplicate');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('changedFiles: a clean tree at base reports nothing', () => {
  const { dir, g } = gitRepo();
  try {
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    g('add', '-A'); g('commit', '-qm', 'init');
    const base = g('rev-parse', 'HEAD').trim();
    assert.deepEqual(changedFiles(base, dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('changedFiles: does not throw when a tracked path collides with the base ref name', () => {
  // Both the worktree AND staged `git diff` calls must keep their trailing `--`.
  // Without it, `git diff <base>` is genuinely AMBIGUOUS the moment a tracked
  // path shares a name with the ref — git refuses outright:
  //   fatal: ambiguous argument 'main': both revision and filename
  // `resolveBase()` in this same file defaults to trying the literal ref name
  // 'main', so a repo with a top-level file or directory named `main` is not a
  // contrived edge case. Mutation-tested: dropping either `--` survived the rest
  // of this suite with zero failures before this test existed.
  const { dir, g } = gitRepo();
  try {
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    g('add', '-A'); g('commit', '-qm', 'init');
    mkdirSync(join(dir, 'main'));
    writeFileSync(join(dir, 'main', 'file.txt'), 'colliding path\n'); // unstaged
    writeFileSync(join(dir, 'a.txt'), 'two\n');
    g('add', 'main/file.txt'); // staged, so the --cached half is exercised too
    assert.doesNotThrow(() => changedFiles('main', dir));
    assert.deepEqual(changedFiles('main', dir).sort(), ['a.txt', 'main/file.txt']);
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

import { fan, fanProviders, PROVIDER_NAMES } from '../lib/llm.mjs';

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

// ─── usage accounting (issue #272) ────────────────────────────────────────
// complete() must keep returning a plain string (every existing caller in
// the toolkit does `const text = await complete(...)`) — usage is an
// additive opt-in side-channel via opts.onUsage, never a change to the
// return shape.

test('complete: anthropic usage is parsed and reported via onUsage, return value is still a plain string', async () => {
  const env = { ANTHROPIC_API_KEY: 'k-anthropic' };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      content: [{ text: 'from-anthropic' }],
      usage: { input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 40, cache_creation_input_tokens: 5 },
    }),
  });
  let captured = null;
  try {
    const out = await complete({ tier: 'mid', prompt: 'hi', onUsage: (u) => { captured = u; } }, env);
    assert.equal(typeof out, 'string');
    assert.equal(out, 'from-anthropic');
    assert.deepEqual(captured, {
      inputTokens: 120,
      outputTokens: 30,
      cachedTokens: 45, // cache_read + cache_creation
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      tier: 'mid',
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('complete: openai usage is parsed (prompt_tokens/completion_tokens/cached_tokens)', async () => {
  const env = { OPENAI_API_KEY: 'k-openai' };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { content: 'from-openai' } }],
      usage: { prompt_tokens: 200, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 80 } },
    }),
  });
  let captured = null;
  try {
    await complete({ tier: 'mid', prompt: 'hi', provider: 'openai', onUsage: (u) => { captured = u; } }, env);
    assert.deepEqual(captured, {
      inputTokens: 200,
      outputTokens: 50,
      cachedTokens: 80,
      provider: 'openai',
      model: 'gpt-5.1',
      tier: 'mid',
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('complete: gemini usage is parsed (usageMetadata)', async () => {
  const env = { GEMINI_API_KEY: 'k-gemini' };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      candidates: [{ content: { parts: [{ text: 'from-gemini' }] } }],
      usageMetadata: { promptTokenCount: 90, candidatesTokenCount: 15, cachedContentTokenCount: 10 },
    }),
  });
  let captured = null;
  try {
    await complete({ tier: 'mid', prompt: 'hi', provider: 'gemini', onUsage: (u) => { captured = u; } }, env);
    assert.deepEqual(captured, {
      inputTokens: 90,
      outputTokens: 15,
      cachedTokens: 10,
      provider: 'gemini',
      model: 'gemini-2.5-pro',
      tier: 'mid',
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('complete: a provider response with no usage block does not throw and does not call onUsage', async () => {
  const env = { ANTHROPIC_API_KEY: 'k-anthropic' };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ content: [{ text: 'no-usage-here' }] }) });
  let called = false;
  try {
    const out = await complete({ tier: 'mid', prompt: 'hi', onUsage: () => { called = true; } }, env);
    assert.equal(out, 'no-usage-here');
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('complete: without opts.onUsage, behavior is byte-identical to before usage accounting existed', async () => {
  const env = { ANTHROPIC_API_KEY: 'k-anthropic' };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ content: [{ text: 'unchanged' }], usage: { input_tokens: 10, output_tokens: 2 } }),
  });
  try {
    const out = await complete({ tier: 'mid', prompt: 'hi' }, env);
    assert.equal(out, 'unchanged');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fan: opts.onUsage fires once per resample, each with that resample\'s own usage', async () => {
  const env = { ANTHROPIC_API_KEY: 'k-anthropic' };
  const originalFetch = globalThis.fetch;
  let call = 0;
  globalThis.fetch = async () => {
    // Capture the invocation index NOW — the 3 fan calls run concurrently,
    // so `call` would already be 3 by the time a lazily-evaluated json()
    // closure read it below.
    const n = ++call;
    return {
      ok: true,
      json: async () => ({
        content: [{ text: `out-${n}` }],
        usage: { input_tokens: 100 * n, output_tokens: n },
      }),
    };
  };
  const seen = [];
  try {
    const results = await fan({ tier: 'cheap', prompt: 'x', onUsage: (u) => seen.push(u) }, 3, env);
    assert.equal(results.length, 3);
    assert.equal(seen.length, 3, 'onUsage must fire once per fan resample');
    assert.deepEqual(seen.map((u) => u.inputTokens).sort((a, b) => a - b), [100, 200, 300]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── prompt caching (issue #273) ──────────────────────────────────────────

test('complete: without cacheable, anthropic sends plain string system/content (unchanged from before caching existed)', async () => {
  const env = { ANTHROPIC_API_KEY: 'k-anthropic' };
  const originalFetch = globalThis.fetch;
  let capturedBody;
  globalThis.fetch = async (_url, init) => {
    capturedBody = JSON.parse(init.body);
    return { ok: true, json: async () => ({ content: [{ text: 'ok' }] }) };
  };
  try {
    await complete({ tier: 'mid', system: 'sys', prompt: 'hi' }, env);
    assert.equal(capturedBody.system, 'sys');
    assert.equal(capturedBody.messages[0].content, 'hi');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('complete: cacheable:true wraps system and the user message in cache_control blocks (anthropic)', async () => {
  const env = { ANTHROPIC_API_KEY: 'k-anthropic' };
  const originalFetch = globalThis.fetch;
  let capturedBody;
  globalThis.fetch = async (_url, init) => {
    capturedBody = JSON.parse(init.body);
    return { ok: true, json: async () => ({ content: [{ text: 'ok' }] }) };
  };
  try {
    await complete({ tier: 'mid', system: 'sys', prompt: 'hi', cacheable: true }, env);
    assert.deepEqual(capturedBody.system, [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }]);
    assert.deepEqual(capturedBody.messages[0].content, [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('complete: cacheable:true with no system still caches the user message, and sends no system field', async () => {
  const env = { ANTHROPIC_API_KEY: 'k-anthropic' };
  const originalFetch = globalThis.fetch;
  let capturedBody;
  globalThis.fetch = async (_url, init) => {
    capturedBody = JSON.parse(init.body);
    return { ok: true, json: async () => ({ content: [{ text: 'ok' }] }) };
  };
  try {
    await complete({ tier: 'mid', prompt: 'hi', cacheable: true }, env);
    assert.equal('system' in capturedBody, false);
    assert.deepEqual(capturedBody.messages[0].content, [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fan: defaults to cacheable:true — every resample sends cache_control blocks', async () => {
  const env = { ANTHROPIC_API_KEY: 'k-anthropic' };
  const originalFetch = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return { ok: true, json: async () => ({ content: [{ text: 'ok' }] }) };
  };
  try {
    await fan({ tier: 'cheap', system: 'sys', prompt: 'x' }, 3, env);
    assert.equal(bodies.length, 3);
    for (const body of bodies) {
      assert.deepEqual(body.system, [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }]);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fan: cacheable:false explicitly opts out of caching', async () => {
  const env = { ANTHROPIC_API_KEY: 'k-anthropic' };
  const originalFetch = globalThis.fetch;
  let capturedBody;
  globalThis.fetch = async (_url, init) => {
    capturedBody = JSON.parse(init.body);
    return { ok: true, json: async () => ({ content: [{ text: 'ok' }] }) };
  };
  try {
    await fan({ tier: 'cheap', system: 'sys', prompt: 'x', cacheable: false }, 1, env);
    assert.equal(capturedBody.system, 'sys');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fanProviders: does NOT default to cacheable (one call per provider — no repeat to amortize a cache write against)', async () => {
  const env = { ANTHROPIC_API_KEY: 'k-anthropic', OPENAI_API_KEY: 'k-openai' };
  const originalFetch = globalThis.fetch;
  let anthropicBody;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('anthropic.com')) anthropicBody = JSON.parse(init.body);
    if (String(url).includes('openai.com')) {
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'openai-out' } }] }) };
    }
    return { ok: true, json: async () => ({ content: [{ text: 'anthropic-out' }] }) };
  };
  try {
    await fanProviders({ tier: 'mid', system: 'sys', prompt: 'x' }, ['anthropic', 'openai'], env);
    assert.equal(anthropicBody.system, 'sys', 'fanProviders must not force cache_control by default');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('complete: openai/gemini providers ignore the cacheable flag without erroring (no explicit cache_control support wired for them yet)', async () => {
  const env = { OPENAI_API_KEY: 'k-openai' };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) });
  try {
    const out = await complete({ tier: 'mid', system: 'sys', prompt: 'hi', provider: 'openai', cacheable: true }, env);
    assert.equal(out, 'ok');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('agy provider: onUsage is never called (no metered usage available) — text still returned normally', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-agy-usage-'));
  const stubPath = join(dir, 'fake-agy.sh');
  writeFileSync(stubPath, '#!/bin/sh\ncat >/dev/null\necho "stub output"\n');
  chmodSync(stubPath, 0o755);
  let called = false;
  try {
    const out = await complete(
      { tier: 'cheap', prompt: 'hi', provider: 'agy', onUsage: () => { called = true; } },
      { ADLC_AGY: stubPath }
    );
    assert.match(out, /stub output/);
    assert.equal(called, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
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
