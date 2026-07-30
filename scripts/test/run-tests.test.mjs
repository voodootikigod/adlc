// run-tests.test.mjs — the test runner must scrub ambient trust-root env
// (T-01KYQMPBEKCDCZ60FZKDC1WNF7, spec .adlc/specs/manifest-key-hermeticity.md Layer 1).
//
// Why: an exported ADLC_MANIFEST_KEY flips key-present/key-absent branches deep in
// library code (measured 2026-07-29: gate-manifest + tickets segments 0/2 with the key
// exported, 2/2 without), and an exported RAILS_BASE retargets rails-guard tests at
// branches the scratch repos don't contain (75/80 bootstrap tests failed). The failure
// names a package, not a variable — so the runner deletes non-empty values of the
// sensitive set from every segment's env and says so once.
//
// Presence-vs-emptiness is load-bearing: an explicitly-empty ADLC_MANIFEST_KEY='' is a
// deliberate fail-closed that beats the .env.local file loader
// (packages/prosecute/lib/load-env-local.mjs rule 2). DELETING it would convert
// "never fall back to a file key" into absence and re-enable file fallback in spawned
// bins — so '' is PRESERVED, and only non-empty values are deleted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join, dirname, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSegmentEnv, SCRUBBED_ENV_VARS } from '../run-tests.mjs';

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

test('the sensitive set is exactly the six ambient trust-root/override variables', () => {
  assert.deepEqual([...SCRUBBED_ENV_VARS].sort(), ['ADLC_BUILD_GATE_BYPASS', 'ADLC_GATE_MOCK_RESPONSE', 'ADLC_MANIFEST_KEY', 'ADLC_RAILS_BYPASS', 'BASE_REF', 'RAILS_BASE']);
});

test('non-empty sensitive values are ABSENT from the segment env and reported', () => {
  const { env, scrubbed } = buildSegmentEnv({
    HOME: '/h',
    ADLC_MANIFEST_KEY: 'leaked-key',
    RAILS_BASE: 'chore/somewhere',
    BASE_REF: 'main',
  });
  for (const name of SCRUBBED_ENV_VARS) {
    assert.equal(Object.hasOwn(env, name), false, `${name} must be deleted, not emptied`);
  }
  assert.deepEqual([...scrubbed].sort(), ['ADLC_MANIFEST_KEY', 'BASE_REF', 'RAILS_BASE']);
  assert.equal(env.HOME, '/h', 'unrelated vars pass through');
});

test("an explicitly-empty KEY is PRESERVED; empty OTHER variables are scrubbed", () => {
  // '' preservation is a key-specific contract (presence blocks the .env.local
  // loader). The rest have presence-checked consumers — ADLC_GATE_MOCK_RESPONSE=''
  // could still select a mock path — so present-but-empty is scrubbed for them.
  const { env, scrubbed } = buildSegmentEnv({ ADLC_MANIFEST_KEY: '', RAILS_BASE: '', ADLC_GATE_MOCK_RESPONSE: '' });
  assert.equal(env.ADLC_MANIFEST_KEY, '', "'' key must survive: it blocks .env.local fallback by PRESENCE");
  assert.equal(Object.hasOwn(env, 'RAILS_BASE'), false);
  assert.equal(Object.hasOwn(env, 'ADLC_GATE_MOCK_RESPONSE'), false, "an empty mock seam must not reach segments");
  assert.deepEqual([...scrubbed].sort(), ['ADLC_GATE_MOCK_RESPONSE', 'RAILS_BASE']);
});

test('unset variables stay absent and produce no notice', () => {
  const { env, scrubbed } = buildSegmentEnv({ HOME: '/h' });
  for (const name of SCRUBBED_ENV_VARS) assert.equal(Object.hasOwn(env, name), false);
  assert.deepEqual(scrubbed, []);
});

test('mixed input: a set key is scrubbed while an EMPTY key is the only preserved form', () => {
  const { env, scrubbed } = buildSegmentEnv({ ADLC_MANIFEST_KEY: 'k', RAILS_BASE: '' });
  assert.equal(Object.hasOwn(env, 'ADLC_MANIFEST_KEY'), false);
  assert.equal(Object.hasOwn(env, 'RAILS_BASE'), false, 'empty non-key variables are scrubbed too');
  assert.deepEqual([...scrubbed].sort(), ['ADLC_MANIFEST_KEY', 'RAILS_BASE']);
});

test('the runner PATH prepend is preserved by the helper', () => {
  const { env } = buildSegmentEnv({ PATH: '/usr/bin' });
  assert.ok(env.PATH.startsWith(join(REPO_ROOT, 'node_modules', '.bin') + delimiter),
    'node_modules/.bin must stay first on PATH (mutation-gate baseline runs the runner directly)');
});

