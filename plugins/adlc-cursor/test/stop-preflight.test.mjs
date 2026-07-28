// stop-preflight.test.mjs — T18 P5 HOLLOW-TEST AMENDMENT: the DISABLED-by-default
// unpinned hooks (adlc-preflight.mjs / adlc-stop.mjs) ship runnable pure logic
// that had zero coverage. These tests pin that logic directly through the
// modules' exports — no Cursor event is invented or wired here (the scripts stay
// disabled by default; see scaffold.test.mjs for the wiring contract).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { preflightOnce, PRECEDENCE_ASSERTION } from '../hooks/adlc-preflight.mjs';
import { run, stopAudit, gitChangedPaths } from '../hooks/adlc-stop.mjs';
import { SESSION_TTL_MS, PREFLIGHT_MARKER_FILE } from '../constants.mjs';

const mkRoot = ({ adlc = true } = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-cursor-stoppre-'));
  if (adlc) mkdirSync(join(root, '.adlc'), { recursive: true });
  return root;
};
const cleanup = (root) => rmSync(root, { recursive: true, force: true });
const markerPath = (root) => join(root, '.adlc', PREFLIGHT_MARKER_FILE);

/** A spawnSync stand-in that records calls and returns a canned result. */
function spawnStub(result = { status: 0, stdout: '', stderr: '' }) {
  const calls = [];
  const impl = (bin, args, opts) => { calls.push({ bin, args, opts }); return result; };
  return { impl, calls };
}

// --- constants contract -------------------------------------------------------

test('SESSION_TTL_MS pins the ADR-0006 session window: exactly 30 minutes', () => {
  // ADR 0006 documents 30 minutes of inactivity as the session-staleness window
  // shared by the depth counter, the flail window, and the preflight marker.
  assert.equal(SESSION_TTL_MS, 30 * 60 * 1000);
});

// --- adlc-preflight.mjs: preflightOnce ----------------------------------------

test('preflight SKIPS a repo with no .adlc/ — exactly { skipped: true, ran: false, notices: [] }, nothing spawned', () => {
  const root = mkRoot({ adlc: false });
  const { impl, calls } = spawnStub();
  try {
    const res = preflightOnce(root, { spawnImpl: impl });
    assert.deepEqual(res, { skipped: true, ran: false, notices: [] });
    assert.equal(calls.length, 0, 'a non-ADLC repo must not spawn adlc');
    assert.ok(!existsSync(join(root, '.adlc')), 'must not create .adlc');
  } finally { cleanup(root); }
});

test('a VALID recent marker suppresses the re-run (once per session)', () => {
  const root = mkRoot();
  const now = Date.now();
  const { impl, calls } = spawnStub();
  try {
    writeFileSync(markerPath(root), `${JSON.stringify({ ts: now - 1000 })}\n`);
    const res = preflightOnce(root, { spawnImpl: impl, now });
    assert.deepEqual(res, { skipped: true, ran: false, notices: [] });
    assert.equal(calls.length, 0, 'a fresh marker means this session already ran preflight');
  } finally { cleanup(root); }
});

test('a STALE marker does not suppress: preflight runs and refreshes the marker', () => {
  const root = mkRoot();
  const now = Date.now();
  const { impl, calls } = spawnStub({ status: 0, stdout: '{}', stderr: '' });
  try {
    writeFileSync(markerPath(root), `${JSON.stringify({ ts: now - SESSION_TTL_MS - 1 })}\n`);
    const res = preflightOnce(root, { spawnImpl: impl, now });
    assert.equal(res.skipped, false);
    assert.equal(res.ran, true);
    assert.deepEqual(res.notices, [PRECEDENCE_ASSERTION], 'a clean run carries only the precedence assertion');
    assert.equal(calls.length, 1, 'the stale marker must trigger a real preflight run');
    assert.deepEqual(JSON.parse(readFileSync(markerPath(root), 'utf8')), { ts: now }, 'the marker is refreshed to this run');
  } finally { cleanup(root); }
});

