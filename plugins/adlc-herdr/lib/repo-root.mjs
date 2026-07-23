// Repo-root resolution for pane cwds (plan §5.1, premortem prevention #4):
// `git rev-parse --show-toplevel`, so a git worktree resolves to its own
// root — never the main checkout. Cached per directory; failures resolve to
// null (pane excluded from the map, never a crash).
import { execFileSync } from 'node:child_process';

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
  cache.set(dir, root);
  return root;
}

/** Test hook: drop cached resolutions. */
export function clearRepoRootCache() {
  cache.clear();
}
