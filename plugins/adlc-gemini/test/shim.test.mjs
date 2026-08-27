import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { runFromStdin } from '../hooks/adlc-rails-guard.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHIM = join(HERE, '..', 'hooks', 'adlc-rails-guard.cjs');

test('runFromStdin: malformed JSON under enforcement fails closed', () => {
  const v = runFromStdin('{not json', { ADLC_P4_ENFORCEMENT: '1' });
  assert.equal(v.allow_tool, false);
});
test('runFromStdin: malformed JSON with enforcement off allows', () => {
  const v = runFromStdin('{not json', {});
  assert.equal(v.allow_tool, true);
});
test('runFromStdin: empty/blank stdin under enforcement fails closed', () => {
  assert.equal(runFromStdin('', { ADLC_P4_ENFORCEMENT: '1' }).allow_tool, false);
  assert.equal(runFromStdin('   ', { ADLC_P4_ENFORCEMENT: '1' }).allow_tool, false);
});
test('runFromStdin: empty/blank stdin with enforcement off allows', () => {
  assert.equal(runFromStdin('', {}).allow_tool, true);
  assert.equal(runFromStdin('   ', {}).allow_tool, true);
});
test('runFromStdin: null/undefined raw under enforcement fails closed without throwing', () => {
  assert.equal(runFromStdin(null, { ADLC_P4_ENFORCEMENT: '1' }).allow_tool, false);
  assert.equal(runFromStdin(undefined, { ADLC_P4_ENFORCEMENT: '1' }).allow_tool, false);
});
test('runFromStdin: null/undefined raw with enforcement off allows', () => {
  assert.equal(runFromStdin(null, {}).allow_tool, true);
  assert.equal(runFromStdin(undefined, {}).allow_tool, true);
});
test('runFromStdin: an object with no tool name under enforcement fails closed', () => {
  assert.equal(runFromStdin('{}', { ADLC_P4_ENFORCEMENT: '1' }).allow_tool, false);
  assert.equal(runFromStdin('{"toolCall":{}}', { ADLC_P4_ENFORCEMENT: '1' }).allow_tool, false);
  assert.equal(runFromStdin('{"toolCall":{"args":{"AbsolutePath":"/x"}}}', { ADLC_P4_ENFORCEMENT: '1' }).allow_tool, false);
});
test('runFromStdin: an object with no tool name with enforcement off allows', () => {
  assert.equal(runFromStdin('{}', {}).allow_tool, true);
  assert.equal(runFromStdin('{"toolCall":{}}', {}).allow_tool, true);
});
test('runFromStdin: non-object JSON payloads under enforcement fail closed', () => {
  assert.equal(runFromStdin('null', { ADLC_P4_ENFORCEMENT: '1' }).allow_tool, false);
  assert.equal(runFromStdin('"hi"', { ADLC_P4_ENFORCEMENT: '1' }).allow_tool, false);
  assert.equal(runFromStdin('123', { ADLC_P4_ENFORCEMENT: '1' }).allow_tool, false);
  assert.equal(runFromStdin('[]', { ADLC_P4_ENFORCEMENT: '1' }).allow_tool, false);
});
test('runFromStdin: non-object JSON payloads with enforcement off allow', () => {
  assert.equal(runFromStdin('null', {}).allow_tool, true);
  assert.equal(runFromStdin('"hi"', {}).allow_tool, true);
  assert.equal(runFromStdin('123', {}).allow_tool, true);
  assert.equal(runFromStdin('[]', {}).allow_tool, true);
});
test('shim: exits 0 and prints an allow verdict for a read tool', () => {
  const out = execFileSync(process.execPath, [SHIM], {
    input: JSON.stringify({ toolCall: { name: 'view_file', args: { AbsolutePath: '/x' } } }),
    env: { ...process.env, ADLC_P4_ENFORCEMENT: '1' }, encoding: 'utf8',
  });
  assert.deepEqual(JSON.parse(out), { allow_tool: true });
});
test('shim: empty stdin under enforcement fails closed with allow_tool: false', () => {
  const out = execFileSync(process.execPath, [SHIM], {
    input: '',
    env: { ...process.env, ADLC_P4_ENFORCEMENT: '1' }, encoding: 'utf8',
  });
  assert.equal(JSON.parse(out).allow_tool, false);
});
test('shim: scalar JSON under enforcement fails closed with allow_tool: false', () => {
  const out = execFileSync(process.execPath, [SHIM], {
    input: 'null',
    env: { ...process.env, ADLC_P4_ENFORCEMENT: '1' }, encoding: 'utf8',
  });
  assert.equal(JSON.parse(out).allow_tool, false);
});
test('shim: broken ESM module path under enforcement → exit 0 AND fail-closed payload', () => {
  // execFileSync only throws on non-zero exit; since the shim always exits 0,
  // it returns stdout normally here — exit 0 is implicitly covered because a
  // future regression that exits non-zero would make execFileSync throw and
  // fail this test. The point of this test is the payload assertion below.
  const out = execFileSync(process.execPath, [SHIM], {
    input: '{}', encoding: 'utf8',
    env: { ...process.env, ADLC_P4_ENFORCEMENT: '1', ADLC_AGY_ADAPTER_OVERRIDE: '/no/such/module.mjs' },
  });
  const v = JSON.parse(out);
  assert.equal(v.allow_tool, false);           // fail CLOSED under enforcement
  assert.ok(/ADLC rails-guard/.test(v.deny_reason ?? ''));
});
test('shim: broken ESM module path with enforcement OFF → exit 0 AND allow', () => {
  const out = execFileSync(process.execPath, [SHIM], {
    input: '{}', encoding: 'utf8',
    env: { ...process.env, ADLC_AGY_ADAPTER_OVERRIDE: '/no/such/module.mjs' },  // no ADLC_P4_ENFORCEMENT
  });
  assert.deepEqual(JSON.parse(out), { allow_tool: true });
});
