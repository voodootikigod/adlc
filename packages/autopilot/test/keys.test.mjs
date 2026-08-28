// AC 12 / 160 (allowlist half) — key hygiene: the seven key-bearing commands
// are the ONE authority (the test table is built from the same export), a
// key-bearing spawn's argv[0] is the pinned adlc, and no other spawn carries the
// key. The full-sequence half (every spawn of a `once` run classified) lives in
// sequence.test.mjs once the orchestrator is assembled.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KEY_BEARING_ARGV, isKeyBearing, spawnIsKeyBearing, classifySpawn, childEnv, keyBearingValues, MANIFEST_KEY_VAR } from '../lib/keys.mjs';
import { withMutation } from '../lib/mutations.mjs';

const pinned = { adlc: '/opt/adlc', node: '/opt/node', specLintBin: '/repo/packages/spec-lint/bin/spec-lint.mjs', gh: '/usr/bin/gh', git: '/usr/bin/git', claude: '/home/op/.local/bin/claude' };

export function ac12_sevenKeyBearingCommandsAreTheAuthority() {
  assert.equal(KEY_BEARING_ARGV.length, 7, 'seven entries today');
  const table = KEY_BEARING_ARGV.map((entry) => entry.join(' '));
  assert.deepEqual(table, ['ticket create --write', 'ticket complete --write', 'ticket update --write', 'coldstart --record-verdict', 'spec-lint --record', 'prosecute record-cross-model', 'gate-manifest verify']);
  // Built from the export: each entry, with realistic surrounding argv, is key-bearing…
  const real = {
    'ticket create --write': ['ticket', 'create', '--input', '-', '--write', '--dir', '/wt/.adlc'],
    'ticket complete --write': ['ticket', 'complete', 'T-01M0Z3FN7SAS4HAH7CS63YQ0DH', '--dir', '/wt/.adlc', '--write'],
    'ticket update --write': ['ticket', 'update', 'T-01M0Z3FN7SAS4HAH7CS63YQ0DH', '--input', '-', '--expect', 'h', '--authorize', '--write', '--dir', '/wt/.adlc'],
    'coldstart --record-verdict': ['coldstart', 'T-01M0Z3FN7SAS4HAH7CS63YQ0DH', '--tickets', '/wt/.adlc/tickets', '--prompt-only', '--record-verdict', '-'],
    'spec-lint --record': ['spec-lint', '/wt/.adlc/specs/x-ac.md', '--record', '--ticket', 'T-01M0Z3FN7SAS4HAH7CS63YQ0DH', '--dir', '/wt/.adlc'],
    'prosecute record-cross-model': ['prosecute', 'record-cross-model', '--ticket', 'T-x', '--provider', 'codex', '--author-provider', 'anthropic', '--verdict', 'approve', '--base', 'a'.repeat(40), '--dir', '/wt/.adlc'],
    'gate-manifest verify': ['gate-manifest', 'verify', '--dir', '/wt/.adlc', '--allow-legacy-unsigned'],
  };
  for (const key of table) assert.equal(isKeyBearing(real[key]), true, key);
  // …and the non-bearing neighbours are not.
  for (const argv of [['ticket', 'create', '--input', '-', '--json'], ['ticket', 'show', 'T-x', '--json'], ['coldstart', 'T-x', '--tickets', 'p', '--prompt-only'], ['spec-lint', 'f.md'], ['gate-manifest', 'show', '--ticket', 'T-x'], ['prosecute', 'tier-check'], ['fleet', 'run', '--tickets', 'T-x'], []]) {
    assert.equal(isKeyBearing(argv), false, argv.join(' '));
  }
}
test('AC12: KEY_BEARING_ARGV lists exactly the seven §9.3 commands and the classifier matches them with real surrounding argv', ac12_sevenKeyBearingCommandsAreTheAuthority);

export async function ac12_onlyThePinnedAdlcCarriesTheKey() {
  assert.equal(spawnIsKeyBearing([pinned.adlc, 'ticket', 'create', '--input', '-', '--write'], pinned), true);
  assert.equal(spawnIsKeyBearing([pinned.node, pinned.specLintBin, '/f.md', '--record', '--ticket', 'T-x', '--dir', '/d'], pinned), true, 'the in-repo spec-lint bin under the pinned node');
  assert.equal(spawnIsKeyBearing(['/usr/local/bin/adlc', 'ticket', 'create', '--write'], pinned), false, 'an adlc that is NOT the pinned one never gets the key');
  assert.equal(spawnIsKeyBearing([pinned.gh, 'ticket', 'create', '--write'], pinned), false);
  assert.equal(spawnIsKeyBearing([pinned.claude, '-p'], pinned), false);
  assert.deepEqual(classifySpawn([pinned.gh, 'pr', 'view'], pinned), { tool: 'gh', toolArgv: ['pr', 'view'] });
  assert.equal(classifySpawn(['/x/unknown'], pinned).tool, 'unknown');
  const base = { PATH: '/usr/bin', HOME: '/h' };
  assert.deepEqual(childEnv(base, { key: 'k', keyBearing: true }), { ...base, [MANIFEST_KEY_VAR]: 'k' });
  assert.deepEqual(childEnv({ ...base, [MANIFEST_KEY_VAR]: 'leaked' }), base, 'a non-bearing spawn never inherits the key, even from a polluted base');
  assert.deepEqual(childEnv(base, { key: 'k', keyBearing: false }), base, 'a non-bearing spawn is never HANDED the key either');
  assert.throws(() => childEnv(base, { keyBearing: true }), /without ADLC_MANIFEST_KEY/);
  await withMutation('keys.leakKey', () => { assert.equal(childEnv(base, { key: 'k' })[MANIFEST_KEY_VAR], 'k', 'seam: every child gets the key'); });
  assert.deepEqual(keyBearingValues({ ADLC_MANIFEST_KEY: 'k'.repeat(16), GH_TOKEN: 'ghp_' + 'x'.repeat(36), FOO_SECRET: 's'.repeat(10), PATH: '/usr/bin', SHORT_KEY: 'abc' }, ['tok-1234567890']).sort(), ['ghp_' + 'x'.repeat(36), 'k'.repeat(16), 's'.repeat(10), 'tok-1234567890'].sort());
}
test('AC12: a key-bearing spawn is the PINNED adlc with a listed argv; childEnv adds the key only then and strips it otherwise', ac12_onlyThePinnedAdlcCarriesTheKey);
