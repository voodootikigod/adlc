// AC 54 / 74 / 163 (module halves) — the host-bound gh wrapper and paginated
// enumeration. The full-sequence classification (every gh spawn in a `once`
// run) is asserted in keys.test / sequence.test.

import { test } from './helpers/node-test.mjs';
import assert from 'node:assert/strict';
import { createSpawner } from '../lib/spawn.mjs';
import { createGh, listOpenIssues, ensureComment, ensureLabel, PAGE_CAP_BYTES, issueBodyEdits, listOpenPrs } from '../lib/github.mjs';
import { fakeSpawnImpl } from './helpers/fake-children.mjs';

function harness(handler, { host = 'github.com', repo = 'o/r' } = {}) {
  const recorder = [];
  const { spawnImpl } = fakeSpawnImpl({ '/usr/bin/gh': handler });
  const spawn = createSpawner({ recorder, spawnImpl });
  const ghc = createGh({ spawn, gh: '/usr/bin/gh', host, repo, env: { PATH: '/usr/bin', HOME: '/h', GH_TOKEN: 'x', GITHUB_TOKEN: 'y', GH_PAGER: 'z' }, cwd: '/repo', sleep: async () => {} });
  return { recorder, ghc };
}

export function ac163_everyGhSpawnIsHostBound() {
  const { recorder, ghc } = harness(() => ({ stdout: '{}' }), { host: 'ghe.example.com', repo: 'o/r' });
  return Promise.all([
    ghc.run(['issue', 'view', '7', '--json', 'title']),
    ghc.run(['api', 'user']),
    ghc.run(['auth', 'status', '--active', '--json', 'hosts']),
    ghc.run(['pr', 'list', '--head', 'x']),
    ghc.run(['repo', 'view', '--json', 'nameWithOwner']),
  ]).then(() => {
    for (const rec of recorder) {
      assert.equal(rec.env.GH_HOST, 'ghe.example.com', `${rec.argv.join(' ')}: GH_HOST bound`);
      assert.equal(rec.env.GH_TOKEN, undefined, 'no other GH_* variable');
      assert.equal(rec.env.GITHUB_TOKEN, undefined, 'no GITHUB_* variable');
      const sub = rec.argv[1];
      if (sub === 'api' || sub === 'auth') assert.ok(rec.argv.includes('--hostname') && rec.argv[rec.argv.indexOf('--hostname') + 1] === 'ghe.example.com', `${sub}: --hostname`);
      else assert.ok(rec.argv.includes('--repo') && rec.argv[rec.argv.indexOf('--repo') + 1] === 'ghe.example.com/o/r', `${sub}: --repo host/owner/name`);
    }
    assert.equal(recorder.length, 5);
  });
}
test('AC163: every gh spawn carries GH_HOST, --hostname on api/auth, --repo <host>/<owner>/<name> elsewhere, and no other GH_*/GITHUB_* variable', ac163_everyGhSpawnIsHostBound);

export async function ac74_paginationContract() {
  const pages = 13; const perPage = 100;
  const seen = [];
  const { ghc } = harness((args) => {
    const m = /[?&]page=(\d+)/.exec(args[1]); const page = Number(m[1]); seen.push(page);
    assert.ok(!args.includes('--paginate') && !args.includes('--slurp'));
    const n = page < pages ? perPage : 50;
    const arr = Array.from({ length: n }, (_, i) => ({ number: (page - 1) * perPage + i + 1, ...(i === 3 ? { pull_request: {} } : {}) }));
    return { stdout: JSON.stringify(arr) };
  });
  const r = await listOpenIssues(ghc);
  assert.equal(r.ok, true);
  assert.deepEqual(seen, Array.from({ length: 13 }, (_, i) => i + 1), '13 calls, page=1..13');
  assert.equal(r.issues.length, 1250 - 13, 'PR entries are dropped');
  assert.equal(r.pagesReached, 13);
}
test('AC74/54: 12×100 + 50 issues → 13 calls page=1..13, PR entries dropped, never --paginate/--slurp', ac74_paginationContract);

