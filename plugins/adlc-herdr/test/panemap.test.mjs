// RAIL (t-herdr-2): frozen contract for lib/panemap.mjs — the pane→repo
// mapping the watcher publishes and the board (t-herdr-4) renders. The edge
// contract on t-herdr-2 names this module; t-herdr-4 may consume it but not
// weaken it.
//
// Mapping rules (plan §5.1, premortem prevention): the pane's repo comes from
// `foreground_cwd` (the live process cwd), falling back to `cwd`; repo-root
// resolution is injected (the daemon uses `git rev-parse --show-toplevel`),
// and a git worktree is its own root. Panes that resolve to no repo are
// excluded from the map.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPaneMap, repoGroups } from '../lib/panemap.mjs';

const pane = (paneId, { cwd, fg, workspaceId = 'w1' } = {}) => ({
  pane_id: paneId,
  workspace_id: workspaceId,
  cwd,
  foreground_cwd: fg,
});

test('buildPaneMap resolves via foreground_cwd, falling back to cwd', () => {
  const seen = [];
  const resolve = (dir) => { seen.push(dir); return dir === null ? null : `${dir}/ROOT`; };
  const map = buildPaneMap(
    [pane('w1:p1', { cwd: '/a', fg: '/a/.worktrees/x' }), pane('w1:p2', { cwd: '/b', fg: undefined })],
    { resolveRepoRoot: resolve },
  );
  assert.deepEqual(seen, ['/a/.worktrees/x', '/b']);
  assert.deepEqual(map, [
    { paneId: 'w1:p1', workspaceId: 'w1', repoRoot: '/a/.worktrees/x/ROOT' },
    { paneId: 'w1:p2', workspaceId: 'w1', repoRoot: '/b/ROOT' },
  ]);
});

test('panes with no resolvable repo are excluded', () => {
  const map = buildPaneMap(
    [pane('w1:p1', { cwd: '/tmp', fg: '/tmp' }), pane('w1:p2', { cwd: '/repo', fg: '/repo' })],
    { resolveRepoRoot: (dir) => (dir === '/repo' ? '/repo' : null) },
  );
  assert.deepEqual(map, [{ paneId: 'w1:p2', workspaceId: 'w1', repoRoot: '/repo' }]);
});

test('panes with neither cwd nor foreground_cwd are excluded without calling the resolver', () => {
  const seen = [];
  const map = buildPaneMap([pane('w1:p1', {})], { resolveRepoRoot: (d) => { seen.push(d); return '/x'; } });
  assert.deepEqual(map, []);
  assert.deepEqual(seen, []);
});

test('buildPaneMap fails soft on malformed input', () => {
  assert.deepEqual(buildPaneMap(null, { resolveRepoRoot: () => '/x' }), []);
  assert.deepEqual(buildPaneMap([{ not_a_pane: true }], { resolveRepoRoot: () => '/x' }), []);
});

test('a null or non-object element is skipped without dropping its neighbors', () => {
  const map = buildPaneMap(
    [null, pane('w1:p2', { cwd: '/ok', fg: '/ok' }), 'junk'],
    { resolveRepoRoot: (d) => d },
  );
  assert.deepEqual(map, [{ paneId: 'w1:p2', workspaceId: 'w1', repoRoot: '/ok' }]);
});

test('a resolver throw excludes that pane instead of crashing the map', () => {
  const map = buildPaneMap(
    [pane('w1:p1', { cwd: '/boom', fg: '/boom' }), pane('w1:p2', { cwd: '/ok', fg: '/ok' })],
    { resolveRepoRoot: (dir) => { if (dir === '/boom') throw new Error('git failed'); return dir; } },
  );
  assert.deepEqual(map, [{ paneId: 'w1:p2', workspaceId: 'w1', repoRoot: '/ok' }]);
});

test('repoGroups groups pane ids by repo root, preserving order', () => {
  const groups = repoGroups([
    { paneId: 'w1:p1', workspaceId: 'w1', repoRoot: '/r1' },
    { paneId: 'w1:p2', workspaceId: 'w1', repoRoot: '/r2' },
    { paneId: 'w2:p1', workspaceId: 'w2', repoRoot: '/r1' },
  ]);
  assert.deepEqual([...groups.keys()], ['/r1', '/r2']);
  assert.deepEqual(groups.get('/r1').map((e) => e.paneId), ['w1:p1', 'w2:p1']);
  assert.deepEqual(groups.get('/r2').map((e) => e.paneId), ['w1:p2']);
});
