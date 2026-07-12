import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeReviewRunner } from '../lib/review-runner.mjs';
import { prosecute } from '../lib/prosecute.mjs';

const ctx = { worktree: '/wt', startSha: 'TIP', ticket: { id: 'T1' } };

test('review runner runs a TRUSTED binary (not npx) with --base <startSha> --json (L1)', () => {
  let captured;
  const run = makeReviewRunner({ spawn: (cmd, args, opts) => { captured = { cmd, args, opts }; return { status: 0, stdout: '{"findings":[]}' }; } });
  run(ctx);
  assert.equal(captured.cmd, 'adversarial-review', 'invoked by trusted name, NOT via npx-from-worktree (L1)');
  assert.notEqual(captured.cmd, 'npx');
  const i = captured.args.indexOf('--base');
  assert.equal(captured.args[i + 1], 'TIP', 'diffs against the ticket startSha (N3)');
  assert.ok(captured.args.includes('--json'));
  assert.equal(captured.opts.cwd, '/wt');
  assert.ok(captured.opts.env && typeof captured.opts.env.PATH === 'string', 'resolved against a trusted PATH, not the worktree');
});

test('a configured absolute reviewBin is honored (pinned trusted path)', () => {
  let captured;
  const run = makeReviewRunner({ reviewBin: '/opt/trusted/adversarial-review', spawn: (cmd) => { captured = cmd; return { status: 0, stdout: '{"findings":[]}' }; } });
  run(ctx);
  assert.equal(captured, '/opt/trusted/adversarial-review');
});

test('a clean review (exit 0) → prosecute passes', () => {
  const runReview = makeReviewRunner({ spawn: () => ({ status: 0, stdout: '{"findings":[]}' }) });
  assert.equal(prosecute(ctx, { runReview }).verdict, 'pass');
});

test('needs-attention (exit 2) with a >=medium finding → prosecute BLOCKS (AC4)', () => {
  const runReview = makeReviewRunner({ spawn: () => ({ status: 2, stdout: '{"findings":[{"severity":"high","title":"x"}]}' }) });
  const r = prosecute(ctx, { runReview });
  assert.equal(r.verdict, 'block');
});

test('unreachable provider (exit 1) → prosecute fails CLOSED (AC4)', () => {
  const runReview = makeReviewRunner({ spawn: () => ({ status: 1, stderr: 'no provider configured' }) });
  const r = prosecute(ctx, { runReview });
  assert.equal(r.verdict, 'unavailable');
});

test('spawn error (ENOENT) → fail closed', () => {
  const runReview = makeReviewRunner({ spawn: () => ({ error: new Error('spawn npx ENOENT') }) });
  assert.equal(prosecute(ctx, { runReview }).verdict, 'unavailable');
});

test('a THROWING spawn (not an error result) → fail closed', () => {
  const runReview = makeReviewRunner({ spawn: () => { throw new Error('spawn threw'); } });
  const r = prosecute(ctx, { runReview });
  assert.equal(r.verdict, 'unavailable', 'a review that cannot even be launched must never pass');
});

test('exit 1 WITH valid JSON still fails closed (exit code is authoritative, not stdout)', () => {
  // Even if the CLI printed parseable JSON, a status-1 means the review could not
  // complete — the exit-code guard, not the parse guard, must reject it.
  const runReview = makeReviewRunner({ spawn: () => ({ status: 1, stdout: '{"findings":[]}' }) });
  assert.equal(prosecute(ctx, { runReview }).verdict, 'unavailable');
});

test('exit 0 but non-JSON output → fail closed (cannot trust verdict)', () => {
  const runReview = makeReviewRunner({ spawn: () => ({ status: 0, stdout: 'not json' }) });
  assert.equal(prosecute(ctx, { runReview }).verdict, 'unavailable');
});

test('provider flag is passed through when configured', () => {
  let captured;
  const run = makeReviewRunner({ provider: 'codex', spawn: (_cmd, a) => { captured = a; return { status: 0, stdout: '{"findings":[]}' }; } });
  run(ctx);
  const i = captured.indexOf('--provider');
  assert.equal(captured[i + 1], 'codex');
});
