// railpath.mjs — symlink-aware rail-path canonicalization.
//
// Maps a tool-supplied path to the forward-slash, root-relative path a write
// would really land on. A symlink whose real target is a frozen rail must not
// pass a lexical check. Falls back to the lexical path for anything that
// cannot be resolved.

import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { isAbsolute, join, parse, relative } from 'node:path';

// The kernel's own bound on symlink hops per lookup (Linux MAXSYMLINKS).
const MAX_SYMLINK_HOPS = 40;

function realpathOr(p) {
  try { return realpathSync(p); } catch { return p; }
}

function segmentsOf(p) {
  return p.split(/[\\/]+/).filter(Boolean);
}

function lstatOrNull(p) {
  try { return lstatSync(p); } catch { return null; }
}

function readlinkOrNull(p) {
  try { return readlinkSync(p); } catch { return null; }
}

/**
 * Walk `segments` from the real directory `start` the way path lookup does:
 * left to right, expanding each symlink (including a dangling one) before the
 * next segment, so a `..` applies to the resolved prefix it follows. Once a
 * segment does not exist nothing below it can be a link, so the rest is
 * appended lexically. Returns null on a symlink loop (hop budget spent)
 * or a link that vanishes mid-walk.
 */
function walk(start, segments) {
  const queue = [...segments];
  let cur = start;
  let exists = true;
  let hops = 0;
  while (queue.length > 0) {
    const seg = queue.shift();
    if (seg === '.') continue;
    if (seg === '..') { cur = join(cur, '..'); continue; }
    const next = join(cur, seg);
    const st = exists ? lstatOrNull(next) : null;
    if (st?.isSymbolicLink()) {
      const target = ++hops > MAX_SYMLINK_HOPS ? null : readlinkOrNull(next);
      if (target === null) return null;
      if (isAbsolute(target)) cur = parse(target).root;
      queue.unshift(...segmentsOf(target));
      continue;
    }
    if (!st) exists = false;
    cur = next;
  }
  return cur;
}

/**
 * Resolve `filePath` against `root` in kernel order — each existing segment's
 * symlink expanded before the next segment (`..` included) is applied, and a
 * dangling symlink followed to the file a write through it would create — and
 * return it as a forward-slash path relative to the realpath-resolved root.
 * The file may not exist yet. A symlink loop or vanished link falls back to the lexical path.
 */
export function resolveRailPath(filePath, root) {
  const realRoot = realpathOr(root);
  const start = isAbsolute(filePath) ? parse(filePath).root : realRoot;
  const final = walk(start, segmentsOf(filePath))
    ?? (isAbsolute(filePath) ? filePath : join(realRoot, filePath));
  return relative(realRoot, final).split('\\').join('/');
}
