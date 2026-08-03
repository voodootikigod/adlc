// The PROSECUTOR must not hold the credential that could forge its own verdict
// (issue #446).
//
// `modelPlaneEnv`'s NEVER_EXEMPT set exists for one stated reason: a process
// holding the ledger signing key could forge the cross-model attestations the
// trust-root merge gate is built on. The build worker is scrubbed accordingly.
// The review subprocess — whose verdict that gate trusts — was handed
// `{...process.env}` wholesale.
//
// Every assertion here is on the options object the REAL makeReviewRunner passed
// to an injected `spawn`. A helper that re-derived the env would be a copy of the
// thing under test, and a copy cannot catch drift in what it copies.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeReviewRunner } from '../lib/review-runner.mjs';
import { NEVER_EXEMPT } from '../lib/env-scrub.mjs';

const ctx = { worktree: '/wt', startSha: 'TIP', ticket: { id: 'T1' } };
const idResolve = (b) => b;

/** An ambient environment shaped like a real operator's. */
function ambientEnv() {
  return {
    PATH: `/usr/bin:/opt/homebrew/bin:.:${'/wt/node_modules/.bin'}`,
    HOME: '/home/op',
    ANTHROPIC_API_KEY: 'AMBIENT-anthropic-credential',
    OPENAI_API_KEY: 'AMBIENT-openai-credential',
    GEMINI_API_KEY: 'AMBIENT-gemini-credential',
    ADLC_MANIFEST_KEY: 'LEDGER-SIGNING-KEY-must-never-reach-the-prosecutor',
    ADLC_TICKET: 'T1',
  };
}

/** Run the REAL runner with an injected spawn, and return what it was given. */
async function capture(envOverride) {
  const env = envOverride ?? ambientEnv();
  let captured = null;
  const run = makeReviewRunner({
    resolveBin: idResolve,
    env,
    spawn: (cmd, args, opts) => {
      captured = { cmd, args, opts };
      return { status: 0, stdout: '{"findings":[]}' };
    },
  });
  const result = await run(ctx);
  return { captured, result, env };
}

// ---------------------------------------------------------------------------
// The hole this closes
// ---------------------------------------------------------------------------

test('NO name in NEVER_EXEMPT reaches the review subprocess', async () => {
  const { captured } = await capture();
  assert.ok(captured, 'the runner actually spawned something');
  assert.ok(NEVER_EXEMPT.size > 0, 'the set is non-empty, or this test proves nothing');
  for (const name of NEVER_EXEMPT) {
    assert.equal(
      captured.opts.env[name], undefined,
      `${name} must never reach the process whose verdict the merge gate trusts`,
    );
  }
});

test('the denial is driven by the real NEVER_EXEMPT set, not a copy of its members', async () => {
  // Asserted against the exported set so a future member is covered without
  // editing this test. A hard-coded 'ADLC_MANIFEST_KEY' here would pass while
  // the runner quietly failed to protect a newly-added credential.
  const env = ambientEnv();
  for (const name of NEVER_EXEMPT) env[name] = `SENTINEL-${name}`;
  const { captured } = await capture(env);
  const leaked = [...NEVER_EXEMPT].filter((n) => captured.opts.env[n] !== undefined);
  assert.deepEqual(leaked, [], `these never-exempt names leaked: ${leaked}`);
});

// ---------------------------------------------------------------------------
// …without breaking the reviewer
// ---------------------------------------------------------------------------

test('provider credentials still reach the reviewer, values untouched', async () => {
  // The reviewer calls a model; stripping these would fail every prosecution,
  // and prosecution fails CLOSED — so "nothing can merge", not a visible error.
  const { captured } = await capture();
  assert.equal(captured.opts.env.ANTHROPIC_API_KEY, 'AMBIENT-anthropic-credential');
  assert.equal(captured.opts.env.OPENAI_API_KEY, 'AMBIENT-openai-credential');
  assert.equal(captured.opts.env.GEMINI_API_KEY, 'AMBIENT-gemini-credential');
});

