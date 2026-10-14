// invalid-mutant-discard.test.mjs — issue #312 (sibling of #293): a planted
// mutant that does not parse, or a witness that never launched, is not
// evidence that a reviewer could have caught anything, so it must never count
// as a discriminating plant or enter the recall denominator.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { gitRepo, tmp } from '@adlc/core/test-kit';
import {
  classifySyntaxResult, classifyWitnessRun, filterEquivalentMutants, verifyWitness,
} from '../lib/verify.mjs';
import { buildJsonReport } from '../lib/report.mjs';
import { BOUNDARY_PLANT, createMathRepo, writePlantsFile, runCli } from './cli-fixtures.mjs';

const OBJECT_SOURCE = [
  'export function f() {',
  '  return {',
  '    a: 1,',
  '  };',
  '}',
  '',
].join('\n');

// The #293 reproduction: replacing a multiline `return {` opener leaves an
// orphaned object body, which does not parse.
const MULTILINE_PLANT = Object.freeze({
  file: 'src/obj.mjs',
  line: 2,
  original: '  return {',
  mutated: '  return null;',
  category: 'return',
  defect: 'object result replaced by null',
});

// Passes on the original; on the unparseable mutant the import throws, which
// is exactly the non-zero exit the old logic read as "discriminates".
const IMPORT_WITNESS = {
  cmd: 'node',
  args: ['-e', "import('./src/obj.mjs').then((m) => process.exit(m.f().a === 1 ? 0 : 1))"],
};

function objRepo(t) {
  const repo = gitRepo(t, { prefix: 'rc-invalid-' });
  mkdirSync(join(repo.dir, 'src'));
  writeFileSync(join(repo.dir, 'src', 'obj.mjs'), OBJECT_SOURCE);
  writeFileSync(join(repo.dir, 'src', 'notes.txt'), 'alpha\nbeta\n');
  repo.git('add', '-A');
  repo.git('commit', '-m', 'initial');
  return repo.dir;
}

const abs = (dir, plant) => ({ ...plant, absolutePath: join(dir, plant.file) });

describe('unparseable mutants are discarded (AC1)', () => {
  it('a witnessed multiline `return {` mutant is discarded, not valid', (t) => {
    const dir = objRepo(t);
    const { valid, equivalent, discarded } = filterEquivalentMutants(
      [abs(dir, { ...MULTILINE_PLANT, witness: IMPORT_WITNESS })], dir,
    );
    assert.equal(valid.length, 0);
    assert.equal(equivalent.length, 0);
    assert.equal(discarded.length, 1);
    assert.equal(discarded[0].kind, 'unparseable');
    assert.equal(discarded[0].reason, 'mutant does not parse');
    assert.equal(readFileSync(join(dir, 'src', 'obj.mjs'), 'utf8'), OBJECT_SOURCE, 'file restored');
  });

  it('an unwitnessed unparseable mutant is discarded too', (t) => {
    const dir = objRepo(t);
    const { valid, discarded } = filterEquivalentMutants([abs(dir, MULTILINE_PLANT)], dir);
    assert.equal(valid.length, 0);
    assert.equal(discarded[0].kind, 'unparseable');
  });

  it('the syntax check runs inside the journal so a crash leaves a record', (t) => {
    const dir = objRepo(t);
    const events = [];
    const journal = {
      begin: () => events.push('begin'),
      end: () => events.push('end'),
    };
    filterEquivalentMutants([abs(dir, MULTILINE_PLANT)], dir, undefined, { journal });
    assert.deepEqual(events, ['begin', 'end']);
  });

  it('an injected checker that cannot run leaves the plant valid with syntax unknown', (t) => {
    const dir = objRepo(t);
    const { valid, discarded } = filterEquivalentMutants(
      [abs(dir, MULTILINE_PLANT)], dir, undefined, { syntaxFn: () => 'unknown' },
    );
    assert.equal(discarded.length, 0);
    assert.equal(valid[0].syntax, 'unknown');
  });

  it('.js and .cjs targets are syntax-checked as well as .mjs', (t) => {
    // CommonJS source: `node --check` on a .js file that uses ESM syntax
    // exits 0 even when it does not parse, so only CJS pins the extension.
    const dir = objRepo(t);
    const cjs = 'const o = {\n  a: 1,\n};\n';
    const plant = { file: '', line: 1, original: 'const o = {', mutated: 'const o = null;', category: 'x', defect: 'd' };
    for (const ext of ['js', 'cjs']) {
      writeFileSync(join(dir, 'src', `o.${ext}`), cjs);
      const { valid, discarded } = filterEquivalentMutants([abs(dir, { ...plant, file: `src/o.${ext}` })], dir);
      assert.equal(valid.length, 0, ext);
      assert.equal(discarded[0].kind, 'unparseable', ext);
    }
  });

  it('an unreadable target is not syntax-checked and does not throw', (t) => {
    const dir = objRepo(t);
    const plant = { ...MULTILINE_PLANT, file: 'src/missing.mjs' };
    const { valid, discarded } = filterEquivalentMutants([abs(dir, plant)], dir);
    assert.equal(discarded.length, 0);
    assert.equal(valid[0].syntax, 'unknown');
  });

  it('classifySyntaxResult trusts only a real exit status', () => {
    assert.equal(classifySyntaxResult({ status: 0 }), 'valid');
    assert.equal(classifySyntaxResult({ status: 1 }), 'invalid');
    assert.equal(classifySyntaxResult({ status: 1, error: new Error('x') }), 'unknown');
    assert.equal(classifySyntaxResult({ status: 1, signal: 'SIGTERM' }), 'unknown');
    assert.equal(classifySyntaxResult({ status: null }), 'unknown');
    assert.equal(classifySyntaxResult({ status: 0, error: undefined, signal: null }), 'valid');
  });

  it('a non-JavaScript target is not syntax-checked and records syntax unknown', (t) => {
    const dir = objRepo(t);
    const plant = { file: 'src/notes.txt', line: 1, original: 'alpha', mutated: '{{ alpha', category: 'x', defect: 'd' };
    const { valid, discarded } = filterEquivalentMutants([abs(dir, plant)], dir, undefined, {
      syntaxFn: () => { throw new Error('must not be consulted for .txt'); },
    });
    assert.equal(discarded.length, 0);
    assert.equal(valid[0].syntax, 'unknown');
  });
});

