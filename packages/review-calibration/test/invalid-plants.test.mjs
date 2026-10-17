// review-calibration/test/invalid-plants.test.mjs — TypeScript-family plants
// are syntax-checked too (#313, on top of #312's discard in #1218).
//
// #1218 discards a planted mutant that does not parse, but only for
// .mjs/.cjs/.js: every other plant passes through with `syntax: 'unknown'`.
// review-calibration already plants on TypeScript, so a `Promise<unknown>` ->
// `Promise>=unknown>` plant still entered the recall denominator as a valid,
// catchable bug. Admitting TypeScript to hollow-test (#313) was gated on both
// mutation consumers discarding such mutants, so this file pins that a
// TS-family plant is parsed with the repository's own `typescript` — through the
// same check in @adlc/core that hollow-test uses — and that everything #1218
// decided (unknown passes through, spawn failures are discarded, exit codes and
// --min-plants unchanged) still holds.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitRepo } from '@adlc/core/test-kit';
import { filterEquivalentMutants } from '../lib/verify.mjs';
import { runCli, writePlantsFile } from './cli-fixtures.mjs';

const REAL_TS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../node_modules/typescript');
const NO_TS = !existsSync(join(REAL_TS, 'package.json')) && 'typescript is not installed';

const LOADER = 'export type Loader = () => Promise<unknown>;\nexport const n: number = 1;\n';
const VIEW = 'export const label = (n: number): boolean => n > 1;\nexport const view = <Button label="x" />;\n';
const SHAPE = [
  'export function shape(a: number): { ok: boolean } {',
  '  return {',
  '    ok: a > 1,',
  '  };',
  '}',
  '',
].join('\n');

const GENERIC = Object.freeze({
  file: 'src/loader.ts', line: 1,
  original: 'export type Loader = () => Promise<unknown>;',
  mutated: 'export type Loader = () => Promise>=unknown>;',
  category: 'boundary', defect: 'comparison inverted',
});
const JSX = Object.freeze({
  file: 'src/view.tsx', line: 2,
  original: 'export const view = <Button label="x" />;',
  mutated: 'export const view = >=Button label="x" />;',
  category: 'boundary', defect: 'comparison inverted',
});
const STRANDED = Object.freeze({
  file: 'src/shape.ts', line: 2,
  original: '  return {', mutated: '  return null;',
  category: 'null-handling', defect: 'returns null instead of the shape',
});
const BOUNDARY = Object.freeze({
  file: 'src/shape.ts', line: 3,
  original: '    ok: a > 1,', mutated: '    ok: a >= 1,',
  category: 'boundary', defect: 'inclusive bound admits one',
});

/** A committed repo with the given files; `ts` links the root typescript (gitignored). */
function repoWith(t, files, { ts = true } = {}) {
  const repo = gitRepo(t, { prefix: 'rc-ts-plants-' });
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo.dir, rel)), { recursive: true });
    writeFileSync(join(repo.dir, rel), text);
  }
  writeFileSync(join(repo.dir, 'package.json'), '{ "name": "fixture", "type": "module" }\n');
  writeFileSync(join(repo.dir, '.gitignore'), 'node_modules\n');
  if (ts) {
    mkdirSync(join(repo.dir, 'node_modules'));
    symlinkSync(realpathSync(REAL_TS), join(repo.dir, 'node_modules', 'typescript'), 'dir');
  }
  repo.git('add', '-A');
  repo.git('commit', '-q', '-m', 'initial');
  return repo.dir;
}

const abs = (dir, plant) => ({ ...plant, absolutePath: join(dir, plant.file) });

describe('TypeScript-family plants are syntax-checked', { skip: NO_TS }, () => {
  it('a mutated generic in a .ts plant is discarded as unparseable', (t) => {
    const dir = repoWith(t, { 'src/loader.ts': LOADER });
    const { valid, discarded } = filterEquivalentMutants([abs(dir, GENERIC)], dir);
    assert.deepEqual(valid, []);
    assert.equal(discarded.length, 1);
    assert.equal(discarded[0].kind, 'unparseable');
  });

  it('a mutated JSX element in a .tsx plant is discarded as unparseable', (t) => {
    const dir = repoWith(t, { 'src/view.tsx': VIEW });
    const { valid, discarded } = filterEquivalentMutants([abs(dir, JSX)], dir);
    assert.deepEqual(valid, []);
    assert.equal(discarded[0]?.kind, 'unparseable');
  });

  it('a stranded multiline return in a .ts plant is discarded, a parseable one is valid', (t) => {
    const dir = repoWith(t, { 'src/shape.ts': SHAPE });
    const { valid, discarded } = filterEquivalentMutants([abs(dir, STRANDED), abs(dir, BOUNDARY)], dir);
    assert.deepEqual(discarded.map((p) => p.line), [2]);
    assert.deepEqual(valid.map((p) => p.line), [3]);
    assert.equal(valid[0].syntax, 'valid', 'a TypeScript plant that parses records syntax valid, not unknown');
  });

  it('CLI --json: a TypeScript plant that does not parse is counted as discarded', (t) => {
    const dir = repoWith(t, { 'src/shape.ts': SHAPE });
    const r = runCli([
      '--review-cmd', 'node -e "0"', '--plants-file', writePlantsFile(t, [STRANDED, BOUNDARY]),
      '--min-plants', '1', '--min-recall', '0', '--scorer', 'string', '--json',
    ], dir);
    assert.equal(r.status, 0, r.stderr);
    const report = JSON.parse(r.stdout);
    assert.equal(report.plantsDiscarded.unparseable, 1);
    assert.equal(report.total, 1, 'recall is measured over the parseable plant only');
  });
});

describe('what #1218 decided still holds', () => {
  it('a TypeScript plant without typescript in reach passes through with syntax unknown', (t) => {
    const dir = repoWith(t, { 'src/loader.ts': LOADER }, { ts: false });
    const { valid, discarded } = filterEquivalentMutants([abs(dir, GENERIC)], dir);
    assert.equal(discarded.length, 0);
    assert.equal(valid[0].syntax, 'unknown');
  });

  it('a JavaScript plant that does not parse is still discarded', (t) => {
    const js = 'export function f() {\n  return {\n    a: 1,\n  };\n}\n';
    const dir = repoWith(t, { 'src/obj.mjs': js }, { ts: false });
    const plant = { file: 'src/obj.mjs', line: 2, original: '  return {', mutated: '  return null;', category: 'return', defect: 'null' };
    const { discarded } = filterEquivalentMutants([abs(dir, plant)], dir);
    assert.equal(discarded[0]?.kind, 'unparseable');
  });

  it('a plant with no checker is not syntax-checked', (t) => {
    const dir = repoWith(t, { 'src/app.py': 'def f(a):\n    return a > 1\n' }, { ts: false });
    const plant = { file: 'src/app.py', line: 2, original: '    return a > 1', mutated: '    return a >= 1', category: 'boundary', defect: 'inclusive' };
    const { valid, discarded } = filterEquivalentMutants([abs(dir, plant)], dir);
    assert.equal(discarded.length, 0);
    assert.equal(valid[0].syntax, 'unknown');
  });
});
