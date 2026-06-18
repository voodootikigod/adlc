#!/usr/bin/env node
// Lockstep release for the @adlc suite.
//
//   node scripts/release.mjs <version>            # set version on all packages (no publish)
//   node scripts/release.mjs <version> --publish  # set version, then publish core-first
//
// Publishing relies on npm provenance + trusted publishing (OIDC) in CI, or a
// temporary NPM_TOKEN for the bootstrap run. Every package carries
// publishConfig.access=public, so no per-call --access is required.

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
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

// Publish order: core first (every CLI depends on it); the `cli` umbrella last
// (it depends on every other CLI). Everything else in between.
const rest = readdirSync(PKGS).filter((n) => n !== 'core' && n !== 'cli');
const order = ['core', ...rest, 'cli'].filter((n) => existsSync(join(PKGS, n, 'package.json')));

// 1. Set version everywhere; repin EVERY @adlc/* dependency to match (lockstep).
//    Not just @adlc/core — the `cli` umbrella pins all 19 siblings, and those
//    pins must move in lockstep too or a release ships a broken dependency set.
for (const name of order) {
  const pj = join(PKGS, name, 'package.json');
  const pkg = JSON.parse(readFileSync(pj, 'utf8'));
  pkg.version = version;
  for (const depField of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    const deps = pkg[depField];
    if (!deps) continue;
    for (const dep of Object.keys(deps)) {
      if (dep.startsWith('@adlc/')) deps[dep] = version;
    }
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
