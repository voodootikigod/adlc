// #228 end-to-end: drive the real rails-guard binary over a real git repo.
//
// The unit tests prove the predicate; this proves the whole gate — git plumbing,
// the resolver, exit codes — behaves on the exact scenario from the issue:
// a live ticket rails packages/<x>/**, and a release bumps that package.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
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
