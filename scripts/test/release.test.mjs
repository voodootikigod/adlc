// release.test.mjs — the lockstep release is the moment version drift creeps in
// (a bump that misses a package.json, or leaves package-lock.json stale), so the
// release helper gets a committed regression test. Drives releaseMain against a
// throwaway fake repo with an injected lockfile-regen spy (no real npm, offline,
// leaves no trace).
//
// Regression context: v1.1.0 was bumped across packages/* + root but the bump
// (a) never regenerated package-lock.json (it stayed at 1.0.2 → npm ci broke) and
// (b) skipped plugins/adlc-pi (stranded at 1.0.2). These tests pin BOTH gaps shut.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { releaseMain, repinInternalDependencies, packagePublishOrder, findVersionDrift } from '../release.mjs';

/** Build a throwaway repo: root + packages/{core,cli} + plugins/{adlc-pi, adlc-claude-code}. */
function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'adlc-release-'));
  const packagesDir = join(root, 'packages');
  const pluginsDir = join(root, 'plugins');
  mkdirSync(packagesDir);
  mkdirSync(pluginsDir);
  const write = (p, obj) => writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
  write(join(root, 'package.json'), { name: 'adlc', version: '1.0.0', private: true });
  mkdirSync(join(packagesDir, 'core'));
  write(join(packagesDir, 'core', 'package.json'), { name: '@adlc/core', version: '1.0.0' });
  mkdirSync(join(packagesDir, 'cli'));
  write(join(packagesDir, 'cli', 'package.json'), {
    name: '@adlc/cli',
    version: '1.0.0',
    dependencies: { '@adlc/core': '1.0.0' }, // packages pin exactly
  });
  mkdirSync(join(pluginsDir, 'adlc-pi'));
  write(join(pluginsDir, 'adlc-pi', 'package.json'), {
    name: '@adlc/pi-package',
    version: '1.0.0',
    private: true,
    dependencies: { '@adlc/core': '^1.0.0' }, // plugin uses a caret range
  });
  // A plugin directory with NO package.json (e.g. adlc-claude-code) must be skipped.
  mkdirSync(join(pluginsDir, 'adlc-claude-code'));
  return { root, packagesDir, pluginsDir };
}

const ver = (p) => JSON.parse(readFileSync(p, 'utf8')).version;

test('releaseMain bumps packages, versioned plugins, and root in lockstep', () => {
  const { root, packagesDir, pluginsDir } = makeRepo();
  try {
    let regen = 0;
    const rc = releaseMain(['1.2.0'], { root, packagesDir, pluginsDir, regenerateLockfile: () => regen++ });
    assert.equal(rc, 0);
    assert.equal(ver(join(root, 'package.json')), '1.2.0');
    assert.equal(ver(join(packagesDir, 'core', 'package.json')), '1.2.0');
    assert.equal(ver(join(packagesDir, 'cli', 'package.json')), '1.2.0');
    assert.equal(ver(join(pluginsDir, 'adlc-pi', 'package.json')), '1.2.0'); // NOT stranded
    assert.equal(regen, 1); // lockfile regenerated exactly once
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('releaseMain repins internal @adlc deps, preserving range prefixes', () => {
  const { root, packagesDir, pluginsDir } = makeRepo();
  try {
    releaseMain(['1.2.0'], { root, packagesDir, pluginsDir, regenerateLockfile() {} });
    const cli = JSON.parse(readFileSync(join(packagesDir, 'cli', 'package.json'), 'utf8'));
    assert.equal(cli.dependencies['@adlc/core'], '1.2.0'); // exact stays exact
    const pi = JSON.parse(readFileSync(join(pluginsDir, 'adlc-pi', 'package.json'), 'utf8'));
    assert.equal(pi.dependencies['@adlc/core'], '^1.2.0'); // caret preserved, version moved
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('findVersionDrift flags a stranded plugin package', () => {
  const { root, packagesDir, pluginsDir } = makeRepo();
  try {
    const drift = findVersionDrift('1.2.0', { root, packagesDir, pluginsDir });
    assert.ok(drift.length >= 1);
    assert.ok(drift.some((d) => d.includes('adlc-pi')), `expected a plugin entry, got: ${drift.join(' | ')}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('findVersionDrift returns empty once releaseMain has bumped everything', () => {
  const { root, packagesDir, pluginsDir } = makeRepo();
  try {
    releaseMain(['1.2.0'], { root, packagesDir, pluginsDir, regenerateLockfile() {} });
    assert.deepEqual(findVersionDrift('1.2.0', { root, packagesDir, pluginsDir }), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('releaseMain rejects an invalid version (and does not regenerate the lockfile)', () => {
  const { root, packagesDir, pluginsDir } = makeRepo();
  try {
    let regen = 0;
    const rc = releaseMain(['not-semver'], { root, packagesDir, pluginsDir, regenerateLockfile: () => regen++ });
    assert.equal(rc, 1);
    assert.equal(regen, 0);
    assert.equal(ver(join(root, 'package.json')), '1.0.0'); // untouched
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('packagePublishOrder keeps core first and cli last', () => {
  assert.deepEqual(packagePublishOrder(['cli', 'rails-guard', 'core']), ['core', 'rails-guard', 'cli']);
});

test('repinInternalDependencies leaves non-@adlc deps alone', () => {
  const out = repinInternalDependencies(
    { name: 'x', version: '1.0.0', dependencies: { '@adlc/core': '1.0.0', chalk: '^5.0.0' } },
    '2.0.0'
  );
  assert.equal(out.version, '2.0.0');
  assert.equal(out.dependencies['@adlc/core'], '2.0.0');
  assert.equal(out.dependencies.chalk, '^5.0.0'); // untouched
});