describe('witness launch failures are not evidence (AC2)', () => {
  it('classifyWitnessRun separates completed, timeout and spawn-failed', () => {
    assert.equal(classifyWitnessRun({ status: 0, timedOut: false }), 'completed');
    assert.equal(classifyWitnessRun({ status: 1, timedOut: false }), 'completed');
    assert.equal(classifyWitnessRun({ status: null, timedOut: true }), 'timeout');
    assert.equal(classifyWitnessRun({ status: null, timedOut: false, spawnError: 'ENOENT: x' }), 'spawn-failed');
    assert.equal(classifyWitnessRun({ status: 126, timedOut: false }), 'spawn-failed');
    assert.equal(classifyWitnessRun({ status: 127, timedOut: false }), 'spawn-failed');
    assert.equal(classifyWitnessRun({ status: 125, timedOut: false }), 'completed');
  });

  it('exit 127 on the mutant run is a launch failure, not a caught mutant', (t) => {
    const { dir } = createMathRepo(t);
    const plant = { ...BOUNDARY_PLANT, absolutePath: join(dir, 'src', 'math.mjs'), witness: { cmd: 'w' } };
    let calls = 0;
    const runFn = () => ({ status: calls++ === 0 ? 127 : 0, timedOut: false });
    const v = verifyWitness(plant, dir, runFn);
    assert.equal(v.discriminates, false);
    assert.match(v.reason, /could not start/);
    assert.match(v.reason, /127/);
  });

  it('exit 126 on the original run is a launch failure too', (t) => {
    const { dir } = createMathRepo(t);
    const plant = { ...BOUNDARY_PLANT, absolutePath: join(dir, 'src', 'math.mjs'), witness: { cmd: 'w' } };
    let calls = 0;
    const runFn = () => ({ status: calls++ === 0 ? 1 : 126, timedOut: false });
    const v = verifyWitness(plant, dir, runFn);
    assert.equal(v.discriminates, false);
    assert.match(v.reason, /could not start/);
  });

  it('a launch failure lands in discarded (kind spawn-failed), not equivalent', (t) => {
    const { dir } = createMathRepo(t);
    const plant = { ...BOUNDARY_PLANT, absolutePath: join(dir, 'src', 'math.mjs'), witness: { cmd: join(dir, 'nope') } };
    const { valid, equivalent, discarded } = filterEquivalentMutants([plant], dir);
    assert.equal(valid.length, 0);
    assert.equal(equivalent.length, 0);
    assert.equal(discarded[0].kind, 'spawn-failed');
    assert.match(discarded[0].reason, /ENOENT/);
  });

  it('an ordinary non-discriminating witness is still equivalent, not discarded', (t) => {
    const { dir } = createMathRepo(t);
    const plant = { ...BOUNDARY_PLANT, absolutePath: join(dir, 'src', 'math.mjs'), witness: { cmd: 'node', args: ['-e', '0'] } };
    const { equivalent, discarded } = filterEquivalentMutants([plant], dir);
    assert.equal(equivalent.length, 1);
    assert.equal(discarded.length, 0);
  });
});

