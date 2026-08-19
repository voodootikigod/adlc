// Resolve @adlc/context-handoff for the Claude Code handoff hook.
//
// The plugin install dir (~/.claude/plugins/cache/…) does not ship workspace
// packages, so a bare static import from this file would miss the project's
// (or monorepo's) node_modules. Resolve via createRequire, then dynamic-import
// the ESM entry — sync require() of pure-ESM packages fails on Node 18
// (ERR_REQUIRE_ESM); CI still matrices node 18.

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SPEC = '@adlc/context-handoff';

/** @param {unknown} v */
function nonEmptyString(v) {
  if (typeof v !== 'string') return false;
  return v !== '';
}

/**
 * @param {string} start
 * @yields {string} ancestor directories including start
 */
function* walkUp(start) {
  let cur = start;
  const seen = new Set();
  while (!seen.has(cur)) {
    seen.add(cur);
    yield cur;
    const parent = dirname(cur);
    if (parent === cur) return;
    cur = parent;
  }
}

/**
 * Does this runtime honour `import.meta.resolve`'s second (`parent`) argument?
 *
 * A relative specifier is resolved purely as URL arithmetic — no filesystem
 * access, no package lookup — so a probe against a synthetic parent is both
 * cheap and side-effect free: if the parent is honoured the answer lands beside
 * it, and if it is ignored the answer lands beside this module instead.
 * @returns {boolean}
 */
function importMetaResolveHonoursParent() {
  if (typeof import.meta.resolve !== 'function') return false;
  try {
    const parent = new URL('./__adlc_resolve_probe__/package.json', import.meta.url).href;
    return import.meta.resolve('./probe.mjs', parent) === new URL('./probe.mjs', parent).href;
  } catch {
    return false;
  }
}

/**
 * `node_modules` directories that hold GLOBAL installs — the ones neither the
 * project root nor the plugin's own ancestry can reach.
 *
 * Both plugins document exactly one install route, `npm install -g @adlc/cli`,
 * which lands @adlc/context-handoff outside every path the walks above cover
 * (issue #526). npm's global root is derived from the running interpreter
 * rather than shelled out to (`npm root -g` in a PreToolUse hook would cost a
 * process spawn on every tool call), and NODE_PATH is honoured for prefixes
 * that layout differently.
 *
 * @param {{ env?: Record<string, string|undefined>, execPath?: string }} [opts]
 * @returns {string[]} candidate node_modules directories, most explicit first
 */
export function globalModuleDirs({ env = process.env, execPath = process.execPath } = {}) {
  const dirs = [];
  const add = (dir) => {
    if (nonEmptyString(dir) && !dirs.includes(dir)) dirs.push(dir);
  };

  const nodePath = env?.NODE_PATH;
  if (nonEmptyString(nodePath)) {
    for (const part of nodePath.split(delimiter)) add(part);
  }

  if (nonEmptyString(execPath)) {
    const binDir = dirname(execPath);
    // Windows npm prefix: <prefix>\node.exe with <prefix>\node_modules beside it.
    add(join(binDir, 'node_modules'));
    // POSIX npm prefix: <prefix>/bin/node with <prefix>/lib/node_modules.
    add(join(dirname(binDir), 'lib', 'node_modules'));
  }

  return dirs;
}

/**
 * Layouts npm actually produces for a global `@adlc/cli` install: the package
 * hoisted to the global root, or nested under the CLI that depends on it.
 */
const GLOBAL_PACKAGE_LAYOUTS = [
  ['@adlc', 'context-handoff'],
  ['@adlc', 'cli', 'node_modules', '@adlc', 'context-handoff'],
];

/**
 * Resolve `@adlc/context-handoff` out of a global install, or null.
 * Filesystem and module-resolution lookups only — this never imports the
 * package, which `recoveryDiagnostic` and the recovery-exception matcher in the
 * handoff gates both depend on.
 * @param {{ env?: Record<string, string|undefined>, execPath?: string }} [opts]
 * @returns {string|null}
 */
