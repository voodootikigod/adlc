// An agy CLI that exits without draining its stdin must surface as the
// handled "agy exit N" rejection, never as an uncaught EPIPE that kills the
// calling process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmp } from '../lib/test-kit.mjs';

const LLM = fileURLToPath(new URL('../lib/llm.mjs', import.meta.url));

// Runs in a child so an uncaught exception is observed as an exit code
// rather than tearing down the test runner.
const DRIVER = `
const { complete } = await import(process.env.LLM_MODULE);
process.on('uncaughtException', (e) => { console.log('UNCAUGHT ' + e.code); process.exit(3); });
try {
  await complete({ tier: 'cheap', prompt: 'x'.repeat(1_000_000) }, {
    ADLC_PROVIDER: 'agy',
    ADLC_AGY: process.env.FAKE_AGY,
  });
  console.log('RESOLVED');
} catch (e) {
  console.log('REJECTED ' + e.message);
}
`;

test('agy that exits before reading a large prompt rejects with its exit diagnostic', (t) => {
  const dir = tmp(t, 'adlc-agy-epipe-');
  const fake = join(dir, 'fake-agy');
  // Close stdin first so the parent's write is guaranteed to hit a dead pipe.
  writeFileSync(fake, '#!/bin/sh\nexec 0<&-\necho auth error >&2\nexit 1\n');
  chmodSync(fake, 0o755);
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', DRIVER], {
    env: { ...process.env, LLM_MODULE: LLM, FAKE_AGY: fake },
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(r.status, 0, `driver exited ${r.status}: ${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /^REJECTED agy exit 1: auth error/m);
});

test('agy that exits 0 without reading the prompt is rejected, not resolved', (t) => {
  const dir = tmp(t, 'adlc-agy-epipe-');
  const fake = join(dir, 'fake-agy');
  writeFileSync(fake, '#!/bin/sh\nexec 0<&-\necho an answer to a prompt it never read\nexit 0\n');
  chmodSync(fake, 0o755);
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', DRIVER], {
    env: { ...process.env, LLM_MODULE: LLM, FAKE_AGY: fake },
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(r.status, 0, `driver exited ${r.status}: ${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /^REJECTED agy did not read the full prompt: .*EPIPE/m);
});

test('agy that reads the whole prompt and exits 0 resolves with its output', (t) => {
  const dir = tmp(t, 'adlc-agy-epipe-');
  const fake = join(dir, 'fake-agy');
  writeFileSync(fake, '#!/bin/sh\ncat > /dev/null\necho fine\nexit 0\n');
  chmodSync(fake, 0o755);
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', DRIVER], {
    env: { ...process.env, LLM_MODULE: LLM, FAKE_AGY: fake },
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(r.status, 0, `driver exited ${r.status}: ${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /^RESOLVED$/m);
});
