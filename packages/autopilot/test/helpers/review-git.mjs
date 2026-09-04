// Real temporary git repositories for the review / push / maintain suites
// (fixture construction only — production code paths still go through
// ctx.spawn). Every command runs with a fixed identity, no global/system
// config and signing disabled.

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const FIXTURE_ENV = Object.freeze({
  PATH: '/usr/bin:/bin', HOME: '/nonexistent', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@adlc.invalid', GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@adlc.invalid',
  GIT_AUTHOR_DATE: '2026-08-28T00:00:00Z', GIT_COMMITTER_DATE: '2026-08-28T00:00:00Z',
});

/** Run git in `cwd`; returns trimmed stdout. */
export function git(cwd, args, { input } = {}) {
  return execFileSync('/usr/bin/git', ['-c', 'commit.gpgsign=false', ...args], { cwd, env: { ...FIXTURE_ENV }, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

export function writeFile(root, rel, content) {
  const p = join(root, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, content); return p;
}

/** `git init -b main` + one commit of `files` ({ rel: content }). Returns the head OID. */
export function initRepo(dir, files = { 'README.md': 'base\n' }, message = 'base') {
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  for (const [rel, content] of Object.entries(files)) writeFile(dir, rel, content);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', message]);
  return git(dir, ['rev-parse', 'HEAD']);
}

/** Write + commit one file; returns the new head OID. */
export function commitFile(dir, rel, content, message = `edit ${rel}`) {
  writeFile(dir, rel, content);
  git(dir, ['add', '-A', '--', rel]);
  git(dir, ['commit', '-q', '-m', message]);
  return git(dir, ['rev-parse', 'HEAD']);
}

export const head = (dir) => git(dir, ['rev-parse', 'HEAD']);

/** The §6.1 shape: a linked worktree at `.worktrees/autopilot-issue-<n>` on `adlc/autopilot/issue-<n>` with the ownership marker. */
export function makeIssueWorktree({ repoRoot, issue, baseOid, token }) {
  const wt = join(repoRoot, '.worktrees', `autopilot-issue-${issue}`);
  const branch = `adlc/autopilot/issue-${issue}`;
  mkdirSync(join(repoRoot, '.worktrees'), { recursive: true });
  git(repoRoot, ['worktree', 'add', '-q', wt, '-b', branch, baseOid]);
  if (token) git(repoRoot, ['config', `branch.${branch}.adlcAutopilotToken`, token]);
  return { wt, branch };
}

/** A bare repository usable as a LOCAL pinned remote URL. */
export function bareRemote(dir) { mkdirSync(dir, { recursive: true }); git(dir, ['init', '-q', '--bare']); git(dir, ['config', 'gc.auto', '0']); git(dir, ['config', 'gc.autoDetach', 'false']); return dir; }

/** Tip of `refs/heads/<branch>` in a bare repo, or null. */
export function bareTip(bare, branch) {
  try { return git(bare, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`]) || null; } catch { return null; }
}