// Behavioral, process-boundary: the notice appears exactly once when a non-empty key is
// exported, and never when the environment is clean. Uses the cheapest real segment.
// The assertion greps for the variable name plus the word "scrub" rather than pinning
// the full sentence — the notice is prose, and prose must stay reword-able.
function runRunner(extraEnv) {
  const env = { ...process.env, ...extraEnv };
  // Start from a clean slate for EVERY scrubbed variable — this test file itself may
  // be running under a deliberately leaked env (that is T1's whole premise). Case-fold
  // on win32 for the same reason buildSegmentEnv does: an ambient mixed-case spelling
  // would survive a canonical-only delete there and trip the no-notice assertion.
  const fold = process.platform === 'win32';
  for (const name of SCRUBBED_ENV_VARS) {
    for (const k of Object.keys(env)) {
      if (k === name || (fold && k.toUpperCase() === name)) delete env[k];
    }
  }
  Object.assign(env, extraEnv);
  return execFileSync(process.execPath, ['scripts/run-tests.mjs', 'generated-reader'], {
    cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env,
  });
}

test('spawned runner prints the scrub notice exactly once with a leaked key', () => {
  const out = runRunner({ ADLC_MANIFEST_KEY: 'leak-test' });
  const notices = out.split('\n').filter((l) => /ADLC_MANIFEST_KEY/.test(l) && /scrub/i.test(l));
  assert.equal(notices.length, 1, `expected exactly one notice line, got:\n${out}`);
});

test('spawned runner prints no notice when the environment is clean', () => {
  const out = runRunner({});
  assert.ok(!/scrub/i.test(out), `expected no scrub notice, got:\n${out}`);
});

test('an unknown segment filter is an OPERATIONAL error: exit 1, never the gate-fail code 2', () => {
  // Exit codes are load-bearing across ADLC: 1 = operational error, 2 = a gate
  // failed. A runner that exits 2 for a typo'd segment name would read as a real
  // test failure to any caller that distinguishes the two.
  let status = 0, stderr = '';
  try {
    execFileSync(process.execPath, ['scripts/run-tests.mjs', 'no-such-segment-xyz'], {
      cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) { status = err.status; stderr = String(err.stderr); }
  assert.equal(status, 1);
  assert.match(stderr, /no test segment matches/);
});

test('win32: differently-cased spellings are scrubbed too (env names are case-insensitive there)', () => {
  const { env, scrubbed } = buildSegmentEnv(
    { adlc_manifest_key: 'k', Rails_Base: 'b', BASE_REF: 'main', HOME: '/h' },
    { platform: 'win32' },
  );
  assert.equal(Object.hasOwn(env, 'adlc_manifest_key'), false);
  assert.equal(Object.hasOwn(env, 'Rails_Base'), false);
  assert.equal(Object.hasOwn(env, 'BASE_REF'), false);
  assert.deepEqual([...scrubbed].sort(), ['ADLC_MANIFEST_KEY', 'BASE_REF', 'RAILS_BASE'], 'reported names are canonical');
  assert.equal(env.HOME, '/h');
});

test('posix: a differently-cased spelling is a DIFFERENT variable and is preserved', () => {
  const { env, scrubbed } = buildSegmentEnv(
    { adlc_manifest_key: 'unrelated', ADLC_MANIFEST_KEY: 'k' },
    { platform: 'linux' },
  );
  assert.equal(env.adlc_manifest_key, 'unrelated', 'lowercase variant is untouched on POSIX');
  assert.equal(Object.hasOwn(env, 'ADLC_MANIFEST_KEY'), false);
  assert.deepEqual(scrubbed, ['ADLC_MANIFEST_KEY']);
});

test("win32: an explicitly-empty canonical value still blocks scrubbing of ITSELF but a non-empty variant is removed", () => {
  const { env, scrubbed } = buildSegmentEnv(
    { ADLC_MANIFEST_KEY: '', adlc_manifest_key: 'k' },
    { platform: 'win32' },
  );
  assert.equal(env.ADLC_MANIFEST_KEY, '', "explicit '' preserved");
  assert.equal(Object.hasOwn(env, 'adlc_manifest_key'), false, 'the non-empty variant is scrubbed');
  assert.deepEqual(scrubbed, ['ADLC_MANIFEST_KEY']);
});

test('gate-bypass and mock-seam variables are scrubbed like the key', () => {
  const { env, scrubbed } = buildSegmentEnv({
    ADLC_RAILS_BYPASS: '1',
    ADLC_BUILD_GATE_BYPASS: '1',
    ADLC_GATE_MOCK_RESPONSE: '{"verdict":"pass"}',
  });
  for (const name of ['ADLC_RAILS_BYPASS', 'ADLC_BUILD_GATE_BYPASS', 'ADLC_GATE_MOCK_RESPONSE']) {
    assert.equal(Object.hasOwn(env, name), false, `${name} must not reach test segments ambiently`);
  }
  assert.equal(scrubbed.length, 3);
});
