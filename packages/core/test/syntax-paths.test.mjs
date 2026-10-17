// Regression coverage for relative paths and case-insensitive TypeScript extensions (#313).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmp } from '../lib/test-kit.mjs';
import { checkSyntax } from '../index.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const REAL_TS = join(ROOT, 'node_modules/typescript');
const WORKER = join(ROOT, 'packages/core/lib/syntax-check-typescript.mjs');
const CORE_URL = pathToFileURL(join(ROOT, 'packages/core/index.mjs')).href;
const NO_TS = !existsSync(join(REAL_TS, 'package.json')) && 'typescript is not installed';

function withRealTs(t, prefix = 'core-syntax-paths-') {
  const dir = tmp(t, prefix);
  mkdirSync(join(dir, 'node_modules'));
  symlinkSync(realpathSync(REAL_TS), join(dir, 'node_modules', 'typescript'), 'dir');
  return dir;
}

function write(dir, name, text) {
  const file = join(dir, name);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  return file;
}

function runModule(cwd, source) {
  return spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
    cwd,
    encoding: 'utf8',
    timeout: 10000,
  });
}

function assertChild(result, expected) {
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), expected);
}

test('relative TypeScript paths resolve and return promptly', { skip: NO_TS }, (t) => {
  const dir = withRealTs(t);
  write(dir, 'src/a.ts', 'export const a: number = 1;\n');

  assertChild(
    runModule(dir, `import { resolveTypeScript } from ${JSON.stringify(CORE_URL)}; console.log(resolveTypeScript('src/a.ts') === null ? 'null' : 'resolved');`),
    'resolved',
  );
  assertChild(
    runModule(dir, `import { syntaxCheckProblem } from ${JSON.stringify(CORE_URL)}; console.log(String(syntaxCheckProblem('src/a.ts')));`),
    'null',
  );
  assertChild(
    runModule(dir, `import { checkSyntax } from ${JSON.stringify(CORE_URL)}; console.log(checkSyntax('src/a.ts', process.cwd()));`),
    'valid',
  );
});

test('upper-case TypeScript extensions preserve syntax verdicts', { skip: NO_TS }, (t) => {
  const dir = withRealTs(t, 'core-syntax-upper-');
  assert.equal(checkSyntax(write(dir, 'A.TS', 'export const a: number = 1;\n'), dir), 'valid');
  assert.equal(checkSyntax(write(dir, 'B.TSX', 'export const B = () => <main />;\n'), dir), 'valid');
  assert.equal(checkSyntax(write(dir, 'C.TS', 'export const c = (1;\n'), dir), 'invalid');
});

test('the worker diagnoses an undetermined syntax check', (t) => {
  const dir = tmp(t, 'core-syntax-no-typescript-');
  const file = write(dir, 'src/a.ts', 'export const a: number = 1;\n');
  const result = spawnSync(process.execPath, [WORKER, file], { cwd: dir, encoding: 'utf8' });

  assert.equal(result.status, 3);
  assert.match(result.stderr, /^adlc syntax check: .+\n$/);
  assert.match(result.stderr, /typescript could not be resolved/);
});
