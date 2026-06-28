import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mapIssue, githubProvider, parseIssueNumberFromUrl, parseCommentId } from '../lib/providers/github.mjs';
import { serializeBlock, parseBlock } from '../lib/block.mjs';
import { canonicalHash } from '../lib/canonical.mjs';
import { push, extractSentinelKey, orderLocalByDependency } from '../lib/push.mjs';

// ---------------------------------------------------------------------------
// mapIssue / listIssues (read path)
// ---------------------------------------------------------------------------

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

test('mapIssue preserves title, body, and url (body carries the block — must not be dropped)', () => {
  const m = mapIssue(raw);
  assert.equal(m.title, 'Do the thing');
  assert.equal(m.body, 'desc');
  assert.equal(m.url, 'https://github.com/acme/app/issues/42');
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

// ---------------------------------------------------------------------------
// URL/id parsing
// ---------------------------------------------------------------------------

test('parseIssueNumberFromUrl extracts the trailing issue number', () => {
  assert.equal(parseIssueNumberFromUrl('https://github.com/acme/app/issues/7'), 7);
  assert.equal(parseIssueNumberFromUrl('https://github.com/acme/app/pull/7'), null);
  assert.equal(parseIssueNumberFromUrl('garbage'), null);
});

test('parseCommentId extracts the issuecomment id', () => {
  assert.equal(parseCommentId('https://github.com/a/b/issues/1#issuecomment-99'), '99');
  assert.equal(parseCommentId('https://github.com/a/b/issues/1'), null);
});

// ---------------------------------------------------------------------------
// Provider write ops (unit, injected runner)
// ---------------------------------------------------------------------------

test('createIssue parses the new number then recovers nodeId via issue view', async () => {
  const calls = [];
  const runner = async (args) => {
    calls.push(args);
    if (args[1] === 'create') return { ok: true, stdout: 'https://github.com/acme/app/issues/7\n', stderr: '', error: null };
    if (args[1] === 'view') return { ok: true, stdout: JSON.stringify({ id: 'I_7', number: 7, url: 'u7' }), stderr: '', error: null };
    return { ok: false, error: 'unexpected' };
  };
  const r = await githubProvider().createIssue({ runner, repo: 'acme/app', dryRun: false }, { title: 't', body: 'b' });
  assert.deepEqual(r, { ok: true, number: 7, nodeId: 'I_7', url: 'u7' });
});

test('createIssue attaches labels atomically: ensures the label exists, then create --label (Finding 1 defense)', async () => {
  const calls = [];
  const runner = async (args) => {
    calls.push(args);
    if (args[0] === 'label' && args[1] === 'create') return { ok: true, stdout: '', stderr: '', error: null };
    if (args[1] === 'create') return { ok: true, stdout: 'https://github.com/acme/app/issues/7\n', stderr: '', error: null };
    if (args[1] === 'view') return { ok: true, stdout: JSON.stringify({ id: 'I_7', number: 7, url: 'u7' }), stderr: '', error: null };
    return { ok: false, error: 'unexpected' };
  };
  const r = await githubProvider().createIssue({ runner, repo: 'acme/app', dryRun: false }, { title: 't', body: 'b', labels: ['adlc'] });
  assert.ok(r.ok, r.error);
  assert.ok(calls.some((a) => a[0] === 'label' && a[1] === 'create' && a.includes('adlc') && a.includes('--force')), 'label is ensured (create --force) before use');
  const create = calls.find((a) => a[0] === 'issue' && a[1] === 'create');
  assert.ok(create.includes('--label') && create[create.indexOf('--label') + 1] === 'adlc', 'create carries --label adlc');
});

test('createIssue with no labels emits no --label (createLabel unset path)', async () => {
  const calls = [];
  const runner = async (args) => {
    calls.push(args);
    if (args[1] === 'create') return { ok: true, stdout: 'https://github.com/acme/app/issues/7\n', stderr: '', error: null };
    if (args[1] === 'view') return { ok: true, stdout: JSON.stringify({ id: 'I_7', number: 7, url: 'u7' }), stderr: '', error: null };
    return { ok: false, error: 'unexpected' };
  };
  await githubProvider().createIssue({ runner, repo: 'acme/app', dryRun: false }, { title: 't', body: 'b' });
  assert.ok(!calls.some((a) => a.includes('--label')), 'no --label when none requested');
  assert.ok(!calls.some((a) => a[0] === 'label' && a[1] === 'create'), 'no label create when none requested');
});

test('getIssue distinguishes a CONFIRMED-deleted issue (notFound) from a transient failure (Finding C)', async () => {
  const deleted = await githubProvider().getIssue({ runner: async () => ({ ok: false, error: 'GraphQL: Could not resolve to an Issue with the number of 9.' }) }, 9);
  assert.equal(deleted.ok, false);
  assert.equal(deleted.notFound, true, 'a "could not resolve" error is a confirmed deletion');
  const transient = await githubProvider().getIssue({ runner: async () => ({ ok: false, error: 'HTTP 503: upstream connect error' }) }, 9);
  assert.equal(transient.ok, false);
  assert.equal(transient.notFound, false, 'a 5xx/network error is NOT a confirmed deletion');
});

test('getIssue reports the issue labels (drives label-diff suppression on adoption)', async () => {
  const runner = async (args) => {
    if (args[1] === 'view') return { ok: true, stdout: JSON.stringify({ id: 'I_5', number: 5, url: 'u5', labels: [{ name: 'adlc' }, { name: 'adlc:passed' }], state: 'OPEN' }), stderr: '', error: null };
    return { ok: false };
  };
  const r = await githubProvider().getIssue({ runner, repo: 'acme/app' }, 5);
  assert.ok(r.ok);
  assert.deepEqual(r.labels, ['adlc', 'adlc:passed'], 'labels are reported, not dropped');
  assert.equal(r.nodeId, 'I_5');
});

test('createIssue is a no-op under dryRun (no runner call)', async () => {
  let called = false;
  const r = await githubProvider().createIssue({ runner: async () => { called = true; }, repo: 'r', dryRun: true }, { title: 't', body: 'b' });
  assert.deepEqual(r, { ok: true, dryRun: true });
  assert.equal(called, false);
});

test('ensureLabels makes no call when add+remove are both empty (idempotency)', async () => {
  let called = false;
  const r = await githubProvider().ensureLabels({ runner: async () => { called = true; }, repo: 'r', dryRun: false }, { number: 1 }, { add: [], remove: [] });
  assert.deepEqual(r, { ok: true, noop: true });
  assert.equal(called, false);
});

test('upsertStatusComment makes no mutating call when the existing comment is byte-equal', async () => {
  const body = '<!-- adlc:status -->\nADLC P5 prosecution: CLEAR — change earned its merge.';
  const mutating = [];
  const runner = async (args) => {
    if (args[1] === 'view') return { ok: true, stdout: JSON.stringify({ comments: [{ author: { login: 'bot' }, body, url: 'u#issuecomment-1' }] }), stderr: '', error: null };
    mutating.push(args);
    return { ok: true, stdout: '', stderr: '', error: null };
  };
  const r = await githubProvider().upsertStatusComment({ runner, repo: 'r', dryRun: false, login: 'bot' }, { number: 1 }, body);
  assert.deepEqual(r, { ok: true, changed: false });
  assert.equal(mutating.length, 0);
});

// --- provider failure paths (a network/auth failure must NOT report success) ---

test('whoami propagates a gh failure (no false-positive auth)', async () => {
  const r = await githubProvider().whoami({ runner: async () => ({ ok: false, error: 'gh-not-found', code: 1, stdout: '', stderr: '' }) });
  assert.equal(r.ok, false);
});

test('createIssue propagates a create-step failure', async () => {
  const r = await githubProvider().createIssue({ runner: async () => ({ ok: false, error: 'boom', stderr: 'boom', code: 1, stdout: '' }), repo: 'r', dryRun: false }, { title: 't', body: 'b' });
  assert.equal(r.ok, false);
  assert.match(r.error, /boom/);
});

test('createIssue fails closed when the create URL has no parseable issue number', async () => {
  const runner = async (a) => (a[1] === 'create' ? { ok: true, stdout: 'not-a-url\n', stderr: '', error: null } : { ok: false, error: 'unexpected' });
  const r = await githubProvider().createIssue({ runner, repo: 'r', dryRun: false }, { title: 't', body: 'b' });
  assert.equal(r.ok, false);
  assert.match(r.error, /could not parse/);
});

test('createIssue propagates a view-step (nodeId recovery) failure', async () => {
  const runner = async (a) => (a[1] === 'create'
    ? { ok: true, stdout: 'https://github.com/acme/app/issues/7\n', stderr: '', error: null }
    : { ok: false, error: 'view-failed', code: 1, stdout: '', stderr: '' });
  const r = await githubProvider().createIssue({ runner, repo: 'acme/app', dryRun: false }, { title: 't', body: 'b' });
  assert.equal(r.ok, false);
  assert.match(r.error, /view-failed/);
});

test('upsertStatusComment ignores a same-marker comment by a DIFFERENT author (creates its own)', async () => {
  const body = '<!-- adlc:status -->\nADLC: in progress.';
  const mutating = [];
  const runner = async (args) => {
    if (args[1] === 'view') return { ok: true, stdout: JSON.stringify({ comments: [{ author: { login: 'someone-else' }, body, url: 'u#issuecomment-1' }] }), stderr: '', error: null };
    mutating.push(args);
    return { ok: true, stdout: '', stderr: '', error: null };
  };
  const r = await githubProvider().upsertStatusComment({ runner, repo: 'r', dryRun: false, login: 'bot' }, { number: 1 }, body);
  assert.equal(r.changed, true);
  assert.equal(mutating[0][1], 'comment', 'a fresh comment is created, not an edit of the other identity');
});

// ---------------------------------------------------------------------------
// A stateful fake `gh` runner — simulates GitHub so push() can be exercised
// end-to-end (the "recording fake" of the acceptance criteria).
// ---------------------------------------------------------------------------

function fakeGitHub({ issues = [], login = 'bot' } = {}) {
  const state = { issues: issues.map((i) => ({ labels: [], comments: [], state: 'open', ...i })) };
  let seq = Math.max(0, ...state.issues.map((i) => i.number));
  const mutating = [];
  const calls = [];
  const find = (n) => state.issues.find((i) => String(i.number) === String(n));
  const ok = (stdout = '') => ({ ok: true, code: 0, stdout, stderr: '', error: null });

  const runner = async (args) => {
    calls.push(args);
    const [a0, a1] = args;
    if (a0 === 'issue' && a1 === 'list') {
      // Model the real selector: `gh issue list --label X` returns only issues that
      // carry EVERY requested label. An issue outside the selection is invisible here
      // (this is the realism that exposes the unlabeled-orphan duplicate bug).
      const want = [];
      for (let k = 0; k < args.length; k++) if (args[k] === '--label') want.push(args[k + 1]);
      const selected = state.issues.filter((i) => want.every((l) => i.labels.includes(l)));
      return ok(JSON.stringify(selected.map((i) => ({
        id: i.id, number: i.number, title: i.title, body: i.body,
        labels: i.labels.map((name) => ({ name })), state: i.state.toUpperCase(), url: i.url,
      }))));
    }
    if (a0 === 'api' && a1 === 'user') return ok(JSON.stringify({ login }));
    if (a0 === 'issue' && a1 === 'view') {
      const i = find(args[2]);
      const fields = args[args.indexOf('--json') + 1];
      if (!i) return { ok: false, code: 1, stdout: '', stderr: 'not found', error: 'not found' };
      if (fields.includes('comments')) return ok(JSON.stringify({ comments: i.comments }));
      // issue view by number works regardless of labels — this is how crash recovery
      // adopts an orphan the selector can't see.
      const out = { id: i.id, number: i.number, url: i.url };
      if (fields.includes('labels')) out.labels = i.labels.map((name) => ({ name }));
      if (fields.includes('state')) out.state = i.state.toUpperCase();
      if (fields.includes('body')) out.body = i.body;
      return ok(JSON.stringify(out));
    }
    // --- mutations ---
    if (a0 === 'issue' && a1 === 'create') {
      mutating.push(args);
      seq += 1;
      const number = seq;
      const labels = [];
      for (let k = 0; k < args.length; k++) if (args[k] === '--label') labels.push(args[k + 1]);
      state.issues.push({
        number, id: `I_${number}`, url: `https://github.com/acme/app/issues/${number}`,
        title: args[args.indexOf('--title') + 1], body: args[args.indexOf('--body') + 1],
        labels, state: 'open', comments: [],
      });
      return ok(`https://github.com/acme/app/issues/${number}\n`);
    }
    if (a0 === 'label' && a1 === 'create') { mutating.push(args); return ok(); }
    if (a0 === 'issue' && a1 === 'edit') {
      mutating.push(args);
      const i = find(args[2]);
      const b = args.indexOf('--body');
      if (b >= 0) i.body = args[b + 1];
      for (let k = 0; k < args.length; k++) {
        if (args[k] === '--add-label' && !i.labels.includes(args[k + 1])) i.labels.push(args[k + 1]);
        if (args[k] === '--remove-label') i.labels = i.labels.filter((l) => l !== args[k + 1]);
      }
      return ok();
    }
    if (a0 === 'issue' && a1 === 'comment') {
      mutating.push(args);
      const i = find(args[2]);
      const cid = 1000 + i.comments.length + 1;
      i.comments.push({ author: { login }, body: args[args.indexOf('--body') + 1], url: `${i.url}#issuecomment-${cid}` });
      return ok();
    }
    if (a0 === 'api' && args.includes('PATCH')) {
      mutating.push(args);
      const cid = args[args.indexOf('--method') + 2].split('/').pop();
      const body = args[args.indexOf('-f') + 1].replace(/^body=/, '');
      for (const i of state.issues) for (const c of i.comments) if (c.url.endsWith(`#issuecomment-${cid}`)) c.body = body;
      return ok();
    }
    return { ok: false, code: 1, stdout: '', stderr: `unhandled: ${args.join(' ')}`, error: `unhandled: ${args.join(' ')}` };
  };
  return { runner, state, mutating, calls };
}

const CONFIG = {
  ticketSync: {
    provider: 'github', repo: 'acme/app',
    select: { state: 'open', labels: ['adlc'] }, createLabel: 'adlc',
    statusLabels: { 'p5-pass': 'adlc:passed', 'p5-fail': 'adlc:failed', wip: 'adlc:in-progress' },
  },
};

function repo({ tickets = [], sidecar, manifest = [], config = CONFIG } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-push-'));
  mkdirSync(join(dir, '.adlc'));
  writeFileSync(join(dir, '.adlc', 'config.json'), JSON.stringify(config));
  writeFileSync(join(dir, '.adlc', 'tickets.json'), JSON.stringify({ tickets }, null, 2));
  if (sidecar) writeFileSync(join(dir, '.adlc', 'ticket-sync.state.json'), JSON.stringify(sidecar));
  if (manifest.length) writeFileSync(join(dir, '.adlc', 'manifest.jsonl'), manifest.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return dir;
}
const readTickets = (dir) => JSON.parse(readFileSync(join(dir, '.adlc', 'tickets.json'), 'utf8')).tickets;
const readSidecar = (dir) => JSON.parse(readFileSync(join(dir, '.adlc', 'ticket-sync.state.json'), 'utf8'));
const p5clear = (ticket, seq) => ({ seq, gate: 'prosecution', ts: '2026-06-01T00:00:00Z', ticket, data: { verdict: 'clear' }, files: {}, prev: null });

// ---------------------------------------------------------------------------
// Acceptance criterion #2 — idempotency, adoption, lost-write, edge rewrite
// ---------------------------------------------------------------------------

test('push twice → the second run makes ZERO mutating calls (create then converge)', async () => {
  const dir = repo({
    tickets: [{ id: 'T7', title: 'Build it', scope: ['a/**'], duration: 1 }],
    manifest: [p5clear('T7', 1)],
  });
  try {
    let n = 0;
    const gh1 = fakeGitHub();
    const r1 = await push({ dir, provider: githubProvider(), runner: gh1.runner, write: true, now: 'T', uuid: () => `KEY-${(n += 1)}` });
    assert.equal(r1.exitCode, 0, JSON.stringify(r1.errors));
    assert.ok(gh1.mutating.length > 0, 'first run creates + labels + comments');
    // The ticket is now synced.
    assert.equal(readTickets(dir).find((t) => t.id.startsWith('gh:')).id, 'gh:acme/app#1');

    // Second run: feed the SAME simulated GitHub state forward.
    const gh2 = fakeGitHub({ issues: gh1.state.issues });
    const r2 = await push({ dir, provider: githubProvider(), runner: gh2.runner, write: true, now: 'T', uuid: () => 'NEVER' });
    assert.equal(r2.exitCode, 0, JSON.stringify(r2.errors));
    assert.equal(gh2.mutating.length, 0, `converged push must not mutate, did: ${JSON.stringify(gh2.mutating)}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('create adoption: an UNLABELED orphan is adopted via the pendingCreates handle, NOT duplicated (Finding 1)', async () => {
  const KEY = 'stable-key-123';
  // Simulate the real crash window: a prior create succeeded remotely (issue #5
  // carries the key) but the local reassignment was lost — tickets.json still has
  // T7, pendingCreates survives WITH the {nodeId,number} handle. Crucially #5 is
  // UNLABELED, and the selector is label-scoped (select.labels:['adlc']), so the
  // adoption SCAN cannot see #5. Recovery MUST adopt via the stored number handle
  // (selector-independent), or it duplicates the issue.
  const body = serializeBlock({ prefix: 'Build it\n\n', suffix: '' }, { scope: ['a/**'], duration: 1 }, { key: KEY });
  const dir = repo({
    tickets: [{ id: 'T7', title: 'Build it', scope: ['a/**'], duration: 1 }],
    sidecar: { version: 1, tickets: {}, pendingCreates: { [KEY]: { localId: 'T7', nodeId: 'I_5', number: 5 } } },
    manifest: [p5clear('T7', 1)],
  });
  try {
    const gh = fakeGitHub({ issues: [{ number: 5, id: 'I_5', url: 'https://github.com/acme/app/issues/5', title: 'Build it', body, labels: [] }] });
    const before = gh.state.issues.length;
    const r = await push({ dir, provider: githubProvider(), runner: gh.runner, write: true, now: 'T', uuid: () => 'WOULD-DUP' });
    assert.equal(r.exitCode, 0, JSON.stringify(r.errors));
    assert.ok(!gh.mutating.some((a) => a[0] === 'issue' && a[1] === 'create'), 'must NOT create a second issue');
    assert.equal(gh.state.issues.length, before, 'remote issue count unchanged — no duplicate');
    assert.equal(readTickets(dir).find((t) => t.id.startsWith('gh:')).id, 'gh:acme/app#5', 'adopted #5 via the handle');
    assert.deepEqual(readSidecar(dir).pendingCreates, {}, 'pendingCreates cleared after adoption');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('handle adoption: a TRANSIENT getIssue failure FAILS CLOSED — never recreates a duplicate (Finding C)', async () => {
  const KEY = 'k-transient';
  const body = serializeBlock({ prefix: 'x\n\n', suffix: '' }, { scope: ['a/**'], duration: 1 }, { key: KEY });
  const dir = repo({
    tickets: [{ id: 'T7', title: 'x', scope: ['a/**'], duration: 1 }],
    sidecar: { version: 1, tickets: {}, pendingCreates: { [KEY]: { localId: 'T7', nodeId: 'I_5', number: 5 } } },
    manifest: [p5clear('T7', 1)],
  });
  try {
    const gh = fakeGitHub({ issues: [{ number: 5, id: 'I_5', url: 'https://github.com/acme/app/issues/5', title: 'x', body, labels: [] }] });
    // The handle read (`issue view 5` for the getIssue fields) fails TRANSIENTLY (not a 404).
    const runner = async (args) => {
      if (args[0] === 'issue' && args[1] === 'view' && String(args[2]) === '5' && !args.includes('comments')) {
        return { ok: false, code: 1, stdout: '', stderr: 'HTTP 503: server error', error: 'HTTP 503: server error' };
      }
      return gh.runner(args);
    };
    const before = gh.state.issues.length;
    const r = await push({ dir, provider: githubProvider(), runner, write: true, now: 'T', uuid: () => 'WOULD-DUP' });
    assert.equal(r.exitCode, 1, 'a transient verify failure is operational, not a silent recreate');
    assert.ok(!gh.mutating.some((a) => a[0] === 'issue' && a[1] === 'create'), 'must NOT create a duplicate on a transient failure');
    assert.equal(gh.state.issues.length, before, 'remote issue count unchanged');
    assert.ok(r.errors.some((e) => /could not verify pending issue/.test(e)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('handle adoption: a CONFIRMED-deleted pending issue (notFound) is safely RECREATED, not failed (Finding C)', async () => {
  const KEY = 'k-deleted';
  const dir = repo({
    tickets: [{ id: 'T7', title: 'x', scope: ['a/**'], duration: 1 }],
    // pending number points to #9 which does NOT exist remotely (deleted).
    sidecar: { version: 1, tickets: {}, pendingCreates: { [KEY]: { localId: 'T7', nodeId: 'I_9', number: 9 } } },
    manifest: [p5clear('T7', 1)],
  });
  try {
    const gh = fakeGitHub(); // no issue #9 → the fake's view returns a not-found error
    const r = await push({ dir, provider: githubProvider(), runner: gh.runner, write: true, now: 'T', uuid: () => KEY });
    assert.equal(r.exitCode, 0, JSON.stringify(r.errors));
    assert.ok(gh.mutating.some((a) => a[0] === 'issue' && a[1] === 'create'), 'a confirmed-deleted issue is recreated');
    assert.ok(readTickets(dir).find((t) => t.id.startsWith('gh:')), 'ticket reassigned to the recreated issue');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('push creates the issue WITH the createLabel atomically (closes the pre-number-write orphan window) (Finding 1 defense)', async () => {
  const dir = repo({ tickets: [{ id: 'T7', title: 'x', scope: ['a/**'], duration: 1 }], manifest: [p5clear('T7', 1)] });
  try {
    const gh = fakeGitHub();
    const r = await push({ dir, provider: githubProvider(), runner: gh.runner, write: true, now: 'T', uuid: () => 'K' });
    assert.equal(r.exitCode, 0, JSON.stringify(r.errors));
    const create = gh.calls.find((a) => a[0] === 'issue' && a[1] === 'create');
    assert.ok(create, 'an issue was created');
    // The orphan must belong to the label-scoped selection AT BIRTH, not only after
    // the later labeling step — else a crash before the number-write reopens Finding 1.
    assert.ok(create.includes('--label') && create[create.indexOf('--label') + 1] === 'adlc', 'create carries the configured createLabel');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('no-number handle: a LABELED orphan is adopted via the scan; the createLabel is what makes it visible (Finding 1)', async () => {
  const KEY = 'k-nonum';
  const body = serializeBlock({ prefix: 'x\n\n', suffix: '' }, { scope: ['a/**'], duration: 1 }, { key: KEY });
  // pendingCreates has NO number (crash between create and the number-write), so the
  // primary handle-adoption is skipped and recovery falls to the label-scoped scan.
  const dir = repo({
    tickets: [{ id: 'T7', title: 'x', scope: ['a/**'], duration: 1 }],
    sidecar: { version: 1, tickets: {}, pendingCreates: { [KEY]: { localId: 'T7' } } },
    manifest: [p5clear('T7', 1)],
  });
  try {
    // The orphan carries the createLabel, so the label-scoped listIssues returns it.
    const gh = fakeGitHub({ issues: [{ number: 5, id: 'I_5', url: 'https://github.com/acme/app/issues/5', title: 'x', body, labels: ['adlc'] }] });
    const before = gh.state.issues.length;
    const r = await push({ dir, provider: githubProvider(), runner: gh.runner, write: true, now: 'T', uuid: () => KEY });
    assert.equal(r.exitCode, 0, JSON.stringify(r.errors));
    assert.ok(!gh.mutating.some((a) => a[0] === 'issue' && a[1] === 'create'), 'labeled orphan adopted via scan, not duplicated');
    assert.equal(gh.state.issues.length, before, 'no duplicate created');
    assert.equal(readTickets(dir).find((t) => t.id.startsWith('gh:')).id, 'gh:acme/app#5');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('handle adoption suppresses a redundant label re-add when the orphan is already correctly labeled (getIssue labels are used)', async () => {
  const KEY = 'k-labeled';
  const body = serializeBlock({ prefix: 'x\n\n', suffix: '' }, { scope: ['a/**'], duration: 1 }, { key: KEY });
  const dir = repo({
    tickets: [{ id: 'T7', title: 'x', scope: ['a/**'], duration: 1 }],
    sidecar: { version: 1, tickets: {}, pendingCreates: { [KEY]: { localId: 'T7', nodeId: 'I_5', number: 5 } } },
    manifest: [p5clear('T7', 1)],
  });
  try {
    // The orphan is already at the desired label set (status p5-pass → adlc:passed, plus createLabel).
    const gh = fakeGitHub({ issues: [{ number: 5, id: 'I_5', url: 'https://github.com/acme/app/issues/5', title: 'x', body, labels: ['adlc', 'adlc:passed'] }] });
    const r = await push({ dir, provider: githubProvider(), runner: gh.runner, write: true, now: 'T', uuid: () => 'NOPE' });
    assert.equal(r.exitCode, 0, JSON.stringify(r.errors));
    // getIssue reported the existing labels, so the diff is empty — no --add-label call.
    assert.ok(!gh.mutating.some((a) => a.includes('--add-label')), 'no redundant label re-add (getIssue labels suppress it)');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('push attaches EVERY selector label at create, not just createLabel (multi-label selector) (Finding A)', async () => {
  const MULTI = {
    ticketSync: {
      provider: 'github', repo: 'acme/app',
      select: { state: 'open', labels: ['adlc', 'team-a'] }, createLabel: 'adlc',
      statusLabels: { 'p5-pass': 'adlc:passed', 'p5-fail': 'adlc:failed', wip: 'adlc:in-progress' },
    },
  };
  const dir = repo({ config: MULTI, tickets: [{ id: 'T7', title: 'x', scope: ['a/**'], duration: 1 }], manifest: [p5clear('T7', 1)] });
  try {
    const gh = fakeGitHub();
    const r = await push({ dir, provider: githubProvider(), runner: gh.runner, write: true, now: 'T', uuid: () => 'K' });
    assert.equal(r.exitCode, 0, JSON.stringify(r.errors));
    const create = gh.calls.find((a) => a[0] === 'issue' && a[1] === 'create');
    const created = gh.state.issues.find((i) => i.title === 'x');
    // Both required selector labels must be present at birth, or a multi-label
    // selector can't see the orphan in the crash-before-number-write window.
    assert.ok(created.labels.includes('adlc') && created.labels.includes('team-a'), `orphan must carry both selector labels, has: ${created.labels}`);
    assert.ok(create.filter((x) => x === '--label').length >= 2, 'create attaches every selector label');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('multi-create FORWARD edge: the referrer\'s remote body carries the rewritten edge to a LATER-created ticket (Finding B)', async () => {
  // T7 references T8 (forward edge); T8 appears later in tickets.json. Dependency-first
  // create order makes T8 get its gh: id BEFORE T7's body is serialized, so T7's remote
  // body must carry the rewritten gh: edge, not a stale 'T8'.
  const dir = repo({
    tickets: [
      { id: 'T7', title: 'Refers forward', duration: 1, edges: [{ to: 'T8', contract: 'c.json' }] },
      { id: 'T8', title: 'Referenced later', scope: ['a/**'], duration: 1 },
    ],
    manifest: [p5clear('T7', 1)],
  });
  try {
    const gh = fakeGitHub();
    const r = await push({ dir, provider: githubProvider(), runner: gh.runner, write: true, now: 'T', uuid: () => 'K' });
    assert.equal(r.exitCode, 0, JSON.stringify(r.errors));
    const t8Issue = gh.state.issues.find((i) => i.title === 'Referenced later');
    const t7Issue = gh.state.issues.find((i) => i.title === 'Refers forward');
    const parsed = parseBlock(t7Issue.body);
    assert.ok(parsed.ok, `T7 remote body must parse: ${parsed.errors?.join('; ')}`);
    assert.equal(parsed.block.edges[0].to, `gh:acme/app#${t8Issue.number}`, 'forward edge rewritten in the remote body, NOT stale T8');
    // sidecar base must hash the published (rewritten) block — no remote/base drift.
    const t7Id = readTickets(dir).find((t) => t.title === 'Refers forward').id;
    assert.equal(readSidecar(dir).tickets[t7Id].syncedHash, canonicalHash(parsed.block, { omit: ['$schema'] }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('multi-create TRANSITIVE chain (T7→T8→T9): every remote body carries a rewritten gh: edge (Finding B, multi-hop)', async () => {
  // Dependency-first order is a topological sort, so a chain serializes leaf-first
  // (T9, then T8, then T7); each referrer's body must hold the final gh: id of its
  // (transitive) target — no stale T<n> anywhere in the chain.
  const dir = repo({
    tickets: [
      { id: 'T7', title: 'top', duration: 1, edges: [{ to: 'T8' }] },
      { id: 'T8', title: 'mid', duration: 1, edges: [{ to: 'T9' }] },
      { id: 'T9', title: 'leaf', scope: ['a/**'], duration: 1 },
    ],
    manifest: [p5clear('T7', 1)],
  });
  try {
    const gh = fakeGitHub();
    const r = await push({ dir, provider: githubProvider(), runner: gh.runner, write: true, now: 'T', uuid: () => 'K' });
    assert.equal(r.exitCode, 0, JSON.stringify(r.errors));
    const num = (title) => gh.state.issues.find((i) => i.title === title).number;
    const edgeOf = (title) => parseBlock(gh.state.issues.find((i) => i.title === title).body).block.edges[0].to;
    assert.equal(edgeOf('top'), `gh:acme/app#${num('mid')}`, 'T7 body → mid gh id');
    assert.equal(edgeOf('mid'), `gh:acme/app#${num('leaf')}`, 'T8 body → leaf gh id');
    // No remote body may still contain a bare T<n> edge.
    for (const i of gh.state.issues) {
      const b = parseBlock(i.body).block;
      for (const e of b.edges ?? []) assert.match(e.to, /^gh:/, `remote edge must be a gh: id, got ${e.to}`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('multi-create DIAMOND DAG (T7→{T8,T9}, T8→T10, T9→T10): all edges rewritten, no stale T<n> (Finding B)', async () => {
  const dir = repo({
    tickets: [
      { id: 'T7', title: 'apex', duration: 1, edges: [{ to: 'T8' }, { to: 'T9' }] },
      { id: 'T8', title: 'left', duration: 1, edges: [{ to: 'T10' }] },
      { id: 'T9', title: 'right', duration: 1, edges: [{ to: 'T10' }] },
      { id: 'T10', title: 'base', scope: ['a/**'], duration: 1 },
    ],
    manifest: [p5clear('T7', 1)],
  });
  try {
    const gh = fakeGitHub();
    const r = await push({ dir, provider: githubProvider(), runner: gh.runner, write: true, now: 'T', uuid: () => 'K' });
    assert.equal(r.exitCode, 0, JSON.stringify(r.errors));
    for (const i of gh.state.issues) {
      for (const e of parseBlock(i.body).block.edges ?? []) assert.match(e.to, /^gh:/, `every remote edge rewritten; got ${e.to} on "${i.title}"`);
    }
    // tickets.json is internally consistent: no dangling edge after the full DAG create.
    const tickets = readTickets(dir);
    const ids = new Set(tickets.map((t) => t.id));
    for (const t of tickets) for (const e of t.edges ?? []) assert.ok(ids.has(e.to), `edge ${t.id}→${e.to} resolves`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('id reassignment rewrites every edge reference store-wide', async () => {
  const dir = repo({
    tickets: [
      { id: 'T7', title: 'Build it', scope: ['a/**'], duration: 1 },
      { id: 'T8', title: 'Depends on it', duration: 1, edges: [{ to: 'T7', contract: 'c.json' }] },
    ],
    manifest: [p5clear('T7', 1)],
  });
  try {
    const gh = fakeGitHub();
    const r = await push({ dir, provider: githubProvider(), runner: gh.runner, write: true, now: 'T', uuid: () => 'K' });
    assert.equal(r.exitCode, 0, JSON.stringify(r.errors));
    // T8 is also local-only, so it too is created (→ #2); find it by its stable title.
    const t8 = readTickets(dir).find((t) => t.title === 'Depends on it');
    assert.equal(t8.id, 'gh:acme/app#2', 'the dependent ticket was itself reassigned');
    assert.equal(t8.edges[0].to, 'gh:acme/app#1', 'its edge follows T7→#1 reassignment store-wide');
    assert.equal(t8.edges[0].contract, 'c.json', 'edge metadata preserved');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('multi-create: the dependent ticket\'s REMOTE body carries the rewritten edge, not the stale T<n> (Finding 2)', async () => {
  // T7 + T8(edges→T7), both local-only. T7 is created first (→#1) and its edge is
  // rewritten store-wide; when T8 is created, its REMOTE issue body + sidecar
  // syncedHash must reflect the rewritten edge gh:acme/app#1 — not the stale 'T7' —
  // or a fresh clone pulling before the next push sees a dangling edge.
  const dir = repo({
    tickets: [
      { id: 'T7', title: 'Build it', scope: ['a/**'], duration: 1 },
      { id: 'T8', title: 'Depends on it', duration: 1, edges: [{ to: 'T7', contract: 'c.json' }] },
    ],
    manifest: [p5clear('T7', 1)],
  });
  try {
    const gh = fakeGitHub();
    const r = await push({ dir, provider: githubProvider(), runner: gh.runner, write: true, now: 'T', uuid: () => 'K' });
    assert.equal(r.exitCode, 0, JSON.stringify(r.errors));
    const t8Issue = gh.state.issues.find((i) => i.title === 'Depends on it');
    const parsed = parseBlock(t8Issue.body);
    assert.ok(parsed.ok, `T8 remote body must parse: ${parsed.errors?.join('; ')}`);
    assert.equal(parsed.block.edges[0].to, 'gh:acme/app#1', 'remote body edge must be the rewritten gh id, NOT stale T7');
    // The sidecar base must hash the SAME (rewritten) block that was published.
    const sc = readSidecar(dir);
    assert.equal(
      sc.tickets['gh:acme/app#2'].syncedHash,
      canonicalHash(parsed.block, { omit: ['$schema'] }),
      'syncedHash must match the published rewritten block (no remote/base drift)',
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('push fails closed (exit 2) when >1 issue already carries the create key', async () => {
  const KEY = 'dup-key';
  const body = serializeBlock({ prefix: 'x\n\n', suffix: '' }, { scope: ['a/**'], duration: 1 }, { key: KEY });
  const dir = repo({
    tickets: [{ id: 'T7', title: 'x', scope: ['a/**'], duration: 1 }],
    sidecar: { version: 1, tickets: {}, pendingCreates: { [KEY]: { localId: 'T7' } } },
  });
  try {
    // Both dups carry the createLabel so they ARE in the label-scoped selection —
    // the >1-match guard operates on the selector list, and pendingCreates here has
    // no number handle, so adoption falls through to the scan.
    const gh = fakeGitHub({ issues: [
      { number: 1, id: 'I_1', url: 'https://github.com/acme/app/issues/1', title: 'x', body, labels: ['adlc'] },
      { number: 2, id: 'I_2', url: 'https://github.com/acme/app/issues/2', title: 'x', body, labels: ['adlc'] },
    ] });
    const r = await push({ dir, provider: githubProvider(), runner: gh.runner, write: true, now: 'T', uuid: () => KEY });
    assert.equal(r.exitCode, 2);
    assert.ok(r.errors.some((e) => e.includes('carry create key')));
    assert.ok(!gh.mutating.some((a) => a[1] === 'create'), 'never create a third');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('push is dry-run by default: it plans a create but makes no mutating calls', async () => {
  const dir = repo({ tickets: [{ id: 'T7', title: 'x', scope: ['a/**'], duration: 1 }], manifest: [p5clear('T7', 1)] });
  try {
    const gh = fakeGitHub();
    const r = await push({ dir, provider: githubProvider(), runner: gh.runner, write: false, uuid: () => 'K' });
    assert.equal(r.exitCode, 0);
    assert.ok(r.dryRun);
    assert.ok(r.plan.some((p) => p.kind === 'create' && p.id === 'T7'));
    assert.equal(gh.mutating.length, 0, 'dry-run must not mutate');
    assert.equal(readTickets(dir).find((t) => t.id === 'T7').id, 'T7', 'dry-run leaves local ids untouched');
    // Filesystem purity: dry-run must not write the sidecar nor emit a bogus #undefined id.
    assert.equal(existsSync(join(dir, '.adlc', 'ticket-sync.state.json')), false, 'dry-run must not write the sidecar');
    assert.ok(!r.plan.some((p) => String(p.newId ?? '').includes('undefined')), 'no #undefined planned id');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('orderLocalByDependency: a referenced ticket is ordered BEFORE its referrer (dependency-first)', () => {
  const order = orderLocalByDependency([
    { id: 'T7', title: 'a', edges: [{ to: 'T8' }] }, // references T8 → T8 must come first
    { id: 'T8', title: 'b' },
    { id: 'gh:acme/app#1', title: 'synced — ignored' },
  ]).map((t) => t.id);
  assert.deepEqual(order, ['T8', 'T7'], 'T8 (referenced) precedes T7 (referrer); synced ticket excluded');
});

test('orderLocalByDependency: tolerates a cycle without looping (cycles are gate-rejected anyway)', () => {
  const order = orderLocalByDependency([
    { id: 'T7', title: 'a', edges: [{ to: 'T8' }] },
    { id: 'T8', title: 'b', edges: [{ to: 'T7' }] },
  ]).map((t) => t.id);
  assert.equal(order.length, 2, 'every ticket appears exactly once despite the cycle');
  assert.deepEqual([...order].sort(), ['T7', 'T8']);
});

test('extractSentinelKey returns the bare key for both spaced and hand-edited (no-space) bodies', () => {
  assert.equal(extractSentinelKey('<!-- adlc:begin v=1 key=ABC123 -->'), 'ABC123');
  assert.equal(extractSentinelKey('<!-- adlc:begin v=1 key=ABC123-->'), 'ABC123', 'a hand-edited body with no space before --> still adopts');
  assert.equal(extractSentinelKey('no sentinel here'), null);
});

test('the pendingCreates recovery handle is on disk BEFORE the remote create (crash-recovery ordering)', async () => {
  const dir = repo({ tickets: [{ id: 'T7', title: 'x', scope: ['a/**'], duration: 1 }], manifest: [p5clear('T7', 1)] });
  try {
    const gh = fakeGitHub();
    let atCreate = null;
    const runner = async (args) => {
      // Snapshot the on-disk sidecar at the instant `issue create` is invoked.
      if (args[0] === 'issue' && args[1] === 'create') atCreate = readSidecar(dir);
      return gh.runner(args);
    };
    const r = await push({ dir, provider: githubProvider(), runner, write: true, now: 'T', uuid: () => 'K' });
    assert.equal(r.exitCode, 0, JSON.stringify(r.errors));
    assert.ok(atCreate, 'create was actually invoked');
    const handle = Object.values(atCreate.pendingCreates).find((v) => v.localId === 'T7');
    assert.ok(handle, 'pendingCreates handle is persisted before the remote create');
    assert.equal(handle.nodeId, undefined, 'the pre-create handle has no nodeId yet — proves it was written BEFORE create returned');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('push tolerates a malformed tickets.json (graceful empty, no throw)', async () => {
  const dir = repo({ tickets: [], manifest: [] });
  writeFileSync(join(dir, '.adlc', 'tickets.json'), '{ this is not json');
  try {
    const gh = fakeGitHub();
    const r = await push({ dir, provider: githubProvider(), runner: gh.runner, write: false });
    assert.equal(r.exitCode, 0, 'a corrupt tickets.json degrades to empty, not a crash');
    assert.equal(gh.mutating.length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('push migrates manifest evidence so the created issue inherits the ticket status label', async () => {
  const dir = repo({ tickets: [{ id: 'T7', title: 'x', scope: ['a/**'], duration: 1 }], manifest: [p5clear('T7', 1)] });
  try {
    const gh = fakeGitHub();
    const r = await push({ dir, provider: githubProvider(), runner: gh.runner, write: true, now: 'T', uuid: () => 'K' });
    assert.equal(r.exitCode, 0, JSON.stringify(r.errors));
    const issue = gh.state.issues.find((i) => i.number === 1);
    assert.ok(issue.labels.includes('adlc:passed'), 'p5-pass status rendered as a label on the new issue');
    // The manifest gained a re-attestation row bound to the new id.
    const manifest = readFileSync(join(dir, '.adlc', 'manifest.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(manifest.some((e) => e.ticket === 'gh:acme/app#1' && e.data?.migratedFrom === 'T7'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('push: a failed remote create → exit 1 and NEVER writes a gh:#undefined id', async () => {
  const dir = repo({ tickets: [{ id: 'T7', title: 'x', scope: ['a/**'], duration: 1 }], manifest: [p5clear('T7', 1)] });
  try {
    const gh = fakeGitHub();
    const runner = async (args) => {
      if (args[0] === 'issue' && args[1] === 'create') return { ok: false, code: 1, stdout: '', stderr: 'create failed', error: 'create failed' };
      return gh.runner(args);
    };
    const r = await push({ dir, provider: githubProvider(), runner, write: true, now: 'T', uuid: () => 'K' });
    assert.equal(r.exitCode, 1, 'a failed create is operational failure, not success');
    const ids = readTickets(dir).map((t) => t.id);
    assert.ok(!ids.some((id) => String(id).includes('undefined')), 'no gh:#undefined id corrupts the store');
    assert.ok(ids.includes('T7'), 'T7 stays local-only after a failed create');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('push defense-in-depth: a provider returning ok with a non-integer number never mints gh:#undefined', async () => {
  // Pin the Number.isInteger guard with a misbehaving provider stub (the real
  // provider returns ok:false on failure, so this belt is otherwise unreachable).
  const dir = repo({ tickets: [{ id: 'T7', title: 'x', scope: ['a/**'], duration: 1 }], manifest: [p5clear('T7', 1)] });
  try {
    const gh = fakeGitHub();
    const realProvider = githubProvider();
    const provider = { ...realProvider, createIssue: async () => ({ ok: true, number: undefined, nodeId: 'I_x', url: 'u' }) };
    const r = await push({ dir, provider, runner: gh.runner, write: true, now: 'T', uuid: () => 'K' });
    assert.equal(r.exitCode, 1, 'a non-integer issue number fails the ticket');
    const ids = readTickets(dir).map((t) => t.id);
    assert.ok(!ids.some((id) => String(id).includes('undefined')), 'store never gains a gh:#undefined id');
    assert.ok(ids.includes('T7'), 'T7 stays local-only');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('push defaults to dry-run when `write` is omitted (no mutating calls)', async () => {
  const dir = repo({ tickets: [{ id: 'T7', title: 'x', scope: ['a/**'], duration: 1 }], manifest: [p5clear('T7', 1)] });
  try {
    const gh = fakeGitHub();
    const r = await push({ dir, provider: githubProvider(), runner: gh.runner, uuid: () => 'K' }); // no `write`
    assert.ok(r.dryRun, 'omitting write defaults to dry-run');
    assert.equal(gh.mutating.length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('push exits 1 (operational) when the repo cannot be resolved', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-push-'));
  mkdirSync(join(dir, '.adlc'));
  writeFileSync(join(dir, '.adlc', 'config.json'), JSON.stringify({ ticketSync: { provider: 'github', statusLabels: {} } }));
  writeFileSync(join(dir, '.adlc', 'tickets.json'), JSON.stringify({ tickets: [] }));
  try {
    const r = await push({ dir, provider: githubProvider(), runner: async () => ({ ok: true, stdout: '[]', stderr: '', error: null }), write: false });
    assert.equal(r.exitCode, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('push exits 1 when the gh auth probe (whoami) fails', async () => {
  const dir = repo({ tickets: [] });
  try {
    const runner = async (args) => (args[0] === 'api' && args[1] === 'user'
      ? { ok: false, code: 1, stdout: '', stderr: 'no auth', error: 'no auth' }
      : { ok: true, stdout: '[]', stderr: '', error: null });
    const r = await push({ dir, provider: githubProvider(), runner, write: false });
    assert.equal(r.exitCode, 1);
    assert.ok(r.errors.some((e) => /auth probe/.test(e)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('push exits 1 when issue list fails (operational, not blocked)', async () => {
  const dir = repo({ tickets: [] });
  try {
    const runner = async (args) => {
      if (args[0] === 'api' && args[1] === 'user') return { ok: true, stdout: JSON.stringify({ login: 'bot' }), stderr: '', error: null };
      if (args[0] === 'issue' && args[1] === 'list') return { ok: false, code: 1, stdout: '', stderr: 'list boom', error: 'list boom' };
      return { ok: true, stdout: '{}', stderr: '', error: null };
    };
    const r = await push({ dir, provider: githubProvider(), runner, write: false });
    assert.equal(r.exitCode, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('push updates a synced ticket body when the canonical block changed', async () => {
  // Issue #1 exists with duration:1; local synced ticket now says duration:2.
  const body = serializeBlock({ prefix: 'human\n\n', suffix: '' }, { scope: ['a/**'], duration: 1 }, {});
  const dir = repo({
    tickets: [{ id: 'gh:acme/app#1', title: 'x', scope: ['a/**'], duration: 2 }],
    sidecar: { version: 1, tickets: { 'gh:acme/app#1': { provider: 'github', repo: 'acme/app', number: 1, nodeId: 'I_1', syncedHash: canonicalHash({ scope: ['a/**'], duration: 1 }, { omit: ['$schema'] }) } }, pendingCreates: {} },
  });
  try {
    const gh = fakeGitHub({ issues: [{ number: 1, id: 'I_1', url: 'https://github.com/acme/app/issues/1', title: 'x', body, labels: ['adlc'] }] });
    const r = await push({ dir, provider: githubProvider(), runner: gh.runner, write: true, now: 'T' });
    assert.equal(r.exitCode, 0, JSON.stringify(r.errors));
    assert.ok(gh.mutating.some((a) => a[0] === 'issue' && a[1] === 'edit' && a.includes('--body')), 'body was edited');
    assert.match(gh.state.issues[0].body, /"duration": 2/, 'remote block now reflects the local edit');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
