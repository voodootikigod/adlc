// fleet-ext (issue-autopilot-local §14) — the operator-local extension flags.
//
// Every one of these decides what a run may SPEND (strikes, wall clock), what
// the worker may READ (bounded reads, mirror, egress) or what the orchestrator
// TRUSTS (pre-strike helper, worker-deps). A candidate tree must not be able to
// set any of them, so a repo-committed value is warned and ignored exactly like
// `fleet.adapter` / `fleet.model` (K1). AC2 of the fleet-extensions ticket.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveRunConfig, DEFAULTS, OPERATOR_LOCAL_EXTENSION_KEYS, validateExtensionFlags, parsePreStrike,
  MAX_STRIKES_MIN, MAX_STRIKES_MAX,
} from '../lib/config.mjs';
import { parseFlags, extensionFlags } from '../bin/fleet.mjs';

// The value each key resolves to when NOTHING operator-local is given — the
// "existing behaviour byte-identical" half of AC1.
const DEFAULT_VALUE = {
  noPr: false, noComplete: false, deadEndFile: null, maxStrikes: DEFAULTS.maxStrikes, wallClockMinutes: null,
  charterFile: null, preStrikeArgv: null, preStrikeEnv: null, modelPlaneRead: 'host', modelPlaneReadOnly: [],
  modelPlaneGit: 'shared', modelPlaneGitMirror: null, modelPlaneEgress: 'open', workerDeps: null,
};

test('every operator-local extension key in repo config is warned (SECURITY, naming the key) and ignored', () => {
  assert.deepEqual([...OPERATOR_LOCAL_EXTENSION_KEYS].sort(), Object.keys(DEFAULT_VALUE).sort(), 'the test table covers exactly the exported key list');
  for (const key of OPERATOR_LOCAL_EXTENSION_KEYS) {
    const repoValue = key === 'noPr' || key === 'noComplete' ? true : key === 'maxStrikes' || key === 'wallClockMinutes' ? 40 : ['/evil'];
    const c = resolveRunConfig({ [key]: repoValue }, {});
    assert.deepEqual(c[key], DEFAULT_VALUE[key], `${key}: repo value must be ignored`);
    const w = c.warnings.find((m) => m.includes(`fleet.${key}`));
    assert.ok(w, `${key}: a warning names the key`);
    assert.match(w, /^SECURITY:/, `${key}: the warning is a SECURITY warning`);
    assert.match(w, /operator-local/, `${key}: the warning says why`);
  }
});

test('with no flags every extension resolves to its documented default and no warning is emitted', () => {
  const c = resolveRunConfig({}, {});
  for (const [key, value] of Object.entries(DEFAULT_VALUE)) assert.deepEqual(c[key], value, key);
  assert.equal(c.reviewMaxBytes, DEFAULTS.reviewMaxBytes);
  assert.equal(DEFAULTS.maxStrikes, 2, 'the historical two-strike policy is the default');
  assert.equal(DEFAULTS.reviewMaxBytes, 262144, "adversarial-review's own inline-diff default");
  assert.deepEqual(c.warnings, []);
});

test('the operator-local flags ARE honoured from argv', () => {
  const c = resolveRunConfig({}, {
    noPr: true, noComplete: true, deadEndFile: '/d', maxStrikes: 7, wallClockMinutes: 15, charterFile: '/c',
    preStrikeArgv: ['/bin/x'], preStrikeEnv: { PATH: '/p' }, modelPlaneRead: 'bounded', modelPlaneReadOnly: ['/usr'],
    modelPlaneGit: 'mirror', modelPlaneGitMirror: '/m.git', modelPlaneEgress: 'allowlist', workerDeps: '/deps',
  });
  assert.equal(c.noPr, true); assert.equal(c.noComplete, true); assert.equal(c.deadEndFile, '/d');
  assert.equal(c.maxStrikes, 7); assert.equal(c.wallClockMinutes, 15); assert.equal(c.charterFile, '/c');
  assert.deepEqual(c.preStrikeArgv, ['/bin/x']); assert.deepEqual(c.preStrikeEnv, { PATH: '/p' });
  assert.equal(c.modelPlaneRead, 'bounded'); assert.deepEqual(c.modelPlaneReadOnly, ['/usr']);
  assert.equal(c.modelPlaneGit, 'mirror'); assert.equal(c.modelPlaneGitMirror, '/m.git');
  assert.equal(c.modelPlaneEgress, 'allowlist'); assert.equal(c.workerDeps, '/deps');
});

