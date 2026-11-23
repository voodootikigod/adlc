import { test } from './helpers/node-test.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, symlinkSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmp } from '@adlc/core/test-kit';
import { pinToolchain, globalNodeModuleTree, ToolError } from '../lib/tools.mjs';
import { readSet, buildFleetArgv, MAX_DISPATCH_STRIKES } from '../lib/fleet-args.mjs';
import { checkReadSetInvariant } from '@adlc/fleet/lib/bounded-model-plane.mjs';
import { NODE_TOOL_TREE_RE } from '@adlc/fleet/lib/extensions.mjs';

const uid = process.getuid();

test('R1/C6: pinToolchain allows trusted global <prefix>/lib/node_modules/<pkg> symlinks and rejects project node_modules', (t) => {
  const root = tmp(t, 'ap-r1-');
  const repoRoot = join(root, 'repo');
  const prefix = join(root, 'opt', 'node');
  const binDir = join(prefix, 'bin');
  const adlcBin = join(prefix, 'lib', 'node_modules', '@adlc', 'cli', 'bin');
  const npmBin = join(prefix, 'lib', 'node_modules', 'npm', 'bin');
  const projectPkg = join(root, 'other-project', 'node_modules', 'evil', 'bin');

  mkdirSync(repoRoot, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  mkdirSync(adlcBin, { recursive: true });
  mkdirSync(npmBin, { recursive: true });
  mkdirSync(projectPkg, { recursive: true });

  writeFileSync(join(adlcBin, 'adlc.mjs'), '#!/usr/bin/env node\n');
  chmodSync(join(adlcBin, 'adlc.mjs'), 0o755);
  symlinkSync(join(adlcBin, 'adlc.mjs'), join(binDir, 'adlc'));

  writeFileSync(join(npmBin, 'npm-cli.js'), '#!/usr/bin/env node\n');
  chmodSync(join(npmBin, 'npm-cli.js'), 0o755);
  symlinkSync(join(npmBin, 'npm-cli.js'), join(binDir, 'npm'));

  writeFileSync(join(binDir, 'node'), '#!/bin/sh\n');
  chmodSync(join(binDir, 'node'), 0o755);

  writeFileSync(join(projectPkg, 'evil.js'), '#!/usr/bin/env node\n');
  chmodSync(join(projectPkg, 'evil.js'), 0o755);
  symlinkSync(join(projectPkg, 'evil.js'), join(binDir, 'evil'));

  const stat = () => ({ uid, mode: 0o755 });
  const { pinned } = pinToolchain({
    pathValue: binDir,
    repoRoot,
    uid,
    stat,
    required: ['adlc', 'npm', 'node'],
  });

  assert.equal(pinned.adlc, join(adlcBin, 'adlc.mjs'));
  assert.equal(pinned.npm, join(npmBin, 'npm-cli.js'));
  assert.equal(globalNodeModuleTree(pinned.adlc), join(prefix, 'lib', 'node_modules', '@adlc', 'cli'));
  assert.equal(globalNodeModuleTree(pinned.npm), join(prefix, 'lib', 'node_modules', 'npm'));
  assert.equal(globalNodeModuleTree(join(projectPkg, 'evil.js')), null);

  // Project node_modules (not under /lib/node_modules/) must be rejected
  assert.throws(
    () => pinToolchain({ pathValue: binDir, repoRoot, uid, stat, required: ['evil'] }),
    (e) => e instanceof ToolError && e.code === 'untrusted-tool:evil',
  );

  // Global node_modules inside repoRoot must still be rejected
  const repoFakeGlobal = join(repoRoot, 'lib', 'node_modules', 'fake', 'bin');
  mkdirSync(repoFakeGlobal, { recursive: true });
  writeFileSync(join(repoFakeGlobal, 'fake.js'), '#!/usr/bin/env node\n');
  symlinkSync(join(repoFakeGlobal, 'fake.js'), join(binDir, 'fake'));
  assert.throws(
    () => pinToolchain({ pathValue: binDir, repoRoot, uid, stat, required: ['fake'] }),
    (e) => e instanceof ToolError && e.code === 'untrusted-tool:fake',
  );

  // readSet binds package trees, NEVER <prefix>/bin, and passes checkReadSetInvariant
  const ro = readSet({ ctx: { pinned, repoRoot } });
  assert.ok(ro.includes(join(prefix, 'lib', 'node_modules', '@adlc', 'cli')));
  assert.ok(ro.includes(join(prefix, 'lib', 'node_modules', 'npm')));
  assert.ok(!ro.includes(binDir), 'must never bind <prefix>/bin directory');
  // Validate invariant with realistic non-/tmp installation prefix
  const optRo = readSet({
    ctx: {
      pinned: {
        adlc: '/opt/node/lib/node_modules/@adlc/cli/bin/adlc.mjs',
        'adlc:realpath': '/opt/node/lib/node_modules/@adlc/cli/bin/adlc.mjs',
        node: '/opt/node/bin/node',
        'node:realpath': '/opt/node/bin/node',
      },
      repoRoot: '/srv/repo',
    },
  });
  const allowedDirs = optRo.filter((p) => NODE_TOOL_TREE_RE.test(p));
  const inv = checkReadSetInvariant({
    readOnlyPaths: optRo,
    writableRoots: ['/srv/repo'],
    home: '/home/op',
    allowedDirs,
    isFile: (p) => p.endsWith('.mjs') || p.endsWith('/node'),
  });
  assert.equal(inv.ok, true, inv.violations.join('; '));
});

test('P4: buildFleetArgv caps single-dispatch --max-strikes to MAX_DISPATCH_STRIKES (3)', () => {
  const ctx = {
    pinned: { adlc: '/usr/local/bin/adlc', 'node:realpath': '/usr/local/bin/node' },
    local: { adapter: 'claude-code', model: 'opus', quotaThreshold: 80, quotaReserve: 10 },
    env: { path: '/usr/local/bin', home: '/home/op' },
    paths: { statusFile: '/repo/.adlc/autopilot-status.json' },
    lock: { token: 'tok' },
    iterationId: 'iter-1',
    charterPath: '/repo/.adlc/charter.md',
    repoRoot: '/repo',
  };
  const capped = buildFleetArgv({
    ctx,
    issue: 42,
    ticketId: 'T-01K00000000000000000000001',
    budget: { strikes: 15, wallClockMinutes: 90 },
    mirror: '/mirror',
    workerDeps: '/deps',
  });
  assert.equal(capped[capped.indexOf('--max-strikes') + 1], String(MAX_DISPATCH_STRIKES));

  const small = buildFleetArgv({
    ctx,
    issue: 42,
    ticketId: 'T-01K00000000000000000000001',
    budget: { strikes: 2, wallClockMinutes: 15 },
    mirror: '/mirror',
    workerDeps: '/deps',
  });
  assert.equal(small[small.indexOf('--max-strikes') + 1], '2');
});
