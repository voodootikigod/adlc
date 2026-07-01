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
test('shim: exits 0 and prints an allow verdict for a read tool', () => {
  const out = execFileSync(process.execPath, [SHIM], {
    input: JSON.stringify({ toolCall: { name: 'view_file', args: { AbsolutePath: '/x' } } }),
    env: { ...process.env, ADLC_P4_ENFORCEMENT: '1' }, encoding: 'utf8',
  });
  assert.deepEqual(JSON.parse(out), { allow_tool: true });
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
