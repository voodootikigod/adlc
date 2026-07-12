import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeReviewRunner, resolveTrustedBin } from '../lib/review-runner.mjs';
import { prosecute } from '../lib/prosecute.mjs';

const ctx = { worktree: '/wt', startSha: 'TIP', ticket: { id: 'T1' } };
// Identity resolver in tests that exercise spawn/parse logic (resolution is
// covered separately by the resolveTrustedBin tests below).
const idResolve = (b) => b;
const mk = (opts) => makeReviewRunner({ resolveBin: idResolve, ...opts });

test('review runner runs a TRUSTED binary (not npx) with --base <startSha> --json (L1)', () => {
  let captured;
  const run = mk({ spawn: (cmd, args, opts) => { captured = { cmd, args, opts }; return { status: 0, stdout: '{"findings":[]}' }; } });
  run(ctx);
  assert.equal(captured.cmd, 'adversarial-review', 'invoked by trusted name, NOT via npx-from-worktree (L1)');
  assert.notEqual(captured.cmd, 'npx');
  const i = captured.args.indexOf('--base');
  assert.equal(captured.args[i + 1], 'TIP', 'diffs against the ticket startSha (N3)');
  assert.ok(captured.args.includes('--json'));
  assert.equal(captured.opts.cwd, '/wt');
  assert.ok(captured.opts.env && typeof captured.opts.env.PATH === 'string', 'resolved against a sanitized PATH');
});

test('a configured absolute reviewBin is honored (pinned trusted path)', () => {
  let captured;
  const run = mk({ reviewBin: '/opt/trusted/adversarial-review', spawn: (cmd) => { captured = cmd; return { status: 0, stdout: '{"findings":[]}' }; } });
  run(ctx);
  assert.equal(captured, '/opt/trusted/adversarial-review');
});

test('a clean review (exit 0) → prosecute passes', () => {
  const runReview = mk({ spawn: () => ({ status: 0, stdout: '{"findings":[]}' }) });
  assert.equal(prosecute(ctx, { runReview }).verdict, 'pass');
});

test('needs-attention (exit 2) with a >=medium finding → prosecute BLOCKS (AC4)', () => {
  const runReview = mk({ spawn: () => ({ status: 2, stdout: '{"findings":[{"severity":"high","title":"x"}]}' }) });
  assert.equal(prosecute(ctx, { runReview }).verdict, 'block');
});

test('unreachable provider (exit 1) → prosecute fails CLOSED (AC4)', () => {
  const runReview = mk({ spawn: () => ({ status: 1, stderr: 'no provider configured' }) });
  assert.equal(prosecute(ctx, { runReview }).verdict, 'unavailable');
});

test('spawn error (ENOENT) → fail closed', () => {
  const runReview = mk({ spawn: () => ({ error: new Error('spawn ENOENT') }) });
  assert.equal(prosecute(ctx, { runReview }).verdict, 'unavailable');
});

test('a THROWING spawn (not an error result) → fail closed', () => {
  const runReview = mk({ spawn: () => { throw new Error('spawn threw'); } });
  assert.equal(prosecute(ctx, { runReview }).verdict, 'unavailable', 'a review that cannot even be launched must never pass');
});

test('exit 1 WITH valid JSON still fails closed (exit code is authoritative)', () => {
  const runReview = mk({ spawn: () => ({ status: 1, stdout: '{"findings":[]}' }) });
  assert.equal(prosecute(ctx, { runReview }).verdict, 'unavailable');
});

test('exit 0 but non-JSON output → fail closed', () => {
  const runReview = mk({ spawn: () => ({ status: 0, stdout: 'not json' }) });
  assert.equal(prosecute(ctx, { runReview }).verdict, 'unavailable');
});

test('provider flag is passed through when configured', () => {
  let captured;
  const run = mk({ provider: 'codex', spawn: (_cmd, a) => { captured = a; return { status: 0, stdout: '{"findings":[]}' }; } });
  run(ctx);
  assert.equal(captured[captured.indexOf('--provider') + 1], 'codex');
});

// ---- resolveTrustedBin: the M2 security boundary (no cwd/relative shadowing) ----

test('resolveTrustedBin rejects relative/empty PATH and the worktree, preventing shadowing (M2)', () => {
  // A relative PATH (node_modules/.bin, ".", empty) must NOT resolve — even if a
  // binary of that name sits in the worktree.
  assert.equal(resolveTrustedBin('adversarial-review', 'node_modules/.bin:.:', '/wt'), null);
  assert.equal(resolveTrustedBin('adversarial-review', '', '/wt'), null);
  // The worktree itself, even if absolute and on PATH, is excluded.
  assert.equal(resolveTrustedBin('adversarial-review', '/wt:/wt/node_modules/.bin', '/wt'), null);
});

test('resolveTrustedBin fails closed → prosecute unavailable when no trusted bin exists (M2)', () => {
  // Use the REAL resolver against a relative-only PATH: nothing trusted resolves.
  const runReview = makeReviewRunner({ reviewBin: 'adversarial-review', trustedPath: 'node_modules/.bin:.', spawn: () => ({ status: 0, stdout: '{"findings":[]}' }) });
  const r = prosecute(ctx, { runReview });
  assert.equal(r.verdict, 'unavailable', 'a worktree-shadowable PATH must fail closed, not run the fake');
});

test('resolveTrustedBin returns an absolute reviewBin only if it exists', () => {
  assert.equal(resolveTrustedBin('/definitely/not/here/adversarial-review', '/usr/bin', '/wt'), null);
  // A real absolute path that exists (use node itself as a stand-in existing file).
  assert.equal(resolveTrustedBin(process.execPath, '/usr/bin', '/wt'), process.execPath);
});
