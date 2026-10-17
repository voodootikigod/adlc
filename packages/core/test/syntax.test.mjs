// syntax.test.mjs — the shared syntax check (#312, #313).
//
// hollow-test and review-calibration both score a mutant by a non-zero exit, and
// a file that does not parse also exits non-zero. One check, in core, decides
// whether a mutant is code at all. It is tri-state, and its one rule is that a
// check that did not finish is `unknown`, never `invalid`: an `invalid` that was
// really a crash would discard a mutant that could have been a survivor.
//
// The TypeScript family uses the `typescript` package of the repository under
// test, resolved from the file. No @adlc package depends on it (CONVENTIONS
// rule 1), so the tests link the root devDependency into each fixture.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmp } from '../lib/test-kit.mjs';
import * as core from '../index.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const REAL_TS = join(ROOT, 'node_modules/typescript');
const WORKER = join(ROOT, 'packages/core/lib/syntax-check-typescript.mjs');
const NO_TS = !existsSync(join(REAL_TS, 'package.json')) && 'typescript is not installed';

const { checkSyntax, resolveTypeScript, syntaxCheckProblem, syntaxLanguage } = core;

function requireApi() {
  for (const name of ['checkSyntax', 'resolveTypeScript', 'syntaxCheckProblem', 'syntaxLanguage']) {
    assert.equal(typeof core[name], 'function', `@adlc/core must export ${name}`);
  }
}

/** A fixture directory whose node_modules/typescript is the root devDependency. */
function withRealTs(t, prefix = 'core-syntax-') {
  const dir = tmp(t, prefix);
  mkdirSync(join(dir, 'node_modules'));
  symlinkSync(realpathSync(REAL_TS), join(dir, 'node_modules', 'typescript'), 'dir');
  return dir;
}

/** A fake `typescript` package; `source` is the body of its CommonJS entry. */
function fakeTs(dir, { version = '5.0.0', source, main = 'index.js', exportsField } = {}) {
  const pkg = join(dir, 'node_modules', 'typescript');
  mkdirSync(join(pkg, 'lib'), { recursive: true });
  const manifest = { name: 'typescript', version, main };
  if (exportsField) manifest.exports = exportsField;
  writeFileSync(join(pkg, 'package.json'), JSON.stringify(manifest));
  if (source !== undefined) writeFileSync(join(pkg, main ?? 'index.js'), source);
  return pkg;
}

/** The shape of the TypeScript 7 (native) package: no JavaScript parser API. */
function fakeTs7(dir) {
  const pkg = fakeTs(dir, { version: '7.0.2', main: null, exportsField: { '.': './lib/version.cjs' } });
  writeFileSync(join(pkg, 'lib', 'version.cjs'), "module.exports = { version: '7.0.2' };\n");
  return pkg;
}

function write(dir, name, text) {
  const file = join(dir, name);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  return file;
}

test('syntaxLanguage maps each extension', () => {
  requireApi();
  for (const f of ['a.js', 'a.mjs', 'a.cjs', 'dir/A.JS']) assert.equal(syntaxLanguage(f), 'javascript', f);
  for (const f of ['a.ts', 'a.mts', 'a.cts', 'a.tsx', 'a.jsx', 'dir/A.TSX']) assert.equal(syntaxLanguage(f), 'typescript', f);
  for (const f of ['a.py', 'a.css', 'a.json', 'Makefile', 'a.ts.bak', 'a.mjsx']) assert.equal(syntaxLanguage(f), null, f);
});

