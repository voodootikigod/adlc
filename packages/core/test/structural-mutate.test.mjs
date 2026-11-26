import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dropObjectArgKey,
  STRUCTURAL_FALLBACK_OPERATORS,
} from '../lib/structural-mutate.mjs';

test('STRUCTURAL_FALLBACK_OPERATORS is frozen with object-arg-key-drop operator', () => {
  assert.ok(Object.isFrozen(STRUCTURAL_FALLBACK_OPERATORS));
  assert.equal(STRUCTURAL_FALLBACK_OPERATORS.length, 1);
  const op = STRUCTURAL_FALLBACK_OPERATORS[0];
  assert.ok(Object.isFrozen(op));
  assert.equal(op.name, 'object-arg-key-drop');
  assert.equal(op.apply, dropObjectArgKey);
});

test('dropObjectArgKey drops last non-exempt call-site option key', () => {
  const line = 'doSomething({ foo: 1, bar: 2 });';
  assert.equal(dropObjectArgKey(line), 'doSomething({ foo: 1 });');

  const withArgs = "runCommand('test', { silent: true, verbose: false });";
  assert.equal(dropObjectArgKey(withArgs), "runCommand('test', { silent: true });");

  const threeProps = 'configure({ a: 1, b: 2, c: 3 });';
  assert.equal(dropObjectArgKey(threeProps), 'configure({ a: 1, b: 2 });');
});

test('dropObjectArgKey preserves tuning identifiers and exempt keys while dropping non-exempt key', () => {
  const withTimeout = 'fetch(url, { timeout: 5000, cache: false });';
  assert.equal(dropObjectArgKey(withTimeout), 'fetch(url, { timeout: 5000 });');

  const withEncoding = "fs.readFile(file, { encoding: 'utf8', flag: 'r' });";
  assert.equal(dropObjectArgKey(withEncoding), "fs.readFile(file, { encoding: 'utf8' });");

  const withForce = 'fs.rm(path, { force: true, recursive: true, dryRun: false });';
  assert.equal(dropObjectArgKey(withForce), 'fs.rm(path, { force: true, recursive: true });');

  const withMaxBytes = 'exec(cmd, { maxBytes: 1024, cwd: "/tmp", env: opts });';
  assert.equal(dropObjectArgKey(withMaxBytes), 'exec(cmd, { maxBytes: 1024, cwd: "/tmp" });');
});

test('dropObjectArgKey returns null when total properties < 2', () => {
  assert.equal(dropObjectArgKey('doSomething({ single: 1 });'), null);
});

test('dropObjectArgKey returns null when all properties are exempt or tuning knobs', () => {
  assert.equal(dropObjectArgKey('read(file, { encoding: "utf8", timeout: 1000 });'), null);
  assert.equal(dropObjectArgKey('rm(file, { force: true, recursive: false });'), null);
  assert.equal(dropObjectArgKey('exec(cmd, { timeoutMs: 5000, maxBufferBytes: 1024 });'), null);
});

test('dropObjectArgKey returns null on destructuring declarations and assignments', () => {
  assert.equal(dropObjectArgKey('const { a, b } = options;'), null);
  assert.equal(dropObjectArgKey('let { a, b } = options;'), null);
  assert.equal(dropObjectArgKey('var { a, b } = options;'), null);
  assert.equal(dropObjectArgKey('({ a, b } = options);'), null);
});

test('dropObjectArgKey returns null on function definitions and arrow parameters', () => {
  assert.equal(dropObjectArgKey('function foo({ a, b }) {}'), null);
  assert.equal(dropObjectArgKey('const fn = ({ a, b }) => a + b;'), null);
});

test('dropObjectArgKey returns null on import/export statements', () => {
  assert.equal(dropObjectArgKey("import { a, b } from 'mod';"), null);
  assert.equal(dropObjectArgKey('export { a, b };'), null);
});

test('dropObjectArgKey returns null on spread operators', () => {
  assert.equal(dropObjectArgKey('call({ ...defaults, custom: true, extra: 1 });'), null);
});

test('dropObjectArgKey returns null on non-call statements', () => {
  assert.equal(dropObjectArgKey('const config = { a: 1, b: 2 };'), null);
  assert.equal(dropObjectArgKey('return { a: 1, b: 2 };'), null);
  assert.equal(dropObjectArgKey('if ({ a: 1, b: 2 }) {}'), null);
});

test('dropObjectArgKey returns null on unbalanced delimiters or multi-line strings', () => {
  assert.equal(dropObjectArgKey('call({ a: 1, b: 2'), null);
  assert.equal(dropObjectArgKey('call({ a: 1, b: 2 }'), null);
  assert.equal(dropObjectArgKey('call({\n  a: 1,\n  b: 2\n});'), null);
});
