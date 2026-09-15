// fetch.test.mjs — AC4.
//
// The truncation rule is inherited from `scripts/release-audit-collect.mjs`
// `fetchIssues` for its stated reason: a capped list is indistinguishable from a
// complete one, so silently dropping the tail would let a sweep report "nothing
// to groom" about issues it never saw. That is the same false-green the whole
// package exists to prevent, so it is enforced here rather than trusted.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ISSUE_FETCH_LIMIT, fetchIssues } from '../lib/fetch.mjs';

/** A fake `run` returning the given stdout, recording the argv it was handed. */
function fakeRun(stdout, calls = []) {
  return (cmd, args) => {
    calls.push({ cmd, args });
    return stdout;
  };
}

function issueList(n, overrides = {}) {
  return JSON.stringify(
    Array.from({ length: n }, (_, i) => ({
      number: i + 1,
      title: `issue ${i + 1}`,
      body: 'body',
      labels: [{ name: 'bug' }],
      url: `https://example.invalid/${i + 1}`,
      updatedAt: '2026-09-13T00:00:00Z',
      ...overrides,
    }))
  );
}

test('AC4: a response of exactly the fetch limit is reported as truncated, never as complete', () => {
  const r = fetchIssues({ run: fakeRun(issueList(ISSUE_FETCH_LIMIT)) });
  assert.equal(r.truncated, ISSUE_FETCH_LIMIT, 'a full page must announce the cap it hit');
  assert.equal(r.issues.length, ISSUE_FETCH_LIMIT, 'the issues it did see are still returned');
});

test('AC4: a short response is not truncated', () => {
  const r = fetchIssues({ run: fakeRun(issueList(3)) });
  assert.equal(r.truncated, null);
  assert.equal(r.issues.length, 3);
});

test('AC4: an empty backlog is a complete answer, not a truncated one', () => {
  const r = fetchIssues({ run: fakeRun('[]') });
  assert.equal(r.truncated, null);
  assert.deepEqual(r.issues, []);
  assert.equal(r.unconsultable, null, 'an empty backlog is consultable — it just has nothing in it');
});

test('AC4: a gh failure is unconsultable and yields no issues — never an empty success', () => {
  const boom = () => { throw new Error('gh: not authenticated'); };
  const r = fetchIssues({ run: boom });
  assert.deepEqual(r.issues, []);
  assert.match(r.unconsultable, /not authenticated/, 'the operator must see why');
  assert.equal(r.truncated, null);
});

test('AC4: unparseable JSON is unconsultable, not an empty backlog', () => {
  // The dangerous failure is reporting "0 issues" when gh returned garbage: a
  // sweep would then claim a clean backlog it never read.
  const r = fetchIssues({ run: fakeRun('not json at all') });
  assert.deepEqual(r.issues, []);
  assert.match(r.unconsultable, /unparseable/i);
});

test('AC4: updatedAt is requested and carried — the cache key depends on it', () => {
  const calls = [];
  const r = fetchIssues({ run: fakeRun(issueList(1), calls) });
  const json = calls[0].args[calls[0].args.indexOf('--json') + 1];
  assert.match(json, /updatedAt/, 'without updatedAt the cache cannot tell a changed issue from an unchanged one');
  assert.equal(r.issues[0].updatedAt, '2026-09-13T00:00:00Z');
});

test('AC4: the fetch asks for open issues only, at the declared limit', () => {
  const calls = [];
  fetchIssues({ run: fakeRun(issueList(1), calls) });
  const { cmd, args } = calls[0];
  assert.equal(cmd, 'gh');
  assert.ok(args.includes('--state') && args[args.indexOf('--state') + 1] === 'open');
  assert.equal(args[args.indexOf('--limit') + 1], String(ISSUE_FETCH_LIMIT));
});

test('AC4: labels are flattened to names and the body is preserved in full', () => {
  // release-audit truncates bodies to 4000 chars because it only needs path
  // mentions for routing. This package PARSES the body for code references and
  // snippets, so a truncated body would silently drop a reference and push a
  // mechanical issue onto the model route — a verification downgrade with no
  // signal. Bodies are kept whole.
  const long = 'x'.repeat(9000);
  const r = fetchIssues({ run: fakeRun(JSON.stringify([{ number: 1, title: 't', body: long, labels: [{ name: 'bug' }, { name: 'P1-high' }], url: 'u', updatedAt: 'now' }])) });
  assert.deepEqual(r.issues[0].labels, ['bug', 'P1-high']);
  assert.equal(r.issues[0].body.length, 9000, 'the body must not be capped — a dropped reference is a silent verification downgrade');
});

test('AC4: a missing body or labels normalise rather than crash the sweep', () => {
  const r = fetchIssues({ run: fakeRun(JSON.stringify([{ number: 7, title: 't', url: 'u', updatedAt: 'now' }])) });
  assert.equal(r.issues[0].body, '');
  assert.deepEqual(r.issues[0].labels, []);
});

test('AC4: a response above the limit is still reported truncated', () => {
  // gh should not exceed --limit, but a >= comparison is the safe one: treating
  // "more than we asked for" as complete would be the same blind spot.
  const r = fetchIssues({ run: fakeRun(issueList(ISSUE_FETCH_LIMIT + 2)) });
  assert.equal(r.truncated, ISSUE_FETCH_LIMIT);
});

test('AC4: the fetch cap is 500 — the number appears in operator-facing output', () => {
  // Pinned deliberately. ISSUE_FETCH_LIMIT is exported, and the report says
  // "TRUNCATED at N" using it, so the value is part of what an operator reads
  // and reasons about. It also matches the cap release-audit established, which
  // is what makes two sweeps of the same backlog comparable.
  assert.equal(ISSUE_FETCH_LIMIT, 500);
});
