// stop-preflight.test.mjs — T18 P5 HOLLOW-TEST AMENDMENT: the DISABLED-by-default
// unpinned hooks (adlc-preflight.mjs / adlc-stop.mjs) ship runnable pure logic
// that had zero coverage. These tests pin that logic directly through the
// modules' exports — no Cursor event is invented or wired here (the scripts stay
// disabled by default; see scaffold.test.mjs for the wiring contract).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { preflightOnce, PRECEDENCE_ASSERTION } from '../hooks/adlc-preflight.mjs';
import { run } from '../hooks/adlc-stop.mjs';
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
