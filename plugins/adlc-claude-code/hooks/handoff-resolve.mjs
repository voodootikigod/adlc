// Resolve @adlc/context-handoff for the Claude Code handoff hook.
//
// The plugin install dir (~/.claude/plugins/cache/…) does not ship workspace
// packages, so a bare static import from this file would miss the project's
// (or monorepo's) node_modules. Walk createRequire anchors instead — sync
// require() of the ESM package works on Node ≥20.19 / 22+ (this repo's floor).

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SPEC = '@adlc/context-handoff';

/**
 * @param {string} start
 * @yields {string} ancestor directories including start
 */
function* walkUp(start) {
  let cur = start;
  for (let i = 0; i < 64; i++) {
    yield cur;
    const parent = dirname(cur);
    if (parent === cur) return;
    cur = parent;
  }
}

/**
 * Load `@adlc/context-handoff` from the project tree and/or plugin ancestry.
 * @param {{ projectRoot?: string|null, pluginHooksDir?: string }} [opts]
 * @returns {typeof import('@adlc/context-handoff') | null}
 */
export function loadContextHandoff({
  projectRoot = null,
  pluginHooksDir = dirname(fileURLToPath(import.meta.url)),
} = {}) {
  const anchors = [];
  if (typeof projectRoot === 'string' && projectRoot.length > 0) {
    anchors.push(join(projectRoot, 'package.json'));
  }
  for (const dir of walkUp(pluginHooksDir)) {
    anchors.push(join(dir, 'package.json'));
  }

  const seen = new Set();
  for (const anchor of anchors) {
    if (seen.has(anchor)) continue;
    seen.add(anchor);
    if (!existsSync(anchor)) continue;
    try {
      const req = createRequire(anchor);
      return req(SPEC);
    } catch {
      /* try next */
    }
  }

  // Last resort: filesystem walk for node_modules/@adlc/context-handoff and
  // require its lib entry by absolute path (covers odd layouts / NODE_PATH).
  const starts = [];
  if (typeof projectRoot === 'string' && projectRoot.length > 0) starts.push(projectRoot);
  starts.push(pluginHooksDir);
  for (const start of starts) {
    for (const dir of walkUp(start)) {
      const entry = join(dir, 'node_modules', '@adlc', 'context-handoff', 'lib', 'index.mjs');
      if (!existsSync(entry)) continue;
      try {
        const req = createRequire(entry);
        return req(entry);
      } catch {
        /* keep walking */
      }
    }
  }
  return null;
}
