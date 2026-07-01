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
test('shim: exit code is 0 even when the ESM module path is broken (fail-open is agy default; we still must not crash noisily)', () => {
  // Point the shim at a non-existent module via env override to simulate a load failure.
  let code = 0;
  try {
    execFileSync(process.execPath, [SHIM], {
      input: '{}', encoding: 'utf8',
      env: { ...process.env, ADLC_P4_ENFORCEMENT: '1', ADLC_AGY_ADAPTER_OVERRIDE: '/no/such/module.mjs' },
    });
  } catch (e) { code = e.status ?? 1; }
  assert.equal(code, 0);
});
