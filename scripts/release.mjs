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
/**
 * True only for a manifest that ALREADY declares a string `version`. The bumper
 * must never INVENT that field: `plugins/<x>/plugin.json` is not necessarily a
 * versioned host manifest (it can be a tool config or a schema), and for a host
 * whose manifest schema is additionalProperties:false — which
 * claude-code-plugin-smoke.mjs documents as the real constraint in this
 * ecosystem — an injected key is an install-time rejection. ADR 0011 §4 says the
 * bumper only updates what exists; that has to mean fields, not just files.
 */
function declaresVersion(manifestPath) {
  try {
    return typeof readJson(manifestPath).version === 'string';
  } catch {
    return false; // unparseable — not something to stamp a version into
  }
}

export function hostPluginManifestPaths(pluginsDir = PLUGINS) {
  if (!existsSync(pluginsDir)) return [];
  const paths = [];
  for (const name of readdirSync(pluginsDir).sort()) {
    const dir = join(pluginsDir, name);
    const flat = join(dir, 'plugin.json');
    if (existsSync(flat) && declaresVersion(flat)) paths.push(flat);
    let entries;
    try {
      entries = readdirSync(dir).sort();
    } catch {
      continue; // not a directory (a stray file in plugins/) — nothing to bump
    }
    for (const entry of entries) {
      if (entry === 'node_modules' || !HOST_PLUGIN_DIR.test(entry)) continue;
      const nested = join(dir, entry, 'plugin.json');
      if (existsSync(nested) && declaresVersion(nested)) paths.push(nested);
    }
  }
  return paths;
}

/**
 * Directories that LOOK like host packaging dirs but do not match
 * HOST_PLUGIN_DIR — `.Codex-plugin`, `.claude_plugin`, `.jetbrains.ai-plugin`.
 *
 * This closes the hole the shape regex would otherwise reopen. Sharing the
 * discovery functions between bumper and gate makes bumper/gate divergence
 * impossible, but it does NOT make discovery/reality divergence impossible: a
 * host directory the regex misses is invisible to BOTH sides, which is verbatim
 * the Defect A failure mode (a frozen manifest under a green gate). Reporting
 * near misses turns that silent class into a loud one.
 */
export function hostDiscoveryNearMisses({ root = ROOT, pluginsDir = PLUGINS } = {}) {
  const misses = [];
  const dotted = (entry) => entry.startsWith('.') && !HOST_PLUGIN_DIR.test(entry);
  const scan = (dir, filename, label) => {
    let entries;
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === '.git' || entry === '.worktrees' || entry === 'node_modules') continue;
      if (!dotted(entry)) continue;
      const candidate = join(dir, entry, filename);
      if (!existsSync(candidate)) continue;
      misses.push(
        `${candidate}: directory "${entry}" holds a ${filename} but does not match ${HOST_PLUGIN_DIR} — ` +
          `it would be invisible to BOTH the bump and the drift gate (${label}). ` +
          `Rename it to .<host>-plugin, or widen HOST_PLUGIN_DIR deliberately.`
      );
    }
  };
  scan(root, 'marketplace.json', 'root marketplace');
  if (existsSync(pluginsDir)) {
    for (const name of readdirSync(pluginsDir).sort()) {
      scan(join(pluginsDir, name), 'plugin.json', 'plugin manifest');
    }
  }
  return misses;
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
    // SYMMETRY WITH THE BUMPER (load-bearing): the bumper writes metadata.version
    // only when a `metadata` object already exists, so the gate must only demand
    // it under the same condition. Checking unconditionally created a state the
    // bump could never satisfy — a metadata-less marketplace.json made releaseMain
    // rewrite the whole tree and then abort, identically on every re-run, leaving
    // a fully mutated working tree behind. .agents/plugins/marketplace.json is
    // exactly that shape today; it escapes only because its directory does not
    // match HOST_PLUGIN_DIR, which is not a guarantee worth relying on.
    if (marketplace.metadata && 'version' in marketplace.metadata && marketplace.metadata.version !== version) {
      problems.push(`${marketplacePath} metadata.version: ${marketplace.metadata.version} != ${version}`);
    }
    for (const entry of marketplace.plugins ?? []) {
      // Same rule for entries: only lockstep a version that already exists.
      if ('version' in entry && entry.version !== version) {
        problems.push(`${marketplacePath} plugin ${entry.name}: ${entry.version} != ${version}`);
      }
    }
  }

  // A host directory the shape regex misses is invisible to bumper AND gate —
  // the Defect A shape. Surface it as drift so it aborts loudly.
  problems.push(...hostDiscoveryNearMisses({ root, pluginsDir }));
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

