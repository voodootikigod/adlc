// review-calibration/test/witness-diagnostics.test.mjs
// A witness that is red on the ORIGINAL tree is a broken witness, not proof of
// an equivalent mutant, and the operator needs its output to tell the two
// apart. A witness that cannot start at all is neither, and must not be
// reported as a timeout.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmp } from '@adlc/core/test-kit';
import { runWitness, verifyWitness } from '../lib/verify.mjs';
import { BOUNDARY_PLANT, MATH_SOURCE, createMathRepo, writePlantsFile, runCli } from './cli-fixtures.mjs';

function plantIn(dir, witness) {
  return { ...BOUNDARY_PLANT, absolutePath: join(dir, 'src', 'math.mjs'), witness };
}

describe('witness runner keeps the diagnostics', () => {
  it('runWitness returns the output of a failing witness', (t) => {
    const dir = tmp(t, 'rc-witness-');
    const r = runWitness({ cmd: 'node', args: ['-e', 'console.error("boom: missing fixture"); process.exit(3)'] }, dir);
    assert.equal(r.status, 3);
    assert.equal(r.timedOut, false);
    assert.match(r.output, /boom: missing fixture/);
  });

  it('a witness binary that cannot start is a spawn error, not a timeout', (t) => {
    const dir = tmp(t, 'rc-witness-');
    const r = runWitness({ cmd: join(dir, 'no-such-binary') }, dir);
    assert.equal(r.timedOut, false);
    assert.match(r.spawnError, /ENOENT/);
  });

  it('verifyWitness names a spawn failure instead of "did not discriminate"', (t) => {
    const { dir } = createMathRepo(t);
    const v = verifyWitness(plantIn(dir, { cmd: join(dir, 'no-such-binary') }), dir);
    assert.equal(v.discriminates, false);
    assert.match(v.reason, /could not start/);
    assert.match(v.reason, /ENOENT/);
  });

  it('a witness red on the original tree reports that run\'s output', (t) => {
    const { dir } = createMathRepo(t);
    const witness = { cmd: 'node', args: ['--test', 'test/renamed-away.test.mjs'] };
    const v = verifyWitness(plantIn(dir, witness), dir);
    assert.equal(v.discriminates, false);
    assert.match(v.reason, /original exit 1/);
    assert.match(v.reason, /renamed-away/);
  });

  it('bounds the reported output', (t) => {
    const { dir } = createMathRepo(t);
    const witness = { cmd: 'node', args: ['-e', 'process.stderr.write("x".repeat(100000) + "TAIL"); process.exit(1)'] };
    const v = verifyWitness(plantIn(dir, witness), dir);
    assert.match(v.reason, /TAIL/);
    assert.ok(v.reason.length < 3000, `reason is ${v.reason.length} chars`);
  });

  it('restores the file byte-for-byte after a failing witness', (t) => {
    const { dir } = createMathRepo(t);
    verifyWitness(plantIn(dir, { cmd: 'node', args: ['-e', 'process.exit(1)'] }), dir);
    assert.equal(readFileSync(join(dir, 'src', 'math.mjs'), 'utf8'), MATH_SOURCE);
  });
});

describe('the CLI shows why a witnessed plant was excluded', () => {
  it('names the witness failure when every plant is excluded', (t) => {
    const { dir } = createMathRepo(t);
    const plants = writePlantsFile(t, [{
      ...BOUNDARY_PLANT,
      witness: { cmd: 'node', args: ['--test', 'test/renamed-away.test.mjs'] },
    }]);
    const result = runCli([
      '--review-cmd', 'node -e "0"', '--plants-file', plants,
      '--min-plants', '1', '--scorer', 'string',
    ], dir);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /src\/math\.mjs:6/);
    assert.match(result.stderr, /original exit 1/);
    assert.match(result.stderr, /renamed-away/);
  });

  it('warns about an excluded plant when others remain valid', (t) => {
    const { dir } = createMathRepo(t);
    const plants = writePlantsFile(t, [
      { ...BOUNDARY_PLANT, witness: { cmd: 'node', args: ['-e', 'console.error("witness broken here"); process.exit(1)'] } },
      { file: 'src/math.mjs', line: 2, original: '  return a + b;', mutated: '  return a - b;', category: 'arith', defect: 'subtracts' },
    ]);
    const result = runCli([
      '--review-cmd', 'node -e "0"', '--plants-file', plants,
      '--min-plants', '1', '--min-recall', '0', '--scorer', 'string',
    ], dir);
    assert.notEqual(result.status, 1, result.stderr);
    assert.match(result.stderr, /excluded src\/math\.mjs:6/);
    assert.match(result.stderr, /witness broken here/);
  });
});
