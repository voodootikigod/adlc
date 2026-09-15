// cli-e2e.test.mjs — the binary, run for real, with a fake `gh` on PATH.
//
// The last few branches in the binary are only reachable by actually running it:
// whether a successful sweep exits 0, whether the cache is written by default,
// and whether a warning is printed when there is nothing to warn about. Stubbing
// `gh` rather than the module keeps the test hermetic while still exercising the
// real wiring end to end.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { rmSync, mkdtempSync, writeFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import { EMIT_SCHEMA_VERSION } from '../lib/emit.mjs';
import { fileURLToPath } from 'node:url';

/**
 * Every sandbox this file creates, removed when the file finishes.
 *
 * `mkdtempSync` with no cleanup leaks a git repository per test, per run. That
 * is invisible until the filesystem runs out of INODES — which reports as "no
 * space left on device" while df still shows most of the disk free.
 */
const SANDBOXES = [];
const registerSandbox = (dir) => { SANDBOXES.push(dir); return dir; };
after(() => {
  for (const dir of SANDBOXES) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'backlog-groom.mjs');

/** A scratch dir with a `gh` shim that answers with `issues`. */
function sandbox(issues = []) {
  const dir = registerSandbox(mkdtempSync(join(tmpdir(), 'groom-e2e-')));
  const bin = join(dir, 'fakebin');
  mkdirSync(bin);
  const gh = join(bin, 'gh');
  writeFileSync(gh, `#!/bin/sh\ncat <<'JSON'\n${JSON.stringify(issues)}\nJSON\n`);
  chmodSync(gh, 0o755);
  mkdirSync(join(dir, '.adlc'));
  // A real repository with one commit: verification reads code AT A REVISION, so
  // a run that cannot resolve one now fails closed rather than reporting a sweep
  // of `unverifiable` verdicts as a successful, normal-looking result.
  const git = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'test');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'seed.txt'), 'seed\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'seed', '--no-gpg-sign');
  return { dir, bin };
}

function run(args, { dir, bin }) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
}

test('a successful sweep exits 0', () => {
  // 1 is the operational-error code. A run that produced its report must not
  // claim to have failed — a caller branching on the exit would discard a good
  // answer.
  const box = sandbox([]);
  const r = run([], box);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Examined 0 issue/);
});

test('the cache is written by DEFAULT, and not written under --no-cache', () => {
  const box = sandbox([]);
  const cachePath = join(box.dir, '.adlc', 'backlog-groom-cache.json');

  run([], box);
  assert.ok(existsSync(cachePath), 'incrementality is the default, so the cache must persist');
  assert.match(readFileSync(cachePath, 'utf8'), /^\{/);

  const box2 = sandbox([]);
  run(['--no-cache'], box2);
  assert.equal(existsSync(join(box2.dir, '.adlc', 'backlog-groom-cache.json')), false, '--no-cache must leave no cache behind');
});

test('a clean run prints no warning — a warning with nothing to say trains the reader to ignore them', () => {
  const box = sandbox([]);
  const r = run([], box);
  assert.doesNotMatch(r.stderr, /warning/i);
});

test('--json emits the groomed set, and --out writes it', () => {
  const box = sandbox([]);
  const out = join(box.dir, 'set.json');
  const r = run(['--json', '--out', out], box);
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  // Against the CONSTANT, not a literal: a literal here is a second place the
  // schema version has to be remembered, and it was already forgotten once.
  assert.equal(parsed.schemaVersion, EMIT_SCHEMA_VERSION);
  assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), parsed, 'the file and stdout must agree');
});

test('a gh failure exits 1 and says the backlog was unconsultable — never an empty success', () => {
  const box = sandbox([]);
  writeFileSync(join(box.bin, 'gh'), '#!/bin/sh\necho "gh: auth required" >&2\nexit 1\n');
  chmodSync(join(box.bin, 'gh'), 0o755);
  const r = run([], box);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /gh issue list failed/);
  assert.doesNotMatch(r.stdout, /Examined 0 issue/, 'a failed fetch must not render as a clean, empty backlog');
});

test('a LARGE --json payload survives being piped — no truncation on exit', () => {
  // Raised in cross-model review. `console.log` to a pipe is asynchronous, and a
  // 500-issue groomed set comfortably exceeds the pipe buffer; forcing
  // process.exit terminates before stdout drains and the consumer gets an
  // unparseable fragment. The test needs a payload big enough to exceed the
  // buffer, or it passes whatever the code does.
  const many = Array.from({ length: 500 }, (_, i) => ({
    number: i + 1,
    title: `issue ${i + 1} with a deliberately long title so the payload exceeds a pipe buffer`,
    body: `prose about nothing in particular, repeated to add bulk. ${'x'.repeat(400)}`,
    labels: [{ name: 'bug' }],
    url: `https://example.invalid/${i + 1}`,
    updatedAt: '2026-09-13T00:00:00Z',
  }));
  const box = sandbox(many);
  const r = run(['--json', '--no-cache'], box);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.length > 65536, `payload must exceed a pipe buffer to be a real test (got ${r.stdout.length})`);

  const parsed = JSON.parse(r.stdout); // throws on a truncated document
  assert.equal(parsed.issues.length, 500, 'every issue must survive the pipe');
  assert.equal(parsed.coverage.total, 500);
});

test('an operational error prints its message alone — no stack trace on top', () => {
  // The message is the whole of what an operator needs. A stack trace printed
  // over it is noise they have to read past to find the one line that matters,
  // and it makes a handled, expected refusal look like a crash.
  const box = sandbox([]);
  const r = run(['--threshold', '7'], box);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--threshold must be a number between 0 and 1/);
  assert.doesNotMatch(r.stderr, /\s+at\s/, 'a handled refusal must not surface a stack');
  assert.doesNotMatch(r.stderr, /Error:/, 'nor an exception header');
});
