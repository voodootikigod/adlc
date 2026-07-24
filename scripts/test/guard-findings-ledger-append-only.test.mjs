// The findings ledger (.adlc/findings.jsonl, ADR 0014) is durable P5->P7 memory and is
// append-only by construction. This guard is the git-boundary backstop that fails a change
// which DELETES, truncates, or rewrites the ledger — the exact data-loss the single-tree
// secret scanner cannot see (a deleted ledger has nothing to scan, so it passes).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { appendOnlyViolations, baseLedger } from '../guard-findings-ledger-append-only.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'guard-findings-ledger-append-only.mjs');

// ---- unit: the pure append-only predicate -----------------------------------------------

test('an unchanged ledger is append-only (no violations)', () => {
  assert.deepEqual(appendOnlyViolations('{"a":1}\n{"b":2}\n', '{"a":1}\n{"b":2}\n'), []);
});

test('appending new findings is append-only (no violations)', () => {
  assert.deepEqual(appendOnlyViolations('{"a":1}\n', '{"a":1}\n{"b":2}\n{"c":3}\n'), []);
});

test('a new ledger on an empty base is append-only', () => {
  assert.deepEqual(appendOnlyViolations('', '{"a":1}\n'), []);
});

test('deleting the whole ledger is a violation (truncation)', () => {
  const v = appendOnlyViolations('{"a":1}\n{"b":2}\n', '');
  assert.equal(v.length, 1);
  assert.match(v[0], /2 removed|deletion or truncation/);
});

test('dropping one existing finding is a violation', () => {
  const v = appendOnlyViolations('{"a":1}\n{"b":2}\n', '{"a":1}\n');
  assert.match(v[0], /1 removed|deletion or truncation/);
});

test('rewriting an existing finding in place is a violation', () => {
  const v = appendOnlyViolations('{"a":1}\n{"b":2}\n', '{"a":1}\n{"b":999}\n{"c":3}\n');
  assert.match(v[0], /line 2 was rewritten|append-only/);
});

test('trailing-newline differences do not count as changes', () => {
  assert.deepEqual(appendOnlyViolations('{"a":1}', '{"a":1}\n'), []);
});

// ---- unit: baseLedger separates "absent at base" from an operational read failure --------

// A fake git runner: each verb maps to a string to return or an Error to throw.
const fakeRun = (handlers) => (...args) => {
  const h = handlers[args[0]];
  if (h instanceof Error) throw h;
  if (h === undefined) throw new Error(`unexpected git ${args.join(' ')}`);
  return h;
};
const ENTRY = '100644 blob abc123\t.adlc/findings.jsonl';

test('baseLedger: ledger genuinely ABSENT at base (ls-tree empty) → resolved, empty text', () => {
  const run = fakeRun({ 'merge-base': 'POINT', 'ls-tree': '' });
  assert.deepEqual(baseLedger('main', run), { resolved: true, text: '' });
});

test('baseLedger: base ledger present and readable → resolved with its text', () => {
  const run = fakeRun({ 'merge-base': 'POINT', 'ls-tree': ENTRY, 'show': '{"desc":"x"}\n' });
  assert.deepEqual(baseLedger('main', run), { resolved: true, text: '{"desc":"x"}\n' });
});

test('baseLedger: present in the tree but `show` FAILS (corrupt/unreadable blob) → fail closed', () => {
  const run = fakeRun({ 'merge-base': 'POINT', 'ls-tree': ENTRY, 'show': new Error('fatal: object corrupt') });
  assert.deepEqual(baseLedger('main', run), { resolved: false });
});

test('baseLedger: cannot inspect the base tree (ls-tree fails) → fail closed', () => {
  const run = fakeRun({ 'merge-base': 'POINT', 'ls-tree': new Error('fatal: bad tree object') });
  assert.deepEqual(baseLedger('main', run), { resolved: false });
});

test('baseLedger: unresolvable base (no merge-base, rev-parse fails) → fail closed', () => {
  const run = fakeRun({ 'merge-base': new Error('no merge base'), 'rev-parse': new Error('bad ref') });
  assert.deepEqual(baseLedger('bogus', run), { resolved: false });
});