function resolveFromGlobalInstall(opts) {
  for (const dir of globalModuleDirs(opts)) {
    for (const segments of GLOBAL_PACKAGE_LAYOUTS) {
      const pkgDir = join(dir, ...segments);
      const manifest = join(pkgDir, 'package.json');
      if (!existsSync(manifest)) continue;
      try {
        // Honours the package's `exports` when the layout is walk-up-reachable.
        return createRequire(manifest).resolve(SPEC);
      } catch {
        /* NODE_PATH dirs are not on node's own walk-up; fall through */
      }
      const entry = join(pkgDir, 'lib', 'index.mjs');
      if (existsSync(entry)) return entry;
    }
  }
  return null;
}

/**
 * Resolve the absolute filesystem path of `@adlc/context-handoff`'s ESM entry.
 * @param {{ projectRoot?: string|null, pluginHooksDir?: string, env?: Record<string, string|undefined>, execPath?: string }} [opts]
 * @returns {string|null}
 */
export function resolveContextHandoffEntry({
  projectRoot = null,
  pluginHooksDir = dirname(fileURLToPath(import.meta.url)),
  env = process.env,
  execPath = process.execPath,
} = {}) {
  const anchors = [];
  if (nonEmptyString(projectRoot)) {
    anchors.push(join(projectRoot, 'package.json'));
  }
  for (const dir of walkUp(pluginHooksDir)) {
    anchors.push(join(dir, 'package.json'));
  }

  // Prefer ESM resolve when available (avoids CJS export-condition gaps) — but
  // ONLY when this runtime honours the `parent` argument. Node stabilized
  // one-argument `import.meta.resolve` and left the second argument behind
  // --experimental-import-meta-resolve, where it is silently IGNORED rather
  // than rejected. Unguarded, this branch resolved from THIS FILE's location
  // instead of `projectRoot` — in the monorepo it happened to find the right
  // package, and anywhere else it threw and fell through, which is why it went
  // unnoticed; the failure it can produce is loading a different tree's
  // @adlc/context-handoff than the project actually installed.
  if (nonEmptyString(projectRoot) && importMetaResolveHonoursParent()) {
    try {
      const url = import.meta.resolve(SPEC, pathToFileURL(join(projectRoot, 'package.json')).href);
      if (typeof url === 'string' && url.startsWith('file:')) {
        return fileURLToPath(url);
      }
    } catch {
      /* fall through to createRequire.resolve */
    }
  }

  const seen = new Set();
  for (const anchor of anchors) {
    if (seen.has(anchor)) continue;
    seen.add(anchor);
    if (!existsSync(anchor)) continue;
    try {
      const req = createRequire(anchor);
      return req.resolve(SPEC);
    } catch {
      /* try next */
    }
  }

  const starts = [];
  if (nonEmptyString(projectRoot)) starts.push(projectRoot);
  starts.push(pluginHooksDir);
  for (const start of starts) {
    for (const dir of walkUp(start)) {
      const entry = join(dir, 'node_modules', '@adlc', 'context-handoff', 'lib', 'index.mjs');
      if (existsSync(entry)) return entry;
    }
  }

  // Global installs last: a project-local or monorepo copy keeps winning, so
  // existing resolution order — and the trust ordering that rests on it — is
  // unchanged by this fallback.
  return resolveFromGlobalInstall({ env, execPath });
}

/**
 * Load `@adlc/context-handoff` from the project tree, the plugin ancestry, or a
 * global install. Async because the package is ESM-only (Node 18 cannot
 * sync-require it).
 * @param {{ projectRoot?: string|null, pluginHooksDir?: string, env?: Record<string, string|undefined>, execPath?: string }} [opts]
 * @returns {Promise<typeof import('@adlc/context-handoff') | null>}
 */
export async function loadContextHandoff(opts = {}) {
  const entry = resolveContextHandoffEntry(opts);
  if (!entry) return null;
  try {
    return await import(pathToFileURL(entry).href);
  } catch {
    return null;
  }
}
