import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmp } from '@adlc/core/test-kit';
import plugin from '../index.mjs';
import { checkToolCall } from '../rails-checker.mjs';

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

test('OpenCode setup resolves nested linked worktree launch directory over outer project.directory', async (t) => {
  const primary = tmp(t, 'oc-wt-primary-');
  git(primary, 'init', '-b', 'main');
  mkdirSync(join(primary, '.adlc'), { recursive: true });
  writeFileSync(
    join(primary, '.adlc', 'tickets.json'),
    JSON.stringify({ tickets: [{ id: 'T-WT', title: 'Worktree Ticket', rails: ['src/frozen.mjs'] }] })
  );
  mkdirSync(join(primary, 'src'), { recursive: true });
  writeFileSync(join(primary, 'src', 'frozen.mjs'), 'export const x = 1;\n');
  git(primary, 'add', '-A');
  git(primary, 'commit', '-m', 'init');

  const lane = join(primary, '.worktrees', 'lane-a');
  git(primary, 'worktree', 'add', '-b', 'lane-a', lane);
  // Activate ticket ONLY in the nested worktree, not in primary
  writeFileSync(join(lane, '.adlc', 'current-ticket.json'), JSON.stringify({ id: 'T-WT' }));

  const prevEnf = process.env.ADLC_P4_ENFORCEMENT;
  process.env.ADLC_P4_ENFORCEMENT = '1';
  t.after(() => {
    if (prevEnf === undefined) delete process.env.ADLC_P4_ENFORCEMENT;
    else process.env.ADLC_P4_ENFORCEMENT = prevEnf;
  });

  let beforeHook = null;
  const ac = new AbortController();
  t.after(() => ac.abort());

  await plugin.setup({
    location: {
      directory: lane,
      project: { directory: primary },
    },
    signal: ac.signal,
    tool: {
      hook(stage, fn) {
        if (stage === 'execute.before') beforeHook = fn;
      },
      register() {},
    },
    permission: {
      hook() {},
    },
    event: {
      async *subscribe({ signal }) {
        await new Promise((res) => signal.addEventListener('abort', res, { once: true }));
      },
    },
  });

  assert.equal(typeof beforeHook, 'function');
  await assert.rejects(
    () =>
      beforeHook({
        tool: 'write',
        sessionID: 'sess-wt',
        input: { path: join(lane, 'src', 'frozen.mjs'), content: 'tamper' },
      }),
    /frozen rail/
  );
  ac.abort();
});

test('checkToolCall extracts alternative shell workdir keys (Cwd, dir_path, working_directory)', (t) => {
  const root = tmp(t, 'oc-wd-keys-');
  mkdirSync(join(root, '.adlc'), { recursive: true });
  writeFileSync(
    join(root, '.adlc', 'tickets.json'),
    JSON.stringify({ tickets: [{ id: 'T1', title: 'Test', rails: ['src/frozen.mjs'] }] })
  );
  const env = { ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: 'T1' };

  for (const key of ['Cwd', 'dir_path', 'working_directory']) {
    const denied = checkToolCall({
      tool: 'bash',
      args: { command: 'rm frozen.mjs', [key]: 'src' },
      root,
      env,
    });
    assert.equal(denied.decision, 'deny', key);
    assert.match(denied.reason, /changes cwd/);

    const allowed = checkToolCall({
      tool: 'bash',
      args: { command: 'rm src/free.mjs', [key]: root },
      root,
      env,
    });
    assert.equal(allowed.decision, 'allow', key);
  }
});
