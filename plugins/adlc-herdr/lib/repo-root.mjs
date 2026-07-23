// Repo-root resolution for pane cwds (plan §5.1, premortem prevention #4):
// `git rev-parse --show-toplevel`, so a git worktree resolves to its own
// root — never the main checkout. Cached per directory; failures resolve to
// null (pane excluded from the map, never a crash).
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, delimiter } from 'node:path';

const cache = new Map();

export function resolveRepoRoot(dir) {
  if (cache.has(dir)) return cache.get(dir);
  let root = null;
  try {
    root = execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch {
    root = null;
  }
  // Cache only SUCCESSFUL resolutions. This runs inside a session-long daemon:
  // caching null would let one transient git failure (timeout under load, a
  // momentary lock) blind a pane for the whole process lifetime, and would
  // pin a directory that only later becomes a repo (a freshly opened worktree)
  // as non-repo forever. Negative results are re-probed on the next refresh.
  if (root !== null) cache.set(dir, root);
  return root;
}

/** Test hook: drop cached resolutions. */
export function clearRepoRootCache() {
  cache.clear();
}

/** Resolve a binary name against PATH entries (first hit wins), or null.
 *  Used to fail closed BEFORE spawning anything that needs the binary. */
export function resolveOnPath(bin, pathValue) {
  const entries = typeof pathValue === 'string' ? pathValue.split(delimiter) : [];
  for (const dir of entries) {
    if (dir && existsSync(join(dir, bin))) return join(dir, bin);
  }
  return null;
}