// Module specifiers in shipped source. Relative specifiers resolve to FILES that
// must be inside the tarball; `node:` builtins and bare specifiers
// (`@adlc/core`) are dependency-resolved and never shipped, so only relative
// ones are checked.
//
// `require()` is included because the file filter admits .cjs/.js: a CommonJS
// `require('../scripts/gen-schema.js')` is the EXACT shape of Defect B, and
// matching only ESM forms while claiming to scan .cjs would leave the original
// bug undetectable in its CommonJS spelling.
//
// A dynamic import (or require) with a COMPUTED specifier stays undecidable by
// static analysis. That gap is stated in the failure output rather than implied
// away.
const SPECIFIER_PATTERNS = [
  /\bimport\s+[^;'"]*?\bfrom\s*['"]([^'"]+)['"]/g, // import x from '...'
  /\bexport\s+[^;'"]*?\bfrom\s*['"]([^'"]+)['"]/g, // export x from '...'
  /\bimport\s*['"]([^'"]+)['"]/g,                  // import '...' (side effect)
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,        // import('...') with a literal
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,       // require('...')
  /\brequire\.resolve\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

const SENTINEL = ' ';

/**
 * A minimal single-pass lexer: removes comments and replaces every string /
 * template literal with an opaque `"\0<n>\0"` placeholder, returning the
 * placeholder table alongside.
 *
 * Regex-only handling of this is not good enough, and both failure directions
 * are real:
 *   - stripping `/*…*\/` with a regex treats a `/*` that appears INSIDE a string
 *     literal as a comment opener and deletes everything up to the next `*\/`,
 *     silently removing real imports — the gate then fails OPEN;
 *   - scanning raw text finds import-shaped text inside ordinary string literals
 *     (codegen templates, fixtures, docs) and hard-aborts a valid release — a
 *     false POSITIVE, after the tree has already been bumped.
 *
 * Replacing strings with placeholders fixes both: a specifier is still a quoted
 * token the patterns can match, but the CONTENTS of unrelated strings can no
 * longer look like code. An AST parser would be the textbook answer; this repo
 * is zero-runtime-dependency by convention and Node ships no parser, so this is
 * the honest middle ground. Its limits are stated in the gate's output.
 */
function lexModule(source) {
  const strings = [];
  let code = '';
  let prev = '';
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      let value = '';
      while (j < source.length) {
        if (source[j] === '\\') { value += source[j + 1] ?? ''; j += 2; continue; }
        if (source[j] === c) break;
        value += source[j];
        j++;
      }
      strings.push(value);
      code += `"${SENTINEL}${strings.length - 1}${SENTINEL}"`;
      prev = '"';
      i = j + 1;
      continue;
    }
    // A regex literal can contain quotes and slashes; skipping it prevents those
    // from desynchronising the string state above.
    if (c === '/' && /[(,=:[!&|?{};+\-*%~^]/.test(prev)) {
      let j = i + 1;
      let inClass = false;
      while (j < source.length) {
        if (source[j] === '\\') { j += 2; continue; }
        if (source[j] === '[') inClass = true;
        else if (source[j] === ']') inClass = false;
        else if (source[j] === '\n') break;
        else if (source[j] === '/' && !inClass) break;
        j++;
      }
      prev = '/';
      i = j + 1;
      continue;
    }
    code += c;
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return { code, strings };
}

function relativeSpecifiers(source) {
  const { code, strings } = lexModule(source);
  const placeholder = new RegExp(`^${SENTINEL}(\\d+)${SENTINEL}$`);
  const found = new Set();
  for (const re of SPECIFIER_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(code)) !== null) {
      const hit = placeholder.exec(m[1]);
      if (!hit) continue; // matched something that was never a string literal
      const value = strings[Number(hit[1])];
      if (typeof value === 'string' && value.startsWith('.')) found.add(value);
    }
  }
  return [...found];
}

const JS_EXTENSION = /\.(mjs|cjs|js|json|node)$/;

/**
 * Node does not require an extension for CommonJS: `require('../scripts/gen')`
 * legitimately resolves to `gen.js`, `gen.cjs`, or `gen/index.js`. Comparing the
 * literal specifier against the tarball's file list would therefore hard-abort
 * every valid CJS package — a false positive in a release-blocking gate.
 * An extension that IS present is matched exactly, so a genuine escape is still
 * caught.
 */
function resolutionCandidates(resolved) {
  if (JS_EXTENSION.test(resolved)) return [resolved];
  return [
    resolved,
    `${resolved}.js`, `${resolved}.cjs`, `${resolved}.mjs`, `${resolved}.json`,
    `${resolved}/index.js`, `${resolved}/index.cjs`, `${resolved}/index.mjs`,
  ];
}

/**
 * Which shipped files to scan. Extension alone is not enough: a package may
 * declare an EXTENSIONLESS bin (`"bin": { "cli": "bin/cli" }`, an ordinary CLI
 * pattern), and skipping it means the package's own entrypoint — the file most
 * likely to be executed — is never checked. That is a fail-open on the most
 * important file in the tarball.
 */
