// fleet-ext item 10 / AC8: `fleet run` invoked with cwd = a LINKED git worktree
// reads THAT worktree's ticket store (not the main worktree's) and cuts its
// nested worktrees under <cwd>/.worktrees/. Verified, not assumed, against a
// real repository: the autopilot dispatches fleet from inside its issue
// worktree and depends on exactly this.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorktree, INTEGRATION_WORKTREE } from '../lib/worktrees.mjs';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'fleet.mjs');
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' };
const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', env: GIT_ENV });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const ticketsJson = (ids) => JSON.stringify({ tickets: ids.map((id) => ({ id, title: id, scope: [`packages/${id.toLowerCase()}/**`], edges: [] })) }, null, 2);

function fixture() {
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'fleet-linked-')));
  const main = join(root, 'main');
  mkdirSync(join(main, '.adlc'), { recursive: true });
  git(main, 'init', '-q', '-b', 'main');
  writeFileSync(join(main, '.adlc', 'tickets.json'), ticketsJson(['T1']));
  writeFileSync(join(main, '.gitignore'), '.worktrees/\n');
  git(main, 'add', '-A'); git(main, 'commit', '-q', '-m', 'base');
  // The linked worktree carries an EXTRA ticket the main worktree does not have.
  const linked = join(root, 'linked');
  git(main, 'worktree', 'add', '-q', '-b', 'issue-7', linked, 'main');
  writeFileSync(join(linked, '.adlc', 'tickets.json'), ticketsJson(['T1', 'T7']));
  git(linked, 'add', '-A'); git(linked, 'commit', '-q', '-m', 'ticket T7');
  return { root, main, linked };
}

test('fleet run --dry-run --json from a linked worktree lists the shard that exists only there and roots every path under it', () => {
  const { root, main, linked } = fixture();
  try {
    const r = spawnSync(process.execPath, [BIN, 'run', '--dry-run', '--json'], { cwd: linked, encoding: 'utf8', env: GIT_ENV });
    assert.equal(r.status, 0, r.stderr);
    const plan = JSON.parse(r.stdout);
    assert.ok(plan.readyNow.includes('T7'), `the linked worktree's own ticket is planned: ${JSON.stringify(plan.readyNow)}`);
    assert.equal(plan.worktreeRoot, linked, 'the run is rooted in the linked worktree');
    assert.equal(plan.plannedWorktrees.T7, join(linked, '.worktrees', 'fleet-t7'));
    assert.equal(plan.integrationWorktree, join(linked, '.worktrees', 'fleet-integration'));
    for (const p of Object.values(plan.plannedWorktrees)) assert.ok(p.startsWith(linked + '/'), `${p} is under the linked worktree, never the main one`);
    // Control: the MAIN worktree does not see T7 — so the linked result is not an artefact of a shared store.
    const m = spawnSync(process.execPath, [BIN, 'run', '--dry-run', '--json'], { cwd: main, encoding: 'utf8', env: GIT_ENV });
    assert.equal(m.status, 0, m.stderr);
    assert.ok(!JSON.parse(m.stdout).readyNow.includes('T7'), 'the main worktree plans only its own store');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('createWorktree rooted at a linked worktree cuts the nested worktree under <linked>/.worktrees and off the linked branch tip', () => {
  const { root, linked } = fixture();
  try {
    const wt = createWorktree(linked, 'T7', { integrationBranch: 'issue-7' });
    assert.equal(wt.path, join(linked, '.worktrees', 'fleet-t7'));
    assert.ok(existsSync(join(wt.path, '.adlc', 'tickets.json')), 'the nested worktree is a real checkout');
    assert.equal(wt.startSha, git(linked, 'rev-parse', 'issue-7'), 'cut from the linked branch tip, which carries the extra ticket');
    assert.match(git(wt.path, 'rev-parse', '--git-common-dir'), /\/main\/\.git$/, 'shares the repository database (a linked worktree of the same repo)');
    assert.equal(join(linked, INTEGRATION_WORKTREE), join(linked, '.worktrees', 'fleet-integration'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
