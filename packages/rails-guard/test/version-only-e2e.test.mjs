// #228 end-to-end: drive the real rails-guard binary over a real git repo.
//
// The unit tests prove the predicate; this proves the whole gate — git plumbing,
// the resolver, exit codes — behaves on the exact scenario from the issue:
// a live ticket rails packages/<x>/**, and a release bumps that package.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'rails-guard.mjs');

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'rg-228-'));
  const run = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  run('init', '-q', '-b', 'main');
  run('config', 'user.email', 'test@test.invalid');
  run('config', 'user.name', 'Test');
  run('config', 'commit.gpgsign', 'false');
  run('config', 'tag.gpgsign', 'false');
  mkdirSync(join(dir, 'packages', 'build-gate', 'lib'), { recursive: true });
  writeFileSync(
    join(dir, 'packages', 'build-gate', 'package.json'),
    JSON.stringify({ name: '@adlc/build-gate', version: '1.5.0', main: 'lib/tier.mjs',
      dependencies: { '@adlc/core': '^1.5.0' } }, null, 2) + '\n'
  );
  writeFileSync(join(dir, 'packages', 'build-gate', 'lib', 'tier.mjs'), 'export const tier = 1;\n');
  run('add', '-A');
  run('commit', '-q', '-m', 'base');
  const baseSha = run('rev-parse', 'HEAD').trim();
  return { dir, run, baseSha };
}

function guard(dir, baseSha, rails) {
  return spawnSync(process.execPath, [BIN, '--base', baseSha, '--rails', rails], {
    cwd: dir, encoding: 'utf8',
  });
}

const RAIL = 'packages/build-gate/**';

test('a lockstep version bump under a live rail PASSES (the #228 regression)', () => {
  const { dir, baseSha } = makeRepo();
  try {
    writeFileSync(
      join(dir, 'packages', 'build-gate', 'package.json'),
      JSON.stringify({ name: '@adlc/build-gate', version: '1.5.1', main: 'lib/tier.mjs',
        dependencies: { '@adlc/core': '^1.5.1' } }, null, 2) + '\n'
    );
    const res = guard(dir, baseSha, RAIL);
    assert.equal(res.status, 0, `expected pass, got ${res.status}: ${res.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a behaviour edit under the SAME rail still FAILS (the guard is not weakened)', () => {
  const { dir, baseSha } = makeRepo();
  try {
    writeFileSync(join(dir, 'packages', 'build-gate', 'lib', 'tier.mjs'), 'export const tier = 99;\n');
    const res = guard(dir, baseSha, RAIL);
    assert.equal(res.status, 2, `expected deny, got ${res.status}: ${res.stdout}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a version bump SMUGGLING a manifest behaviour change still FAILS', () => {
  const { dir, baseSha } = makeRepo();
  try {
    writeFileSync(
      join(dir, 'packages', 'build-gate', 'package.json'),
      JSON.stringify({ name: '@adlc/build-gate', version: '1.5.1', main: 'lib/tier.mjs',
        dependencies: { '@adlc/core': '^1.5.1' },
        scripts: { postinstall: 'echo pwned' } }, null, 2) + '\n'
    );
    const res = guard(dir, baseSha, RAIL);
    assert.equal(res.status, 2, `expected deny, got ${res.status}: ${res.stdout}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a bump COMMITTED (not just working-tree) under a live rail also passes', () => {
  const { dir, run, baseSha } = makeRepo();
  try {
    writeFileSync(
      join(dir, 'packages', 'build-gate', 'package.json'),
      JSON.stringify({ name: '@adlc/build-gate', version: '1.5.1', main: 'lib/tier.mjs',
        dependencies: { '@adlc/core': '^1.5.1' } }, null, 2) + '\n'
    );
    run('add', '-A');
    run('commit', '-q', '-m', 'chore: bump to 1.5.1');
    const res = guard(dir, baseSha, RAIL);
    assert.equal(res.status, 0, `expected pass, got ${res.status}: ${res.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('deleting a railed manifest during a bump still FAILS', () => {
  const { dir, baseSha } = makeRepo();
  try {
    rmSync(join(dir, 'packages', 'build-gate', 'package.json'));
    const res = guard(dir, baseSha, RAIL);
    assert.equal(res.status, 2, `expected deny, got ${res.status}: ${res.stdout}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// P5 prosecution regression: readFileSync follows symlinks while `git show`
// returns the blob, so a manifest replaced by a symlink to identical text
// compared equal and was exempted — while git recorded a typechange. The link
// target then lives outside the rail and can be swapped freely afterwards.
test('replacing a railed manifest with a symlink still FAILS', { skip: process.platform === 'win32' }, () => {
  const { dir, baseSha } = makeRepo();
  try {
    const manifest = join(dir, 'packages', 'build-gate', 'package.json');
    const decoy = join(dir, 'packages', 'build-gate', 'decoy.json');
    writeFileSync(decoy, execFileSync('cat', [manifest], { encoding: 'utf8' }));
    rmSync(manifest);
    symlinkSync('decoy.json', manifest);
    const res = guard(dir, baseSha, RAIL);
    assert.equal(res.status, 2, `expected deny, got ${res.status}: ${res.stdout}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('flipping a railed manifest to executable still FAILS', { skip: process.platform === 'win32' }, () => {
  const { dir, baseSha } = makeRepo();
  try {
    const manifest = join(dir, 'packages', 'build-gate', 'package.json');
    writeFileSync(
      manifest,
      JSON.stringify({ name: '@adlc/build-gate', version: '1.5.1', main: 'lib/tier.mjs',
        dependencies: { '@adlc/core': '^1.5.1' } }, null, 2) + '\n'
    );
    chmodSync(manifest, 0o755);
    const res = guard(dir, baseSha, RAIL);
    assert.equal(res.status, 2, `expected deny, got ${res.status}: ${res.stdout}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
