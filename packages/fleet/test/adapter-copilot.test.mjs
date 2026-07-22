import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as copilot from '../lib/adapters/copilot.mjs';

const PROMPT = 'build ticket T1 as specified';
const ENV = { ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: 'T1' };

function stubExec(rec, result = { status: 0, stdout: 'ok', stderr: '' }) {
  return (cmd, args, opts) => { rec.push({ cmd, args, opts }); return result; };
}

test('default posture: explicit allowlist (write+shell) — NOT --allow-all-tools, so the rails-guard hook still enforces', async () => {
  const rec = [];
  await copilot.dispatch({ worktree: '/wt/T1', prompt: PROMPT, timeoutMs: 60000, env: ENV, exec: stubExec(rec) });
  assert.equal(rec[0].cmd, 'copilot');
  assert.deepEqual(rec[0].args, ['-p', PROMPT, '--allow-tool', 'write', '--allow-tool', 'shell']);
  assert.equal(rec[0].args.includes('--allow-all-tools'), false, '--allow-all-tools would auto-approve the hook deny-ask (verified live #240)');
  assert.equal(rec[0].opts.input, undefined, 'prompt is an arg, not stdin');
});

test('allowAllTools:true opts into CI-gate-only autonomy (neuters the in-session hook)', async () => {
  const rec = [];
  await copilot.dispatch({ worktree: '/wt', prompt: PROMPT, timeoutMs: 1, env: ENV, exec: stubExec(rec), allowAllTools: true });
  assert.deepEqual(rec[0].args, ['-p', PROMPT, '--allow-all-tools']);
});

test('denyShell strips the shell tool category (deny beats allow)', async () => {
  const rec = [];
  await copilot.dispatch({ worktree: '/wt', prompt: PROMPT, timeoutMs: 1, env: ENV, exec: stubExec(rec), denyShell: true });
  assert.deepEqual(rec[0].args, ['-p', PROMPT, '--allow-tool', 'write', '--allow-tool', 'shell', '--deny-tool', 'shell']);
});

test('allowTools overrides the default allowlist; denyTools append', async () => {
  const rec = [];
  await copilot.dispatch({
    worktree: '/wt', prompt: PROMPT, timeoutMs: 1, env: ENV, exec: stubExec(rec),
    allowTools: ['write(src)'], denyTools: ['url'],
  });
  assert.deepEqual(rec[0].args, ['-p', PROMPT, '--allow-tool', 'write(src)', '--deny-tool', 'url']);
});

test('non-zero exit maps to a failed-strike result', async () => {
  const r = await copilot.dispatch({ worktree: '/wt', prompt: PROMPT, timeoutMs: 1, env: ENV, exec: stubExec([], { status: 2, stderr: 'boom' }) });
  assert.equal(r.exitCode, 2);
  assert.match(r.output, /boom/);
});

test('timeout maps to timedOut with a non-zero exit', async () => {
  const r = await copilot.dispatch({ worktree: '/wt', prompt: PROMPT, timeoutMs: 1, env: ENV, exec: stubExec([], { status: null, signal: 'SIGTERM', timedOut: true }) });
  assert.equal(r.timedOut, true);
  assert.notEqual(r.exitCode, 0);
});

test('command/args override the default (a CLI change is a config fix)', async () => {
  const rec = [];
  await copilot.dispatch({ worktree: '/wt', prompt: PROMPT, timeoutMs: 1, env: ENV, exec: stubExec(rec), command: 'my-copilot', args: ['--custom'] });
  assert.equal(rec[0].cmd, 'my-copilot');
  assert.deepEqual(rec[0].args, ['--custom']);
});