export async function ac74_truncationCases() {
  const cases = [
    ['third page fails', (args) => (/[?&]page=3/.test(args[1]) ? { status: 1, stderr: 'boom' } : { stdout: JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ number: i + 1 }))) }), 2],
    ['page is an object', () => ({ stdout: '{"number":1}' }), 0],
    ['page is a string', () => ({ stdout: '"nope"' }), 0],
    ['element without integer number', () => ({ stdout: '[{"number":"7"}]' }), 0],
    ['page exceeds 4 MiB', () => ({ stdout: '[' + JSON.stringify({ number: 1, body: 'x'.repeat(PAGE_CAP_BYTES + 100) }) + ']' }), 0],
  ];
  for (const [name, handler, pagesReached] of cases) {
    const { ghc } = harness(handler);
    const r = await listOpenIssues(ghc);
    assert.equal(r.ok, false, name); assert.equal(r.reason, 'candidate-set-truncated', name); assert.equal(r.pagesReached, pagesReached, name);
  }
  // 50 full pages → truncated after exactly 50 calls; page 51 is never requested.
  const seen = [];
  const { ghc } = harness((args) => { seen.push(Number(/[?&]page=(\d+)/.exec(args[1])[1])); return { stdout: JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ number: i + 1 }))) }; });
  const r = await listOpenIssues(ghc);
  assert.equal(r.ok, false); assert.equal(r.reason, 'candidate-set-truncated'); assert.equal(seen.length, 50); assert.ok(!seen.includes(51));
}
test('AC74: a failing third page, an object/string page, a malformed element, a 4 MiB page or 50 full pages → candidate-set-truncated with pagesReached, and page=51 is never requested', ac74_truncationCases);

export async function ac4_idempotentEffects() {
  const calls = [];
  const { ghc } = harness((args) => {
    calls.push(args.join(' '));
    if (args[0] === 'api' && /comments/.test(args[1])) return { stdout: JSON.stringify([{ body: '<!-- adlc-autopilot:clarify abc -->\nold' }]) };
    if (args[0] === 'issue' && args[1] === 'view') return { stdout: JSON.stringify({ labels: [{ name: 'adlc:needs-clarification' }] }) };
    return { stdout: '{}' };
  });
  assert.deepEqual(await ensureComment(ghc, 7, '<!-- adlc-autopilot:clarify abc -->', 'body'), { posted: false });
  assert.deepEqual(await ensureLabel(ghc, 7, 'adlc:needs-clarification', { present: true }), { mutated: false });
  assert.ok(!calls.some((c) => /issue comment|--add-label/.test(c)), 'zero mutating calls when both effects are already observed on GitHub');
  const { ghc: g2 } = harness((args) => (args[0] === 'api' && /comments/.test(args[1]) ? { stdout: '[]' } : { stdout: JSON.stringify({ labels: [] }) }));
  assert.deepEqual(await ensureComment(g2, 7, '<!-- s -->', 'b'), { posted: true });
  assert.deepEqual(await ensureLabel(g2, 7, 'adlc:needs-clarification', { present: true }), { mutated: true });
}
test('AC4: comment and label effects are reconciled against GitHub independently — both present → zero mutating calls', ac4_idempotentEffects);

export async function ac4_commentSearchCoversEveryPage() {
  const pages = { 1: Array.from({ length: 100 }, (_, i) => ({ body: `c${i}` })), 2: [{ body: 'x <!-- adlc-autopilot:blocked s --> y' }] };
  const { recorder, ghc } = harness((args) => { const p = Number((args[1].match(/[?&]page=(\d+)/) ?? [])[1] ?? 1); return { stdout: JSON.stringify(pages[p] ?? []) }; });
  const r = await ensureComment(ghc, 7, '<!-- adlc-autopilot:blocked s -->', 'body');
  assert.equal(r.posted, false, 'the sentinel on page 2 is found — no duplicate comment');
  assert.equal(recorder.filter((x) => x.argv.some((a) => /comments\?per_page=100&page=2/.test(a))).length, 1);
  const { ghc: broken } = harness((args) => (/comments/.test(args[1]) ? { status: 1, stderr: 'HTTP 500' } : { stdout: '{}' }));
  await assert.rejects(() => ensureComment(broken, 7, '<!-- s -->', 'body'), /gh-failed/, 'an unreadable page fails closed: nothing is posted');
}
test('AC4: the terminal-comment sentinel search covers every bounded page and fails closed when a page is unreadable', ac4_commentSearchCoversEveryPage);

