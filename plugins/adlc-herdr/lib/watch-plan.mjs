// Pure token-assembly planner for the watcher (t-herdr-2). Extracted from
// bin/watcher.mjs so the decision-shaped logic — which panes get which tokens,
// and how workspace backlog counts combine — is unit-testable without a herdr
// host. The daemon does the I/O (snapshot, file reads, publishing); this turns
// (paneMap, per-repo state) into the token maps to publish.
import { join } from 'node:path';
import { paneTokens, workspaceTokens } from './tokens.mjs';

/**
 * Which directories the watcher should attach an `fs.watch` to for `repoRoot`
 * that it is NOT already watching — `.adlc` and (once it exists) `.adlc/tickets`.
 * Pure so the "tickets dir created after the repo was first seen" race is
 * testable: passing the same `watched` set across calls, the tickets dir is
 * returned on the first call where `exists` reports it, even though `.adlc`
 * was already watched. A non-recursive watch on `.adlc` does not fire for
 * shard edits inside `.adlc/tickets`, so that directory needs its own watch.
 */
export function pendingWatchDirs(repoRoot, watched, exists) {
  const adlcDir = join(repoRoot, '.adlc');
  if (!exists(adlcDir)) return [];
  const out = [];
  for (const dir of [adlcDir, join(adlcDir, 'tickets')]) {
    if (exists(dir) && !watched.has(dir)) out.push(dir);
  }
  return out;
}

/**
 * Wrap `action` so it runs AT MOST once, no matter how many times the result
 * is called. Used for socket reconnect: a failed connection emits both `error`
 * and `close`, and scheduling a retry on each would double the attempts every
 * failure (2^N) until file descriptors are exhausted.
 */
export function once(action) {
  let done = false;
  return (...args) => {
    if (done) return undefined;
    done = true;
    return action(...args);
  };
}

/**
 * Map `fn` over `items` with at most `limit` in flight at once, preserving
 * result order. Bounds the fan-out of subprocess-spawning reads so a session
 * with many open worktrees doesn't spawn one `adlc` process per worktree all
 * at once on each heartbeat (a cache stampede that pegs the host).
 */
export async function mapLimit(items, limit, fn) {
  const list = Array.isArray(items) ? items : [];
  const results = new Array(list.length);
  let next = 0;
  const workers = Math.max(1, Math.min(limit, list.length));
  async function run() {
    while (next < list.length) {
      const idx = next;
      next += 1;
      results[idx] = await fn(list[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: workers }, run));
  return results;
}

/**
 * Watched directories whose repo is no longer active — the FSWatchers to
 * close so a long session navigating many repos does not leak inotify watches
 * until it hits the OS limit. `watchedDirs` maps dir → {repoRoot}; `active`
 * is the set of currently-present repo roots.
 */
export function staleWatchDirs(watchedDirs, active) {
  const stale = [];
  for (const [dir, info] of watchedDirs) {
    if (!active.has(info.repoRoot)) stale.push(dir);
  }
  return stale;
}

/**
 * Watched directories that no longer exist on disk. Deleting a watched dir
 * emits `rename`/`change` (NOT `error`), so an error-handler self-heal never
 * fires — the daemon must actively check existence each refresh, drop the dead
 * watch, and let `pendingWatchDirs` re-attach when the dir reappears (the
 * `rm -rf .adlc && adlc init` case). `exists` is injected for testability.
 */
export function deadWatchDirs(watchedDirs, exists) {
  const dead = [];
  for (const dir of watchedDirs.keys()) if (!exists(dir)) dead.push(dir);
  return dead;
}

/**
 * @param {Array<{paneId, workspaceId, repoRoot}>} paneMap
 * @param {Map<string,{active, phase, counts}>} repoState  keyed by repoRoot
 * @returns {{nextPane: Map<string,object>, nextWorkspace: Map<string,object>}}
 *
 * Workspace backlog counts AGGREGATE across the distinct repos in that
 * workspace (summed once per repoRoot) rather than last-writer-wins — a herdr
 * workspace routinely spans the main checkout plus its worktrees, each a
 * distinct repo root, and the previous per-repo overwrite made the published
 * counts depend on snapshot iteration order (flicker + wrong totals).
 */
export function planTokens(paneMap, repoState) {
  const nextPane = new Map();
  const accByWs = new Map(); // workspaceId -> {ready,inFlight,blocked, repos:Set}
  for (const entry of Array.isArray(paneMap) ? paneMap : []) {
    const state = repoState.get(entry.repoRoot);
    if (!state) continue;
    const tokens = paneTokens(state.active, state.phase);
    if (Object.keys(tokens).length > 0) nextPane.set(entry.paneId, tokens);
    if (!state.counts || typeof entry.workspaceId !== 'string') continue;
    let acc = accByWs.get(entry.workspaceId);
    if (!acc) {
      acc = { ready: 0, inFlight: 0, blocked: 0, repos: new Set() };
      accByWs.set(entry.workspaceId, acc);
    }
    if (!acc.repos.has(entry.repoRoot)) {
      acc.repos.add(entry.repoRoot);
      acc.ready += state.counts.ready;
      acc.inFlight += state.counts.inFlight;
      acc.blocked += state.counts.blocked;
    }
  }
  const nextWorkspace = new Map();
  for (const [wsId, acc] of accByWs) {
    nextWorkspace.set(wsId, workspaceTokens(acc));
  }
  return { nextPane, nextWorkspace };
}