// ---- integration: the real CLI against a real git repo ----------------------------------

function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'ledger-guard-'));
  const git = (...args) =>
    execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'user.email=g@t', '-c', 'user.name=g', ...args], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  git('init', '-b', 'main');
  mkdirSync(join(root, '.adlc'), { recursive: true });
  writeFileSync(join(root, '.adlc', 'findings.jsonl'), '{"desc":"finding one"}\n{"desc":"finding two"}\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'seed findings ledger');
  return { root, git };
}

function runGuard(root) {
  try {
    const out = execFileSync('node', [SCRIPT, 'main'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out };
  } catch (err) {
    return { code: err.status, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

test('CLI: DELETING the durable ledger fails the guard (the vector the scanner misses)', () => {
  const { root, git } = makeRepo();
  try {
    git('checkout', '-q', '-b', 'feature');
    rmSync(join(root, '.adlc', 'findings.jsonl'));
    git('add', '-A');
    git('commit', '-q', '-m', 'delete the findings ledger');

    const r = runGuard(root);
    assert.equal(r.code, 2, 'a deleted ledger must fail the guard');
    assert.match(r.out, /removed|deletion or truncation/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CLI: appending new findings passes the guard', () => {
  const { root, git } = makeRepo();
  try {
    git('checkout', '-q', '-b', 'feature');
    writeFileSync(join(root, '.adlc', 'findings.jsonl'), '{"desc":"finding one"}\n{"desc":"finding two"}\n{"desc":"finding three"}\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'append a finding');

    const r = runGuard(root);
    assert.equal(r.code, 0, 'appending is append-only and passes');
    assert.match(r.out, /append-only/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CLI: an UNCOMMITTED deletion in the working tree also fails (not only committed ones)', () => {
  const { root } = makeRepo();
  try {
    // Do not commit — just remove the working copy, as an `rm` before staging would.
    rmSync(join(root, '.adlc', 'findings.jsonl'));
    const r = runGuard(root);
    assert.equal(r.code, 2, 'a working-tree deletion is caught before it is ever committed');
    assert.match(r.out, /removed|deletion or truncation/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CLI: an UNRESOLVABLE base fails closed (op error), never silently passes as an empty base', () => {
  // A misspelled / deleted / unfetched base ref must NOT be collapsed into "empty base →
  // nothing to protect → pass": that would let a ledger deletion slip through whenever the
  // base cannot be resolved (adversarial-review round-14). Even with the ledger DELETED, an
  // unresolvable base must exit 1 (operational), not 0.
  const { root } = makeRepo();
  try {
    rmSync(join(root, '.adlc', 'findings.jsonl')); // a deletion that would pass on a fail-open base
    const r = (() => {
      try {
        const out = execFileSync('node', [SCRIPT, 'no-such-base-xyz'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        return { code: 0, out };
      } catch (err) { return { code: err.status, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }; }
    })();
    assert.equal(r.code, 1, 'an unresolvable base is an operational failure, not a pass');
    assert.match(r.out, /does not resolve|unknown base/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CLI: a resolvable base with NO ledger yet still passes (a brand-new ledger is append-only)', () => {
  // Distinct from an unresolvable base: here the base commit is real, it simply has no
  // ledger, so adding one is a legitimate append.
  const root = mkdtempSync(join(tmpdir(), 'ledger-guard-'));
  try {
    const git = (...args) =>
      execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'user.email=g@t', '-c', 'user.name=g', ...args], {
        cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    git('init', '-b', 'main');
    git('commit', '--allow-empty', '-q', '-m', 'root with no ledger');
    git('checkout', '-q', '-b', 'feature');
    mkdirSync(join(root, '.adlc'), { recursive: true });
    writeFileSync(join(root, '.adlc', 'findings.jsonl'), '{"desc":"a brand new finding"}\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'introduce the ledger');

    const r = runGuard(root);
    assert.equal(r.code, 0, 'introducing a ledger where the base had none is append-only');
    assert.match(r.out, /append-only/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