export async function ac155_editHistoryCoversEveryPage() {
  const pages = (calls) => ({ repo: 'o/r', json: async (args) => { calls.push(args); const after = args.find((a) => a.startsWith('after='))?.slice(6) ?? null;
    const page = after === null ? { nodes: [{ editedAt: '2026-08-01T00:00:00Z', editor: { login: 'alice' } }], pageInfo: { hasNextPage: true, endCursor: 'c1' } }
      : { nodes: [{ editedAt: '2026-08-02T00:00:00Z', editor: { login: 'mallory' } }], pageInfo: { hasNextPage: false, endCursor: null } };
    return { data: { repository: { issue: { lastEditedAt: '2026-08-02T00:00:00Z', userContentEdits: page } } } }; } });
  const calls = [];
  const r = await issueBodyEdits(pages(calls), 7, { pageSize: 1 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.editors.map((e) => e.login), ['alice', 'mallory'], 'the editor on the SECOND page is seen (an untrusted editor cannot hide past page one)');
  assert.equal(calls.length, 2);
  assert.ok(calls[1].includes('after=c1'), 'the second request carries the cursor');
  const endless = { repo: 'o/r', json: async () => ({ data: { repository: { issue: { userContentEdits: { nodes: [{ editor: { login: 'alice' } }], pageInfo: { hasNextPage: true, endCursor: 'x' } } } } } }) };
  const t = await issueBodyEdits(endless, 7, { pageSize: 1, maxPages: 3 });
  assert.equal(t.ok, false); assert.equal(t.reason, 'edits-truncated', 'a history longer than the bound fails closed');
  const cursorless = { repo: 'o/r', json: async () => ({ data: { repository: { issue: { userContentEdits: { nodes: [], pageInfo: { hasNextPage: true, endCursor: null } } } } } }) };
  assert.equal((await issueBodyEdits(cursorless, 7)).reason, 'edits-unreadable', 'hasNextPage without a cursor is unreadable, never "complete"');
}
test('AC155: the issue edit history is read across EVERY page (bounded) — a later-page editor is seen, an over-long history is edits-truncated, a cursorless page is edits-unreadable', ac155_editHistoryCoversEveryPage);

export async function ac4_commentPostIsNeverRetriedBlind() {
  // gh fails AFTER the comment landed: exactly one POST, the failure surfaces, and the next call finds the sentinel.
  const posts = []; const comments = [];
  const { ghc } = harness((args, io) => {
    if (args[0] === 'issue' && args[1] === 'comment') { posts.push(args); comments.push(String(io.stdin ?? '')); return { status: 1, stderr: 'connection reset after POST' }; }
    if (args[0] === 'api' && String(args[1]).includes('/comments')) return { stdout: JSON.stringify(comments.map((body) => ({ body }))) };
    return { stdout: '[]' };
  }, { host: 'github.com', repo: 'o/r' });
  await assert.rejects(() => ensureComment(ghc, 7, '<!-- s -->', 'body'), /gh-failed|exited 1/);
  assert.equal(posts.length, 1, 'the POST ran exactly once (no blind retry)');
  const again = await ensureComment(ghc, 7, '<!-- s -->', 'body');
  assert.deepEqual(again, { posted: false }, 'the next call finds the sentinel: that is the idempotent retry');
  assert.equal(posts.length, 1);
}
test('AC4: a terminal-comment POST is never retried blind — a failure after the comment landed posts once, and the sentinel search is the retry', ac4_commentPostIsNeverRetriedBlind);

export async function ac3_openPrsCoverEveryPage() {
  const page = (n, count, per) => Array.from({ length: count }, (_, i) => ({ number: (n - 1) * per + i + 1, head: { ref: `adlc/autopilot/issue-${(n - 1) * per + i + 1}` }, body: '' }));
  const ghc = (pages, hasMore) => ({ repo: 'o/r', run: async (args) => { const p = Number(/[?&]page=(\d+)/.exec(args[1])[1]); const per = Number(/per_page=(\d+)/.exec(args[1])[1]); return { status: 0, stdout: JSON.stringify(p <= pages ? page(p, p < pages || hasMore ? per : 1, per) : []), truncated: false }; } });
  const two = await listOpenPrs(ghc(2, false), { perPage: 2 });
  assert.equal(two.ok, true); assert.deepEqual(two.prs.map((p) => p.number), [1, 2, 3], 'the PR on the SECOND page is listed');
  assert.equal(two.prs[0].headRefName, 'adlc/autopilot/issue-1');
  const endless = await listOpenPrs(ghc(99, true), { perPage: 2, maxPages: 3 });
  assert.equal(endless.ok, false); assert.equal(endless.reason, 'open-prs-truncated', 'more pages than the bound fails closed');
  const bad = await listOpenPrs({ repo: 'o/r', run: async () => ({ status: 0, stdout: '{"not":"an array"}', truncated: false }) });
  assert.equal(bad.ok, false);
}
test('AC3: the open-PR exclusion set is read across EVERY page (bounded) and fails closed when truncated — never a silent 100-entry cap', ac3_openPrsCoverEveryPage);
