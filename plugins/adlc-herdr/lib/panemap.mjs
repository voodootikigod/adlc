// Pane→repo mapping (plan §5.1). Published by the watcher (t-herdr-2) and
// consumed by the board (t-herdr-4) — contract frozen in test/panemap.test.mjs
// (rail). Repo resolution is injected: the daemon passes a
// `git rev-parse --show-toplevel` resolver, so a git worktree maps to its own
// root, never the main checkout.

/**
 * Map herdr snapshot panes to repo roots. The pane's directory is
 * `foreground_cwd` (live process cwd) with `cwd` as fallback. Panes without a
 * directory or a resolvable repo are excluded; a resolver failure excludes
 * that pane instead of crashing the map.
 */
export function buildPaneMap(panes, { resolveRepoRoot }) {
  if (!Array.isArray(panes)) return [];
  const out = [];
  for (const pane of panes) {
    if (!pane || typeof pane !== 'object' || typeof pane.pane_id !== 'string') continue;
    const dir = typeof pane.foreground_cwd === 'string' && pane.foreground_cwd.length > 0
      ? pane.foreground_cwd
      : typeof pane.cwd === 'string' && pane.cwd.length > 0 ? pane.cwd : null;
    if (dir === null) continue;
    let repoRoot = null;
    try {
      repoRoot = resolveRepoRoot(dir);
    } catch {
      repoRoot = null;
    }
    if (typeof repoRoot !== 'string' || repoRoot.length === 0) continue;
    out.push({ paneId: pane.pane_id, workspaceId: pane.workspace_id, repoRoot });
  }
  return out;
}

/** Group pane-map entries by repo root, preserving first-seen order. */
export function repoGroups(paneMap) {
  const groups = new Map();
  if (!Array.isArray(paneMap)) return groups;
  for (const entry of paneMap) {
    if (!entry || typeof entry.repoRoot !== 'string') continue;
    if (!groups.has(entry.repoRoot)) groups.set(entry.repoRoot, []);
    groups.get(entry.repoRoot).push(entry);
  }
  return groups;
}
