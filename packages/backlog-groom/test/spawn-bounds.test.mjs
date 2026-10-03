// spawn-bounds.test.mjs — every child process this package starts is bounded.
//
// A remote that accepts the connection and then stops answering blocks a
// synchronous spawn forever. On the read path that is a sweep that never
// reports; on the write path it is a run that hangs HOLDING the apply lock, so
// every later apply refuses behind it. Each spawn site gets a finite timeout and
// a SIGKILL, and a timeout surfaces as an ordinary failure.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fetchIssues, FETCH_TIMEOUT_MS } from '../lib/fetch.mjs';
import { makeGhWriter, GH_TIMEOUT_MS } from '../lib/gh.mjs';
import { makeReviewRunner, REVIEW_GRACE_S } from '../lib/gate.mjs';
import { gitRead, readFileAtRevision, GIT_READ_TIMEOUT_MS } from '../lib/git-read.mjs';
import { headCommit, pathKindAtRevision } from '../lib/verify.mjs';

const timedOut = () => Object.assign(new Error('spawnSync gh ETIMEDOUT'), { code: 'ETIMEDOUT', signal: 'SIGKILL' });

function assertBounded(opts, ceilingMs) {
  assert.equal(typeof opts?.timeout, 'number', 'a timeout must be passed');
  assert.ok(opts.timeout > 0 && opts.timeout <= ceilingMs, `timeout ${opts.timeout} must be finite and at most ${ceilingMs}`);
  assert.equal(opts.killSignal, 'SIGKILL');
}

// ---- read path -------------------------------------------------------------

test('gh issue list is bounded', () => {
  let seen;
  fetchIssues({ run: (cmd, args, opts) => { seen = opts; return '[]'; } });
  assertBounded(seen, FETCH_TIMEOUT_MS);
});

test('a gh issue list that times out is unconsultable, not an empty backlog', () => {
  const r = fetchIssues({ run: () => { throw timedOut(); } });
  assert.deepEqual(r.issues, []);
  assert.match(r.unconsultable, /timed out/);
});

test('git reads on the read path are bounded', () => {
  let seen;
  const run = (cmd, args, opts) => { seen = opts; return 'blob\n'; };
  gitRead(['cat-file', '-t', 'HEAD:x'], run);
  assertBounded(seen, GIT_READ_TIMEOUT_MS);
  assert.ok(seen.maxBuffer >= 64 * 1024 * 1024, 'a cited file is read whole — the 1 MiB default would truncate it');

  seen = null;
  pathKindAtRevision('x', 'HEAD', run);
  assertBounded(seen, GIT_READ_TIMEOUT_MS);

  seen = null;
  headCommit((cmd, args, opts) => { seen = opts; return `${'a'.repeat(40)}\n`; });
  assertBounded(seen, GIT_READ_TIMEOUT_MS);
});

test('file reads at a revision are bounded', () => {
  let seen;
  readFileAtRevision('x.mjs', 'HEAD', (cmd, args, opts) => { seen = { args, opts }; return 'body'; });
  assert.deepEqual(seen.args, ['show', 'HEAD:x.mjs']);
  assertBounded(seen.opts, GIT_READ_TIMEOUT_MS);
});

// ---- write path ------------------------------------------------------------

test('every gh writer call is bounded', () => {
  const seen = [];
  const gh = makeGhWriter({
    spawn: (cmd, args, opts) => {
      seen.push(opts);
      if (args[0] === 'api') return { status: 0, stdout: '{"login":"me"}' };
      if (args.includes('comments')) return { status: 0, stdout: '{"comments":[]}' };
      return { status: 0, stdout: '{"number":1,"labels":[]}' };
    },
  });
  gh.issue(1);
  gh.login();
  gh.comments(1);
  gh.comment(1, 'body');
  gh.apply(1, 'close');
  gh.apply(1, 'relabel', { from: 'a', to: 'b' });
  assert.equal(seen.length, 6);
  for (const opts of seen) assertBounded(opts, GH_TIMEOUT_MS);
});

test('a gh call that times out throws, naming the timeout', () => {
  const gh = makeGhWriter({ spawn: () => ({ status: null, signal: 'SIGKILL', error: timedOut() }) });
  assert.throws(() => gh.apply(1, 'close'), /^Error: gh issue timed out after 60s$/);
});

test('the reviewer spawn is bounded above its own --timeout', () => {
  let seen;
  const run = makeReviewRunner({
    spawn: (cmd, argv, opts) => { seen = opts; return { status: 0 }; },
    artifactPath: '/nonexistent/artifact.md',
    reviewer: 'openai',
    timeout: 600,
  });
  run();
  assertBounded(seen, (600 + REVIEW_GRACE_S) * 1000);
  assert.equal(seen.timeout, (600 + 120) * 1000, 'the reviewer\'s own timeout plus a two-minute grace');
});

test('a reviewer killed by the parent bound did not run — it is never a verdict', () => {
  const run = makeReviewRunner({
    spawn: () => ({ status: null, signal: 'SIGKILL', error: timedOut() }),
    artifactPath: '/nonexistent/artifact.md',
    reviewer: 'openai',
  });
  assert.throws(run);
});
