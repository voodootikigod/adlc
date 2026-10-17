// hollow-test/test/typescript.test.mjs — TypeScript, TSX and JSX are mutable
// source (#313).
//
// They were refused because the line-based operators turn `Promise<unknown>`
// into `Promise>=unknown>` and `<Button>` into `>=Button>`, and an unparseable
// mutant used to be credited as a kill (#293). #306 made such a mutant a
// discard, but its check was `node --check`, which cannot parse TypeScript at
// all. Each run below is a real git repository driven through the real bin; the
// fixture's node_modules/typescript links the root devDependency, because no
// @adlc package depends on it.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitRepo } from '@adlc/core/test-kit';
import { isMutableSource, isSupportedSourceExtension } from '../lib/targets.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(HERE, '../bin/hollow-test.mjs');
const REAL_TS = resolve(HERE, '../../../node_modules/typescript');
const NO_TS = !existsSync(join(REAL_TS, 'package.json')) && 'typescript is not installed';

// Runs src/<file> through the fixture's own typescript and asserts on it. It is
// committed in the base, so it is never part of the diff that gets mutated.
const CHECK = [
  "import { createRequire } from 'node:module';",
  "import { readFileSync } from 'node:fs';",
  "const ts = createRequire(import.meta.url)('typescript');",
  'const [file, expr] = process.argv.slice(2);',
  "const source = readFileSync(new URL(`./src/${file}`, import.meta.url), 'utf8');",
  'const { outputText } = ts.transpileModule(source, {',
  '  fileName: file,',
  '  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.React },',
  '});',
  "const m = await import('data:text/javascript,' + encodeURIComponent(outputText));",
  'const ok = new Function("m", `return (${expr});`)(m);',
  'process.exit(ok === true ? 0 : 1);',
  '',
].join('\n');

/**
 * A repo whose base commit holds `base` (path → content), the check script and,
 * when `ts`, a node_modules/typescript link; a second commit applies `change`.
 */
function tsRepo(t, { base = {}, change = {}, ts = true } = {}) {
  const repo = gitRepo(t, { prefix: 'hollow-ts-' });
  const put = (rel, text) => {
    mkdirSync(dirname(join(repo.dir, rel)), { recursive: true });
    writeFileSync(join(repo.dir, rel), text);
  };
  put('.gitignore', 'node_modules\n');
  put('package.json', '{ "name": "fixture", "type": "module" }\n');
  put('check.mjs', CHECK);
  for (const [rel, text] of Object.entries(base)) put(rel, text);
  if (ts) {
    mkdirSync(join(repo.dir, 'node_modules'));
    symlinkSync(realpathSync(REAL_TS), join(repo.dir, 'node_modules', 'typescript'), 'dir');
  }
  repo.git('add', '-A');
  repo.git('commit', '-q', '-m', 'base');
  const sha = repo.git('rev-parse', 'HEAD').trim();
  for (const [rel, text] of Object.entries(change)) put(rel, text);
  repo.git('add', '-A');
  repo.git('commit', '-q', '-m', 'change');
  return { ...repo, base: sha, put };
}

function hollow(repo, args) {
  return spawnSync(process.execPath, [BIN, '--base', repo.base, ...args], {
    cwd: repo.dir, encoding: 'utf8', stdio: 'pipe', timeout: 120_000,
  });
}

const json = (r) => JSON.parse(r.stdout);

const AGE_BASE = 'export function isAdult(age: number): boolean {\n  return false;\n}\n';
const AGE_CHANGED = 'export function isAdult(age: number): boolean {\n  return age >= 18;\n}\n';

describe('the source set', () => {
  it('the source set admits the TypeScript family', () => {
    for (const f of ['a.ts', 'a.mts', 'a.cts', 'a.tsx', 'a.jsx', 'src/A.TSX', 'apps/docs/app/page.tsx']) {
      assert.equal(isSupportedSourceExtension(f), true, f);
      assert.equal(isMutableSource(f), true, f);
    }
    for (const f of ['a.mjs', 'a.cjs', 'a.js']) assert.equal(isMutableSource(f), true, f);
  });

  it('declaration and test files are not source', () => {
    for (const f of ['index.d.ts', 'lib/test-kit.d.mts', 'types.d.cts', 'src/Global.D.TS']) {
      assert.equal(isSupportedSourceExtension(f), false, f);
      assert.equal(isMutableSource(f), false, f);
    }
    for (const f of ['src/a.test.ts', 'src/a.spec.tsx', 'test/a.ts', 'src/__tests__/a.tsx', 'a-test.jsx']) {
      assert.equal(isMutableSource(f), false, f);
    }
    // A declared source glob still cannot make a declaration file mutable.
    assert.equal(isMutableSource('lib/x.d.ts', { sourceGlobs: ['lib/**'] }), false);
  });

  it('Python is still refused', (t) => {
    assert.equal(isSupportedSourceExtension('src/app.py'), false);
    const repo = tsRepo(t, { base: { 'src/app.py': 'x = 1\n' }, change: { 'src/app.py': 'x = 2\n' }, ts: false });
    const r = hollow(repo, ['--test-cmd', 'node -e 0', '--target', 'src/app.py']);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /not a supported source language/);
  });
});

