import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmp } from '@adlc/core/test-kit';
import { decide, resolveOwning, extractFilePaths } from '../hooks/adlc-rails-guard.mjs';
import { dispatch } from '../hooks/adlc-pretool.mjs';
import { adviseShell } from '../hooks/adlc-shell-advisory.mjs';
import { isShellTool } from '../rails-checker.mjs';
import { spawnHook } from './helpers/run-hook.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PREFLIGHT_HOOK = join(HERE, '..', 'hooks', 'adlc-preflight.mjs');
const STOP_HOOK = join(HERE, '..', 'hooks', 'adlc-stop.mjs');

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

test('Cursor preflight, stop, and shell-advisory hooks resolve nested worktree and subdirectory payload.cwd when process.cwd() is outside', async (t) => {
  const primary = tmp(t, 'cursor-adv-primary-');
  const outsideCwd = tmp(t, 'cursor-adv-outside-');
  git(primary, 'init', '-b', 'main');
  mkdirSync(join(primary, '.adlc'), { recursive: true });
  writeFileSync(
    join(primary, '.adlc', 'tickets.json'),
    JSON.stringify({ tickets: [{ id: 'T-ADV', title: 'Adv', rails: ['src/frozen.js'] }] })
  );
  mkdirSync(join(primary, 'src'), { recursive: true });
  writeFileSync(join(primary, 'src', 'frozen.js'), 'export const x = 1;\n');
  git(primary, 'add', '-A');
  git(primary, 'commit', '-m', 'init');

  const lane = join(primary, '.worktrees', 'lane-adv');
  git(primary, 'worktree', 'add', '-b', 'lane-adv', lane);
  writeFileSync(join(lane, '.adlc', 'current-ticket.json'), JSON.stringify({ id: 'T-ADV' }));
  mkdirSync(join(lane, 'src', 'auth'), { recursive: true });
  writeFileSync(join(lane, 'src', 'auth', 'session.mjs'), 'export const r = 1;\n');

  const shellAdv = adviseShell(
    {
      workspace_roots: [primary],
      cwd: join(lane, 'src'),
      command: 'rm src/frozen.js',
    },
    { env: { ADLC_P4_ENFORCEMENT: '1' } }
  );
  assert.equal(shellAdv.permission, 'allow');
  assert.match(shellAdv.user_message ?? '', /src\/frozen\.js/);

  const preflightRes = spawnHook([PREFLIGHT_HOOK], {
    cwd: outsideCwd,
    input: JSON.stringify({ workspace_roots: [primary], cwd: join(lane, 'src') }),
    env: { ...process.env, PATH: outsideCwd, CURSOR_PROJECT_DIR: '' },
  });
  assert.equal(preflightRes.status, 0);
  assert.match(preflightRes.stderr, /ADLC precedence:/);

  const stopRes = spawnHook([STOP_HOOK], {
    cwd: outsideCwd,
    input: JSON.stringify({ workspace_roots: [primary], cwd: join(lane, 'src') }),
    env: { ...process.env, CURSOR_PROJECT_DIR: '' },
  });
  assert.equal(stopRes.status, 0);
  assert.match(stopRes.stderr, /risk-gated change/);

  // Nested worktree with its own store enforces its own rails even when ADLC_TICKET_STORE / ADLC_TICKET point at outer checkout
  writeFileSync(
    join(lane, '.adlc', 'tickets.json'),
    JSON.stringify({ tickets: [{ id: 'T-LANE-ONLY', title: 'Lane only', rails: ['lane-only/frozen.js'] }] })
  );
  writeFileSync(join(lane, '.adlc', 'current-ticket.json'), JSON.stringify({ id: 'T-LANE-ONLY' }));
  const outerOverrideVerdict = decide(
    {
      tool_name: 'Write',
      workspace_roots: [primary],
      tool_input: { file_path: join(lane, 'lane-only', 'frozen.js') },
    },
    {
      env: {
        ADLC_P4_ENFORCEMENT: '1',
        ADLC_TICKET: 'T-ADV',
        ADLC_TICKET_STORE: join(primary, '.adlc', 'tickets.json'),
      },
    }
  );
  assert.equal(outerOverrideVerdict.permission, 'deny');
  assert.match(outerOverrideVerdict.user_message ?? '', /T-LANE-ONLY/);

  // Secondary build-gate in Cursor dispatch ALSO sanitizes outer ADLC_TICKET_STORE=/tmp/outer.json when nested worktree owns high-risk local store
  const extLowStore = join(outsideCwd, 'cursor-outer-low.json');
  writeFileSync(extLowStore, JSON.stringify({ tickets: [{ id: 'T-SHARED', title: 'Low', rails: [] }] }));
  writeFileSync(
    join(lane, '.adlc', 'tickets.json'),
    JSON.stringify({ tickets: [{ id: 'T-SHARED', title: 'High', category: 'architecture', rails: [] }] })
  );
  writeFileSync(join(lane, '.adlc', 'current-ticket.json'), JSON.stringify({ id: 'T-SHARED' }));
  const stateDir = tmp(t, 'cursor-bg-state-');
  const bgEnv = {
    ADLC_P4_ENFORCEMENT: '1',
    ADLC_BUILD_GATE_ENFORCEMENT: '1',
    ADLC_TICKET_STORE: extLowStore,
    ADLC_TICKET: 'T-SHARED',
    ADLC_CURSOR_STATE_DIR: stateDir,
    ADLC_CURSOR_SESSION_ID: 'sess-bg-nested',
  };
  let lastBgVerdict = null;
  for (let i = 0; i < 45; i += 1) {
    lastBgVerdict = await dispatch(
      {
        tool_name: 'Write',
        tool_use_id: `tu-${i}`,
        workspace_roots: [primary],
        tool_input: { file_path: join(lane, 'src', 'free.js') },
      },
      { env: bgEnv }
    );
  }
  assert.equal(lastBgVerdict?.permission, 'deny');
  assert.match(lastBgVerdict?.user_message ?? '', /build-gate|high-risk/i);

  // targetPath key in tool_input is extracted alongside file_path (so dropping targetPath would allow instead of opaque-denying)
  const targetPathVerdict = decide(
    {
      tool_name: 'Edit',
      workspace_roots: [primary],
      tool_input: {
        file_path: join(primary, 'src', 'ok.js'),
        targetPath: join(primary, 'src', 'frozen.js'),
      },
    },
    { env: { ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: 'T-ADV' } }
  );
  assert.equal(targetPathVerdict.permission, 'deny');

  // Explicit payload.root declaration is respected directly without climbing to enclosing primary repo
  writeFileSync(
    join(primary, '.adlc', 'tickets.json'),
    JSON.stringify({ tickets: [{ id: 'T-ADV', title: 'Adv', rails: ['src/frozen.js', 'uninit-sub/src/frozen.js'] }] })
  );
  const uninitSub = join(primary, 'uninit-sub', 'src');
  mkdirSync(uninitSub, { recursive: true });
  const explicitRootVerdict = decide(
    {
      tool_name: 'Edit',
      root: join(primary, 'uninit-sub'),
      tool_input: { file_path: join(uninitSub, 'frozen.js') },
    },
    { env: { ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: 'T-ADV' } }
  );
  assert.equal(explicitRootVerdict.permission, 'allow');
});
