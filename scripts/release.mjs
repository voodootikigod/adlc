#!/usr/bin/env node
// Lockstep release for the @adlc suite.
//
//   node scripts/release.mjs <version>            # set version on all packages (no publish)
//   node scripts/release.mjs <version> --publish  # set version, then publish core-first
//
// Publishing relies on npm provenance + trusted publishing (OIDC) in CI, or a
// temporary NPM_TOKEN for the bootstrap run. Every package carries
// publishConfig.access=public, so no per-call --access is required.

import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PKGS = join(ROOT, 'packages');
const PLUGINS = join(ROOT, 'plugins');

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

/**
 * Regenerate package-lock.json so it tracks the freshly-bumped versions. Pure
 * lockfile resolution (the suite is zero-dependency / workspace-only), so this is
 * offline and fast. Injectable via the `regenerateLockfile` option so the unit
 * tests can drive releaseMain without shelling out to npm.
 */
function defaultRegenerateLockfile(root) {
  execFileSync('npm', ['install', '--package-lock-only'], { cwd: root, stdio: 'inherit' });
}

export function packagePublishOrder(names) {
  const unique = Array.from(new Set(names)).sort();
  return [
    ...unique.filter((name) => name === 'core'),
    ...unique.filter((name) => name !== 'core' && name !== 'cli'),
    ...unique.filter((name) => name === 'cli'),
  ];
}

export function repinInternalDependencies(pkg, version) {
  const next = structuredClone(pkg);
  for (const dependencyKind of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    if (!next[dependencyKind]) continue;
    for (const name of Object.keys(next[dependencyKind])) {
      if (!name.startsWith('@adlc/')) continue;
      // Preserve the existing range style: packages/* pin exactly (`1.2.0`), but a
      // consumer-style package (e.g. plugins/adlc-pi) may use `^`/`~` ranges —
      // forcing those to exact would silently change its dependency intent.
      const prev = next[dependencyKind][name];
      const prefix = typeof prev === 'string' && /^[\^~]/.test(prev) ? prev[0] : '';
      next[dependencyKind][name] = prefix + version;
    }
  }
  next.version = version;
  return next;
}

function workspacePackageNames(packagesDir) {
  return readdirSync(packagesDir).filter((name) => existsSync(join(packagesDir, name, 'package.json')));
}

/**
 * Every versioned package.json in the suite: each `packages/*` AND each
 * `plugins/*` that ships a package.json. Plugins without one (skill/command-only
 * integrations like adlc-claude-code) are skipped. The root is handled separately.
 */
function versionedPackageJsonPaths({ packagesDir = PKGS, pluginsDir = PLUGINS } = {}) {
  const paths = [];
  for (const base of [packagesDir, pluginsDir]) {
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base)) {
      const pj = join(base, name, 'package.json');
      if (existsSync(pj)) paths.push(pj);
    }
  }
  return paths;
}

/**
 * Deterministic post-bump gate: return a list of every place still NOT at
 * `version` — any versioned package.json (packages/* + plugins/*), the root, and
 * package-lock.json. An empty list means the suite is fully in lockstep. This is
 * what makes "the v1.1.0 drift can't happen again" machine-checkable rather than
 * a thing a human has to remember.
 */
export function findVersionDrift(version, { root = ROOT, packagesDir = PKGS, pluginsDir = PLUGINS } = {}) {
  const problems = [];
  for (const pj of versionedPackageJsonPaths({ packagesDir, pluginsDir })) {
    const v = readJson(pj).version;
    if (v !== version) problems.push(`${pj}: ${v} != ${version}`);
  }
  const rootV = readJson(join(root, 'package.json')).version;
  if (rootV !== version) problems.push(`${join(root, 'package.json')}: ${rootV} != ${version}`);
  const lockPath = join(root, 'package-lock.json');
  if (existsSync(lockPath)) {
    const lockV = readJson(lockPath).version;
    if (lockV !== version) problems.push(`${lockPath}: ${lockV} != ${version}`);
  }
  return problems;
}

export function releaseMain(
  argv = process.argv.slice(2),
  { root = ROOT, packagesDir = PKGS, pluginsDir = PLUGINS, regenerateLockfile = defaultRegenerateLockfile } = {}
) {
  const version = argv[0];
  const publish = argv.includes('--publish');

  if (!version || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
    console.error('usage: release.mjs <semver> [--publish]');
    return 1;
  }

  // core publishes first; cli publishes last because it depends on every routed tool.
  const order = packagePublishOrder(workspacePackageNames(packagesDir));

  // 1. Set version everywhere and repin every internal @adlc/* dependency to match.
  for (const name of order) {
    const pj = join(packagesDir, name, 'package.json');
    const pkg = repinInternalDependencies(readJson(pj), version);
    writeJson(pj, pkg);
    console.log(`set ${pkg.name}@${version}`);
  }

  // Versioned plugin packages (e.g. @adlc/pi-package) are part of the suite and
  // must move in lockstep — skipping them is exactly how plugins/adlc-pi got
  // stranded at 1.0.2 while everything else went to 1.1.0.
  if (existsSync(pluginsDir)) {
    for (const name of readdirSync(pluginsDir)) {
      const pj = join(pluginsDir, name, 'package.json');
      if (!existsSync(pj)) continue; // skill/command-only plugins have no package.json
      const pkg = repinInternalDependencies(readJson(pj), version);
      writeJson(pj, pkg);
      console.log(`set ${pkg.name}@${version} (plugin)`);
    }
  }

  // Keep the (private) root version in lockstep too.
  const rootPj = join(root, 'package.json');
  const rootPkg = readJson(rootPj);
  rootPkg.version = version;
  writeJson(rootPj, rootPkg);
  console.log(`set ${rootPkg.name}@${version} (root)`);

  // 2. Regenerate the lockfile so package-lock.json tracks the new versions.
  // Omitting this is the bug that left the lockfile at 1.0.2 (npm ci broke).
  regenerateLockfile(root);
  console.log('regenerated package-lock.json');

  // 3. Fail closed on any residual drift — a missed package.json or a stale
  // lockfile aborts the release instead of shipping an inconsistent suite.
  const drift = findVersionDrift(version, { root, packagesDir, pluginsDir });
  if (drift.length > 0) {
    console.error(`version drift after bump — aborting:\n  ${drift.join('\n  ')}`);
    return 1;
  }

  if (!publish) {
    console.log(`\nversions set to ${version} (no publish). Commit, tag v${version}, push.`);
    return 0;
  }

  // 2. Publish in dependency order.
  for (const name of order) {
    const dir = join(packagesDir, name);
    const { name: pkgName } = readJson(join(dir, 'package.json'));
    console.log(`\npublishing ${pkgName}@${version} ...`);
    execFileSync('npm', ['publish', '--provenance'], { cwd: dir, stdio: 'inherit' });
  }
  console.log(`\npublished @adlc suite @ ${version}`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(releaseMain());
}