test('fleet.reviewMaxBytes IS a repo key: a positive integer is honoured, anything else warns and falls back', () => {
  assert.equal(resolveRunConfig({ reviewMaxBytes: 100000 }, {}).reviewMaxBytes, 100000);
  for (const bad of [0, -1, 1.5, '262144', null]) {
    const c = resolveRunConfig({ reviewMaxBytes: bad }, {});
    assert.equal(c.reviewMaxBytes, DEFAULTS.reviewMaxBytes, `reviewMaxBytes=${JSON.stringify(bad)} → default`);
    if (bad !== null) assert.ok(c.warnings.some((w) => /reviewMaxBytes/.test(w)), 'and says so');
  }
});

test('validateExtensionFlags bounds --max-strikes to 1..50 and rejects non-integers', () => {
  assert.equal(MAX_STRIKES_MIN, 1); assert.equal(MAX_STRIKES_MAX, 50);
  for (const ok of [1, 2, 15, 50]) assert.equal(validateExtensionFlags({ maxStrikes: ok }), true);
  for (const bad of [0, 51, -1, 2.5, Number.NaN]) assert.throws(() => validateExtensionFlags({ maxStrikes: bad }), /--max-strikes/);
  assert.throws(() => validateExtensionFlags({ wallClockMinutes: 0 }), /--wall-clock-minutes/);
  assert.throws(() => validateExtensionFlags({ wallClockMinutes: Number.NaN }), /--wall-clock-minutes/);
  assert.equal(validateExtensionFlags({ wallClockMinutes: 90 }), true);
});

test('validateExtensionFlags: modes are closed sets, mirror needs bounded reads + an absolute mirror, paths are absolute', () => {
  assert.throws(() => validateExtensionFlags({ modelPlaneRead: 'open' }), /--model-plane-read/);
  assert.throws(() => validateExtensionFlags({ modelPlaneGit: 'clone' }), /--model-plane-git/);
  assert.throws(() => validateExtensionFlags({ modelPlaneEgress: 'deny' }), /--model-plane-egress/);
  assert.throws(() => validateExtensionFlags({ modelPlaneGit: 'mirror', modelPlaneRead: 'host', modelPlaneGitMirror: '/m.git' }), /requires --model-plane-read bounded/);
  assert.throws(() => validateExtensionFlags({ modelPlaneGit: 'mirror', modelPlaneRead: 'bounded' }), /--model-plane-git-mirror/);
  assert.throws(() => validateExtensionFlags({ modelPlaneGit: 'mirror', modelPlaneRead: 'bounded', modelPlaneGitMirror: 'rel.git' }), /absolute/);
  assert.throws(() => validateExtensionFlags({ modelPlaneGitMirror: '/m.git' }), /only meaningful/);
  assert.throws(() => validateExtensionFlags({ modelPlaneReadOnly: ['/usr', 'lib'] }), /absolute/);
  assert.throws(() => validateExtensionFlags({ workerDeps: 'node_modules' }), /--worker-deps/);
  assert.equal(validateExtensionFlags({ modelPlaneGit: 'mirror', modelPlaneRead: 'bounded', modelPlaneGitMirror: '/m.git', modelPlaneReadOnly: ['/usr'], workerDeps: '/w' }), true);
});

