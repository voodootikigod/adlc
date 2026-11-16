import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmp } from '@adlc/core/test-kit';
import { resolveAdlcRoot, createAdlcRootState } from '../lib/handoff-gate.mjs';
import { checkShellCommand } from '../lib/rails-checker.mjs';
import { createExtension } from '../lib/extension.mjs';

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

test('resolveAdlcRoot resolves nested linked git worktrees ahead of outer repo even when outer repo is armed', (t) => {
  const primary = tmp(t, 'pi-wt-primary-');
  git(primary, 'init', '-b', 'main');
  mkdirSync(join(primary, '.adlc'), { recursive: true });
  writeFileSync(
    join(primary, '.adlc', 'tickets.json'),
    JSON.stringify({ tickets: [{ id: 'T1', title: 'Primary', rails: ['src/frozen.js'] }] })
  );
  mkdirSync(join(primary, 'src'), { recursive: true });
  writeFileSync(join(primary, 'src', 'frozen.js'), 'export const x = 1;\n');
  git(primary, 'add', '-A');
  git(primary, 'commit', '-m', 'init');

  const lane = join(primary, '.worktrees', 'lane-a');
  git(primary, 'worktree', 'add', '-b', 'lane-a', lane);
  mkdirSync(join(lane, 'packages', 'sub'), { recursive: true });

  const roots = createAdlcRootState();
  roots.record(realpathSync(primary));

  assert.equal(resolveAdlcRoot(lane, null, roots), realpathSync(lane));
  assert.equal(resolveAdlcRoot(join(lane, 'packages', 'sub'), null, roots), realpathSync(lane));
});

test('checkShellCommand denies mutating commands that move workdir and allows root workdir or read-only commands', (t) => {
  const root = tmp(t, 'pi-shell-wd-');
  const ticket = { id: 'T1', title: 'Test', rails: ['src/frozen.js'] };

  const moved = checkShellCommand('rm frozen.js', ticket, root, { workdir: 'src' });
  assert.equal(moved.decision, 'deny');
  assert.match(moved.reason, /changes cwd/);

  const sameRoot = checkShellCommand('rm src/free.js', ticket, root, { workdir: root });
  assert.equal(sameRoot.decision, 'allow');

  const readOnlyInSub = checkShellCommand('ls -la', ticket, root, { workdir: 'src' });
  assert.equal(readOnlyInSub.decision, 'allow');
});

test('extension resolves subdirectory ctx.cwd to enclosing ADLC root and enforces rails on relative write and bash cwd', async (t) => {
  const root = tmp(t, 'pi-ext-sub-');
  git(root, 'init', '-b', 'main');
  mkdirSync(join(root, '.adlc'), { recursive: true });
  writeFileSync(
    join(root, '.adlc', 'tickets.json'),
    JSON.stringify({ tickets: [{ id: 'T1', title: 'Subdir test', rails: ['src/frozen.js'] }] })
  );
  writeFileSync(join(root, '.adlc', 'current-ticket.json'), JSON.stringify({ id: 'T1' }));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'frozen.js'), 'frozen\n');
  writeFileSync(join(root, 'src', 'free.js'), 'free\n');

  const handlers = new Map();
  const pi = {
    on(event, fn) {
      handlers.set(event, fn);
    },
    registerTool() {},
    registerCommand() {},
    sendMessage() {},
    async exec() {
      return { stdout: '', stderr: '', code: 0 };
    },
  };

  const ext = createExtension({ env: {} });
  ext(pi);

  const subCwd = join(root, 'src');
  const ctx = {
    cwd: subCwd,
    ui: { notify() {}, setWidget() {}, setStatus() {} },
    getContextUsage: () => ({ percent: 10 }),
    sessionManager: { getSessionId: () => 'sess-sub-1', getEntries: () => [] },
  };

  await handlers.get('session_start')({}, ctx);

  // Relative write 'frozen.js' from ctx.cwd = root/src hits rail 'src/frozen.js'
  const writeBlocked = await handlers.get('tool_call')(
    { toolName: 'write', toolCallId: 'c1', input: { path: 'frozen.js', content: 'tamper' } },
    ctx
  );
  assert.equal(writeBlocked?.block, true);

  // Relative write 'free.js' from ctx.cwd = root/src is allowed
  const writeAllowed = await handlers.get('tool_call')(
    { toolName: 'write', toolCallId: 'c2', input: { path: 'free.js', content: 'ok' } },
    ctx
  );
  assert.equal(writeAllowed, undefined);

  // Mutating bash with explicit cwd !== activeCwd is blocked
  const bashBlocked = await handlers.get('tool_call')(
    { toolName: 'bash', toolCallId: 'c3', input: { command: 'rm free.js', cwd: subCwd } },
    { ...ctx, cwd: root }
  );
  assert.equal(bashBlocked?.block, true);
  assert.match(bashBlocked?.reason ?? '', /changes cwd/);
});
