import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmp } from '@adlc/core/test-kit';

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

test('Copilot rails-guard and build-gate resolve subdirectory payload.cwd inside nested linked worktrees', (t) => {
  const primary = tmp(t, 'copilot-wt-primary-');
  const outsideCwd = tmp(t, 'copilot-outside-cwd-');
  git(primary, 'init', '-b', 'main');
  mkdirSync(join(primary, '.adlc'), { recursive: true });
  writeFileSync(
    join(primary, '.adlc', 'tickets.json'),
    JSON.stringify({
      tickets: [
        {
          id: 'T-COPILOT',
          title: 'Copilot WT',
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
  writeFileSync(join(lane, '.adlc', 'current-ticket.json'), JSON.stringify({ id: 'T-COPILOT' }));

  const subDir = join(lane, 'packages', 'sub');

  // Relative file_path from subdirectory payload.cwd inside nested worktree hits frozen rail
  const editRes = spawnSync(process.execPath, [RAILS_HOOK], {
    cwd: outsideCwd,
    input: JSON.stringify({
      cwd: subDir,
      toolName: 'edit',
      toolArgs: JSON.stringify({ file_path: 'frozen.mjs' }),
    }),
    encoding: 'utf8',
    env: { ...process.env, ADLC_P4_ENFORCEMENT: '1' },
  });
  assert.equal(editRes.status, 0);
  assert.match(editRes.stdout, /blocked rail edit/);

  // Shell tool run_terminal_cmd with Cwd targeting frozen rail is denied
  const shellRes = spawnSync(process.execPath, [RAILS_HOOK], {
    cwd: outsideCwd,
    input: JSON.stringify({
      cwd: lane,
      toolName: 'run_terminal_cmd',
      toolArgs: JSON.stringify({ command: 'rm frozen.mjs', Cwd: subDir }),
    }),
    encoding: 'utf8',
    env: { ...process.env, ADLC_P4_ENFORCEMENT: '1' },
  });
  assert.equal(shellRes.status, 0);
  assert.match(shellRes.stdout, /blocked rail edit/);

  // Build-gate resolves enclosing worktree root when payload.cwd is a subdirectory and fails closed on corrupt store
  writeFileSync(join(lane, '.adlc', 'tickets.json'), '{not-json');
  const bgRes = spawnSync(process.execPath, [BUILD_GATE_HOOK], {
    cwd: outsideCwd,
    input: JSON.stringify({
      cwd: subDir,
      toolName: 'edit',
    }),
    encoding: 'utf8',
  });
  assert.equal(bgRes.status, 0);
  assert.match(bgRes.stdout, /cannot read the ticket store/);
});
