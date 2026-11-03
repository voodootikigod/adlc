import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAdapter } from '../lib/adapters/index.mjs';

const STUB_BIN = mkdtempSync(join(tmpdir(), "fleet-print-argv-bin-"));
for (const bin of ["agy", "jetski"]) {
  const p = join(STUB_BIN, bin);
  writeFileSync(p, "#!/bin/sh\nexit 0\n");
  chmodSync(p, 0o755);
}
after(() => { rmSync(STUB_BIN, { recursive: true, force: true }); });

const PROMPT = 'build ticket T1 as specified';
const ENV = { ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: 'T1', PATH: STUB_BIN };

function stubExec(rec, result = { status: 0, stdout: 'ok', stderr: '' }) {
  return (cmd, args, opts) => { rec.push({ cmd, args, opts }); return result; };
}

// AC1 — gemini/agy/jetski default (no args override) sends the prompt as the
// `--print` flag's argv value, not on stdin.
for (const adapterName of ['gemini', 'agy', 'jetski']) {
  test(`${adapterName}: default argv carries the prompt after --print, no stdin (AC1)`, async () => {
    const rec = [];
    await getAdapter(adapterName).dispatch({
      worktree: '/wt/T1', prompt: PROMPT, timeoutMs: 1, env: ENV, exec: stubExec(rec),
    });
    assert.deepEqual(rec[0].args, ['--print', PROMPT], `${adapterName}: prompt is the --print argv value`);
    assert.equal(rec[0].opts.input, undefined, `${adapterName}: does not pipe stdin by default`);
  });

  // AC2 — useStdin:true restores the OLD stdin-piped shape as an explicit opt-in.
  test(`${adapterName}: useStdin:true restores the stdin-piped shape (AC2)`, async () => {
    const rec = [];
    await getAdapter(adapterName).dispatch({
      worktree: '/wt/T1', prompt: PROMPT, timeoutMs: 1, env: ENV, exec: stubExec(rec), useStdin: true,
    });
    assert.deepEqual(rec[0].args, ['--print'], `${adapterName}: no prompt in argv when useStdin`);
    assert.equal(rec[0].opts.input, PROMPT, `${adapterName}: prompt piped on stdin when useStdin`);
  });

  test(`${adapterName}: useStdin:true still forces an explicit model onto argv`, async () => {
    const rec = [];
    await getAdapter(adapterName).dispatch({
      worktree: '/wt/T1', prompt: PROMPT, timeoutMs: 1, env: ENV, exec: stubExec(rec), useStdin: true, model: 'probe/model-x',
    });
    assert.deepEqual(rec[0].args, ['--print', '--model', 'probe/model-x']);
    assert.equal(rec[0].opts.input, PROMPT);
  });

  test(`${adapterName}: an explicit args override is used verbatim regardless of useStdin`, async () => {
    const rec = [];
    await getAdapter(adapterName).dispatch({
      worktree: '/wt/T1', prompt: PROMPT, timeoutMs: 1, env: ENV, exec: stubExec(rec), args: ['--custom', 'flag'],
    });
    assert.deepEqual(rec[0].args, ['--custom', 'flag']);
    assert.equal(rec[0].opts.input, undefined, 'no stdin when useStdin is not set, even with an args override');
  });
}

// AC3 — pi default (no args override) sends `['--print', prompt]`, not `['run', prompt]`.
test('pi: default argv is [--print, prompt], not [run, prompt] (AC3)', async () => {
  const rec = [];
  await getAdapter('pi').dispatch({
    worktree: '/wt/T1', prompt: PROMPT, timeoutMs: 1, env: ENV, exec: stubExec(rec),
  });
  assert.deepEqual(rec[0].args, ['--print', PROMPT]);
  assert.equal(rec[0].opts.input, undefined, 'pi default does not pipe stdin');
});
