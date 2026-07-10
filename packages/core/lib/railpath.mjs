// railpath.mjs — symlink-aware rail-path canonicalization.
//
// Security-relevant: a symlink whose real target is a frozen rail (e.g. an
// alias pointing at .adlc/tickets.json) must not slip a write past a lexical
// name check. First shipped inline in plugins/adlc-opencode/rails-checker.mjs;
// hoisted here so every integration adapter shares one implementation.

import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';

function realpathOr(p) {
  try { return realpathSync(p); } catch { return p; }
}

/**
 * Resolve symlinks on the target and on its existing parent segments before
 * comparing to a frozen rail set, returning a forward-slash path relative to
 * the (also realpath-resolved) root. The file may not exist yet (a `write`
 * creating it): resolve the deepest existing ancestor (catches a symlinked
 * parent dir), then re-append the tail. Falls back to the lexical path for
 * anything that can't be resolved.
 */
export function resolveRailPath(filePath, root) {
  const abs = isAbsolute(filePath) ? filePath : join(root, filePath);
  let resolved;
  if (existsSync(abs)) {
    resolved = realpathOr(abs);
  } else {
    resolved = join(realpathOr(dirname(abs)), basename(abs));
  }
  return relative(realpathOr(root), resolved).split('\\').join('/');
}