describe('TypeScript through the real bin', { skip: NO_TS }, () => {
  it('a killed TypeScript mutant passes', (t) => {
    const repo = tsRepo(t, { base: { 'src/age.ts': AGE_BASE }, change: { 'src/age.ts': AGE_CHANGED } });
    const r = hollow(repo, ['--test-cmd', 'node check.mjs age.ts "m.isAdult(18) && !m.isAdult(17)"', '--max', '1', '--json']);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const report = json(r);
    assert.equal(report.summary.killed, 1);
    assert.equal(report.mutants[0].file, 'src/age.ts');
  });

  it('a surviving TypeScript mutant fails the gate', (t) => {
    const repo = tsRepo(t, { base: { 'src/age.ts': AGE_BASE }, change: { 'src/age.ts': AGE_CHANGED } });
    const r = hollow(repo, ['--test-cmd', 'node check.mjs age.ts "typeof m.isAdult === \'function\'"', '--max', '1', '--json']);
    assert.equal(r.status, 2, r.stderr + r.stdout);
    assert.equal(json(r).summary.survived, 1);
  });

  it('--target accepts a .tsx file', (t) => {
    const view = 'export const double = (n: number): number => n * 2;\nexport const View = () => <b>{double(2)}</b>;\n';
    const repo = tsRepo(t, { base: { 'src/view.tsx': view }, change: { 'README.md': 'docs\n' } });
    const r = hollow(repo, [
      '--test-cmd', 'node check.mjs view.tsx "m.double(2) === 4 && m.double(5) === 10"',
      '--target', 'src/view.tsx', '--max', '1', '--json',
    ]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(json(r).summary.killed, 1);
  });

  // QUOTA ONE (#293): the only mutant is unparseable. Scoring it as a kill would
  // pass the gate with no assertion run; it must be discarded and the run must
  // say so. Exit 1 alone is not enough here: "nothing to mutate" is also exit 1.
  it('quota one: a mutated generic never passes', (t) => {
    const repo = tsRepo(t, {
      base: { 'src/types.ts': 'export type Id = string;\n' },
      change: { 'src/types.ts': 'export type Id = string;\nexport type Loader = () => Promise<unknown>;\n' },
    });
    const r = hollow(repo, ['--test-cmd', 'node -e 0', '--max', '1', '--json']);
    assert.equal(r.status, 1, r.stderr + r.stdout);
    assert.match(r.stderr, /syntactically invalid/);
    const report = json(r);
    assert.equal(report.summary.invalid, 1);
    assert.equal(report.summary.killed, 0);
    assert.equal(report.mutants[0].mutated.trim(), 'export type Loader = () => Promise>=unknown>;');
  });

  it('quota one: a mutated JSX element never passes', (t) => {
    const repo = tsRepo(t, {
      base: { 'src/view.tsx': 'export const label = "x";\n' },
      change: { 'src/view.tsx': 'export const label = "x";\nexport const view = <Button label="x" />;\n' },
    });
    const r = hollow(repo, ['--test-cmd', 'node -e 0', '--max', '1', '--json']);
    assert.equal(r.status, 1, r.stderr + r.stdout);
    assert.match(r.stderr, /syntactically invalid/);
    assert.equal(json(r).summary.invalid, 1);
    assert.equal(json(r).summary.killed, 0);
  });

  it('refuses before mutating when typescript cannot be resolved', (t) => {
    const repo = tsRepo(t, { base: { 'src/age.ts': AGE_BASE }, change: { 'src/age.ts': AGE_CHANGED }, ts: false });
    const r = hollow(repo, ['--test-cmd', 'node -e 0', '--max', '1']);
    assert.equal(r.status, 1, r.stderr + r.stdout);
    assert.match(r.stderr, /src\/age\.ts/);
    assert.match(r.stderr, /npm i -D typescript/);
    assert.equal(readFileSync(join(repo.dir, 'src/age.ts'), 'utf8'), AGE_CHANGED);
    assert.equal(repo.git('status', '--porcelain').trim(), '');
  });

  it('refuses a target that does not parse before mutating', (t) => {
    const broken = 'export function isAdult(age: number): boolean {\n  return (age >= 18;\n}\n';
    const repo = tsRepo(t, { base: { 'src/age.ts': AGE_BASE }, change: { 'src/age.ts': broken } });
    const r = hollow(repo, ['--test-cmd', 'node -e 0', '--max', '1']);
    assert.equal(r.status, 1, r.stderr + r.stdout);
    assert.match(r.stderr, /src\/age\.ts/);
    assert.match(r.stderr, /does not parse/);
    assert.match(r.stderr, /typescript \d+\.\d+\.\d+/);
    assert.equal(readFileSync(join(repo.dir, 'src/age.ts'), 'utf8'), broken);
  });
});
