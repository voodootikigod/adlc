// payload-cwd-root.test.mjs — issue #811.
//
// Copilot's preToolUse stdin carries `cwd`, the repository the tool call targets.
// Both ENFORCING hooks ignored it and anchored every repository read — pointer,
// ticket store, path normalisation — on process.cwd(). Spawned from any other
// directory the rails guard found no pointer, printed "no current ticket
// selected" and allowed the edit for the whole session: a silent fail-open of
// the plugin's one enforcing gate. The advisory lifecycle hook already read the
// payload's cwd; these tests pin that the enforcing hooks do too.
//
// Every hook run here is a child process (the hooks are top-level scripts whose
// decision is their stdout), spawned through the bounded helper. Deny is exit 0
// plus a JSON object carrying `reason`; allow is exit 0 plus empty stdout.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnHook } from './helpers/run-hook.mjs';
import { payloadRoot } from '../adlc-build-gate.mjs';

const HOOKS = join(dirname(fileURLToPath(import.meta.url)), '..');
const RAILS_GUARD = join(HOOKS, 'adlc-rails-guard.mjs');
const BUILD_GATE = join(HOOKS, 'adlc-build-gate.mjs');

const TICKET = { id: 'T1', title: 'Active', scope: ['src/**'], rails: ['test/**'], edges: [] };
const NOTICE_RE = /resolving the repository from the payload cwd/g;

/** A repo whose active ticket rails `test/**`; `pointer` overrides the pointed-at id. */
function makeRepo({ pointer = TICKET.id } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'adlc-copilot-payload-cwd-repo-'));
  mkdirSync(join(root, '.adlc'), { recursive: true });
  writeFileSync(join(root, '.adlc/tickets.json'), `${JSON.stringify({ tickets: [TICKET] }, null, 2)}\n`);
  writeFileSync(join(root, '.adlc/current-ticket.json'), `${JSON.stringify({ id: pointer })}\n`);
  return root;
}

/** A directory with no `.adlc/` at all — where a hook process may actually start. */
function makeOutside() {
  return mkdtempSync(join(tmpdir(), 'adlc-copilot-payload-cwd-outside-'));
}

function cleanEnv() {
  const {
    ADLC_P4_ENFORCEMENT: _e, ADLC_TICKET: _t, ADLC_TICKETS: _ts, ADLC_TICKET_STORE: _s,
    ADLC_RAILS_BYPASS: _b, ADLC_BUILD_GATE_BYPASS: _g, ...base
  } = process.env;
  return base;
}

/**
 * Run a hook as Copilot would: `cwd` is where the process starts, `payload` is
 * the stdin document. `payload.cwd` is passed through verbatim (or omitted when
 * the caller leaves it undefined) so each test states the shape it sends.
 */
function run(hook, { cwd, payload }) {
  return spawnHook([hook], { cwd, env: cleanEnv(), input: JSON.stringify(payload), encoding: 'utf8' });
}

function editPayload(path, extra = {}) {
  return { toolName: 'edit', toolArgs: JSON.stringify({ path }), ...extra };
}

function denyOf(result) {
  const text = result.stdout.trim();
  assert.ok(text, `expected a deny object on stdout, got empty stdout (stderr: ${result.stderr})`);
  const parsed = JSON.parse(text);
  assert.equal(typeof parsed.reason, 'string');
  return parsed.reason;
}

function withDirs(fn) {
  const dirs = [];
  const track = (dir) => { dirs.push(dir); return dir; };
  try { return fn(track); }
  finally { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); }
}

// --- AC1 / AC2: the repository comes from the payload, not from where the process started

test('AC1 rails-guard spawned outside the repo denies a rail edit named by the payload cwd', () => {
  withDirs((track) => {
    const repo = track(makeRepo());
    const outside = track(makeOutside());
    const r = run(RAILS_GUARD, { cwd: outside, payload: editPayload('test/x.mjs', { cwd: repo }) });
    assert.equal(r.status, 0, `hook must never exit non-zero (stderr: ${r.stderr})`);
    const reason = denyOf(r);
    assert.match(reason, /test\/x\.mjs/);
    assert.match(reason, /T1/);
    assert.doesNotMatch(r.stderr, /no current ticket selected/);
  });
});

test('AC2 rails-guard spawned outside the repo allows a non-rail edit named by the payload cwd', () => {
  withDirs((track) => {
    const repo = track(makeRepo());
    const outside = track(makeOutside());
    const r = run(RAILS_GUARD, { cwd: outside, payload: editPayload('src/y.mjs', { cwd: repo }) });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '', `expected an allow (empty stdout), got: ${r.stdout}`);
    // The allow came from reading the payload-cwd store, not from finding no ticket.
    assert.doesNotMatch(r.stderr, /no current ticket selected/);
  });
});

// --- AC3: no cwd, or a non-string cwd, behaves exactly as before

test('AC3 a payload without cwd, spawned inside the repo, denies a rail edit and allows a non-rail edit', () => {
  withDirs((track) => {
    const repo = track(makeRepo());
    const denied = run(RAILS_GUARD, { cwd: repo, payload: editPayload('test/x.mjs') });
    assert.equal(denied.status, 0);
    assert.match(denyOf(denied), /test\/x\.mjs/);
    const allowed = run(RAILS_GUARD, { cwd: repo, payload: editPayload('src/y.mjs') });
    assert.equal(allowed.status, 0);
    assert.equal(allowed.stdout.trim(), '');
  });
});

