#!/usr/bin/env node
// Lockstep release for the @adlc suite.
//
//   node scripts/release.mjs <version>            # set version on all packages (no publish)
//   node scripts/release.mjs <version> --publish  # set version, then publish core-first
//
// Publishing relies on npm provenance + trusted publishing (OIDC) in CI, or a
// temporary NPM_TOKEN for the bootstrap run. Every package carries
// publishConfig.access=public, so no per-call --access is required.

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PKGS = join(ROOT, 'packages');

const version = process.argv[2];
const publish = process.argv.includes('--publish');

if (!version || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
  console.error('usage: release.mjs <semver> [--publish]');
  process.exit(1);
}

// core publishes first because every CLI depends on it.
const names = readdirSync(PKGS).filter((n) => n !== 'core');
const order = ['core', ...names];

// 1. Set version everywhere; repin the @adlc/core dependency to match (lockstep).
for (const name of order) {
  const pj = join(PKGS, name, 'package.json');
  const pkg = JSON.parse(readFileSync(pj, 'utf8'));
  pkg.version = version;
  if (pkg.dependencies?.['@adlc/core']) {
    pkg.dependencies['@adlc/core'] = version;
  }
  writeFileSync(pj, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`set ${pkg.name}@${version}`);
}

// Keep the (private) root version in lockstep too.
const rootPj = join(ROOT, 'package.json');
const root = JSON.parse(readFileSync(rootPj, 'utf8'));
root.version = version;
writeFileSync(rootPj, JSON.stringify(root, null, 2) + '\n');
console.log(`set ${root.name}@${version} (root)`);

if (!publish) {
  console.log(`\nversions set to ${version} (no publish). Commit, tag v${version}, push.`);
  process.exit(0);
}

// 2. Publish in dependency order. core must land before its consumers resolve it.
for (const name of order) {
  const dir = join(PKGS, name);
  const { name: pkgName } = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  console.log(`\npublishing ${pkgName}@${version} ...`);
  execFileSync('npm', ['publish', '--provenance'], { cwd: dir, stdio: 'inherit' });
}
console.log(`\npublished @adlc suite @ ${version}`);
