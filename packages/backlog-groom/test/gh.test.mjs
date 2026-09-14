// gh.test.mjs — the writer's failure handling, out of the binary.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeGhWriter } from '../lib/gh.mjs';

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

test('comments parses the bodies it was given', () => {
  const gh = makeGhWriter({ spawn: () => ok(JSON.stringify({ comments: [{ body: 'one' }, { body: 'two' }] })) });
  assert.deepEqual(gh.comments(7), ['one', 'two']);
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
  assert.throws(() => gh.apply(7, 'relabel'), /no writer wired/);
});
