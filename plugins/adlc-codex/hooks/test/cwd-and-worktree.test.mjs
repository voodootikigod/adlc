import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmp } from '@adlc/core/test-kit';
import { spawnHook } from './helpers/run-hook.mjs';

const HOOKS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const RAILS_HOOK = join(HOOKS_DIR, 'adlc-rails-guard.mjs');
const BUILD_GATE_HOOK = join(HOOKS_DIR, 'adlc-build-gate.mjs');

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });
}

test('Codex rails-guard and build-gate resolve payload.cwd subdirectories and nested linked worktrees when process.cwd() is outside', (t) => {
  const primary = tmp(t, 'codex-wt-primary-');
  const outsideCwd = tmp(t, 'codex-outside-cwd-');
  git(primary, 'init', '-b', 'main');
  mkdirSync(join(primary, '.adlc'), { recursive: true });
  writeFileSync(
    join(primary, '.adlc', 'tickets.json'),
    JSON.stringify({
      tickets: [
        {
          id: 'T-CODEX',
          title: 'Codex WT',
          category: 'architecture',
          rails: ['packages/sub/frozen.mjs'],
        },
      ],
    })
  );
  mkdirSync(join(primary, 'packages', 'sub'), { recursive: true });
  writeFileSync(join(primary, 'packages', 'sub', 'frozen.mjs'), 'export const x = 1;\n');
  git(primary, 'add', '-A');
  git(primary, 'commit', '-m', 'init');

  const lane = join(primary, '.worktrees', 'lane-a');
  git(primary, 'worktree', 'add', '-b', 'lane-a', lane);
  writeFileSync(join(lane, '.adlc', 'current-ticket.json'), JSON.stringify({ id: 'T-CODEX' }));

  const subDir = join(lane, 'packages', 'sub');

  // Structured edit from subdirectory payload.cwd inside nested worktree hits frozen rail (exit 2)
  const editRes = spawnHook([RAILS_HOOK], {
    cwd: outsideCwd,
    input: JSON.stringify({
      cwd: subDir,
      tool_name: 'edit',
      tool_input: { file_path: 'frozen.mjs' },
    }),
    encoding: 'utf8',
    env: { ...process.env, ADLC_P4_ENFORCEMENT: '1' },
  });
  assert.equal(editRes.status, 2, editRes.stderr);
  assert.match(editRes.stderr, /blocked rail edit/);

  // Shell tool run_shell_command with dir_path targeting frozen rail is denied (exit 2)
  const shellRes = spawnHook([RAILS_HOOK], {
    cwd: outsideCwd,
    input: JSON.stringify({
      cwd: lane,
      tool_name: 'run_shell_command',
      tool_input: { command: 'rm frozen.mjs', dir_path: subDir },
    }),
    encoding: 'utf8',
    env: { ...process.env, ADLC_P4_ENFORCEMENT: '1' },
  });
  assert.equal(shellRes.status, 2, shellRes.stderr);

  // Build-gate resolves high-risk ticket from subdirectory payload.cwd inside nested worktree and fails closed without transcript (exit 2)
  const bgRes = spawnHook([BUILD_GATE_HOOK], {
    cwd: outsideCwd,
    input: JSON.stringify({
      cwd: subDir,
      tool_name: 'edit',
    }),
    encoding: 'utf8',
  });
  assert.equal(bgRes.status, 2, bgRes.stderr);
  assert.match(bgRes.stderr, /high-risk/);
});