test('ordinary non-secret variables are still passed through', async () => {
  const { captured } = await capture();
  assert.equal(captured.opts.env.HOME, '/home/op');
  assert.equal(captured.opts.env.ADLC_TICKET, 'T1');
});

test('PATH is still sanitized to absolute, non-worktree directories', async () => {
  // L1/M2: the child must not be able to resolve a worker-planted binary
  // relative to cwd=worktree. Unchanged by this fix, and pinned so it stays so.
  const { captured } = await capture();
  const dirs = captured.opts.env.PATH.split(':');
  assert.ok(!dirs.includes('.'), 'a relative PATH entry would let cwd win');
  assert.ok(!dirs.some((d) => d.startsWith('/wt')), 'the worktree must not be on the child PATH');
  assert.ok(dirs.includes('/usr/bin'), 'trusted absolute entries survive');
});

// ---------------------------------------------------------------------------
// It must not damage the caller
// ---------------------------------------------------------------------------

test('the runner never mutates the environment object it was handed', async () => {
  // The production caller passes process.env. Deleting from it in place would
  // strip the signing key from the ORCHESTRATOR, which needs it to sign manifest
  // entries — a delayed, bizarre failure where reviews work and recording
  // silently produces unsigned entries the gate later rejects.
  const env = ambientEnv();
  const before = JSON.stringify(env);
  await capture(env);
  assert.equal(JSON.stringify(env), before, 'the source environment is untouched');
  assert.equal(env.ADLC_MANIFEST_KEY, 'LEDGER-SIGNING-KEY-must-never-reach-the-prosecutor');
});

test('the scrub applies on the path that actually spawns, not merely somewhere', async () => {
  // Asserted on the options the injected spawn received — an early return or a
  // scrub in the wrong branch would look right in review and never execute here.
  const { captured, result } = await capture();
  assert.equal(result.ok, true, 'the review completed, so this is the live path');
  assert.ok(Object.prototype.hasOwnProperty.call(captured.opts, 'env'), 'an env was passed at all');
  assert.equal(captured.opts.env.ADLC_MANIFEST_KEY, undefined);
});

// ---------------------------------------------------------------------------
// The property that only becomes observable once the set grows
// ---------------------------------------------------------------------------

test('denyNeverExempt scales with the SET, not with its current single member', async () => {
  // `NEVER_EXEMPT` holds one name today, which makes "iterate the set" and
  // "delete that one name" behaviourally identical — a hand-planted mutant that
  // denies only the first member is EQUIVALENT right now, and the drift the
  // premortem warned about (the set grows, the reviewer silently stops being
  // protected) is untestable through the production constant.
  //
  // The helper takes the set as a parameter precisely so this can be proven.
  const { denyNeverExempt } = await import('../lib/env-scrub.mjs');
  const source = { KEEP: 'yes', SECRET_A: 'a', SECRET_B: 'b', SECRET_C: 'c' };
  const out = denyNeverExempt(source, new Set(['SECRET_A', 'SECRET_B', 'SECRET_C']));
  assert.equal(out.SECRET_A, undefined, 'first member denied');
  assert.equal(out.SECRET_B, undefined, 'second member denied — this is the one that drifts');
  assert.equal(out.SECRET_C, undefined, 'and the third');
  assert.equal(out.KEEP, 'yes', 'nothing else is touched');
  assert.equal(source.SECRET_A, 'a', 'the source is copied, never mutated');
});

test('makeReviewRunner() constructs with ALL defaults, evaluating every default parameter', () => {
  // Every other test here injects `spawn`, `env` and `resolveBin`, so none of
  // them evaluates the default-parameter list. An adversarial round read the
  // diff alone and concluded `spawn = defaultSpawn` was an undeclared
  // identifier — it is a hoisted function declaration further down the file, so
  // the claim was false, but nothing in the suite would have caught it if it
  // were true. This closes that: construction alone forces every default to
  // resolve, and it spawns nothing.
  assert.doesNotThrow(() => {
    const run = makeReviewRunner();
    assert.equal(typeof run, 'function', 'it returns the runner');
  });
});
