#!/usr/bin/env node
// Lockstep release for the @adlc suite.
//
//   node scripts/release.mjs <version>            # set version on all packages (no publish)
//   node scripts/release.mjs <version> --publish  # set version, then publish core-first
//
// Publishing relies on npm provenance + trusted publishing (OIDC) in CI, or a
// temporary NPM_TOKEN for the bootstrap run. Every package carries
// publishConfig.access=public, so no per-call --access is required.
//
// Governing decision: docs/adr/0011-release-gates-validate-the-artifact.md.
// Release gates validate the PUBLISHED ARTIFACT, not the source tree, and host
// manifest discovery is glob-driven by shape rather than an enumerated list of
// integrations. Both rules exist because their absence shipped two live defects:
// the Claude Code plugin stranded at 0.2.0 across three releases, and an
// @adlc/ticket-sync tarball missing a file its own lib/doctor.mjs imports.
// scripts/test/release-artifact.test.mjs is the frozen rail for that decision.

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

/**
 * Every directory `--publish` must publish, in dependency order: packages/* in
 * the core-first/cli-last order, THEN each non-private plugin package (plugins
 * consume the packages, so they publish after them). Skipping publishable
 * plugins is exactly how @adlc/opencode ended up registered in user
 * opencode.json files while not existing on npm (T30).
 * Returns [{ dir, name, private }].
 */
