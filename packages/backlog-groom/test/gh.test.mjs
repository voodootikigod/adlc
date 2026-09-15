// gh.test.mjs — the writer's failure handling, out of the binary.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeGhWriter, issueSelector } from '../lib/gh.mjs';

const ok = (stdout = '') => ({ status: 0, stdout });

test('a non-zero exit is a failure even with no Error object', () => {
  // The ordinary gh failure shape: a status and a stderr, no `error`. Requiring
  // both would let every real failure read as success.
  const gh = makeGhWriter({ spawn: () => ({ status: 1, stderr: 'gh: not found\n' }) });
  assert.throws(() => gh.comment(7, 'body'), /not found/);
});

test('a spawn error is a failure even with a zero status', () => {
  const gh = makeGhWriter({ spawn: () => ({ status: 0, error: new Error('ENOENT') }) });
  assert.throws(() => gh.comment(7, 'body'), /ENOENT/);
});

test('a successful write returns stdout', () => {
  const gh = makeGhWriter({ spawn: () => ok('done\n') });
  assert.equal(gh.comment(7, 'body'), 'done\n');
});

test('comments returns each body WITH its author', () => {
  // Authorship is load-bearing: the idempotence marker is derivable from public
  // facts, so only our own prior comment can count as the evidence trail.
  const gh = makeGhWriter({ spawn: () => ok(JSON.stringify({ comments: [{ body: 'one', author: { login: 'me' } }, { body: 'two', author: { login: 'them' } }] })) });
  assert.deepEqual(gh.comments(7), [
    { body: 'one', author: 'me' },
    { body: 'two', author: 'them' },
  ]);
});

test('a comment with no author is attributed to nobody, not to us', () => {
  const gh = makeGhWriter({ spawn: () => ok(JSON.stringify({ comments: [{ body: 'x' }] })) });
  assert.deepEqual(gh.comments(7), [{ body: 'x', author: null }]);
});

test('login reads the authenticated user', () => {
  let seen = null;
  const gh = makeGhWriter({ spawn: (cmd, args) => { seen = args; return ok('{"login":"me"}'); } });
  assert.equal(gh.login(), 'me');
  assert.deepEqual(seen, ['api', 'user']);
});

test('an issue with no comments key yields an empty list', () => {
  const gh = makeGhWriter({ spawn: () => ok('{}') });
  assert.deepEqual(gh.comments(7), []);
});

test('UNPARSEABLE output throws rather than reporting no comments', () => {
  // The dangerous default: [] would make the idempotence check believe nothing
  // had been written, and the next run would re-comment on every issue.
  const gh = makeGhWriter({ spawn: () => ok('<html>rate limited</html>') });
  assert.throws(() => gh.comments(7), /could not parse/);
});

test('comments asks gh for exactly the issue and field it needs', () => {
  let seen = null;
  const gh = makeGhWriter({ spawn: (cmd, args) => { seen = { cmd, args }; return ok('{}'); } });
  gh.comments(7);
  assert.equal(seen.cmd, 'gh');
  assert.deepEqual(seen.args, ['issue', 'view', '7', '--json', 'comments']);
});

test('comment passes the body on stdin, never as an argument', () => {
  // A body on argv is a body subject to shell and length limits, and this one
  // carries arbitrary issue text.
  let seen = null;
  const gh = makeGhWriter({ spawn: (cmd, args, opts) => { seen = { args, input: opts.input }; return ok(); } });
  gh.comment(7, 'the evidence');
  assert.deepEqual(seen.args, ['issue', 'comment', '7', '--body-file', '-']);
  assert.equal(seen.input, 'the evidence');
});

test('close is wired', () => {
  let seen = null;
  const gh = makeGhWriter({ spawn: (cmd, args) => { seen = args; return ok(); } });
  gh.apply(7, 'close');
  assert.deepEqual(seen, ['issue', 'close', '7']);
});

test('an unwired action throws rather than silently doing nothing', () => {
  // A no-op that returned successfully would mark the issue actioned when
  // nothing happened to it.
  const gh = makeGhWriter({ spawn: () => ok() });
  assert.throws(() => gh.apply(7, 'duplicate-link'), /no writer wired/);
});

test('relabel removes the old label and adds the new one in a single call', () => {
  // Two calls could leave the issue with neither label if the second failed —
  // and the comment has already claimed the change happened.
  let seen = null;
  const gh = makeGhWriter({ spawn: (cmd, args) => { seen = args; return ok(); } });
  gh.apply(7, 'relabel', { from: 'P3-low', to: 'P1-high' });
  assert.deepEqual(seen, ['issue', 'edit', '7', '--remove-label', 'P3-low', '--add-label', 'P1-high']);
});

test('a relabel naming neither label is refused rather than issuing a no-op edit', () => {
  const gh = makeGhWriter({ spawn: () => ok() });
  assert.throws(() => gh.apply(7, 'relabel', {}), /neither a from nor a to/);
});

test('a relabel that only adds is allowed', () => {
  let seen = null;
  const gh = makeGhWriter({ spawn: (cmd, args) => { seen = args; return ok(); } });
  gh.apply(7, 'relabel', { to: 'area:review' });
  assert.deepEqual(seen, ['issue', 'edit', '7', '--add-label', 'area:review']);
});

test('a failure with no stderr and no error still names the gh subcommand', () => {
  // The last-resort message. Naming the wrong argv slot would report
  // "gh view failed" for an `issue view` call — the operator then greps for a
  // subcommand that does not exist.
  const gh = makeGhWriter({ spawn: () => ({ status: 1 }) });
  assert.throws(() => gh.comments(7), /gh issue failed/);
});

test('stderr is preferred over the generic message when gh explains itself', () => {
  const gh = makeGhWriter({ spawn: () => ({ status: 1, stderr: '  could not resolve to an Issue\n' }) });
  assert.throws(() => gh.comments(7), /could not resolve to an Issue/);
});

// ---- the issue selector is argv, so it must be a number --------------------

test('a non-numeric issue selector is refused before any gh call', () => {
  // `--repo other/owner` is a perfectly good string. An unvalidated selector,
  // read from a JSON file on disk, would let a crafted set point every call at a
  // repository the operator never named — and close issues there.
  const gh = makeGhWriter({ spawn: () => { throw new Error('must not spawn'); } });
  for (const bad of ['--repo other/owner', '7 --repo x', 1.5, -1, 0, null, undefined, '7']) {
    assert.throws(() => gh.comments(bad), /positive integer/, `${JSON.stringify(bad)} must be refused`);
  }
});

test('every write path validates the selector, not just the read', () => {
  const gh = makeGhWriter({ spawn: () => { throw new Error('must not spawn'); } });
  assert.throws(() => gh.comment('--repo x', 'body'), /positive integer/);
  assert.throws(() => gh.apply('--repo x', 'close'), /positive integer/);
  assert.throws(() => gh.apply('--repo x', 'relabel', { to: 'a' }), /positive integer/);
  assert.throws(() => gh.issue('--repo x'), /positive integer/);
});

test('a valid selector passes through as a string', () => {
  assert.equal(issueSelector(705), '705');
});

test('issue #1 is a real issue number and is accepted', () => {
  // The boundary is zero, not one. Every repository has an issue #1, and a
  // validator that rejected it would be unusable on the oldest issues in a
  // backlog — which is exactly where a grooming sweep starts.
  assert.equal(issueSelector(1), '1');
  assert.throws(() => issueSelector(0), /positive integer/);
});
