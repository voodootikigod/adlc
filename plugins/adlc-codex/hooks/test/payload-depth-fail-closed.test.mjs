// payload-depth-fail-closed.test.mjs — issue #804.
//
// The rail guard is an ENFORCING hook: exit 2 denies, exit 0 allows, and in
// Codex's PreToolUse convention exit 1 is a non-blocking error — the tool call
// proceeds. The hook ran its body at module top level with no error handler,
// so any uncaught throw exited 1 and the edit landed. The demonstrated throw
// was agent-controlled: a payload nested ~20000 levels deep blew the stack in
// the recursive path collector (RangeError), and a frozen-rail write went
// through with a stack trace as the only signal.
//
// Two defences, both pinned here:
//   1. a depth cap, checked iteratively right after JSON.parse, that DENIES a
//      payload nested deeper than MAX_PAYLOAD_DEPTH instead of recursing into it;
//   2. the whole body runs inside main().catch(fail) so that any other internal
//      error denies (exit 2) rather than crashing open (exit 1).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnHook } from './helpers/run-hook.mjs';
import { exceedsDepth, MAX_PAYLOAD_DEPTH } from '../adlc-rails-guard.mjs';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', 'adlc-rails-guard.mjs');
const ticket = { id: 'T1', title: 'Active', scope: ['src/**'], rails: ['test/**'], edges: [] };

const ALLOWED = 0;
const DENIED = 2;