export function publishTargets({ packagesDir = PKGS, pluginsDir = PLUGINS } = {}) {
  const targets = [];
  for (const name of packagePublishOrder(workspacePackageNames(packagesDir))) {
    const dir = join(packagesDir, name);
    const pkg = readJson(join(dir, 'package.json'));
    targets.push({ dir, name: pkg.name, private: pkg.private === true });
  }
  if (existsSync(pluginsDir)) {
    for (const name of readdirSync(pluginsDir).sort()) {
      const pj = join(pluginsDir, name, 'package.json');
      if (!existsSync(pj)) continue;
      const pkg = readJson(pj);
      targets.push({ dir: join(pluginsDir, name), name: pkg.name, private: pkg.private === true });
    }
  }
  return targets.filter((t) => !t.private);
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

// A host packaging directory: `.codex-plugin`, `.cursor-plugin`, `.claude-plugin`,
// and whatever the next integration is called. Matching by SHAPE rather than by
// an enumerated list is the whole fix — release.mjs previously carried one
// hardcoded loop per host, Claude Code (the FIRST integration) never got one, and
// its manifests sat at 0.2.0 through three releases while the drift gate, which
// mirrored the same enumeration, reported green.
const HOST_PLUGIN_DIR = /^\.[a-z0-9-]+-plugin$/;

/**
 * Every version-bearing host plugin manifest, in both shapes the repo uses:
 *   plugins/<name>/.<host>-plugin/plugin.json   (codex, cursor, claude-code)
 *   plugins/<name>/plugin.json                  (antigravity's flat layout)
 *
 * Discovery is DEPTH-EXACT on purpose: it reads only the direct children of
 * pluginsDir and of each plugin dir. A recursive walk would reach the 21 stale
 * copies under .worktrees/ and .claude/worktrees/ and rewrite unrelated in-flight
 * branches. `.worktrees` and `node_modules` simply do not match HOST_PLUGIN_DIR,
 * so they are never descended into.
 */
export function hostPluginManifestPaths(pluginsDir = PLUGINS) {
  if (!existsSync(pluginsDir)) return [];
  const paths = [];
  for (const name of readdirSync(pluginsDir).sort()) {
    const dir = join(pluginsDir, name);
    const flat = join(dir, 'plugin.json');
    if (existsSync(flat)) paths.push(flat);
    let entries;
    try {
      entries = readdirSync(dir).sort();
    } catch {
      continue; // not a directory (a stray file in plugins/) — nothing to bump
    }
    for (const entry of entries) {
      if (!HOST_PLUGIN_DIR.test(entry)) continue;
      const nested = join(dir, entry, 'plugin.json');
      if (existsSync(nested)) paths.push(nested);
    }
  }
  return paths;
}

/**
 * Every root-level host marketplace listing: `<root>/.<host>-plugin/marketplace.json`.
 * Depth-exact for the same reason as above. Only files that ALREADY exist are
 * returned — the bump must never CREATE a manifest, because
 * scripts/claude-code-plugin-smoke.mjs asserts the nested
 * plugins/adlc-claude-code/.claude-plugin/marketplace.json does NOT exist (a
 * second copy causes a dual-resolution failure on live install).
 */
export function hostMarketplacePaths(root = ROOT) {
  if (!existsSync(root)) return [];
  const paths = [];
  for (const entry of readdirSync(root).sort()) {
    if (!HOST_PLUGIN_DIR.test(entry)) continue;
    const p = join(root, entry, 'marketplace.json');
    if (existsSync(p)) paths.push(p);
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
  // Same discovery functions the bumper uses. Sharing them is load-bearing: the
  // original bug was a gate that enumerated a DIFFERENT set of manifests than the
  // bumper, so a surface the bumper missed was also a surface the gate never
  // checked. They can no longer diverge.
  for (const manifest of hostPluginManifestPaths(pluginsDir)) {
    const v = readJson(manifest).version;
    if (v !== version) problems.push(`${manifest}: ${v} != ${version}`);
  }
  for (const marketplacePath of hostMarketplacePaths(root)) {
    const marketplace = readJson(marketplacePath);
    if (marketplace.metadata?.version !== version) {
      problems.push(`${marketplacePath} metadata.version: ${marketplace.metadata?.version} != ${version}`);
    }
    for (const entry of marketplace.plugins ?? []) {
      if (entry.version !== version) {
        problems.push(`${marketplacePath} plugin ${entry.name}: ${entry.version} != ${version}`);
      }
    }
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

// Repo slug every publishable package's provenance is built against. npm's
// sigstore provenance check 422s if package.json repository.url does not resolve
// to this, aborting the lockstep publish partway through.
const PROVENANCE_REPO = 'github.com/voodootikigod/adlc';

/**
 * Every non-private publish target must carry a repository.url that references
 * the source repo, or npm provenance validation rejects it mid-publish. Returns
 * the list of offenders (empty = all good).
 */
export function findPublishMetadataProblems({ packagesDir = PKGS, pluginsDir = PLUGINS } = {}) {
  const problems = [];
  for (const target of publishTargets({ packagesDir, pluginsDir })) {
    const pkg = readJson(join(target.dir, 'package.json'));
    const repo = pkg.repository;
    const url = repo && typeof repo === 'object' ? repo.url : (typeof repo === 'string' ? repo : undefined);
    if (!url || !String(url).includes(PROVENANCE_REPO)) {
      problems.push(`${target.name}: repository.url is ${JSON.stringify(url ?? null)} — provenance requires it to reference ${PROVENANCE_REPO}`);
    }
  }
  return problems;
}

// Static module specifiers in ESM source. Relative specifiers resolve to FILES
// that must be inside the tarball; `node:` builtins and bare specifiers
// (`@adlc/core`) are dependency-resolved and are never shipped, so only
// relative ones are checked. A dynamic import with a COMPUTED specifier is
// undecidable by static analysis and is out of scope — the gate reports what it
// covers rather than pretending completeness.
const SPECIFIER_PATTERNS = [
  /\bimport\s+[^;'"]*?\bfrom\s*['"]([^'"]+)['"]/g, // import x from '...'
  /\bexport\s+[^;'"]*?\bfrom\s*['"]([^'"]+)['"]/g, // export x from '...'
  /\bimport\s*['"]([^'"]+)['"]/g,                  // import '...' (side effect)
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,        // import('...') with a literal
];

function relativeSpecifiers(source) {
  const found = new Set();
  for (const re of SPECIFIER_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(source)) !== null) {
      if (m[1].startsWith('.')) found.add(m[1]);
    }
  }
  return [...found];
}

/**
 * The authoritative list of files a package will actually publish. Asking npm
 * beats reimplementing it: `files` interacts with .npmignore, always-included
 * entries (package.json, README, LICENSE) and always-excluded ones in ways that
 * a hand-rolled prefix match gets subtly wrong. `--dry-run` writes no tarball.
 * Returns null when npm cannot be consulted, so the caller can stay silent
 * rather than fail a release on a tooling hiccup.
 */
function packedFilePaths(dir, packImpl) {
  try {
    const raw = packImpl(dir);
    const parsed = JSON.parse(raw);
    const files = parsed?.[0]?.files ?? [];
    return new Set(files.map((f) => String(f.path).split('\\').join('/')));
  } catch {
    return null;
  }
}

function defaultPackImpl(dir) {
  return execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

/**
 * Every non-private publish target must SHIP every file its shipped code
 * imports. @adlc/ticket-sync declared `files: [bin/, lib/, schemas/, ...]` while
 * lib/doctor.mjs imported `../scripts/gen-schema.mjs` at module load, so the
 * published tarball was missing a file its own code required and
 * `adlc ticket doctor` died with ERR_MODULE_NOT_FOUND for every installed user
 * of 1.5.0 — invisible to `npm test`, which runs against the source tree where
 * the file is present.
 * Returns the list of offenders (empty = every tarball is self-contained).
 */
export function findPackagingProblems({ packagesDir = PKGS, pluginsDir = PLUGINS, packImpl = defaultPackImpl } = {}) {
  const problems = [];
  for (const target of publishTargets({ packagesDir, pluginsDir })) {
    const packed = packedFilePaths(target.dir, packImpl);
    if (packed === null) continue; // npm unavailable — not a release-blocking signal
    for (const rel of packed) {
      if (!/\.(mjs|js|cjs)$/.test(rel)) continue;
      let source;
      try {
        source = readFileSync(join(target.dir, rel), 'utf8');
      } catch {
        continue;
      }
      for (const spec of relativeSpecifiers(source)) {
        // Resolve the specifier against the importing file's directory, then
        // express it back as a package-relative POSIX path to compare with npm's
        // file list.
        const resolved = join(dirname(rel), spec).split('\\').join('/');
        if (packed.has(resolved)) continue;
        problems.push(
          `${target.name}: ${rel} imports ${spec} → ${resolved}, which the "files" allowlist does not publish ` +
            `(the installed package would fail at import time)`
        );
      }
    }
  }
  return problems;
}

function defaultPublishImpl(dir) {
  execFileSync('npm', ['publish', '--provenance'], { cwd: dir, stdio: 'inherit' });
}

export function releaseMain(
  argv = process.argv.slice(2),
  {
    root = ROOT,
    packagesDir = PKGS,
    pluginsDir = PLUGINS,
    regenerateLockfile = defaultRegenerateLockfile,
    publishImpl = defaultPublishImpl,
  } = {}
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

  // Versioned plugin packages (e.g. @adlc/pi) are part of the suite and
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
    // Every host manifest, discovered by shape. Only `version` is touched —
    // antigravity's plugin.json also carries `adlcContract`, which is a protocol
    // number, not a release version, and must survive the bump untouched.
    for (const manifest of hostPluginManifestPaths(pluginsDir)) {
      const plugin = readJson(manifest);
      plugin.version = version;
      writeJson(manifest, plugin);
      console.log(`set ${plugin.name}@${version} (host manifest: ${manifest.slice(root.length + 1)})`);
    }
  }

  // Root-level marketplace listings carry each packaged plugin's version
  // SEPARATELY from its package.json, so a bump that skips one strands the
  // listing. That is exactly how .claude-plugin/marketplace.json stayed at 0.2.0
  // through 1.3.0/1.4.0/1.5.0: `/plugin` compares the declared version string to
  // decide whether an update exists, so every release was invisible to the
  // updater even though main carried current content.
  for (const marketplacePath of hostMarketplacePaths(root)) {
    const marketplace = readJson(marketplacePath);
    if (marketplace.metadata) marketplace.metadata.version = version;
    for (const entry of marketplace.plugins ?? []) {
      entry.version = version;
    }
    writeJson(marketplacePath, marketplace);
    console.log(`set ${marketplacePath.slice(root.length + 1)}@${version} (marketplace)`);
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

  // 4. Fail closed on missing publish metadata. npm provenance validation 422s
  // if a package's repository.url does not match the build's source repo, and it
  // does so MID-publish (core-first) — stranding a partial release (v1.4.0 shipped
  // 27 of 34 because @adlc/tickets had no repository field). Catch it at bump time,
  // before any tag or publish, so the whole suite ships or none of it does.
  const metadataProblems = findPublishMetadataProblems({ packagesDir, pluginsDir });
  if (metadataProblems.length > 0) {
    console.error(`publish metadata invalid — aborting (npm provenance would 422 mid-publish):\n  ${metadataProblems.join('\n  ')}`);
    return 1;
  }

  // 5. Fail closed if any tarball would ship code importing a file the `files`
  // allowlist excludes. This is the artifact gate: steps 3 and 4 validate the
  // SOURCE TREE, where every import resolves because nothing has been filtered
  // yet. Only npm's own view of the tarball reveals that @adlc/ticket-sync
  // shipped lib/doctor.mjs without the ../scripts/gen-schema.mjs it imports.
  const packagingProblems = findPackagingProblems({ packagesDir, pluginsDir });
  if (packagingProblems.length > 0) {
    console.error(
      `packaging incomplete — aborting (the published package would fail on import):\n  ${packagingProblems.join('\n  ')}\n` +
        `  note: only STATIC and literal-dynamic imports are checked; a computed import() specifier is not decidable here.`
    );
    return 1;
  }

  if (!publish) {
    console.log(`\nversions set to ${version} (no publish). Commit, tag v${version}, push.`);
    return 0;
  }

  // 2. Publish in dependency order — packages/* first, then every non-private
  // plugin package (they consume the packages).
  for (const target of publishTargets({ packagesDir, pluginsDir })) {
    console.log(`\npublishing ${target.name}@${version} ...`);
    publishImpl(target.dir, target.name);
  }
  console.log(`\npublished @adlc suite @ ${version}`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(releaseMain());
}
