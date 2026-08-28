// A REAL temporary git fixture for the recovery / reset / creation suites:
// a primary repository (`repo/`, branch `main`, REPO_ROOT), a bare `origin.git`
// that the pinned URLs name (a filesystem path is a valid git URL; the
// SSH-only rule is preflight's), the NET_GIT of §9.1c written by
// lib/git-env.mjs, and a `ctx` whose `git` runs the REAL git through the
// shared spawner while `gh`/`adlc`/`claude`/`npm`/spec-lint are faked through
// fake-children handlers keyed by their pinned fake paths.

import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { spawnSync, spawn as cpSpawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSpawner, DEADLINES } from '../../lib/spawn.mjs';
import { gitBaseEnv, writeNetGit, netGitArgv, networkGitEnv } from '../../lib/git-env.mjs';
import { autopilotPaths } from '../../lib/paths.mjs';
import { createRecordStore, newRecord } from '../../lib/records.mjs';
import { createRedactor } from '../../lib/redact.mjs';
import { createGh } from '../../lib/github.mjs';
import { branchFor, stagingBranchFor } from '../../lib/input.mjs';
import { fakeSpawnImpl } from './fake-children.mjs';
import { fakeGithub } from './recover-gh.mjs';

export const GIT = '/usr/bin/git';
export const FAKE = Object.freeze({ gh: '/fake/bin/gh', adlc: '/fake/bin/adlc', claude: '/fake/bin/claude', npm: '/fake/bin/npm', node: '/fake/bin/node', codex: '/fake/bin/codex' });
export const TOKEN_A = 'a'.repeat(64);
export const TOKEN_B = 'b'.repeat(64);

const IDENTITY = { GIT_AUTHOR_NAME: 'ap-test', GIT_AUTHOR_EMAIL: 'ap@test.invalid', GIT_COMMITTER_NAME: 'ap-test', GIT_COMMITTER_EMAIL: 'ap@test.invalid' };

/**
 * @param opts.gh       a fakeGithub() instance (default: empty state)
 * @param opts.handlers extra fake-children handlers keyed by FAKE.* paths
 */
