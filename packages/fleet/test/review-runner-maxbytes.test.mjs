// fleet-ext item 8: `fleet.reviewMaxBytes` reaches adversarial-review as
// `--max-bytes <n>`, and `--allow-summary-review` is NEVER passed — above the
// grounding limit a summary-only review silently drops every finding, which is
// a false green rather than a review. AC9 of the fleet-extensions ticket.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeReviewRunner } from '../lib/review-runner.mjs';
import { buildLiveDeps } from '../lib/live-deps.mjs';

function recorder(stdout = '{"verdict":"approve","findings":[]}') {
  const calls = [];
  const spawn = async (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { status: 0, stdout, stderr: '' }; };
  return { calls, spawn };
}
const resolveBin = () => '/usr/local/bin/adversarial-review';

test('--max-bytes carries the configured limit and --allow-summary-review never appears', async () => {
  const { calls, spawn } = recorder();
  const run = makeReviewRunner({ spawn, resolveBin, provider: 'codex', maxBytes: 262144, env: { PATH: '/usr/bin' } });
  const r = await run({ worktree: '/wt', startSha: 'SHA' });
  assert.equal(r.ok, true);
  const args = calls[0].args;
  const i = args.indexOf('--max-bytes');
  assert.ok(i >= 0, 'argv carries --max-bytes');
  assert.equal(args[i + 1], '262144', 'as a string with the configured value');
  assert.ok(!args.includes('--allow-summary-review'), 'summary-only reviews are never allowed');
  assert.deepEqual(args.slice(0, 5), ['--base', 'SHA', '--json', '--fail-on', 'medium'], 'the pre-existing argv prefix is unchanged');
});

test('no maxBytes → no --max-bytes (existing argv byte-identical); a non-positive value is not forwarded', async () => {
  for (const maxBytes of [null, undefined, 0, -5, 1.5]) {
    const { calls, spawn } = recorder();
    await makeReviewRunner({ spawn, resolveBin, maxBytes, env: { PATH: '/usr/bin' } })({ worktree: '/wt', startSha: 'S' });
    assert.ok(!calls[0].args.includes('--max-bytes'), `maxBytes=${maxBytes}: not forwarded`);
    assert.ok(!calls[0].args.includes('--allow-summary-review'));
  }
});

test('the runner returns review meta {provider, verdict, exitCode} the --json result echoes', async () => {
  const { spawn } = recorder('{"verdict":"needs-attention","findings":[{"severity":"high"}]}');
  const runNeeds = makeReviewRunner({ spawn, resolveBin, provider: 'codex', env: { PATH: '/usr/bin' } });
  const r = await runNeeds({ worktree: '/wt', startSha: 'S' });
  assert.deepEqual(r.review, { provider: 'codex', verdict: 'needs-attention', exitCode: 0 });
  const bare = recorder('{"findings":[]}');
  const r2 = await makeReviewRunner({ spawn: bare.spawn, resolveBin, env: { PATH: '/usr/bin' } })({ worktree: '/wt', startSha: 'S' });
  assert.equal(r2.review.verdict, 'approve', 'no verdict word in the document → derived from the exit code');
  assert.equal(r2.review.provider, null, 'no provider forced and none reported → null, never fabricated');
});

test('the live deps forward config.reviewMaxBytes into the runner (the whole path, not just the runner)', async () => {
  const calls = [];
  const io = {
    git: () => () => 'SHA',
    adlc: () => ({ status: 0, stdout: '' }), adlcAsync: async () => ({ status: 0, stdout: '' }),
    spawnWorker: async (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { status: 0, stdout: '{"findings":[]}', stderr: '' }; },
    readFile: () => '', exists: () => true, mkdirp: () => {}, writeJson: () => {}, appendLog: () => {}, ensureGitignore: () => {},
    env: { PATH: '/usr/bin', HOME: '/h' }, hasGh: () => false, copyTree: () => {},
  };
  // The runner resolves an absolute reviewBin only if it EXISTS (trusted-binary
  // rule L1/M2), so the fixture pins a real absolute file: this node binary.
  const deps = buildLiveDeps({
    repo: '/repo', statusDir: undefined, sandboxSpec: { mode: 'sandbox', backend: { name: 'bubblewrap' } }, io,
    config: { gate: { test: 'npm test' }, reviewProvider: 'codex', reviewMaxBytes: 4096, reviewBin: process.execPath, prosecuteFailOn: 'medium' },
  });
  const r = await deps.prosecute({ ticket: { id: 'T1' }, worktree: '/wt', startSha: 'SHA' });
  const reviewCall = calls.find((c) => c.cmd === process.execPath);
  assert.ok(reviewCall, 'the trusted reviewer binary was spawned');
  assert.ok(reviewCall.args.includes('--max-bytes') && reviewCall.args[reviewCall.args.indexOf('--max-bytes') + 1] === '4096');
  assert.ok(!reviewCall.args.includes('--allow-summary-review'));
  assert.equal(r.verdict, 'pass');
  assert.deepEqual(r.review, { provider: 'codex', verdict: 'approve', revision: 'SHA' }, 'review meta carries provider, verdict word and the reviewed revision');
});
