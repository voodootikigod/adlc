// AC 54 / 74 / 163 (module halves) — the host-bound gh wrapper and paginated
// enumeration. The full-sequence classification (every gh spawn in a `once`
// run) is asserted in keys.test / sequence.test.

import { test } from './helpers/node-test.mjs';
import assert from 'node:assert/strict';
import { createSpawner } from '../lib/spawn.mjs';
import { createGh, listOpenIssues, ensureComment, ensureLabel, PAGE_CAP_BYTES } from '../lib/github.mjs';
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