test('parsePreStrike: argv is a JSON array of strings with an ABSOLUTE argv[0]; env is a string map; the pair is required together', () => {
  assert.deepEqual(parsePreStrike({}), { argv: null, env: null });
  assert.throws(() => parsePreStrike({ argvJson: '["/bin/x"]' }), /together/);
  assert.throws(() => parsePreStrike({ argvJson: 'nope', envJson: '{}' }), /not valid JSON/);
  assert.throws(() => parsePreStrike({ argvJson: '{"a":1}', envJson: '{}' }), /array of strings/);
  assert.throws(() => parsePreStrike({ argvJson: '[]', envJson: '{}' }), /array of strings/);
  assert.throws(() => parsePreStrike({ argvJson: '["adlc","quota"]', envJson: '{}' }), /absolute/);
  assert.throws(() => parsePreStrike({ argvJson: '["/bin/x", 1]', envJson: '{}' }), /array of strings/);
  assert.throws(() => parsePreStrike({ argvJson: '["/bin/x"]', envJson: '[]' }), /JSON object/);
  assert.throws(() => parsePreStrike({ argvJson: '["/bin/x"]', envJson: '{"PATH": 1}' }), /JSON object/);
  // The helper must never hold the ledger signing key — even if the operator asks.
  assert.throws(() => parsePreStrike({ argvJson: '["/bin/x"]', envJson: '{"ADLC_MANIFEST_KEY":"k"}' }), /ADLC_MANIFEST_KEY/);
  // A metacharacter-laden element stays ONE element: nothing is ever re-split.
  const r = parsePreStrike({ argvJson: JSON.stringify(['/bin/x', '--model', 'opus;touch /tmp/x']), envJson: '{"PATH":"/p","HOME":"/h"}' });
  assert.deepEqual(r.argv, ['/bin/x', '--model', 'opus;touch /tmp/x']);
  assert.deepEqual(r.env, { PATH: '/p', HOME: '/h' });
});

test('the CLI parses every extension flag and validates it before any run (extensionFlags)', () => {
  const flags = parseFlags([
    '--no-pr', '--no-complete', '--dead-end-file', '/d', '--max-strikes', '14', '--wall-clock-minutes', '75',
    '--charter-file', '/c', '--pre-strike-argv', '["/bin/x","a"]', '--pre-strike-env', '{"PATH":"/p"}',
    '--model-plane-read', 'bounded', '--model-plane-read-only', '/usr,/lib', '--model-plane-git', 'mirror',
    '--model-plane-git-mirror', '/m.git', '--model-plane-egress', 'allowlist', '--worker-deps', '/w',
  ]);
  const ext = extensionFlags(flags);
  assert.equal(ext.maxStrikes, 14); assert.equal(ext.wallClockMinutes, 75);
  assert.deepEqual(ext.modelPlaneReadOnly, ['/usr', '/lib']);
  assert.deepEqual(ext.preStrikeArgv, ['/bin/x', 'a']); assert.deepEqual(ext.preStrikeEnv, { PATH: '/p' });
  assert.equal(ext.noPr, true); assert.equal(ext.noComplete, true);
  // Non-numeric strings are rejected, not coerced to 0 or NaN-accepted.
  assert.throws(() => extensionFlags(parseFlags(['--max-strikes', 'ten'])), /--max-strikes/);
  assert.throws(() => extensionFlags(parseFlags(['--max-strikes', '0'])), /--max-strikes/);
  // Omitting everything yields no overrides at all (existing behaviour intact).
  const none = extensionFlags(parseFlags([]));
  for (const [k, v] of Object.entries(none)) if (k !== 'noPr' && k !== 'noComplete') assert.equal(v, undefined, `${k} is undefined when absent`);
  assert.equal(none.noPr, false); assert.equal(none.noComplete, false);
});

test('there is NO --resume flag: resumption is the status reconciliation on an identical re-invocation (item 7)', () => {
  assert.throws(() => parseFlags(['--resume']), /resume/i);
  assert.throws(() => parseFlags(['--resume', 'run-1']), /resume/i);
});

