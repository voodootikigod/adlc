// Pure token-assembly planner for the watcher (t-herdr-2). Extracted from
// bin/watcher.mjs so the decision-shaped logic — which panes get which tokens,
// and how workspace backlog counts combine — is unit-testable without a herdr
// host. The daemon does the I/O (snapshot, file reads, publishing); this turns
// (paneMap, per-repo state) into the token maps to publish.
import { paneTokens, workspaceTokens } from './tokens.mjs';

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