export function createFixture({ gh = fakeGithub(), handlers = {}, now = Date.parse('2026-08-28T12:00:00Z'), spawner = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ap-recover-'));
  const repoRoot = join(root, 'repo');
  const originPath = join(root, 'origin.git');
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  const base = { ...gitBaseEnv({ path: process.env.PATH, home }), ...IDENTITY };
  const sh = (args, cwd = repoRoot) => {
    const r = spawnSync(GIT, ['-c', 'commit.gpgsign=false', ...args], { cwd, env: base, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
    return r.stdout.trim();
  };
  mkdirSync(repoRoot);
  sh(['init', '-q', '-b', 'main']);
  sh(['config', 'user.name', 'ap-test']); sh(['config', 'user.email', 'ap@test.invalid']);
  writeFileSync(join(repoRoot, 'README.md'), '# fixture\n');
  mkdirSync(join(repoRoot, '.adlc', 'tickets'), { recursive: true });
  writeFileSync(join(repoRoot, '.adlc', 'keep'), '');
  writeFileSync(join(repoRoot, 'package.json'), '{"name":"fixture","private":true}\n');
  sh(['add', '-A']); sh(['commit', '-q', '-m', 'base']);
  spawnSync(GIT, ['init', '-q', '--bare', originPath], { env: base });
  sh(['remote', 'add', 'origin', originPath]);
  sh(['push', '-q', originPath, 'main:refs/heads/main']);
  const baseOid = sh(['rev-parse', 'main']);
  const paths = autopilotPaths(repoRoot);
  mkdirSync(paths.runsDir, { recursive: true });
  const wrapper = join(root, 'ssh-wrapper');
  writeFileSync(wrapper, '#!/bin/sh\nexit 1\n');
  writeNetGit({ netGit: paths.netGit, repoRoot, remoteFetchUrl: originPath, remotePushUrl: originPath, sshWrapperPath: wrapper });

  const recorder = [];
  const hooks = [];
  const table = { ...handlers };
  const fake = fakeSpawnImpl(table);
  const spawnImpl = (exe, args, opts) => (table[exe] ? fake.spawnImpl(exe, args, opts) : cpSpawn(exe, args, opts));
  // `kill` reaches the FAKE children too (a hung fake exits on SIGTERM like a real one); `spawner`: extra createSpawner options (injectable timers).
  const kill = (pid, signal) => { try { fake.kill(pid, signal); } catch { process.kill(pid, signal); } };
  const inner = createSpawner({ recorder, spawnImpl, kill, ...spawner });
  const spawn = (req) => { for (const h of hooks) h(req); return inner(req); };
  table[FAKE.gh] = gh.handler;
  if (!table[FAKE.npm]) table[FAKE.npm] = () => ({ stdout: '' });

  const local = (cwd, args, { deadlineMs = DEADLINES.git, stdinBytes } = {}) => spawn({ argv: [GIT, ...args], cwd, env: base, deadlineMs, stdinBytes, label: `git ${args[0]}` });
  const localOut = async (cwd, args) => { const r = await local(cwd, args); if (r.status !== 0) { const e = new Error(`git ${args.join(' ')}: ${r.stderr}`); e.code = 'git-failed'; throw e; } return String(r.stdout).trim(); };
  const netEnv = networkGitEnv({ base, remoteFetchUrl: originPath, remotePushUrl: originPath, sshWrapperPath: wrapper });
  const net = (args) => spawn({ argv: netGitArgv(GIT, paths.netGit, ...args), cwd: repoRoot, env: netEnv, deadlineMs: DEADLINES.gitNetwork, label: `git ${args[0]}` });
  const observe = async (key) => { const r = await local(repoRoot, ['config', '--file', join(repoRoot, '.git', 'config'), '--get', key]); return r.status === 0 ? String(r.stdout).trim() : null; };

  const clock = { value: now };
  let starts = 0;
  const statusDoc = {};
  const status = { read: () => ({ ...statusDoc }), write: (patch) => Object.assign(statusDoc, patch), incrementStarts: () => ++starts };
  const redactor = createRedactor();
  const records = createRecordStore({ paths, redactor, now: () => new Date(clock.value).toISOString() });
  const logs = [];
  const ctx = {
    repoRoot, paths, spawn, recorder, pinned: { git: GIT, gh: FAKE.gh, adlc: FAKE.adlc, claude: FAKE.claude, npm: FAKE.npm, node: FAKE.node, codex: FAKE.codex, specLintBin: join(repoRoot, 'packages', 'spec-lint', 'bin', 'spec-lint.mjs') },
    env: { path: process.env.PATH, home, base: { PATH: process.env.PATH, HOME: home, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC' } },
    key: 'k'.repeat(48), redactor, config: { autopilot: {} }, local: { model: 'sonnet' },
    remote: { remoteFetchUrl: originPath, remotePushUrl: originPath, host: 'github.com', repo: 'o/r', principal: 'op', observed: { fetch: originPath, push: originPath } },
    netGit: paths.netGit, gh: createGh({ spawn, gh: FAKE.gh, host: 'github.com', repo: 'o/r', env: base, cwd: repoRoot, sleep: async () => {} }),
    git: { local, localOut, net, observe }, records, status, lock: { token: 'c'.repeat(64) }, baseOid,
    now: () => clock.value, log: (l) => logs.push(l), dryRun: false, quota: null,
  };
  const fx = {
    root, repoRoot, originPath, baseOid, paths, ctx, gh, recorder, hooks, table, sh, logs, clock, base,
    advance: (ms) => { clock.value += ms; },
    /** OID of a ref in the bare origin, or null. */
    remoteOid: (branch) => { const r = spawnSync(GIT, ['--git-dir', originPath, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { env: base, encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : null; },
    localOid: (branch) => { const r = spawnSync(GIT, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: repoRoot, env: base, encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : null; },
    marker: (branch) => { const r = spawnSync(GIT, ['config', '--file', join(repoRoot, '.git', 'config'), '--get', `branch.${branch}.adlcAutopilotToken`], { env: base, encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : null; },
    /** Every recorded git spawn whose verb is `push`. */
    pushes: () => recorder.filter((r) => r.argv[0] === GIT && r.argv.some((a) => a === 'push')),
    gitArgvs: () => recorder.filter((r) => r.argv[0] === GIT).map((r) => r.argv.slice(1).filter((a) => !a.startsWith('--git-dir='))),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
  return fx;
}

/**
 * Create an autopilot branch + worktree the way §6.1 leaves them: branch at
 * baseOid (+ one commit by default), the ownership marker, the worktree at
 * ISSUE_WT; optionally pushed to origin. Returns { branch, tip, wt }.
 */
export function createAutopilotBranch(fx, { issue, token = TOKEN_A, commit = true, marker = true, worktree = true, push = false } = {}) {
  const branch = branchFor(issue);
  const wt = fx.paths.issueWorktree(issue);
  fx.sh(['worktree', 'add', '-q', wt, '-b', branch, fx.baseOid]);
  if (commit) {
    writeFileSync(join(wt, `work-${issue}.txt`), `issue ${issue}\n`);
    fx.sh(['add', '-A'], wt); fx.sh(['commit', '-q', '-m', `work for #${issue}`], wt);
  }
  const tip = fx.sh(['rev-parse', 'HEAD'], wt);
  if (marker) fx.sh(['config', `branch.${branch}.adlcAutopilotToken`, token]);
  if (push) fx.sh(['push', '-q', fx.originPath, `${branch}:refs/heads/${branch}`]);
  if (!worktree) fx.sh(['worktree', 'remove', wt]);
  return { branch, tip, wt, baseOid: fx.baseOid };
}

/** Persist a run record in `state` for the branch (defaults match createAutopilotBranch). */
export function saveRecord(fx, { issue, token = TOKEN_A, state, tip, extra = {} }) {
  const branch = branchFor(issue);
  const rec = { ...newRecord({ issue, token, baseOid: fx.baseOid, branch, stagingBranch: stagingBranchFor(token), stagingPath: fx.paths.stagingWorktree(issue, token), finalPath: fx.paths.issueWorktree(issue) }), state, creationPhase: null, localHead: tip ?? null, ...extra };
  return fx.ctx.records.save(rec);
}

export function recordOf(fx, issue) { return fx.ctx.records.load(issue); }
export function fileBytes(path) { return existsSync(path) ? readFileSync(path) : null; }
