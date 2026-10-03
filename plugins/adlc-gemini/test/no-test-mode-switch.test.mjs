// no-test-mode-switch.test.mjs — shipped hook code has no environment switch
// that redirects the master-key home, substitutes the session secret, widens
// the transcript allowlist, or swaps the hook adapter module. Tests reach the
// same code through the environment object they inject (HOME, the app-data
// dir) and through the real shim layout.

import assert from 'node:assert/strict';
import { spawnHook } from './helpers/run-hook.mjs';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { tmp } from '@adlc/core/test-kit';
import { getMasterKeyRaw, getOrCreateSessionSecret } from '../build-gate-inline.mjs';
import { resolveTranscriptPath } from '../flail-inline.mjs';
import { getTrustRootSecretHomes, isTrustRootOrSecretPath } from '../hooks/adlc-rails-guard.mjs';

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOME_VAR = process.platform === 'win32' ? 'USERPROFILE' : 'HOME';
const SWITCH = { ADLC_TEST_MODE: '1' };

function homeWithKey(t, prefix, key) {
  const home = tmp(t, prefix);
  const dir = join(home, '.config', 'adlc', 'secrets');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, '.auth-key'), key, { mode: 0o600 });
  return home;
}

test('getMasterKeyRaw reads the injected home and ignores ADLC_HOME_DIR under ADLC_TEST_MODE', (t) => {
  const honest = homeWithKey(t, 'gemini-home-honest-', 'h'.repeat(64));
  const other = homeWithKey(t, 'gemini-home-other-', 'o'.repeat(64));
  const env = { ...SWITCH, ADLC_HOME_DIR: other, [HOME_VAR]: honest };
  assert.equal(getMasterKeyRaw(env), 'h'.repeat(64));
});

test('getOrCreateSessionSecret never returns ADLC_SESSION_SECRET verbatim', (t) => {
  const home = homeWithKey(t, 'gemini-home-secret-', 'k'.repeat(64));
  const root = tmp(t, 'gemini-secret-root-');
  mkdirSync(join(root, '.adlc'), { recursive: true });
  const env = { ...SWITCH, ADLC_SESSION_SECRET: 'forged-constant', [HOME_VAR]: home };
  const secret = getOrCreateSessionSecret(root, env);
  assert.notEqual(secret, 'forged-constant');
  assert.match(secret, /^[0-9a-f]{64}$/);
});

test('getTrustRootSecretHomes protects the injected home, not ADLC_HOME_DIR', (t) => {
  const injected = tmp(t, 'gemini-home-injected-');
  const other = tmp(t, 'gemini-home-ignored-');
  const env = { ...SWITCH, ADLC_HOME_DIR: other, [HOME_VAR]: injected };
  const homes = getTrustRootSecretHomes(env);
  assert.ok(homes.includes(injected.replace(/\\/g, '/')), `homes=${homes}`);
  assert.ok(!homes.includes(other.replace(/\\/g, '/')), `homes=${homes}`);
  assert.equal(
    isTrustRootOrSecretPath(join(injected, '.config', 'adlc', 'secrets', '.auth-key'), env),
    true,
  );
});

test('resolveTranscriptPath does not widen the allowlist to tmpdir or payload workspaces', (t) => {
  const dir = tmp(t, 'gemini-transcript-outside-');
  const transcript = join(dir, 'transcript.jsonl');
  writeFileSync(transcript, '{}\n');
  const appData = tmp(t, 'gemini-appdata-');
  const env = { ...SWITCH, ANTIGRAVITY_APP_DATA_DIR: appData };
  assert.equal(
    resolveTranscriptPath({ payload: { transcriptPath: transcript, workspacePaths: [dir] }, env }),
    null,
  );
});

test('resolveTranscriptPath ignores an .adlc ancestor outside the allowed roots', (t) => {
  const dir = tmp(t, 'gemini-transcript-adlc-');
  mkdirSync(join(dir, '.adlc'), { recursive: true });
  writeFileSync(join(dir, '.adlc', 'tickets.json'), '{"tickets":[]}');
  const transcript = join(dir, 'transcript.jsonl');
  writeFileSync(transcript, '{}\n');
  const env = { ...SWITCH, ANTIGRAVITY_APP_DATA_DIR: tmp(t, 'gemini-appdata-') };
  assert.equal(resolveTranscriptPath({ payload: { transcriptPath: transcript }, env }), null);
});

test('resolveTranscriptPath accepts a transcript under the injected app-data dir', (t) => {
  const appData = tmp(t, 'gemini-appdata-allowed-');
  const transcript = join(appData, 'transcript.jsonl');
  writeFileSync(transcript, '{}\n');
  const resolved = resolveTranscriptPath({
    payload: { transcriptPath: transcript },
    env: { ANTIGRAVITY_APP_DATA_DIR: appData },
  });
  assert.ok(resolved?.endsWith('transcript.jsonl'), `resolved=${resolved}`);
});

test('the .cjs shim loads only its sibling adapter, whatever ADLC_AGY_ADAPTER_OVERRIDE says', (t) => {
  const dir = tmp(t, 'gemini-shim-override-');
  const stub = join(dir, 'stub-adapter.mjs');
  writeFileSync(stub, 'export function postToolUse() { return { decision: "stub-adapter-loaded", allow_tool: true }; }\n');
  const res = spawnHook([join(PLUGIN, 'hooks', 'adlc-rails-guard.cjs'), 'posttooluse'], {
    input: '{}',
    encoding: 'utf8',
    env: { ...process.env, ...SWITCH, ADLC_AGY_ADAPTER_OVERRIDE: stub },
  });
  assert.equal(res.status, 0, res.stderr);
  assert.notEqual(JSON.parse(res.stdout).decision, 'stub-adapter-loaded');
});

test('the .cjs shim resolves the adapter beside itself', (t) => {
  const dir = tmp(t, 'gemini-shim-sibling-');
  copyFileSync(join(PLUGIN, 'hooks', 'adlc-rails-guard.cjs'), join(dir, 'adlc-rails-guard.cjs'));
  writeFileSync(
    join(dir, 'adlc-rails-guard.mjs'),
    'export function postToolUse() { return { decision: "sibling-adapter", allow_tool: true }; }\n',
  );
  const res = spawnHook([join(dir, 'adlc-rails-guard.cjs'), 'posttooluse'], {
    input: '{}',
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(JSON.parse(res.stdout).decision, 'sibling-adapter');
});

test('no shipped gemini source reads ADLC_TEST_MODE', () => {
  const shipped = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return ['test', 'node_modules'].includes(entry.name) ? [] : shipped(full);
      return /\.(c|m)?js$/.test(entry.name) ? [full] : [];
    });
  const offenders = shipped(PLUGIN).filter((file) => readFileSync(file, 'utf8').includes('ADLC_TEST_MODE'));
  assert.deepEqual(offenders, []);
});
