// railpath.mjs — symlink-aware rail-path canonicalization.
//
// Maps a tool-supplied path to the forward-slash, root-relative path a write
// would really land on. A symlink whose real target is a frozen rail must not
// pass a lexical check. Falls back to the lexical path for anything that
// cannot be resolved.

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
  const tail = [];
  let cur = abs;
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) break;
    tail.unshift(basename(cur));
    cur = parent;
  }
  const resolved = tail.length ? join(realpathOr(cur), tail.join('/')) : realpathOr(cur);
  return relative(realpathOr(root), resolved).split('\\').join('/');
}
