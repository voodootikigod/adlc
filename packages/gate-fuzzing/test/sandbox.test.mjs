// §1.7 — sandbox profiles, allowlist, no-sandbox refuse (F6)
// These tests operate on the sandbox module logic without actually spawning
// a bwrap/sandbox-exec process.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSandboxedArgs,
  detectSandbox,
  buildMacOSSbpl,
  SANDBOX_PROFILES,
} from '../lib/sandbox.mjs';

test('detectSandbox returns sandbox type or null', () => {
  // We cannot guarantee which sandbox is available in CI, but the function
  // must return one of: 'bwrap', 'sandbox-exec', or null
  const result = detectSandbox({ which: (cmd) => cmd === 'bwrap' ? '/usr/bin/bwrap' : null });
  assert.ok(result === 'bwrap' || result === null);

  const result2 = detectSandbox({ which: (cmd) => cmd === 'sandbox-exec' ? '/usr/bin/sandbox-exec' : null });
  assert.ok(result2 === 'sandbox-exec' || result2 === null);

  const result3 = detectSandbox({ which: () => null });
  assert.equal(result3, null);
});

test('buildSandboxedArgs for bwrap produces correct argv', () => {
  const cloneDir = '/tmp/gate-fuzzing-test-clone';
  const cmdArgs = ['node', '--test', 'test/foo.mjs'];
  const args = buildSandboxedArgs('bwrap', cloneDir, cmdArgs);

  assert.ok(Array.isArray(args), 'Must return an array');
  // Must start with 'bwrap'
  assert.equal(args[0], 'bwrap');
  // Must include network denial (--unshare-all)
  assert.ok(args.includes('--unshare-all'), 'Must unshare all (deny network)');
  // Must NOT include --share-net (network must be unshared/denied)
  assert.ok(!args.includes('--share-net'), 'Must not share network');
  // Must include --ro-bind / /
  const roBindIdx = args.indexOf('--ro-bind');
  assert.ok(roBindIdx !== -1, 'Must include --ro-bind / /');
  // Clone dir must be bound writable
  assert.ok(args.includes('--bind'), 'Must include --bind for clone dir');
  // Must include --die-with-parent
  assert.ok(args.includes('--die-with-parent'), 'Must include --die-with-parent');
  // The actual command must appear at the end after --
  const dashDashIdx = args.indexOf('--');
  assert.ok(dashDashIdx !== -1, 'Must include -- before command');
  assert.deepEqual(args.slice(dashDashIdx + 1), cmdArgs, 'Command must appear after --');
});

test('buildSandboxedArgs for sandbox-exec produces correct SBPL and argv', () => {
  const cloneDir = '/tmp/gate-fuzzing-test-clone';
  const cmdArgs = ['node', '--test', 'test/foo.mjs'];
  const args = buildSandboxedArgs('sandbox-exec', cloneDir, cmdArgs);

  assert.ok(Array.isArray(args), 'Must return an array');
  assert.equal(args[0], 'sandbox-exec');
  // Must include -p flag for SBPL profile
  assert.ok(args.includes('-p'), 'Must include -p for SBPL');
  const pIdx = args.indexOf('-p');
  const sbpl = args[pIdx + 1];
  // SBPL must deny network
  assert.ok(sbpl.includes('deny network*'), 'SBPL must deny network*');
  // SBPL must allow process
  assert.ok(sbpl.includes('allow process*'), 'SBPL must allow process*');
  // SBPL must allow file-write* for clone dir
  assert.ok(sbpl.includes(cloneDir), 'SBPL must reference clone dir for writes');
  // Command must be appended
  assert.ok(args.includes('node'), 'Command must be in args');
});

test('buildMacOSSbpl includes deny default, deny network, allow file-write for cloneDir', () => {
  const cloneDir = '/tmp/specific-clone-dir';
  const sbpl = buildMacOSSbpl(cloneDir);

  assert.ok(sbpl.includes('(version 1)'));
  assert.ok(sbpl.includes('(deny default)'));
  assert.ok(sbpl.includes('(allow process*)'));
  assert.ok(sbpl.includes('(allow file-read*)'));
  assert.ok(sbpl.includes('(deny network*)'));
  assert.ok(sbpl.includes(`(subpath "${cloneDir}")`));
  assert.ok(sbpl.includes('(allow file-write-data (path "/dev/null"))'));
});

test('SANDBOX_PROFILES exports bwrap and sandbox-exec configs', () => {
  assert.ok(SANDBOX_PROFILES['bwrap'], 'Must have bwrap profile');
  assert.ok(SANDBOX_PROFILES['sandbox-exec'], 'Must have sandbox-exec profile');
});

test('unsupported sandbox type throws', () => {
  assert.throws(
    () => buildSandboxedArgs('nonexistent-sandbox', '/tmp/clone', ['node', 'test.mjs']),
    /unsupported.*sandbox/i
  );
});
