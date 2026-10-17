// hollow-test/test/invalid-refill.test.mjs — a mutant that does not parse does
// not use a budget slot.
//
// hollow-test took the first `quota` mutants of each file, and an unparseable one
// (#293) still used its slot. With a quota of one, a file whose first candidate is
// a stranded `return null;` was reported as "every mutant was syntactically
// invalid" although the next candidate was valid and the tests would have killed
// it. In TypeScript the first candidate is unparseable for 43–45% of measured
// files, so the gate would stop on most of them. The next candidate is tried
// instead, up to 8 tries for each slot, so runtime stays bounded.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitRepo } from '@adlc/core/test-kit';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(HERE, '../bin/hollow-test.mjs');
const REAL_TS = resolve(HERE, '../../../node_modules/typescript');

function repoWith(t, { base, change, extra = () => {} }) {
  const repo = gitRepo(t, { prefix: 'hollow-refill-' });
  const put = (rel, text) => {
    mkdirSync(dirname(join(repo.dir, rel)), { recursive: true });
    writeFileSync(join(repo.dir, rel), text);
  };
  put('.gitignore', 'node_modules\n');
  put('package.json', '{ "name": "fixture", "type": "module" }\n');
  for (const [rel, text] of Object.entries(base)) put(rel, text);
  extra(repo.dir);
  repo.git('add', '-A');
  repo.git('commit', '-q', '-m', 'base');
  const sha = repo.git('rev-parse', 'HEAD').trim();
  for (const [rel, text] of Object.entries(change)) put(rel, text);
  repo.git('add', '-A');
  repo.git('commit', '-q', '-m', 'change');
  return { ...repo, base: sha };
}

function hollow(repo, args) {
  return spawnSync(process.execPath, [BIN, '--base', repo.base, ...args], {
    cwd: repo.dir, encoding: 'utf8', stdio: 'pipe', timeout: 120_000,
  });
}

// Line 2 is a multiline `return {`: null-return strands the object literal, so
// the first candidate does not parse. Line 3 holds a comparison the check kills.
const SHAPE = [
  'export function shape(a) {',
  '  return {',
  '    ok: a > 1,',
  '  };',
  '}',
  '',
].join('\n');

const CHECK_SHAPE = [
  "import { shape } from './src/shape.mjs';",
  'process.exit(shape(2).ok === true && shape(1).ok === false ? 0 : 1);',
  '',
].join('\n');

/** `n` functions whose only candidate is an unparseable `return null;`. */
function strandedReturns(n) {
  const out = [];
  for (let i = 1; i <= n; i++) {
    out.push(`export function f${i}(y) {`, '  return {', '    x: y,', '  };', '}');
  }
  return out;
}

describe('an unparseable candidate does not use the budget', () => {
  it('an invalid first candidate does not use the budget', (t) => {
    const repo = repoWith(t, {
      base: { 'src/shape.mjs': 'export function shape(a) { return { ok: true }; }\n', 'check.mjs': CHECK_SHAPE },
      change: { 'src/shape.mjs': SHAPE },
    });
    const r = hollow(repo, ['--test-cmd', 'node check.mjs', '--max', '1', '--json']);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const report = JSON.parse(r.stdout);
    assert.deepEqual(
      report.mutants.map((m) => [m.line, m.operator, m.status]),
      [[2, 'null-return', 'invalid'], [3, 'invert-comparison', 'killed']],
    );
    assert.equal(report.summary.invalid, 1);
    assert.equal(report.summary.killed, 1);
  });

  it('tries stop at 8 for each budget slot', (t) => {
    // Nine unparseable candidates and then a valid one. With one slot, a cap of
    // 8 tries stops before the 9th; 9 would try one more invalid candidate, and
    // 10 would reach the valid one and pass.
    const lines = [...strandedReturns(9), 'export function g(a) {', '  return a > 1;', '}', ''];
    const repo = repoWith(t, {
      base: { 'src/many.mjs': 'export const placeholder = 0;\n' },
      change: { 'src/many.mjs': lines.join('\n') },
    });
    const r = hollow(repo, ['--test-cmd', 'node -e 0', '--max', '1', '--json']);
    assert.equal(r.status, 1, r.stderr + r.stdout);
    const report = JSON.parse(r.stdout);
    assert.equal(report.mutants.length, 8, report.mutants.map((m) => `${m.line} ${m.status}`).join('\n'));
    assert.ok(report.mutants.every((m) => m.status === 'invalid' && m.operator === 'null-return'));
    assert.match(r.stderr, /syntactically invalid/);
  });

  it('two slots get 16 tries', (t) => {
    const lines = [...strandedReturns(17), 'export function g(a) {', '  return a > 1;', '}', ''];
    const repo = repoWith(t, {
      base: { 'src/many.mjs': 'export const placeholder = 0;\n' },
      change: { 'src/many.mjs': lines.join('\n') },
    });
    const r = hollow(repo, ['--test-cmd', 'node -e 0', '--max', '2', '--json']);
    assert.equal(r.status, 1, r.stderr + r.stdout);
    assert.equal(JSON.parse(r.stdout).mutants.length, 16);
  });

  it('an undetermined candidate still exits 1', { skip: !existsSync(join(REAL_TS, 'package.json')) && 'typescript is not installed' }, (t) => {
    // A `typescript` whose parser throws on one mutant: that check is unknown,
    // and an unknown is never scored, whatever the refill does next.
    const fake = [
      "const real = require(process.env.HOLLOW_REAL_TS);",
      'module.exports = { ...real, createSourceFile(name, text, ...rest) {',
      "  if (text.includes('a <= 1')) throw new Error('parser exploded');",
      '  return real.createSourceFile(name, text, ...rest);',
      '} };',
      '',
    ].join('\n');
    const repo = repoWith(t, {
      base: { 'src/gate.ts': 'export const gate = (a: number): boolean => false;\n' },
      change: { 'src/gate.ts': 'export const gate = (a: number): boolean => a > 1;\n' },
      extra: (dir) => {
        const pkg = join(dir, 'node_modules', 'typescript');
        mkdirSync(pkg, { recursive: true });
        writeFileSync(join(pkg, 'package.json'), '{ "name": "typescript", "version": "5.0.0", "main": "index.js" }\n');
        writeFileSync(join(pkg, 'index.js'), fake);
      },
    });
    const r = spawnSync(process.execPath, [BIN, '--base', repo.base, '--test-cmd', 'node -e 0', '--max', '1', '--json'], {
      cwd: repo.dir, encoding: 'utf8', stdio: 'pipe', timeout: 120_000,
      env: { ...process.env, HOLLOW_REAL_TS: realpathSync(REAL_TS) },
    });
    assert.equal(r.status, 1, r.stderr + r.stdout);
    assert.match(r.stderr, /could not syntax-check/);
    assert.match(r.stderr, /src\/gate\.ts:1/);
  });
});