function withRepo(fn) {
  const root = mkdtempSync(join(tmpdir(), 'adlc-codex-depth-'));
  mkdirSync(join(root, '.adlc'), { recursive: true });
  writeFileSync(join(root, '.adlc/tickets.json'), `${JSON.stringify({ tickets: [ticket] }, null, 2)}\n`);
  writeFileSync(join(root, '.adlc/current-ticket.json'), '{"id":"T1"}\n');
  try { return fn(root); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

function hookEnv() {
  const { ADLC_P4_ENFORCEMENT: _e, ADLC_TICKET: _t, ADLC_TICKETS: _ts, ADLC_TICKET_STORE: _s, ADLC_RAILS_BYPASS: _b, ...base } = process.env;
  return base;
}

/** Run the hook on a RAW stdin string; returns { status, stdout, stderr }. */
function runRaw(root, input) {
  return spawnHook([HOOK], { cwd: root, env: hookEnv(), input, encoding: 'utf8' });
}

/** A write payload whose `deep` field is nested `extra` container levels below tool_input. */
function writePayloadWithDepth(path, extra) {
  // Root object = level 1, tool_input = level 2, then `extra` arrays below it.
  return `{"tool_name":"write","tool_input":{"path":${JSON.stringify(path)},"deep":${'['.repeat(extra)}${']'.repeat(extra)}}}`;
}

// --- AC1: the demonstrated crash is now a deny -------------------------------

test('a payload nested 20000 levels deep is DENIED with the cap message, not a RangeError', () => {
  const depth = 20000;
  const input = `{"tool_name":"write","tool_input":{"path":"test/x.mjs","deep":${'{"a":'.repeat(depth)}1${'}'.repeat(depth)}}}`;
  assert.ok(Buffer.byteLength(input) > 100_000, `payload is ${Buffer.byteLength(input)} bytes; the issue's repro was ~120 KB`);
  withRepo((root) => {
    const r = runRaw(root, input);
    assert.equal(r.status, DENIED, `expected exit 2, got ${r.status}\n${r.stderr}`);
    assert.match(r.stderr, /nesting exceeds 64 levels/);
    assert.doesNotMatch(r.stderr, /RangeError/);
    assert.doesNotMatch(r.stderr, /at collectPaths/);
    assert.equal(r.stdout, '');
  });
});

// --- AC2: the cap is a ceiling, not a trip wire — classification still runs under it

test('a payload nested exactly 64 levels deep is still classified: non-rail path allowed', () => {
  withRepo((root) => {
    const r = runRaw(root, writePayloadWithDepth('src/x.mjs', MAX_PAYLOAD_DEPTH - 2));
    assert.equal(r.status, ALLOWED, r.stderr);
    assert.equal(r.stdout, '');
    assert.doesNotMatch(r.stderr, /nesting exceeds/);
  });
});

test('a payload nested exactly 64 levels deep is still classified: rail path denied with the frozen-rail message', () => {
  withRepo((root) => {
    const r = runRaw(root, writePayloadWithDepth('test/x.mjs', MAX_PAYLOAD_DEPTH - 2));
    assert.equal(r.status, DENIED, r.stderr);
    assert.match(r.stderr, /blocked rail edit for T1: test\/x\.mjs/);
    assert.doesNotMatch(r.stderr, /nesting exceeds/);
  });
});

test('one level past the cap trips it, even on a non-rail path', () => {
  withRepo((root) => {
    const r = runRaw(root, writePayloadWithDepth('src/x.mjs', MAX_PAYLOAD_DEPTH - 1));
    assert.equal(r.status, DENIED, r.stderr);
    assert.match(r.stderr, /nesting exceeds 64 levels/);
  });
});

// --- AC3: the depth check itself is iterative and pure ------------------------

test('MAX_PAYLOAD_DEPTH is 64', () => {
  assert.equal(MAX_PAYLOAD_DEPTH, 64);
});

test('exceedsDepth walks a 100000-deep array without throwing and reports it as too deep', () => {
  let value = [];
  for (let i = 0; i < 100_000; i += 1) value = [value];
  assert.equal(exceedsDepth(value, 64), true);
});

test('exceedsDepth: a flat object is within limit 1; an empty object exceeds limit 0; scalars never exceed', () => {
  assert.equal(exceedsDepth({ a: 1, b: 'x', c: null }, 1), false);
  assert.equal(exceedsDepth({}, 0), true);
  assert.equal(exceedsDepth([], 0), true);
  assert.equal(exceedsDepth('string', 0), false);
  assert.equal(exceedsDepth(null, 0), false);
  assert.equal(exceedsDepth(42, 0), false);
});

test('exceedsDepth counts the deepest branch, not the first one', () => {
  const value = { shallow: 1, mid: [1, 2], deep: { a: { b: { c: [] } } } };
  // root(1) > deep(2) > a(3) > b(4) > c(5)
  assert.equal(exceedsDepth(value, 5), false);
  assert.equal(exceedsDepth(value, 4), true);
});

test('exceedsDepth does not mutate its input', () => {
  const value = { a: [{ b: 1 }] };
  const before = JSON.stringify(value);
  exceedsDepth(value, 1);
  assert.equal(JSON.stringify(value), before);
});

// --- AC4: any OTHER internal error denies instead of crashing open ------------

test('an internal error (working directory removed under the hook) denies with exit 2, never exit 1', () => {
  // process.cwd() throws ENOENT when the cwd no longer exists — a worktree
  // removed under a live session. Before the fix this surfaced as an uncaught
  // throw and exit 1 (allow). The wrapper chdirs into a fresh directory,
  // removes it, then spawns the hook so it inherits the deleted cwd.
  const scratch = mkdtempSync(join(tmpdir(), 'adlc-codex-gone-cwd-'));
  const wrapper = `
    const fs = require('node:fs'), cp = require('node:child_process');
    const [dir, hook] = process.argv.slice(1);
    process.chdir(dir); fs.rmdirSync(dir);
    const r = cp.spawnSync(process.execPath, [hook], {
      input: JSON.stringify({ tool_name: 'write', tool_input: { path: 'test/x.mjs' } }),
      encoding: 'utf8', timeout: 20000, killSignal: 'SIGKILL',
    });
    process.stdout.write(JSON.stringify({ status: r.status, stdout: r.stdout, stderr: r.stderr }));
  `;
  let outer;
  try {
    outer = spawnHook(['-e', wrapper, scratch, HOOK], { env: hookEnv(), encoding: 'utf8' });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  assert.equal(outer.status, 0, `wrapper failed: ${outer.stderr}`);
  const inner = JSON.parse(outer.stdout);
  assert.equal(inner.status, DENIED, `expected exit 2, got ${inner.status}\n${inner.stderr}`);
  assert.match(inner.stderr, /denying to fail closed/);
  assert.equal(inner.stdout, '');
});

// --- regression: the ordinary paths are untouched -----------------------------

test('control: a plain rail edit is denied and a plain non-rail edit is allowed, as before', () => {
  withRepo((root) => {
    const denied = runRaw(root, JSON.stringify({ tool_name: 'write', tool_input: { path: 'test/x.mjs' } }));
    assert.equal(denied.status, DENIED);
    assert.match(denied.stderr, /blocked rail edit for T1: test\/x\.mjs/);
    const allowed = runRaw(root, JSON.stringify({ tool_name: 'write', tool_input: { path: 'src/x.mjs' } }));
    assert.equal(allowed.status, ALLOWED, allowed.stderr);
    assert.equal(allowed.stdout, '');
  });
});

test('malformed JSON still denies with the existing message', () => {
  withRepo((root) => {
    const r = runRaw(root, '{"tool_name": "write", ');
    assert.equal(r.status, DENIED);
    assert.match(r.stderr, /malformed hook payload JSON/);
  });
});
