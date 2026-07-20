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
// acorn is a devDependency of the PRIVATE root package, used only by repo
// tooling. No published @adlc/* package gains a runtime dependency from it —
// see the note on relativeSpecifiers for why a real parser is required here.
import { parse } from 'acorn';

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
/**
 * Three distinct states, deliberately NOT collapsed into a boolean:
 *   'unparseable' — the file is not valid JSON at all
 *   'versioned'   — carries a string `version`
 *   'unversioned' — parses, but declares no string `version`
 *
 * The distinction decides whether silence is correct. A NESTED
 * `.<host>-plugin/plugin.json` is unambiguously a host manifest, so
 * 'unversioned' there is a defect worth reporting. A FLAT
 * `plugins/<x>/plugin.json` carries no such proof — it may legitimately be some
 * tool's config file — so 'unversioned' there must stay silent, while
 * 'unparseable' is a defect either way: a file named plugin.json that is not
 * valid JSON is broken regardless of whose it is.
 */
function manifestState(manifestPath) {
  let parsed;
  try {
    parsed = readJson(manifestPath);
  } catch {
    return 'unparseable';
  }
  return typeof parsed?.version === 'string' ? 'versioned' : 'unversioned';
}

function declaresVersion(manifestPath) {
  return manifestState(manifestPath) === 'versioned';
}

