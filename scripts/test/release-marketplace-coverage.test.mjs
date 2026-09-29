import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostMarketplacePaths, findVersionDrift, releaseMain } from '../release.mjs';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '../..');
const write = (p, obj) => writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

/** True when a marketplace listing carries any version the bumper would own. */
function carriesVersion(listing) {
  return 'version' in (listing.metadata ?? {}) || (listing.plugins ?? []).some((entry) => 'version' in entry);
}

test('every tracked marketplace.json that carries a version is a surface the bump and drift gate cover', () => {
  const tracked = execFileSync('git', ['ls-files', '*marketplace.json'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .filter((rel) => carriesVersion(readJson(join(ROOT, rel))));
  assert.ok(tracked.includes('.github/plugin/marketplace.json'));
  const covered = new Set(hostMarketplacePaths(ROOT).map((p) => p.slice(ROOT.length + 1)));
  assert.deepEqual(tracked.filter((rel) => !covered.has(rel)), []);
});

test('the Copilot marketplace listing is at the suite version', () => {
  const version = readJson(join(ROOT, 'package.json')).version;
  const drift = findVersionDrift(version).filter((entry) => entry.includes(join('.github', 'plugin', 'marketplace.json')));
  assert.deepEqual(drift, []);
});

/** Minimal repo: a root package.json and a stale .github/plugin marketplace. */
function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'adlc-release-marketplace-'));
  const packagesDir = join(root, 'packages');
  const pluginsDir = join(root, 'plugins');
  mkdirSync(packagesDir);
  mkdirSync(pluginsDir);
  write(join(root, 'package.json'), { name: 'adlc', version: '1.0.0', private: true });
  mkdirSync(join(root, '.github', 'plugin'), { recursive: true });
  write(join(root, '.github', 'plugin', 'marketplace.json'), {
    name: 'adlc',
    metadata: { description: 'x', version: '1.0.0' },
    plugins: [{ name: 'adlc-copilot', version: '1.0.0', source: './plugins/adlc-copilot' }],
  });
  return { root, packagesDir, pluginsDir };
}

test('findVersionDrift reports a stale .github/plugin/marketplace.json', () => {
  const { root, packagesDir, pluginsDir } = makeRepo();
  try {
    write(join(root, 'package.json'), { name: 'adlc', version: '1.2.0', private: true });
    const drift = findVersionDrift('1.2.0', { root, packagesDir, pluginsDir });
    const path = join(root, '.github', 'plugin', 'marketplace.json');
    assert.deepEqual(drift, [
      `${path} metadata.version: 1.0.0 != 1.2.0`,
      `${path} plugin adlc-copilot: 1.0.0 != 1.2.0`,
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('releaseMain bumps .github/plugin/marketplace.json in lockstep', () => {
  const { root, packagesDir, pluginsDir } = makeRepo();
  try {
    releaseMain(['1.2.0'], { root, packagesDir, pluginsDir, regenerateLockfile() {} });
    const listing = readJson(join(root, '.github', 'plugin', 'marketplace.json'));
    assert.equal(listing.metadata.version, '1.2.0');
    assert.equal(listing.plugins[0].version, '1.2.0');
    assert.equal(listing.metadata.description, 'x');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a repo without .github/plugin/marketplace.json gains no such file from a release', () => {
  const { root, packagesDir, pluginsDir } = makeRepo();
  try {
    rmSync(join(root, '.github'), { recursive: true, force: true });
    assert.deepEqual(hostMarketplacePaths(root), []);
    releaseMain(['1.2.0'], { root, packagesDir, pluginsDir, regenerateLockfile() {} });
    assert.deepEqual(hostMarketplacePaths(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