describe('valid plants are unchanged (AC4)', () => {
  const DISCRIMINATING = {
    cmd: 'node',
    args: ['-e', "import('./src/math.mjs').then((m) => process.exit(m.isPositive(0) === false ? 0 : 1))"],
  };

  it('a parseable mutant with a discriminating witness is valid and witnessed', (t) => {
    const { dir } = createMathRepo(t);
    const plant = { ...BOUNDARY_PLANT, absolutePath: join(dir, 'src', 'math.mjs'), witness: DISCRIMINATING };
    const { valid, equivalent, discarded } = filterEquivalentMutants([plant], dir);
    assert.equal(valid.length, 1);
    assert.equal(valid[0].witnessed, true);
    assert.equal(valid[0].syntax, 'valid');
    assert.equal(equivalent.length + discarded.length, 0);
    assert.equal(verifyWitness(plant, dir).discriminates, true);
  });

  it('an unwitnessed parseable plant passes through flagged witnessed:false', (t) => {
    const { dir } = createMathRepo(t);
    const plant = { ...BOUNDARY_PLANT, absolutePath: join(dir, 'src', 'math.mjs') };
    const { valid } = filterEquivalentMutants([plant], dir);
    assert.equal(valid[0].witnessed, false);
    assert.equal(valid[0].syntax, 'valid');
  });
});

describe('the report states discarded plants (AC3)', () => {
  it('buildJsonReport carries plantsDiscarded, defaulting to zeros', () => {
    const base = { recall: 1, caught: 1, total: 1, minRecall: 0, scorer: 'string', results: [] };
    assert.deepEqual(buildJsonReport(base).plantsDiscarded, { total: 0, unparseable: 0, spawnFailed: 0 });
    const withDiscards = { ...base, plantsDiscarded: { total: 3, unparseable: 2, spawnFailed: 1 } };
    assert.deepEqual(buildJsonReport(withDiscards).plantsDiscarded, { total: 3, unparseable: 2, spawnFailed: 1 });
  });

  const MIXED = [
    BOUNDARY_PLANT,
    { file: 'src/math.mjs', line: 1, original: 'export function add(a, b) {', mutated: 'export function add(a, b', category: 'syntax', defect: 'signature truncated' },
  ];
  const ARGS = (plants, t) => [
    '--review-cmd', 'node -e "process.stdout.write(\'LGTM\\n\')"',
    '--plants-file', writePlantsFile(t, plants),
    '--scorer', 'string', '--min-recall', '0', '--min-plants', '1',
  ];

  it('CLI --json: the unparseable plant is out of the denominator and counted as discarded', (t) => {
    const { dir } = createMathRepo(t);
    const r = runCli([...ARGS(MIXED, t), '--json'], dir);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.total, 1);
    assert.deepEqual(out.plantsDiscarded, { total: 1, unparseable: 1, spawnFailed: 0 });
    assert.match(r.stderr, /mutant does not parse/);
  });

  it('CLI text: the scorecard names the discarded count', (t) => {
    const { dir } = createMathRepo(t);
    const r = runCli(ARGS(MIXED, t), dir);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Discarded:\s+1 plant\(s\)/);
  });

  it('CLI: when every plant is discarded the run is an operational error', (t) => {
    const { dir } = createMathRepo(t);
    const r = runCli(ARGS([MIXED[1]], t), dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /mutant does not parse/);
    assert.equal(r.stdout.trim(), '');
  });

  it('CLI: discarding below the --min-plants floor applies the existing floor', (t) => {
    const { dir } = createMathRepo(t);
    const args = ARGS(MIXED, t).map((a) => (a === '1' ? '2' : a));
    const r = runCli(args, dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /only 1 valid plant\(s\)/);
  });
});
