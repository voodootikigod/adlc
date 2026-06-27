import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapIssue, githubProvider } from '../lib/providers/github.mjs';

const raw = {
  id: 'I_node1', number: 42, url: 'https://github.com/acme/app/issues/42',
  title: 'Do the thing', body: 'desc', state: 'OPEN',
  labels: [{ name: 'adlc' }, { name: 'p1' }],
};

test('mapIssue maps gh fields incl. the node id and label names', () => {
  const m = mapIssue(raw);
  assert.equal(m.number, 42);
  assert.equal(m.nodeId, 'I_node1');
  assert.equal(m.state, 'open');
  assert.deepEqual(m.labels, ['adlc', 'p1']);
});

const fakeRunner = (stdout) => async () => ({ ok: true, code: 0, stdout, stderr: '', error: null });

test('listIssues returns mapped issues from gh json', async () => {
  const p = githubProvider();
  const r = await p.listIssues({ runner: fakeRunner(JSON.stringify([raw])), repo: 'acme/app', ticketSync: {} });
  assert.ok(r.ok);
  assert.equal(r.issues[0].nodeId, 'I_node1');
});

test('listIssues fails closed on possible truncation (count >= limit)', async () => {
  const p = githubProvider();
  const many = JSON.stringify([raw, raw]);
  const r = await p.listIssues({ runner: fakeRunner(many), repo: 'acme/app', ticketSync: {}, limit: 2 });
  assert.ok(!r.ok);
  assert.ok(r.truncated);
});

test('listIssues surfaces a gh error', async () => {
  const p = githubProvider();
  const r = await p.listIssues({ runner: async () => ({ ok: false, error: 'gh-not-found' }), repo: 'acme/app', ticketSync: {} });
  assert.ok(!r.ok);
  assert.equal(r.error, 'gh-not-found');
});
