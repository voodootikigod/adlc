// AC 24 — path resolution: REPO_ROOT is the main worktree (a linked worktree
// exits 1 not-main-worktree), every derived path is absolute under REPO_ROOT,
// and the four exclude entries are the documented ones.

import { test } from './helpers/node-test.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveRepoRoot, autopilotPaths, EXCLUDE_ENTRIES, PathError } from '../lib/paths.mjs';
import { withMutation } from '../lib/mutations.mjs';

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' };
const gitRun = (args, { cwd }) => { const r = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', env: GIT_ENV }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout; };

export function ac24_derivedPathsAreAbsoluteUnderRoot() {
  const p = autopilotPaths('/srv/repo');
  assert.equal(p.issueWorktree(7), '/srv/repo/.worktrees/autopilot-issue-7');
  assert.equal(p.issueAdlc(7), '/srv/repo/.worktrees/autopilot-issue-7/.adlc');
  assert.equal(p.issueTickets(7), '/srv/repo/.worktrees/autopilot-issue-7/.adlc/tickets');
  assert.equal(p.record(7), '/srv/repo/.adlc/autopilot-runs/7.json');
  assert.equal(p.mirror(7), '/srv/repo/.adlc/autopilot-runs/7/mirror.git');
  assert.equal(p.netGit, '/srv/repo/.adlc/autopilot-runs/net.git');
  assert.equal(p.statusFile, '/srv/repo/.adlc/autopilot-status.json');
  assert.equal(p.stagingWorktree(7, 'ab'), '/srv/repo/.worktrees/autopilot-issue-7.creating-ab');
  assert.throws(() => p.issueWorktree('7; rm'), (e) => e.code === 'bad-input:issue');
  assert.deepEqual([...EXCLUDE_ENTRIES], ['.adlc/autopilot-status.json', '.adlc/autopilot.lock/', '.adlc/autopilot-runs/', '.worktrees/autopilot-issue-*']);
}
test('AC24: ISSUE_WT, <ISSUE_WT>/.adlc and every run path are absolute under REPO_ROOT and built from validated numbers', ac24_derivedPathsAreAbsoluteUnderRoot);

export async function ac24_linkedWorktreeRefused() {
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'ap-paths-')));
  try {
    const main = join(root, 'main'); mkdirSync(main);
    gitRun(['init', '-q', '-b', 'main'], { cwd: main }); gitRun(['config', 'gc.auto', '0'], { cwd: main }); gitRun(['config', 'gc.autoDetach', 'false'], { cwd: main });
    gitRun(['commit', '-q', '--allow-empty', '-m', 'base'], { cwd: main });
    const linked = join(root, 'linked');
    gitRun(['worktree', 'add', '-q', '-b', 'x', linked, 'main'], { cwd: main });
    assert.equal(resolveRepoRoot({ cwd: main, git: gitRun }), main);
    assert.equal(resolveRepoRoot({ cwd: join(main), git: gitRun }), main);
    let err = null;
    try { resolveRepoRoot({ cwd: linked, git: gitRun }); } catch (e) { err = e; }
    assert.ok(err instanceof PathError); assert.equal(err.code, 'not-main-worktree'); assert.equal(err.exitCode, 1);
    await withMutation('paths.allowLinkedWorktree', () => { assert.equal(resolveRepoRoot({ cwd: linked, git: gitRun }), linked, 'seam: the linked worktree passes'); });
  } finally { rmSync(root, { recursive: true, force: true }); }
}
test('AC24: invoking from inside a linked worktree exits 1 not-main-worktree; the main worktree resolves', ac24_linkedWorktreeRefused);

export async function ac30_fleetResultPathsAreSafeAndDistinct() {
  const { autopilotPaths, validateRunId } = await import('../lib/paths.mjs');
  const p = autopilotPaths('/repo');
  assert.equal(p.fleetResult('run-01ABC'), '/repo/.adlc/autopilot-runs/fleet-run-01ABC.json');
  assert.ok(!/\/\d+\.json$/.test(p.fleetResult('7')), 'a numeric run id never becomes an issue record file');
  for (const bad of ['../x', 'a/b', '', '.', '..', 'x\u0000y', 'x'.repeat(200)]) assert.throws(() => validateRunId(bad), /bad-run-id|not a safe path fragment/, JSON.stringify(bad));
}
test('AC30: fleet result files are `fleet-<id>.json` (never mistakable for an issue record) and the id is validated as a safe path fragment', ac30_fleetResultPathsAreSafeAndDistinct);