test('JavaScript keeps node --check', (t) => {
  requireApi();
  const dir = tmp(t, 'core-syntax-js-');
  assert.equal(checkSyntax(write(dir, 'ok.mjs', 'export const a = 1;\n'), dir), 'valid');
  assert.equal(checkSyntax(write(dir, 'ok.cjs', 'module.exports = 1;\n'), dir), 'valid');
  assert.equal(
    checkSyntax(write(dir, 'bad.mjs', 'export function f() {\n  return null;\n    a: 1,\n  };\n}\n'), dir),
    'invalid',
  );
  // node --check, not the TypeScript parser: a type annotation is not JavaScript.
  assert.equal(checkSyntax(write(dir, 'typed.mjs', 'export const a: number = 1;\n'), dir), 'invalid');
  // And no typescript is needed for JavaScript at all: this fixture has none.
  assert.equal(syntaxCheckProblem(join(dir, 'ok.mjs')), null);
  assert.equal(checkSyntax(join(dir, 'ok.mjs'), dir, join(dir, 'no-such-node')), 'unknown');
});

test('each TypeScript-family extension parses', { skip: NO_TS }, (t) => {
  requireApi();
  const dir = withRealTs(t);
  const cases = {
    'a.ts': 'export async function load(): Promise<unknown> { return 1 as unknown; }\n',
    'a.mts': 'export const pick = <T,>(xs: T[]): T | undefined => xs[0];\n',
    'a.cts': 'const n: number = 2;\nmodule.exports = { n };\n',
    'a.tsx': 'export const View = ({ label }: { label: string }) => <Button label={label} />;\n',
    'a.jsx': 'export const View = ({ label }) => <Button label={label} />;\n',
  };
  for (const [name, text] of Object.entries(cases)) {
    assert.equal(checkSyntax(write(dir, name, text), dir), 'valid', name);
    assert.equal(syntaxCheckProblem(join(dir, name)), null, name);
  }
});

test('an unparseable file is invalid for each TypeScript-family extension', { skip: NO_TS }, (t) => {
  requireApi();
  const dir = withRealTs(t);
  for (const name of ['b.ts', 'b.mts', 'b.cts', 'b.tsx', 'b.jsx']) {
    assert.equal(checkSyntax(write(dir, name, 'export const a = (1;\n'), dir), 'invalid', name);
  }
});

test('a mutated generic is invalid', { skip: NO_TS }, (t) => {
  requireApi();
  const dir = withRealTs(t);
  const file = write(dir, 'loader.ts', 'export type Loader = () => Promise>=unknown>;\n');
  assert.equal(checkSyntax(file, dir), 'invalid');
});

test('a mutated JSX element is invalid', { skip: NO_TS }, (t) => {
  requireApi();
  const dir = withRealTs(t);
  assert.equal(checkSyntax(write(dir, 'view.tsx', 'export const view = >=Button label="x" />;\n'), dir), 'invalid');
  assert.equal(checkSyntax(write(dir, 'view.jsx', 'export const view = >=Button label="x" />;\n'), dir), 'invalid');
});

test('a stranded multiline return is invalid', { skip: NO_TS }, (t) => {
  requireApi();
  const dir = withRealTs(t);
  const file = write(dir, 'shape.ts', 'export function f(): unknown {\n  return null;\n    a: 1,\n  };\n}\n');
  assert.equal(checkSyntax(file, dir), 'invalid');
});

test('the worker exits 0 for valid, 65 for invalid and 3 when it cannot decide', { skip: NO_TS }, (t) => {
  requireApi();
  assert.ok(existsSync(WORKER), 'packages/core/lib/syntax-check-typescript.mjs exists');
  const dir = withRealTs(t);
  const run = (file) => spawnSync(process.execPath, [WORKER, file], { cwd: dir, encoding: 'utf8' }).status;
  assert.equal(run(write(dir, 'ok.ts', 'export const a: number = 1;\n')), 0);
  assert.equal(run(write(dir, 'bad.ts', 'export const a = (1;\n')), 65);
  const bare = tmp(t, 'core-syntax-bare-');
  assert.equal(run(write(bare, 'ok.ts', 'export const a: number = 1;\n')), 3);
});

