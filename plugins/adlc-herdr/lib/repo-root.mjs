// Repo-root resolution for pane cwds (plan §5.1, premortem prevention #4):
// `git rev-parse --show-toplevel`, so a git worktree resolves to its own
// root — never the main checkout. Cached per directory; failures resolve to
// null (pane excluded from the map, never a crash).
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, delimiter } from 'node:path';

const cache = new Map(); // dir -> { root, at }

// Positive resolutions are cached permanently (a git toplevel does not move).
// NEGATIVE resolutions are cached only briefly: long enough that a burst of
// high-frequency refreshes (socket events debounce to 400ms) over panes in
// non-git directories does NOT spawn `git` synchronously every time — which
// would stall the daemon's event loop — but short enough that a directory
// which later becomes a repo (a freshly opened worktree) is re-probed soon.
const NEG_TTL_MS = 30_000;
// Bound the cache so a weeks-long session opening panes in many ephemeral
// directories (test worktrees, /tmp) cannot grow it without limit. Map keeps
// insertion order, so evicting the oldest key is FIFO; an evicted positive
// entry is simply re-resolved on next use.
const MAX_ENTRIES = 1_000;

export function resolveRepoRoot(dir, now = Date.now) {
  const cached = cache.get(dir);
  if (cached) {
    if (cached.root !== null) return cached.root; // positive: permanent (until evicted)
    if (now() - cached.at < NEG_TTL_MS) return null; // negative: within TTL
  }
  let root = null;
  try {
    root = execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch {
    root = null;
  }
  cache.delete(dir); // re-insert at the end so refreshed entries are "newest"
  evictIfFull(cache, MAX_ENTRIES);
  cache.set(dir, { root, at: now() });
  return root;
}

/** Evict the oldest entry if the map is at/over `max` (FIFO on a Map's
 *  insertion order). Keeps the cache bounded across a long session. */
export function evictIfFull(map, max) {
  if (map.size >= max) map.delete(map.keys().next().value);
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
