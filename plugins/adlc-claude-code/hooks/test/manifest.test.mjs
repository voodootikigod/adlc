// manifest.test.mjs — #378: the Stop-hook gate-evidence chain audit must not
// cry wolf on this repo's own honest legacy-unsigned prefix. Drives the real
// hook entrypoint as a subprocess against a real manifest (same style as
// review.test.mjs), with the workspace-local `adlc` bin on PATH so the fix
// under test — not a stale globally-installed CLI — is what actually runs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { record as realRecord } from '@adlc/gate-manifest/lib/record.mjs';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', 'adlc-hook.mjs');
const NODE_DIR = dirname(process.execPath);
const REPO_BIN = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'node_modules', '.bin');
const WITH_ADLC = `${REPO_BIN}:${NODE_DIR}:${process.env.PATH ?? ''}`; // workspace-local adlc reachable

const KEY = 'test-manifest-hook-key';

// The library takes `key` explicitly now (spec Layer 2); withKey scopes what the
// wrapper threads, and still mirrors into env to prove the env is inert.
let currentTestKey = null;
const record = (o = {}) => realRecord({ key: currentTestKey, ...o });
function withKey(key, fn) {
  const prev = process.env.ADLC_MANIFEST_KEY;
  const prevCurrent = currentTestKey;
  currentTestKey = key;
  if (key === null) delete process.env.ADLC_MANIFEST_KEY;
  else process.env.ADLC_MANIFEST_KEY = key;
  try { return fn(); }
  finally { currentTestKey = prevCurrent; if (prev === undefined) delete process.env.ADLC_MANIFEST_KEY; else process.env.ADLC_MANIFEST_KEY = prev; }
}

/** Run the `manifest` Stop hook against `dir`. Returns the parsed stdout JSON, or {} if empty. */
function runManifest(dir, { env = {} } = {}) {
  const input = JSON.stringify({ cwd: dir });
  let out = '';
  try {
    out = execFileSync(process.execPath, [HOOK, 'manifest'], {
      input,
      encoding: 'utf8',
      env: { ...process.env, PATH: WITH_ADLC, ...env },
      cwd: dir,
    });
  } catch (e) {
    out = e.stdout ?? '';
  }
  return out.trim() === '' ? {} : JSON.parse(out);
}

function tmp() {
  return mkdtempSync(join(tmpdir(), 'adlc-cc-manifest-'));
}

test('no .adlc/manifest.jsonl — silent, no output', () => {
  const dir = tmp();
  try {
    const out = runManifest(dir, { env: { ADLC_MANIFEST_KEY: KEY } });
    assert.deepEqual(out, {});
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('#378: a legacy-unsigned-prefix manifest (signed since adoption) is silent — no false "evidence chain INVALID"', () => {
  const dir = tmp();
  try {
    withKey(null, () => {
      record({ gate: 'legacy-1', dir: join(dir, '.adlc') });
      record({ gate: 'legacy-2', dir: join(dir, '.adlc') });
    });
    withKey(KEY, () => {
      record({ gate: 'signed-1', dir: join(dir, '.adlc') });
    });
    const out = runManifest(dir, { env: { ADLC_MANIFEST_KEY: KEY } });
    assert.deepEqual(out, {}, 'no systemMessage for an honest legacy-unsigned-then-signed chain');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a genuinely broken chain still surfaces the "evidence chain INVALID" advisory', () => {
  const dir = tmp();
  try {
    withKey(KEY, () => {
      record({ gate: 'signed-1', dir: join(dir, '.adlc') });
    });
    // Regression after adoption: a later entry recorded with no key.
    withKey(null, () => {
      record({ gate: 'plain-after-adoption', dir: join(dir, '.adlc') });
    });
    const out = runManifest(dir, { env: { ADLC_MANIFEST_KEY: KEY } });
    assert.match(out.systemMessage ?? '', /evidence chain INVALID/);
    assert.match(out.systemMessage ?? '', /unsigned entry/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
