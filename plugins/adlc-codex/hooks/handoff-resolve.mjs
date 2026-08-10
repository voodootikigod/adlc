// Resolve @adlc/context-handoff for the Claude Code handoff hook.
//
// The plugin install dir (~/.claude/plugins/cache/…) does not ship workspace
// packages, so a bare static import from this file would miss the project's
// (or monorepo's) node_modules. Resolve via createRequire, then dynamic-import
// the ESM entry — sync require() of pure-ESM packages fails on Node 18
// (ERR_REQUIRE_ESM); CI still matrices node 18.

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
 * Resolve the absolute filesystem path of `@adlc/context-handoff`'s ESM entry.
 * @param {{ projectRoot?: string|null, pluginHooksDir?: string }} [opts]
 * @returns {string|null}
 */
export function resolveContextHandoffEntry({
  projectRoot = null,
  pluginHooksDir = dirname(fileURLToPath(import.meta.url)),
} = {}) {
  const anchors = [];
  if (nonEmptyString(projectRoot)) {
    anchors.push(join(projectRoot, 'package.json'));
  }
  for (const dir of walkUp(pluginHooksDir)) {
    anchors.push(join(dir, 'package.json'));
  }

  // Prefer ESM resolve when available (avoids CJS export-condition gaps).
  if (nonEmptyString(projectRoot) && typeof import.meta.resolve === 'function') {
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
  return null;
}

/**
 * Load `@adlc/context-handoff` from the project tree and/or plugin ancestry.
 * Async because the package is ESM-only (Node 18 cannot sync-require it).
 * @param {{ projectRoot?: string|null, pluginHooksDir?: string }} [opts]
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
