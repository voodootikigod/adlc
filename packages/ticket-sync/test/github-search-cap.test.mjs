// With select.query configured, gh routes `issue list --search` through
// GitHub's search API, which returns at most 1000 results whatever --limit
// says. The truncation guard must treat 1000 rows as a possibly truncated set
// on that path, so a larger --limit cannot turn it into a silent partial sync.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { githubProvider, SEARCH_RESULT_CAP } from '../lib/providers/github.mjs';

const issue = (n) => ({ id: `I_${n}`, number: n, url: `https://github.com/acme/app/issues/${n}`, title: 't', body: '', state: 'OPEN', labels: [] });
const rows = (count) => JSON.stringify(Array.from({ length: count }, (_, i) => issue(i + 1)));
const runnerReturning = (count) => async () => ({ ok: true, code: 0, stdout: rows(count), stderr: '', error: null });
const withQuery = { select: { labels: ['adlc'], query: 'label:adlc' } };

test('the search API ceiling is 1000', () => {
  assert.equal(SEARCH_RESULT_CAP, 1000);
});

test('with a query and --limit 2000, exactly 1000 rows is refused as truncated', async () => {
  const r = await githubProvider().listIssues({ runner: runnerReturning(1000), repo: 'acme/app', ticketSync: withQuery, limit: 2000 });
  assert.equal(r.ok, false);
  assert.equal(r.truncated, true);
  assert.match(r.error, /search .*1000/i);
});

test('with a query and --limit 2000, 999 rows is a complete set', async () => {
  const r = await githubProvider().listIssues({ runner: runnerReturning(999), repo: 'acme/app', ticketSync: withQuery, limit: 2000 });
  assert.equal(r.ok, true);
  assert.equal(r.issues.length, 999);
});

test('with a query and a limit below the ceiling, the limit still governs', async () => {
  const p = githubProvider();
  const full = await p.listIssues({ runner: runnerReturning(500), repo: 'acme/app', ticketSync: withQuery, limit: 500 });
  assert.equal(full.truncated, true);
  assert.doesNotMatch(full.error, /search/i);
  const under = await p.listIssues({ runner: runnerReturning(499), repo: 'acme/app', ticketSync: withQuery, limit: 500 });
  assert.equal(under.ok, true);
});

test('without a query, the ceiling does not apply (gh paginates past 1000)', async () => {
  const r = await githubProvider().listIssues({ runner: runnerReturning(1000), repo: 'acme/app', ticketSync: { select: { labels: ['adlc'] } }, limit: 2000 });
  assert.equal(r.ok, true);
  assert.equal(r.issues.length, 1000);
});
