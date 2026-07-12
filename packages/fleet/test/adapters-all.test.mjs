import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getAdapter } from '../lib/adapters/index.mjs';

const PROMPT = 'build ticket T1 as specified';
const ENV = { ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: 'T1', ANTHROPIC_API_KEY: 'sk' };

// Each entry: adapter name → expected default { cmd, args } and whether it pipes
// the prompt on stdin (agy).
const EXPECTED = {
  codex: { cmd: 'codex', args: ['exec', PROMPT], stdin: false },
  agy: { cmd: 'agy', args: ['--print'], stdin: true },
  opencode: { cmd: 'opencode', args: ['run', PROMPT], stdin: false },
  pi: { cmd: 'pi', args: ['run', PROMPT], stdin: false },
  cursor: { cmd: 'cursor-agent', args: ['-p', PROMPT], stdin: false },
};

function stubExec(rec, result = { status: 0, stdout: 'ok', stderr: '' }) {
  return (cmd, args, opts) => { rec.push({ cmd, args, opts }); return result; };
}

for (const [adapterName, exp] of Object.entries(EXPECTED)) {
  test(`${adapterName}: dispatch spawns the harness headless with the prompt + model-plane env (AC2)`, async () => {
    const rec = [];
    const r = await getAdapter(adapterName).dispatch({
      worktree: '/wt/T1', prompt: PROMPT, timeoutMs: 60000, env: ENV, exec: stubExec(rec),
    });
    assert.equal(rec.length, 1);
    assert.equal(rec[0].cmd, exp.cmd, `${adapterName}: command`);
    assert.deepEqual(rec[0].args, exp.args, `${adapterName}: default args`);
    assert.equal(rec[0].opts.cwd, '/wt/T1', `${adapterName}: cwd is the worktree`);
    assert.equal(rec[0].opts.env, ENV, `${adapterName}: env passed through (model plane)`);
    assert.equal(rec[0].opts.timeout, 60000);
    if (exp.stdin) assert.equal(rec[0].opts.input, PROMPT, `${adapterName}: prompt piped on stdin`);
    else assert.equal(rec[0].opts.input, undefined, `${adapterName}: does NOT pipe stdin by default`);
    assert.equal(r.exitCode, 0);
  });

  test(`${adapterName}: a non-zero exit maps to a failed-strike result`, async () => {
    const rec = [];
    const r = await getAdapter(adapterName).dispatch({
      worktree: '/wt/T1', prompt: PROMPT, timeoutMs: 60000, env: ENV,
      exec: stubExec(rec, { status: 3, stderr: 'boom' }),
    });
    assert.equal(r.exitCode, 3);
    assert.match(r.output, /boom/);
  });

  test(`${adapterName}: a timeout maps to timedOut with a non-zero exit`, async () => {
    const rec = [];
    const r = await getAdapter(adapterName).dispatch({
      worktree: '/wt/T1', prompt: PROMPT, timeoutMs: 10, env: ENV,
      exec: stubExec(rec, { status: null, signal: 'SIGTERM', timedOut: true }),
    });
    assert.equal(r.timedOut, true);
    assert.notEqual(r.exitCode, 0);
  });

  test(`${adapterName}: config command/args override the default (AC3 — CLI change is a config fix)`, async () => {
    const rec = [];
    await getAdapter(adapterName).dispatch({
      worktree: '/wt/T1', prompt: PROMPT, timeoutMs: 60000, env: ENV, exec: stubExec(rec),
      command: 'my-harness', args: ['--custom', 'flag'],
    });
    assert.equal(rec[0].cmd, 'my-harness', `${adapterName}: command overridden`);
    assert.deepEqual(rec[0].args, ['--custom', 'flag'], `${adapterName}: args overridden`);
  });
}

test('pi: useStdin pipes the prompt on stdin (A3 RPC transport)', async () => {
  const rec = [];
  await getAdapter('pi').dispatch({ worktree: '/wt', prompt: PROMPT, timeoutMs: 1, env: ENV, exec: stubExec(rec), args: ['--mode', 'rpc'], useStdin: true });
  assert.deepEqual(rec[0].args, ['--mode', 'rpc']);
  assert.equal(rec[0].opts.input, PROMPT, 'prompt routed to stdin when useStdin');
});

test('agy: --model is added from the model option', async () => {
  const rec = [];
  await getAdapter('agy').dispatch({ worktree: '/wt', prompt: PROMPT, timeoutMs: 1, env: ENV, exec: stubExec(rec), model: 'Claude Opus 4.6' });
  assert.deepEqual(rec[0].args, ['--print', '--model', 'Claude Opus 4.6']);
});