function scannableFiles(dir, packed) {
  const files = new Set([...packed].filter((p) => /\.(mjs|js|cjs)$/.test(p)));
  let bin;
  try {
    bin = readJson(join(dir, 'package.json')).bin;
  } catch {
    return files;
  }
  const declared = typeof bin === 'string' ? [bin] : (bin && typeof bin === 'object' ? Object.values(bin) : []);
  for (const entry of declared) {
    const rel = String(entry).replace(/^\.\//, '');
    if (packed.has(rel)) files.add(rel);
  }
  return files;
}

/**
 * The authoritative list of files a package will actually publish. Asking npm
 * beats reimplementing it: `files` interacts with .npmignore, always-included
 * entries (package.json, README, LICENSE) and always-excluded ones in ways that
 * a hand-rolled prefix match gets subtly wrong. `--dry-run` writes no tarball.
 *
 * Returns a THREE-STATE result, never a bare list. "verified clean" and "never
 * checked" must not collapse into the same value: the original version returned
 * null on any failure and the caller silently skipped the package, so an npm
 * hiccup removed all coverage for exactly the package we were about to publish,
 * with no log and no counter. `parsed[0].files` being absent was even quieter —
 * it produced an EMPTY SET rather than null, so the package passed without the
 * unconsultable path ever being taken.
 */
function packedFilePaths(dir, packImpl) {
  let raw;
  try {
    raw = packImpl(dir);
  } catch (err) {
    return { ok: false, reason: `npm pack failed: ${err.message}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, reason: `npm pack --json output was not parseable JSON: ${err.message}` };
  }
  const files = parsed?.[0]?.files;
  if (!Array.isArray(files)) {
    return { ok: false, reason: 'npm pack --json returned no "files" array (unrecognized output shape)' };
  }
  return { ok: true, files: new Set(files.map((f) => String(f.path).split('\\').join('/'))) };
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
 * Returns { problems, consulted, unconsultable }:
 *   problems      — offenders (empty = every INSPECTED tarball is self-contained)
 *   consulted     — packages npm actually answered for (the DENOMINATOR; an
 *                   empty `problems` list means nothing without it)
 *   unconsultable — [{ name, reason }] npm could not be asked about
 *
 * Callers must not read `problems.length === 0` as "verified". That conflation
 * is what let Defect B ship.
 */
export function findPackagingProblems({ packagesDir = PKGS, pluginsDir = PLUGINS, packImpl = defaultPackImpl } = {}) {
  const problems = [];
  const consulted = [];
  const unconsultable = [];
  for (const target of publishTargets({ packagesDir, pluginsDir })) {
    const packed = packedFilePaths(target.dir, packImpl);
    if (!packed.ok) {
      unconsultable.push({ name: target.name, reason: packed.reason });
      continue;
    }
    consulted.push(target.name);
    for (const rel of scannableFiles(target.dir, packed.files)) {
      let source;
      try {
        source = readFileSync(join(target.dir, rel), 'utf8');
      } catch {
        continue;
      }
      for (const spec of relativeSpecifiers(source)) {
        // Resolve the specifier against the importing file's directory, then
        // express it back as a package-relative POSIX path to compare with npm's
        // file list — accepting any path Node itself would resolve the specifier
        // to, so an extensionless CJS require is not reported as an escape.
        const resolved = join(dirname(rel), spec).split('\\').join('/');
        if (resolutionCandidates(resolved).some((c) => packed.files.has(c))) continue;
        problems.push(
          `${target.name}: ${rel} imports ${spec} → ${resolved}, which the "files" allowlist does not publish ` +
            `(the installed package would fail at import time)`
        );
      }
    }
  }
  return { problems, consulted, unconsultable };
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
    // Injectable like regenerateLockfile/publishImpl so release.test.mjs keeps
    // its documented "no real npm, offline, leaves no trace" contract — and so
    // step 5's fail-closed behavior is testable at all.
    packImpl = defaultPackImpl,
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
    // Only ever UPDATE a version that already exists — never invent the field.
    // The gate applies the identical condition, so every surface the bumper can
    // write is a surface the gate checks, and nothing else.
    if (marketplace.metadata && 'version' in marketplace.metadata) {
      marketplace.metadata.version = version;
    }
    for (const entry of marketplace.plugins ?? []) {
      if ('version' in entry) entry.version = version;
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
  const packaging = findPackagingProblems({ packagesDir, pluginsDir, packImpl });
  if (packaging.problems.length > 0) {
    console.error(
      `packaging incomplete — aborting (the published package would fail on import):\n  ${packaging.problems.join('\n  ')}\n` +
        `  note: static imports, literal import()/require() are checked; a COMPUTED specifier is not decidable here.`
    );
    return 1;
  }
  // An unconsultable package is never silently clean. On a bare version bump it
  // is a warning — nothing leaves the machine, so blocking buys no safety and
  // would make offline releases impossible. With --publish it is FATAL: we are
  // about to run `npm publish` in the very directory where `npm pack` just
  // failed, so that failure is a signal about the next command, not a hiccup.
  if (packaging.unconsultable.length > 0) {
    const detail = packaging.unconsultable.map((u) => `${u.name}: ${u.reason}`).join('\n  ');
    if (publish) {
      console.error(
        `packaging UNVERIFIED for ${packaging.unconsultable.length} package(s) — aborting before publish:\n  ${detail}\n` +
          `  npm pack failed in a directory npm publish is about to run in. Fix npm access and re-run.`
      );
      return 1;
    }
    console.warn(
      `warning: packaging could not be verified for ${packaging.unconsultable.length} package(s):\n  ${detail}\n` +
        `  the bump continues (nothing is published), but --publish will refuse until this is resolved.`
    );
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