test('ABSENT and MALFORMED markers do not suppress the run', () => {
  for (const seed of [null, 'not json at all', '{"ts":"not-a-number"}', '{}']) {
    const root = mkRoot();
    const now = Date.now();
    const { impl, calls } = spawnStub();
    try {
      if (seed !== null) writeFileSync(markerPath(root), seed);
      const res = preflightOnce(root, { spawnImpl: impl, now });
      assert.equal(res.ran, true, `marker=${JSON.stringify(seed)} must not count as a fresh session`);
      assert.equal(calls.length, 1);
    } finally { cleanup(root); }
  }
});

test('a FUTURE-dated marker (clock skew / tamper) does not suppress the run', () => {
  const root = mkRoot();
  const now = Date.now();
  const { impl, calls } = spawnStub();
  try {
    writeFileSync(markerPath(root), `${JSON.stringify({ ts: now + 60_000 })}\n`);
    const res = preflightOnce(root, { spawnImpl: impl, now });
    assert.equal(res.ran, true);
    assert.equal(calls.length, 1);
  } finally { cleanup(root); }
});

test('preflight surfaces problems as notices: missing binary and non-zero exit', () => {
  const root = mkRoot();
  try {
    const missing = preflightOnce(root, { spawnImpl: () => ({ error: new Error('ENOENT'), status: null }) });
    assert.ok(missing.notices.some((n) => /not on PATH/.test(n)), 'a spawn error must surface the install hint');
    rmSync(markerPath(root), { force: true }); // reset the once-per-session marker
    const failing = preflightOnce(root, { spawnImpl: () => ({ status: 1, stdout: '', stderr: 'spec-lint failed' }) });
    assert.ok(failing.notices.some((n) => /reported problems.*spec-lint failed/.test(n)));
  } finally { cleanup(root); }
});

// --- adlc-stop.mjs: run() runner-result mapping --------------------------------

test('run() preserves the spawn status and streams verbatim on success', () => {
  const r = run((bin, args) => ({ status: 7, stdout: `${bin} ${args.join(' ')}`, stderr: 'warn' }), 'git', ['status'], '/tmp');
  assert.equal(r.status, 7, 'a real exit status must be preserved, never remapped');
  assert.equal(r.stdout, 'git status');
  assert.equal(r.stderr, 'warn');
  assert.equal(r.error, undefined);
});

test('run() maps a spawn error with no status to status 1 (exactly 1)', () => {
  const boom = new Error('spawn ENOENT');
  const r = run(() => ({ status: null, error: boom }), 'adlc', ['gate-manifest'], '/tmp');
  assert.equal(r.status, 1);
  assert.equal(r.error, boom);
});

test('run() null-safety: missing stdout/stderr default to empty strings', () => {
  const r = run(() => ({ status: 0 }), 'git', [], '/tmp');
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, '');
  const rNull = run(() => ({ status: 0, stdout: null, stderr: undefined }), 'git', [], '/tmp');
  assert.equal(rNull.stdout, '');
  assert.equal(rNull.stderr, '');
});

test('run() converts a THROWING spawn into { status: 1 } instead of propagating', () => {
  const r = run(() => { throw new Error('kaboom'); }, 'git', [], '/tmp');
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /kaboom/);
});

// --- adlc-stop.mjs: stopAudit + gitChangedPaths (T18 F1) -----------------------
// The audit body and its git parser had ZERO coverage — only run() was pinned.
// These tests exercise the real behavior so planted defects (inverted skip
// branch, slice(2) porcelain parse, dropped ticket-scoping) can no longer pass.

/** A routed spawnSync stand-in: first matching [predicate, result] wins. */
function routedSpawn(routes = []) {
  const calls = [];
  const impl = (bin, args) => {
    calls.push({ bin, args });
    for (const [match, result] of routes) if (match(bin, args)) return result;
    return { status: 0, stdout: '', stderr: '' };
  };
  return { impl, calls };
}