test('unknown when typescript cannot be resolved', (t) => {
  requireApi();
  const dir = tmp(t, 'core-syntax-nots-');
  const file = write(dir, 'src/a.ts', 'export const a: number = 1;\n');
  assert.equal(resolveTypeScript(file), null);
  assert.equal(checkSyntax(file, dir), 'unknown');
});

test('skips a typescript package without the parser API', { skip: NO_TS }, (t) => {
  requireApi();
  // apps/docs in this repository pins typescript 7, which is native and has no
  // createSourceFile; the root 5.x above it does. The nearer package must not win.
  const dir = withRealTs(t);
  mkdirSync(join(dir, 'app'));
  fakeTs7(join(dir, 'app'));
  const file = write(dir, 'app/page.tsx', 'export const Page = () => <main />;\n');
  const resolved = resolveTypeScript(file);
  assert.ok(resolved, 'falls through to the usable package above');
  assert.ok(realpathSync(resolved.path).startsWith(realpathSync(REAL_TS)), `resolved ${resolved.path}`);
  assert.equal(resolved.version, JSON.parse(readFileSync(join(REAL_TS, 'package.json'), 'utf8')).version);
  assert.equal(checkSyntax(file, dir), 'valid');
  assert.equal(checkSyntax(write(dir, 'app/bad.tsx', 'export const Page = () => >=main />;\n'), dir), 'invalid');
  assert.equal(syntaxCheckProblem(file), null);

  // With only the native package in reach there is no parser: unknown, and the
  // problem names the version it skipped.
  const lone = tmp(t, 'core-syntax-ts7-');
  fakeTs7(lone);
  const loneFile = write(lone, 'page.tsx', 'export const Page = () => <main />;\n');
  assert.equal(resolveTypeScript(loneFile), null);
  assert.equal(checkSyntax(loneFile, lone), 'unknown');
  assert.match(syntaxCheckProblem(loneFile), /7\.0\.2/);
});

test('unknown when the checker crashes', (t) => {
  requireApi();
  // A parser that throws. An uncaught error in Node exits 1, so 1 must never be
  // read as "invalid": the worker catches it and the result is unknown.
  const dir = tmp(t, 'core-syntax-crash-');
  fakeTs(dir, {
    source: [
      'exports.version = "5.0.0";',
      'exports.ScriptTarget = { Latest: 99 }; exports.JsxEmit = { Preserve: 1 };',
      'exports.createSourceFile = () => { throw new Error("parser exploded"); };',
      'exports.createProgram = () => { throw new Error("parser exploded"); };',
      '',
    ].join('\n'),
  });
  const file = write(dir, 'a.ts', 'export const a: number = 1;\n');
  assert.equal(checkSyntax(file, dir), 'unknown');
  assert.equal(spawnSync(process.execPath, [WORKER, file], { cwd: dir }).status, 3);

  // A node binary that cannot start, and one that exits 1, are unknown too.
  assert.equal(checkSyntax(file, dir, join(dir, 'no-such-node')), 'unknown');
  const exits1 = join(dir, 'exits-1.sh');
  writeFileSync(exits1, '#!/bin/sh\nexit 1\n');
  chmodSync(exits1, 0o755);
  assert.equal(checkSyntax(file, dir, exits1), 'unknown');
});

test('unknown for an extension with no checker', (t) => {
  requireApi();
  const dir = tmp(t, 'core-syntax-py-');
  assert.equal(checkSyntax(write(dir, 'app.py', 'def f(:\n'), dir), 'unknown');
  assert.match(syntaxCheckProblem(join(dir, 'app.py')), /app\.py/);
});

test('syntaxCheckProblem names the file and the install command', (t) => {
  requireApi();
  const dir = tmp(t, 'core-syntax-problem-');
  const file = write(dir, 'src/view.tsx', 'export const v = <div />;\n');
  const problem = syntaxCheckProblem(file);
  assert.equal(typeof problem, 'string');
  assert.match(problem, /src\/view\.tsx/);
  assert.match(problem, /npm i -D typescript/);
});