export function hostPluginManifestPaths(pluginsDir = PLUGINS) {
  if (!existsSync(pluginsDir)) return [];
  const paths = [];
  for (const name of readdirSync(pluginsDir).sort()) {
    // The OUTER loop needs its own skip: `plugins/node_modules/.claude-plugin/
    // plugin.json` and `plugins/node_modules/plugin.json` are both reachable at
    // this depth and would otherwise be discovered and rewritten. (The inner
    // loop's skip is redundant with HOST_PLUGIN_DIR, but harmless and explicit.)
    if (name === 'node_modules') continue;
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
      if (name === 'node_modules') continue;
      scan(join(pluginsDir, name), 'plugin.json', 'plugin manifest');
      // A manifest INSIDE a directory that does match HOST_PLUGIN_DIR is
      // unambiguously a host manifest. If it declares no string `version` (or
      // does not parse), hostPluginManifestPaths drops it — so the bumper never
      // writes it and the gate, sharing that discovery, never checks it. That is
      // Defect A at field granularity, and near-miss scanning cannot see it
      // because the DIRECTORY name is fine. Report it explicitly.
      const dir = join(pluginsDir, name);
      // The FLAT manifest needs the same treatment as the nested ones below.
      // Round three added the nested check and not this one, so a malformed or
      // versionless plugins/<x>/plugin.json stayed invisible to bumper, gate and
      // near-miss alike — reintroducing Defect A through the one shape the fix
      // was originally written for (antigravity's layout).
      const flatManifest = join(dir, 'plugin.json');
      // UNPARSEABLE only. A flat plugin.json that parses but declares no
      // version is legitimately somebody's config file, and reporting those
      // would abort the release on files that are none of our business.
      if (existsSync(flatManifest) && manifestState(flatManifest) === 'unparseable') {
        misses.push(
          `${flatManifest}: flat host manifest is not valid JSON — ` +
            `it is invisible to BOTH the bump and the drift gate.`
        );
      }
      let entries;
      try {
        entries = readdirSync(dir).sort();
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!HOST_PLUGIN_DIR.test(entry)) continue;
        const manifest = join(dir, entry, 'plugin.json');
        if (!existsSync(manifest) || declaresVersion(manifest)) continue;
        misses.push(
          `${manifest}: host manifest has no string "version" field (or does not parse) — ` +
            `it is invisible to BOTH the bump and the drift gate.`
        );
      }
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

  // NOTE: near-miss host directories are deliberately NOT reported here.
  // findVersionDrift runs AFTER the tree has been rewritten, and every entry it
  // returns must describe something a re-run of the bumper can fix. A near miss
  // names a DIRECTORY, which no bump can rename — reporting it here made
  // releaseMain abort identically on every invocation with a fully mutated
  // working tree, which is the exact failure this file already documents and
  // fixed for the metadata-less marketplace case. It is a PRE-bump preflight
  // instead; see releaseMain step 0.
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

const ACORN_OPTIONS = { ecmaVersion: 'latest', allowHashBang: true, allowReturnOutsideFunction: true };

/**
 * Extract every RELATIVE module specifier from a source file, using a real
 * parser rather than pattern matching.
 *
 * Why a parser, and why a dependency in a repo that prizes having none: being
 * correct here requires tracking JavaScript's LEXICAL STATE, and `/` is
 * ambiguous in a way that is not decidable lexically — telling `a / b` from a
 * regex literal requires knowing whether an operand or an operator is expected.
 * A hand-rolled lexer shipped here first and was measurably fail-OPEN: given
 * `return /[\`*?]/.test(t)` — the exact shape of packages/core/lib/shell.mjs:119,
 * a file inside @adlc/core's published `files` — it walked into the regex body,
 * opened a string on the backtick, and swallowed every subsequent import to EOF.
 * A published file was invisible to this gate. Two independent reviewers reached
 * that conclusion before it was accepted.
 *
 * The dependency cost is narrower than it looks: acorn is a devDependency of the
 * PRIVATE root package, used only by repo tooling. No published @adlc/* package
 * gains a runtime dependency, so the zero-runtime-dependency convention for
 * shipped packages is untouched.
 *
 * Fail-closed contract: a file that cannot be parsed is NOT reported clean — it
 * throws, and findPackagingProblems records the package as `unconsultable`, the
 * same three-state discipline applied to an npm pack failure. "Could not check"
 * must never render as "verified".
 *
 * Still undecidable, and stated rather than implied: a COMPUTED specifier
 * (`import(someVar)`) cannot be resolved statically by any parser.
 */
function relativeSpecifiers(source, { sourceType }) {
  const ast = parse(source, { ...ACORN_OPTIONS, sourceType });
  const found = new Set();

  // A template literal with no interpolations is a compile-time constant and
  // therefore statically decidable — `import(`./lib.mjs`)` must be checked like
  // its quoted twin. Only a template with `${}` expressions is genuinely
  // undecidable.
  const literal = (node) => {
    if (!node) return null;
    if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
    if (node.type === 'TemplateLiteral' && node.expressions.length === 0 && node.quasis.length === 1) {
      return node.quasis[0].value.cooked;
    }
    return null;
  };
  const add = (value) => {
    if (typeof value === 'string' && value.startsWith('.')) found.add(value);
  };

  const visit = (node) => {
    if (!node || typeof node.type !== 'string') return;
    switch (node.type) {
      case 'ImportDeclaration':
      case 'ExportNamedDeclaration':
      case 'ExportAllDeclaration':
      case 'ImportExpression':
        add(literal(node.source));
        break;
      case 'CallExpression': {
        const c = node.callee;
        const isRequire = c && c.type === 'Identifier' && c.name === 'require';
        const isRequireResolve = c && c.type === 'MemberExpression' && !c.computed &&
          c.object && c.object.type === 'Identifier' && c.object.name === 'require' &&
          c.property && c.property.type === 'Identifier' && c.property.name === 'resolve';
        if (isRequire || isRequireResolve) add(literal(node.arguments && node.arguments[0]));
        break;
      }
      default:
        break;
    }
    for (const key of Object.keys(node)) {
      if (key === 'type' || key === 'loc' || key === 'range' || key === 'start' || key === 'end') continue;
      const child = node[key];
      if (Array.isArray(child)) child.forEach(visit);
      else if (child && typeof child === 'object') visit(child);
    }
  };

  visit(ast);
  return [...found];
}

/**
 * Parse as ESM first, falling back to script for genuine CommonJS: a `.cjs` file
 * using top-level `require` parses only as script, and an ESM file with
 * top-level await parses only as module. Both are attempted before a file is
 * declared unparseable.
 */
function specifiersForFile(source, rel) {
  const order = rel.endsWith('.cjs') ? ['script', 'module'] : ['module', 'script'];
  let lastError;
  for (const sourceType of order) {
    try {
      return relativeSpecifiers(source, { sourceType });
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
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
function resolutionCandidates(resolved, mode) {
  if (JS_EXTENSION.test(resolved)) return [resolved];
  // ESM appends NO extensions and resolves no directory index — a bare
  // './helper' in an .mjs file is simply unresolvable. Applying the CommonJS
  // fallbacks there would let a genuine ERR_MODULE_NOT_FOUND pass as clean,
  // which is the very symptom this gate exists to catch.
  if (mode === 'esm') return [resolved];
  // Mirrors Node's CommonJS resolver: X, X.js, X.json, X.node, then X/index.js,
  // X/index.json, X/index.node. Omitting .node and the index.json/index.node
  // forms produced a release-BLOCKING false positive on specifiers Node resolves
  // fine (`require('./binding')` against a shipped binding.node).
  return [
    resolved,
    `${resolved}.js`, `${resolved}.cjs`, `${resolved}.mjs`, `${resolved}.json`, `${resolved}.node`,
    `${resolved}/index.js`, `${resolved}/index.cjs`, `${resolved}/index.mjs`,
    `${resolved}/index.json`, `${resolved}/index.node`,
  ];
}

/**
 * Which resolver Node will use for a shipped file: `.mjs` is always ESM, `.cjs`
 * always CommonJS, and a bare `.js` follows the package's `type` field.
 */
function resolutionMode(rel, pkgType) {
  if (rel.endsWith('.mjs')) return 'esm';
  if (rel.endsWith('.cjs')) return 'cjs';
  return pkgType === 'module' ? 'esm' : 'cjs';
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
  const missingBins = [];
  let pkg;
  try {
    pkg = readJson(join(dir, 'package.json'));
  } catch {
    return { files, missingBins, type: undefined };
  }
  // Every DECLARED entrypoint, not just bin. VERIFIED npm behaviour: npm
  // force-includes `bin` and `main` regardless of `files`, but does NOT
  // force-include `exports` targets — packing `exports: {'./side':
  // './extra/side.mjs'}` with `files: ['lib/']` omits extra/side.mjs entirely.
  // So an `exports` subpath is the same defect class as a missing bin, without
  // npm's safety net: the import resolves for the author and 404s for everyone
  // who installs it.
  const entrypoints = [];
  const collect = (label, value) => {
    if (typeof value === 'string') {
      if (value.startsWith('.')) entrypoints.push([label, value]);
      return;
    }
    // `exports` nests arbitrarily: subpaths, and condition objects
    // (import/require/default/node/browser...). Walk every string leaf.
    if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) collect(`${label}${k.startsWith('.') ? k.slice(1) : `.${k}`}`, v);
    }
  };
  collect('bin', pkg.bin);
  collect('main', pkg.main);
  collect('module', pkg.module);
  collect('exports', pkg.exports);

  const reported = new Set();
  for (const [name, entry] of entrypoints) {
    const rel = String(entry).replace(/^\.\//, '');
    if (rel.includes('*')) continue; // subpath PATTERN — not a single file, out of scope
    if (packed.has(rel)) {
      // EXISTENCE is checked for every entrypoint; PARSING only for files that
      // are actually JavaScript. `exports` legitimately points at `index.d.ts`
      // (a types condition) and at `./package.json` — neither is parseable by a
      // JS parser, and treating a parse failure there as "unconsultable" marked
      // @adlc/core, @adlc/tickets and @adlc/init unverifiable, which under
      // --publish would block the release outright.
      if (/\.(mjs|js|cjs)$/.test(rel) || !/\.[a-z0-9]+$/i.test(rel)) files.add(rel);
    } else if (!reported.has(rel)) {
      // A declared entrypoint absent from the tarball is worse than a broken
      // import: for `bin`, `npm i -g` creates a shim to a nonexistent file and
      // every invocation dies with ENOENT before any import runs; for `exports`,
      // the documented subpath simply does not exist in the published package.
      // Deduped by target path — an `exports` condition object names the same
      // file once per condition (import/require/default) and that is one defect,
      // not three.
      reported.add(rel);
      missingBins.push({ name, rel });
    }
  }
  return { files, missingBins, type: pkg.type };
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
    const { files, missingBins, type } = scannableFiles(target.dir, packed.files);
    for (const { name, rel } of missingBins) {
      const consequence = name.startsWith('bin')
        ? 'the installed CLI would not exist — every invocation fails with ENOENT'
        : 'the documented entrypoint would not exist in the published package';
      problems.push(
        `${target.name}: package.json ${name} points at ${rel}, which the "files" allowlist does not publish ` +
          `(${consequence})`
      );
    }

    // A file we cannot PARSE is not a file we have checked. Marking the package
    // unconsultable rather than consulted keeps "could not check" distinct from
    // "verified clean" — the same discipline applied to an npm pack failure, and
    // the property whose absence made the previous hand-rolled lexer fail OPEN.
    let unparseable = null;
    const specsByFile = new Map();
    for (const rel of files) {
      let source;
      try {
        source = readFileSync(join(target.dir, rel), 'utf8');
      } catch (err) {
        // Same polarity as a parse failure. Skipping an unreadable file while
        // still counting the package as `consulted` would put it in the
        // denominator that callers read as "inspected" — a dangling symlink or
        // a permission error would then be indistinguishable from a clean scan.
        unparseable = `${rel} could not be read: ${err.message}`;
        break;
      }
      try {
        specsByFile.set(rel, specifiersForFile(source, rel));
      } catch (err) {
        unparseable = `${rel} could not be parsed as ESM or CommonJS: ${err.message}`;
        break;
      }
    }
    if (unparseable) {
      unconsultable.push({ name: target.name, reason: unparseable });
      continue;
    }

    consulted.push(target.name);
    for (const [rel, specs] of specsByFile) {
      const mode = resolutionMode(rel, type);
      for (const spec of specs) {
        // Resolve the specifier against the importing file's directory, then
        // express it back as a package-relative POSIX path to compare with npm's
        // file list — accepting any path Node's resolver for THIS file's mode
        // would accept, so an extensionless CJS require is not a false positive
        // while an unresolvable ESM specifier still is.
        const resolved = join(dirname(rel), spec).split('\\').join('/');
        if (resolutionCandidates(resolved, mode).some((c) => packed.files.has(c))) continue;
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

  // 0. PREFLIGHT — before a single file is written. A host directory whose name
  // the shape regex misses is invisible to both the bump and the drift gate (the
  // Defect A shape), and no re-run of the bumper can rename a directory. Checking
  // it post-bump would abort forever with a mutated tree; checking it here aborts
  // with the tree untouched and a fixable instruction.
  const nearMisses = hostDiscoveryNearMisses({ root, pluginsDir });
  // Every JSON file the bump will REWRITE must be parseable before we write the
  // first one. hostMarketplacePaths checks only existence, and the bump then does
  // a bare readJson — so a merge-conflict marker in .claude-plugin/marketplace.json
  // threw an uncaught SyntaxError out of releaseMain AFTER packages/*, plugins/*
  // and every host manifest had already been rewritten: a mutated tree, no
  // diagnostic, and no return-1 path. Same failure class already fixed twice
  // (metadata-less marketplace, non-JSON npm pack output).
  for (const jsonPath of [...hostMarketplacePaths(root), join(root, 'package.json')]) {
    try {
      readJson(jsonPath);
    } catch (err) {
      nearMisses.push(`${jsonPath}: not valid JSON (${err.message}) — the bump would abort mid-write`);
    }
  }
  if (nearMisses.length > 0) {
    console.error(
      `release preflight failed — aborting before any file is modified:\n  ${nearMisses.join('\n  ')}`
    );
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