/** A fully ADLC-initialized root (tickets.json + empty manifest.jsonl). */
function mkAdlcRoot() {
  const root = mkdtempSync(join(tmpdir(), 'adlc-cursor-stopaudit-'));
  mkdirSync(join(root, '.adlc'), { recursive: true });
  writeFileSync(join(root, '.adlc', 'tickets.json'), JSON.stringify({ tickets: [] }));
  writeFileSync(join(root, '.adlc', 'manifest.jsonl'), '');
  return root;
}

/** A real, minimal git repo fixture (identity + no gpg signing). */
function gitRepo() {
  const root = mkdtempSync(join(tmpdir(), 'adlc-cursor-gitcp-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  return { root, git };
}

// (a) skip-when-.adlc-absent — the exact skip shape, nothing spawned.
test('stopAudit SKIPS a repo with no .adlc/tickets.json — exactly { skipped: true, warnings: [] }, nothing spawned', () => {
  const root = mkRoot({ adlc: false });
  const { impl, calls } = routedSpawn();
  try {
    const res = stopAudit(root, { spawnImpl: impl, env: {} });
    assert.deepEqual(res, { skipped: true, warnings: [] });
    assert.equal(calls.length, 0, 'a non-ADLC repo must not spawn anything (inverted skip branch would proceed and spawn)');
  } finally { cleanup(root); }
});

// (b) gate-manifest verify warning path — a non-zero verify surfaces a warning;
// with no changed paths the run is not risk-gated, so that is the only warning.
test('stopAudit surfaces the gate-manifest verify problem as a warning when verify exits non-zero', () => {
  const root = mkAdlcRoot();
  const { impl, calls } = routedSpawn([
    [(b, a) => b === 'adlc' && a.includes('verify'), { status: 1, stdout: '', stderr: 'gate chain broken' }],
    // git status/ls-files/rev-parse all fall through to the empty default → no changed paths.
  ]);
  try {
    const res = stopAudit(root, { spawnImpl: impl, env: {} });
    assert.equal(res.skipped, false);
    assert.equal(res.warnings.length, 1, 'exactly the verify warning (no changed paths ⇒ not risk-gated)');
    assert.match(res.warnings[0], /gate-manifest verify reported a problem/);
    assert.match(res.warnings[0], /gate chain broken/);
    // #378: pin that the verify spawn actually passes --allow-legacy-unsigned — a
    // revert of that flag would restore the "cry wolf on legacy history" bug
    // without any test here catching it (the route above matches on 'verify' alone).
    const verifyCall = calls.find((c) => c.bin === 'adlc' && c.args.includes('verify'));
    assert.ok(verifyCall, 'a gate-manifest verify call was made');
    assert.ok(verifyCall.args.includes('--allow-legacy-unsigned'), 'verify is called with --allow-legacy-unsigned');
  } finally { cleanup(root); }
});

// (c) gitChangedPaths porcelain slice(3) + the -z NUL form: a two-status "AM"
// entry with a SPACE in the path must yield the clean, whole path. The `-z` flag
// is load-bearing — without it git C-quotes spaced paths ("...path.js" → a quoted
// token) and the slice(3) parse would keep the quotes; the spaced filename makes
// that (and any prefix off-by-one) observable rather than trim-masked.
test('gitChangedPaths parses porcelain (-z, slice(3)): a staged-then-modified (AM) file WITH SPACES yields the clean whole path', () => {
  const { root, git } = gitRepo();
  try {
    writeFileSync(join(root, 'seed.txt'), 'x');
    git('add', 'seed.txt'); git('commit', '-qm', 'seed');
    // stage a new file, then modify it again → index=A, worktree=M → porcelain "AM path".
    const p = 'staged then modified.js';
    writeFileSync(join(root, p), 'v1');
    git('add', p);
    writeFileSync(join(root, p), 'v2');
    const changed = gitChangedPaths(root, { base: 'no-such-base' }); // base missing ⇒ merge-base skipped
    assert.ok(changed.includes(p), `-z + slice(3) must yield the clean whole "${p}" (no quotes, no status-char prefix)`);
    assert.ok(!changed.some((c) => c !== p && c.endsWith(p)), 'no status-char-prefixed or quoted variant may leak in');
  } finally { cleanup(root); }
});

// (c cont.) merge-base fallback: a file committed only on the branch surfaces via
// the diff against the merge-base of the named base.
test('gitChangedPaths includes a branch-only committed file via the merge-base diff against the base', () => {
  const { root, git } = gitRepo();
  try {
    writeFileSync(join(root, 'base.txt'), 'x');
    git('add', 'base.txt'); git('commit', '-qm', 'base');
    git('branch', '-M', 'main');
    git('checkout', '-q', '-b', 'feature');
    const committed = 'feature-only.js';
    writeFileSync(join(root, committed), 'y');
    git('add', committed); git('commit', '-qm', 'feature');
    const changed = gitChangedPaths(root, { base: 'main' });
    assert.ok(changed.includes(committed), 'the branch-only commit must surface via the merge-base diff');
  } finally { cleanup(root); }
});

// (d) decideAdversarialReviewNotice wiring is TICKET-SCOPED: a risk-gated path
// with an adversarial-review record for a DIFFERENT ticket must still fire the
// notice (the active ticket is unreviewed). Dropping the ticket-scoping (passing
// ticketId=null) would let any record silence it — this is the RED case.
test('stopAudit ticket-scoping: a risk-gated path with an adversarial-review record for a DIFFERENT ticket still fires the notice', () => {
  const root = mkAdlcRoot();
  const { impl } = routedSpawn([
    [(b, a) => b === 'git' && a[0] === 'status', { status: 0, stdout: ' M src/auth/login.js\0', stderr: '' }],
    [(b, a) => b === 'git' && a[0] === 'rev-parse', { status: 1, stdout: '', stderr: '' }], // no base ⇒ skip merge-base
    [(b, a) => b === 'adlc' && a.includes('verify'), { status: 0, stdout: '', stderr: '' }],
    [(b, a) => b === 'adlc' && a.includes('show'),
      { status: 0, stdout: JSON.stringify({ entries: [{ gate: 'adversarial-review', ticket: 'T99' }] }), stderr: '' }],
  ]);
  try {
    const res = stopAudit(root, { spawnImpl: impl, env: { ADLC_TICKET: 'T18' } });
    assert.equal(res.skipped, false);
    const notice = res.warnings.find((w) => /risk-gated change/.test(w));
    assert.ok(notice, 'a record scoped to a different ticket must not satisfy the active ticket');
    assert.match(notice, /auth-trust-boundary/);
    assert.match(notice, /ticket T18/);
  } finally { cleanup(root); }
});

// (d cont.) the positive: an adversarial-review record for the ACTIVE ticket
// silences the notice.
test('stopAudit ticket-scoping: an adversarial-review record for the ACTIVE ticket silences the notice', () => {
  const root = mkAdlcRoot();
  const { impl } = routedSpawn([
    [(b, a) => b === 'git' && a[0] === 'status', { status: 0, stdout: ' M src/auth/login.js\0', stderr: '' }],
    [(b, a) => b === 'git' && a[0] === 'rev-parse', { status: 1, stdout: '', stderr: '' }],
    [(b, a) => b === 'adlc' && a.includes('verify'), { status: 0, stdout: '', stderr: '' }],
    [(b, a) => b === 'adlc' && a.includes('show'),
      { status: 0, stdout: JSON.stringify({ entries: [{ gate: 'adversarial-review', ticket: 'T18' }] }), stderr: '' }],
  ]);
  try {
    const res = stopAudit(root, { spawnImpl: impl, env: { ADLC_TICKET: 'T18' } });
    assert.equal(res.skipped, false);
    assert.ok(!res.warnings.some((w) => /risk-gated change/.test(w)), 'an in-ticket adversarial-review record must silence the notice');
  } finally { cleanup(root); }
});
