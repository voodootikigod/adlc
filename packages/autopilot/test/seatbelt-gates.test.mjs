import { test } from './helpers/node-test.mjs';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmp } from '@adlc/core/test-kit';
import { buildGateSeatbeltProfile, composeGateArgv, spawnInGateSandbox, GatesError } from '../lib/gates.mjs';
import { withMutation } from '../lib/mutations.mjs';

test('R2: composeGateArgv supports macOS Seatbelt without crashing on missing --chdir', () => {
  const inner = ['/usr/local/bin/node', 'scripts/run-tests.mjs'];
  const baseSbpl = '(version 1)\n(deny default)\n(allow process*)\n(deny network*)';
  const wrapped = ['sandbox-exec', '-p', baseSbpl, ...inner];
  const nodeModules = '/tmp/gate-deps/node_modules';

  const argv = composeGateArgv({
    wrapped,
    inner,
    bwrap: '/usr/bin/bwrap',
    sandboxExec: '/usr/bin/sandbox-exec',
    backend: { name: 'seatbelt', path: '/usr/bin/sandbox-exec' },
    clone: '/tmp/clone',
    nodeModules,
    bindDeps: true,
  });

  assert.equal(argv[0], '/usr/bin/sandbox-exec');
  assert.equal(argv[1], '-p');
  assert.match(argv[2], /\(allow file-read\* \(subpath "\/tmp\/gate-deps\/node_modules"\)\)/);
  assert.match(argv[2], /\(deny network\*\)/);
  assert.equal(argv[3], '--');
  assert.deepEqual(argv.slice(4), inner);

  // Seam gates.skipDepsBind omits the nodeModules allow rule
  withMutation('gates.skipDepsBind', () => {
    const noDeps = composeGateArgv({
      wrapped,
      inner,
      bwrap: '/usr/bin/bwrap',
      sandboxExec: '/usr/bin/sandbox-exec',
      backend: { name: 'seatbelt' },
      clone: '/tmp/clone',
      nodeModules,
      bindDeps: true,
    });
    assert.ok(!noDeps[2].includes(nodeModules));
  });

  // Malformed seatbelt argv throws GatesError('sandbox-unavailable')
  assert.throws(
    () => composeGateArgv({ wrapped: ['sandbox-exec', '--bad'], inner, backend: { name: 'seatbelt' } }),
    (e) => e instanceof GatesError && e.code === 'sandbox-unavailable',
  );
});

test('R2: spawnInGateSandbox dispatches Seatbelt backend cleanly, links clone/node_modules, and escapes SBPL paths', async (t) => {
  const root = tmp(t, 'ap-seatbelt-');
  const clone = join(root, 'clone');
  const home = join(root, 'home');
  const nodeModules = join(root, 'deps', 'node_modules');
  mkdirSync(clone, { recursive: true });
  mkdirSync(nodeModules, { recursive: true });
  let captured = null;
  let sawLinkDuringSpawn = false;
  const ctx = {
    pinned: {
      node: process.execPath,
      'node:realpath': process.execPath,
      bwrap: '/usr/bin/bwrap',
      'sandbox-exec': '/usr/bin/sandbox-exec',
    },
    env: { base: { PATH: '/usr/bin:/bin', HOME: '/Users/op' } },
    spawn: async (opts) => {
      captured = opts;
      sawLinkDuringSpawn = lstatSync(join(clone, 'node_modules')).isSymbolicLink();
      return { status: 0, stdout: 'ok', stderr: '', timedOut: false };
    },
  };
  const res = await spawnInGateSandbox({
    ctx,
    clone,
    inner: [process.execPath, '-e', 'process.exit(0)'],
    nodeModules,
    backend: { name: 'seatbelt', path: '/usr/bin/sandbox-exec' },
    home,
    label: 'gate:tests',
    bindDeps: true,
  });
  assert.equal(res.status, 0);
  assert.equal(sawLinkDuringSpawn, true, 'clone/node_modules symlink exists during Seatbelt spawn');
  assert.equal(existsSync(join(clone, 'node_modules')), false, 'clone/node_modules symlink cleaned up after spawn');
  assert.equal(captured.argv[0], '/usr/bin/sandbox-exec');
  assert.equal(captured.argv[1], '-p');
  assert.ok(captured.argv[2].includes(nodeModules));
  assert.equal(captured.cwd, clone);

  // SBPL injection defense: control characters rejected and quotes escaped
  assert.throws(
    () => buildGateSeatbeltProfile({ clone: '/tmp/bad\n(allow default)', home: '/tmp/h' }),
    (e) => e instanceof GatesError && e.code === 'sandbox-unavailable',
  );
  const escaped = buildGateSeatbeltProfile({ clone: '/tmp/a"b', home: '/tmp/h', nodeModules: '/tmp/nm' });
  assert.ok(escaped.includes('/tmp/a\\"b'), 'quotes in Seatbelt paths must be escaped');
});
