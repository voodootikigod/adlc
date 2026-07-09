// pi-resolve.mjs — resolve a pi-runtime peer package that is NOT hoisted to the
// repo root. Peers like `typebox` and `@earendil-works/pi-tui` ship nested under
// @earendil-works/pi-coding-agent/node_modules, so a BARE dynamic import of the
// specifier does NOT resolve at pi runtime — it silently rejects and every
// caller degrades (this was a latent Phase-3 bug in renderers.mjs' default
// loader). This module ports the pi-anchored resolution ladder proven in
// prosecute-tool.mjs (for typebox) and generalizes it so renderers.mjs (pi-tui)
// and gate-tool.mjs / prosecute-tool.mjs (typebox) share ONE resolver.
//
// The specifier is only ever passed to createRequire.resolve or a computed
// file: URL import — never a static import — so the TypeScript nodenext resolver
// in CI (`tsc --allowJs` over index.ts) never tries to resolve these nested,
// runtime-only packages, and `node --test` from the repo root stays loadable
// (the import is dynamic; absence just throws for the caller to swallow).

import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Assembled by join so this file carries no static specifier for the resolver.
const PI_PACKAGE = ['@earendil-works', 'pi-coding-agent'].join('/');

/** Import a module by absolute path or file: URL. */
async function importPath(pathOrUrl) {
  const url = pathOrUrl.startsWith('file:') ? pathOrUrl : pathToFileURL(pathOrUrl).href;
  return import(url);
}

/**
 * Resolve a package dir's ESM entry file from its package.json, honoring the
 * `exports['.']` map first (import/default condition), then `module`, then
 * `main`, then a bare index.js. Returns an absolute path or null.
 */
function packageEntry(pkgDir) {
  try {
    const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
    const exp = pkg.exports;
    const dot = exp && typeof exp === 'object' ? exp['.'] ?? exp : undefined;
    const rel =
      (dot && typeof dot === 'object' ? dot.import ?? dot.default : typeof dot === 'string' ? dot : undefined) ??
      pkg.module ?? pkg.main ?? 'index.js';
    return join(pkgDir, typeof rel === 'string' ? rel : 'index.js');
  } catch {
    return null;
  }
}

/**
 * Resolve + import a pi-runtime peer by specifier via a ladder of strategies so
 * it works under jiti (how pi loads extensions) and plain Node, hoisted or not.
 * Throws if every strategy fails (e.g. a plain `node --test` where the peer is
 * genuinely absent) — callers decide how to degrade.
 *
 * @param {string} specifier  e.g. 'typebox' or '@earendil-works/pi-tui'
 * @param {{ anchor?: string }} [opts]  module URL to anchor the walk (tests only)
 * @returns {Promise<any>} the imported module namespace
 */
export async function resolvePiPeer(specifier, { anchor = import.meta.url } = {}) {
  const require = createRequire(anchor);
  const segments = specifier.split('/');

  // 1. Direct resolve — works if the peer is hoisted / a direct dependency.
  try {
    return await importPath(require.resolve(specifier));
  } catch { /* try next */ }

  // 2. Anchor on the pi package via the ESM resolver, then resolve the nested
  //    peer from there (the layout pi ships).
  if (typeof import.meta.resolve === 'function') {
    try {
      const piUrl = import.meta.resolve(PI_PACKAGE);
      const piRequire = createRequire(fileURLToPath(piUrl));
      return await importPath(piRequire.resolve(specifier));
    } catch { /* try next */ }
  }

  // 3. Filesystem walk up from the anchor: look for the peer nested under pi's
  //    node_modules first, then a hoisted install. Jiti-agnostic, deterministic.
  let dir = dirname(fileURLToPath(anchor));
  while (true) {
    for (const rel of [
      ['node_modules', ...PI_PACKAGE.split('/'), 'node_modules', ...segments],
      ['node_modules', ...segments],
    ]) {
      const pkgDir = join(dir, ...rel);
      if (existsSync(join(pkgDir, 'package.json'))) {
        const entry = packageEntry(pkgDir);
        if (entry && existsSync(entry)) {
          try {
            return await importPath(entry);
          } catch { /* keep walking */ }
        }
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  throw new Error(`could not resolve pi-runtime peer "${specifier}"`);
}