test('--model-plane-egress allowlist without --model-plane-read bounded is REFUSED: the proxy only exists inside the bounded plane, so the host policy would report allowlist while enforcing nothing (codex r3)', () => {
  assert.throws(() => extensionFlags(parseFlags(['--model-plane-egress', 'allowlist'])), /allowlist requires --model-plane-read bounded/);
  assert.throws(() => extensionFlags(parseFlags(['--model-plane-egress', 'allowlist', '--model-plane-read', 'host'])), /allowlist requires --model-plane-read bounded/);
  const ok = extensionFlags(parseFlags(['--model-plane-egress', 'allowlist', '--model-plane-read', 'bounded', '--model-plane-read-only', '/usr', '--model-plane-git', 'mirror', '--model-plane-git-mirror', '/m/mirror.git']));
  assert.equal(ok.modelPlaneEgress, 'allowlist');
  assert.equal(extensionFlags(parseFlags(['--model-plane-egress', 'open'])).modelPlaneEgress, 'open', 'open egress needs no bounded plane');
});

import { resolveRunConfig as resolveFleetConfig, DEFAULTS as FLEET_DEFAULTS } from '../lib/config.mjs';
test('fleet.reviewMaxBytes only NARROWS: a repository value above the 262144 default is refused with a warning and the default applies (codex r6)', () => {
  const big = resolveFleetConfig({ reviewMaxBytes: 10 * 1024 * 1024 });
  assert.equal(big.reviewMaxBytes, FLEET_DEFAULTS.reviewMaxBytes);
  assert.ok(big.warnings.some((w) => /exceeds the maximum/.test(w)));
  assert.equal(resolveFleetConfig({ reviewMaxBytes: 1024 }).reviewMaxBytes, 1024, 'a smaller value narrows');
});


test('--model-plane-read bounded requires --model-plane-git mirror: a shared-git worktree cannot reach its common .git inside the plane (codex r12)', () => {
  assert.throws(() => extensionFlags(parseFlags(['--model-plane-read', 'bounded', '--model-plane-read-only', '/usr'])), /bounded requires --model-plane-git mirror/);
  assert.equal(extensionFlags(parseFlags(['--model-plane-read', 'bounded', '--model-plane-read-only', '/usr', '--model-plane-git', 'mirror', '--model-plane-git-mirror', '/m/mirror.git'])).modelPlaneRead, 'bounded');
});

test('readBoundedFile reads through ONE descriptor: a FIFO is refused without blocking, a symlink is refused, an oversized file is refused, a file that grows past the bound while read is refused', async () => {
  const { readBoundedFile, MAX_EXTENSION_FILE_BYTES } = await import('../bin/fleet.mjs');
  const { mkdtempSync, writeFileSync, symlinkSync, rmSync } = await import('node:fs');
  const { execFileSync } = await import('node:child_process');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'fleet-bounded-'));
  try {
    const ok = join(dir, 'ok.md'); writeFileSync(ok, 'hello\n');
    assert.equal(readBoundedFile(ok), 'hello\n');
    const fifo = join(dir, 'pipe'); execFileSync('mkfifo', [fifo]);
    assert.throws(() => readBoundedFile(fifo), /not a regular file/, 'a FIFO is refused (the open never blocks)');
    const link = join(dir, 'link.md'); symlinkSync(ok, link);
    assert.throws(() => readBoundedFile(link), /ELOOP|symbolic/i, 'a symlink is not followed');
    const big = join(dir, 'big.md'); writeFileSync(big, 'x'.repeat(2049));
    assert.throws(() => readBoundedFile(big, 2048), /exceeds 2048/);
    // Growth during the read: fstat says 10 bytes, the reads return more.
    let calls = 0;
    const fakeRead = (fd, buf, off, len) => { calls++; if (calls > 3) return 0; buf.fill(0x61, off, off + Math.min(len, 8)); return Math.min(len, 8); };
    assert.throws(() => readBoundedFile(ok, 10, { readSync: fakeRead }), /grew while it was read/);
    assert.ok(MAX_EXTENSION_FILE_BYTES >= 1024 * 1024);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