test('AC3 a non-string cwd is treated as absent (process cwd is used)', () => {
  withDirs((track) => {
    const repo = track(makeRepo());
    const outside = track(makeOutside());
    // Inside the repo: identical to today.
    const inside = run(RAILS_GUARD, { cwd: repo, payload: editPayload('test/x.mjs', { cwd: 42 }) });
    assert.equal(inside.status, 0);
    assert.match(denyOf(inside), /test\/x\.mjs/);
    // Outside the repo: the number is NOT resolved as a path — the hook falls back
    // to process cwd, finds no pointer there, and reports exactly today's inactive notice.
    const out = run(RAILS_GUARD, { cwd: outside, payload: editPayload('test/x.mjs', { cwd: 42 }) });
    assert.equal(out.status, 0);
    assert.equal(out.stdout.trim(), '');
    assert.match(out.stderr, /no current ticket selected/);
  });
});

test('AC3 an empty or blank cwd string is treated as absent', () => {
  withDirs((track) => {
    const outside = track(makeOutside());
    for (const cwd of ['', '   ']) {
      const r = run(RAILS_GUARD, { cwd: outside, payload: editPayload('test/x.mjs', { cwd }) });
      assert.equal(r.status, 0);
      assert.equal(r.stdout.trim(), '', `cwd ${JSON.stringify(cwd)} must not be resolved as a path`);
      assert.match(r.stderr, /no current ticket selected/);
    }
  });
});

// --- AC4: the notice fires exactly once, and only when the two directories differ

test('AC4 rails-guard prints the payload-cwd notice exactly once when it differs from process cwd', () => {
  withDirs((track) => {
    const repo = track(makeRepo());
    const outside = track(makeOutside());
    const r = run(RAILS_GUARD, { cwd: outside, payload: editPayload('src/y.mjs', { cwd: repo }) });
    const hits = r.stderr.match(NOTICE_RE) ?? [];
    assert.equal(hits.length, 1, `expected one notice, stderr was: ${r.stderr}`);
    assert.match(r.stderr, new RegExp(`payload cwd ${repo.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  });
});

test('AC4 rails-guard prints no notice when the payload cwd and process cwd agree', () => {
  withDirs((track) => {
    const repo = track(makeRepo());
    const r = run(RAILS_GUARD, { cwd: repo, payload: editPayload('src/y.mjs', { cwd: repo }) });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
    assert.equal((r.stderr.match(NOTICE_RE) ?? []).length, 0, `unexpected notice: ${r.stderr}`);
  });
});

// --- AC5: build-gate reads the payload-cwd store too

test('AC5 build-gate spawned outside the repo reads the payload-cwd store and fails closed on a dangling pointer', () => {
  withDirs((track) => {
    const repo = track(makeRepo({ pointer: 'T9' }));
    const outside = track(makeOutside());
    const r = run(BUILD_GATE, { cwd: outside, payload: { toolName: 'edit', toolArgs: '{}', cwd: repo } });
    assert.equal(r.status, 0, `hook must never exit non-zero (stderr: ${r.stderr})`);
    const reason = denyOf(r);
    assert.match(reason, /T9/);
    assert.match(reason, /not found in the ticket store/);
    assert.equal((r.stderr.match(NOTICE_RE) ?? []).length, 1, `expected one notice, stderr was: ${r.stderr}`);
  });
});

test('AC5 build-gate spawned outside the repo allows when the payload cwd is not an ADLC repo', () => {
  withDirs((track) => {
    const notRepo = track(makeOutside());
    const outside = track(makeOutside());
    const r = run(BUILD_GATE, { cwd: outside, payload: { toolName: 'edit', toolArgs: '{}', cwd: notRepo } });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '', `expected an allow, got: ${r.stdout}`);
  });
});

test('AC5 build-gate spawned inside a repo with a dangling pointer and no payload cwd still fails closed', () => {
  withDirs((track) => {
    const repo = track(makeRepo({ pointer: 'T9' }));
    const r = run(BUILD_GATE, { cwd: repo, payload: { toolName: 'edit', toolArgs: '{}' } });
    assert.equal(r.status, 0);
    assert.match(denyOf(r), /T9/);
    assert.equal((r.stderr.match(NOTICE_RE) ?? []).length, 0);
  });
});

// --- AC6: payloadRoot is a pure derivation

test('AC6 payloadRoot derives the root from the payload and never reads process.cwd()', () => {
  assert.equal(payloadRoot({ cwd: '/x' }, '/y'), resolve('/x'));
  assert.equal(payloadRoot({ cwd: 'rel/dir' }, '/y'), resolve('rel/dir'));
  assert.equal(payloadRoot({}, '/y'), '/y');
  assert.equal(payloadRoot({ cwd: '' }, '/y'), '/y');
  assert.equal(payloadRoot({ cwd: '   ' }, '/y'), '/y');
  assert.equal(payloadRoot({ cwd: 42 }, '/y'), '/y');
  assert.equal(payloadRoot({ cwd: null }, '/y'), '/y');
  assert.equal(payloadRoot(null, '/y'), '/y');
  assert.equal(payloadRoot(undefined, '/y'), '/y');
  // Two different fallbacks, same payload: the answer tracks the argument, not the process.
  assert.equal(payloadRoot({}, '/a'), '/a');
  assert.equal(payloadRoot({}, '/b'), '/b');
});

test('AC6 payloadRoot does not mutate its input', () => {
  const payload = Object.freeze({ cwd: '/x', toolName: 'edit' });
  payloadRoot(payload, '/y');
  assert.deepEqual(payload, { cwd: '/x', toolName: 'edit' });
});
