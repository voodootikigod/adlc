import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmp } from '@adlc/core/test-kit';
import { decide, resolveOwning, extractFilePaths } from '../hooks/adlc-rails-guard.mjs';
import { dispatch } from '../hooks/adlc-pretool.mjs';
import { isShellTool } from '../rails-checker.mjs';

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

test('Cursor resolveOwning and decide bind nested linked worktrees instead of outer workspace_roots', (t) => {
  const primary = tmp(t, 'cursor-wt-primary-');
  git(primary, 'init', '-b', 'main');
  mkdirSync(join(primary, '.adlc'), { recursive: true });
  writeFileSync(
    join(primary, '.adlc', 'tickets.json'),
    JSON.stringify({ tickets: [{ id: 'T-CUR', title: 'Cursor WT', rails: ['src/frozen.js'] }] })
  );
  mkdirSync(join(primary, 'src'), { recursive: true });
  writeFileSync(join(primary, 'src', 'frozen.js'), 'export const x = 1;\n');
  git(primary, 'add', '-A');
  git(primary, 'commit', '-m', 'init');

  const lane = join(primary, '.worktrees', 'lane-a');
  git(primary, 'worktree', 'add', '-b', 'lane-a', lane);
  writeFileSync(join(lane, '.adlc', 'current-ticket.json'), JSON.stringify({ id: 'T-CUR' }));

  const target = join(lane, 'src', 'frozen.js');
  const owned = resolveOwning({ workspace_roots: [primary] }, target, undefined, {});
  assert.equal(realpathSync(owned.root), realpathSync(lane));

  const verdict = decide(
    {
      tool_name: 'Write',
      workspace_roots: [primary],
      tool_input: { file_path: target, content: 'tamper' },
    },
    { env: { ADLC_P4_ENFORCEMENT: '1' } }
  );
  assert.equal(verdict.permission, 'deny');

  // Outer target must NOT be redirected to nested worktree just because payload.cwd points at a clean worktree
  const cleanWt = join(primary, '.worktrees', 'clean-wt');
  git(primary, 'worktree', 'add', '-b', 'clean-wt', cleanWt);
  writeFileSync(join(primary, '.adlc', 'current-ticket.json'), JSON.stringify({ id: 'T-CUR' }));
  const outerVerdict = decide(
    {
      tool_name: 'Write',
      workspace_roots: [primary],
      cwd: cleanWt,
      tool_input: { file_path: join(primary, 'src', 'frozen.js'), content: 'tamper' },
    },
    { env: { ADLC_P4_ENFORCEMENT: '1' } }
  );
  assert.equal(outerVerdict.permission, 'deny');

  // Subdirectory payload.cwd (without workspace_roots) climbs to enclosing ADLC checkout root
  const subdirOwned = resolveOwning({ cwd: join(primary, 'src') }, 'frozen.js', undefined, {});
  assert.equal(realpathSync(subdirOwned.root), realpathSync(primary));

  const subdirVerdict = decide(
    {
      tool_name: 'Write',
      cwd: join(primary, 'src'),
      tool_input: { file_path: 'frozen.js', content: 'tamper' },
    },
    { env: { ADLC_P4_ENFORCEMENT: '1' } }
  );
  assert.equal(subdirVerdict.permission, 'deny');
  assert.match(subdirVerdict.user_message ?? '', /frozen rail/);

  // Non-rail edit with cwd-only payload succeeds cleanly (never throws ReferenceError)
  const subdirAllowed = decide(
    {
      tool_name: 'Write',
      cwd: join(primary, 'src'),
      tool_input: { file_path: 'free.js', content: 'ok' },
    },
    { env: { ADLC_P4_ENFORCEMENT: '1' } }
  );
  assert.equal(subdirAllowed.permission, 'allow');

  // Pathless opaque mutator from subdirectory or nested worktree fails closed under enforcement
  const opaqueSubdir = decide(
    {
      tool_name: 'edit_file',
      cwd: join(primary, 'src'),
      tool_input: {},
    },
    { env: { ADLC_P4_ENFORCEMENT: '1' } }
  );
  assert.equal(opaqueSubdir.permission, 'deny');
  assert.match(opaqueSubdir.user_message ?? '', /no verifiable target path/);

  mkdirSync(join(lane, 'src'), { recursive: true });
  const opaqueNestedWt = decide(
    {
      tool_name: 'edit_file',
      workspace_roots: [primary],
      cwd: join(lane, 'src'),
      tool_input: {},
    },
    { env: { ADLC_P4_ENFORCEMENT: '1' } }
  );
  assert.equal(opaqueNestedWt.permission, 'deny');
});

test('Cursor dispatch handles cwd-only payloads under ADLC_BUILD_GATE_ENFORCEMENT=1 without throwing', async (t) => {
  const primary = tmp(t, 'cursor-dispatch-cwd-');
  git(primary, 'init', '-b', 'main');
  mkdirSync(join(primary, '.adlc'), { recursive: true });
  writeFileSync(
    join(primary, '.adlc', 'tickets.json'),
    JSON.stringify({ tickets: [{ id: 'T-BG', title: 'Normal', rails: ['src/frozen.js'] }] })
  );
  writeFileSync(join(primary, '.adlc', 'current-ticket.json'), JSON.stringify({ id: 'T-BG' }));
  mkdirSync(join(primary, 'src'), { recursive: true });

  const verdict = await dispatch(
    {
      tool_name: 'Write',
      cwd: join(primary, 'src'),
      tool_input: { file_path: 'free.js', content: 'ok' },
    },
    { env: { ADLC_P4_ENFORCEMENT: '0', ADLC_BUILD_GATE_ENFORCEMENT: '1' } }
  );
  assert.equal(verdict.permission, 'allow');
});

test('Cursor extracts notebook_path and classifies run_shell_command as shell tool', () => {
  assert.deepEqual(
    extractFilePaths({ tool_name: 'NotebookEdit', tool_input: { notebook_path: 'notebooks/eval.ipynb' } }),
    ['notebooks/eval.ipynb']
  );
  assert.equal(isShellTool('run_shell_command'), true);
});
