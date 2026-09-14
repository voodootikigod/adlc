// apply-e2e.test.mjs — the write path through the real binary.
//
// The library seams are tested directly elsewhere. What only a spawned process
// exercises is the wiring: that `--apply` refuses without its set, that the
// reviewer and the writer are invoked as separate executables, and above all
// that a run which cannot review WRITES NOTHING. A fake `gh` on PATH records
// every call, so "nothing was written" is an assertion rather than a hope.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'backlog-groom.mjs');

/**
 * A scratch repo with a recorded `gh` and a scripted `adversarial-review`.
 *
 * `reviewExit` is the reviewer's exit code — the whole verdict contract — and
 * the `gh` shim appends every invocation to a log, so a test can assert on
 * writes that did NOT happen.
 */
function sandbox({ reviewExit = 0, profile = null, ghFails = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'groom-apply-'));
  const bin = join(dir, 'fakebin');
  mkdirSync(bin);
  const log = join(dir, 'gh.log');

  writeFileSync(
    join(bin, 'gh'),
    `#!/bin/sh\necho "$@" >> ${log}\n` +
      `case "$2" in\n  view) echo '{"comments":[]}' ;;\n  *) ${ghFails ? 'exit 1' : 'echo ok'} ;;\nesac\n`
  );
  chmodSync(join(bin, 'gh'), 0o755);

  writeFileSync(join(bin, 'adversarial-review'), `#!/bin/sh\necho "review $@" >> ${log}\nexit ${reviewExit}\n`);
  chmodSync(join(bin, 'adversarial-review'), 0o755);

  mkdirSync(join(dir, '.adlc'));
  mkdirSync(join(dir, '.claude'), { recursive: true });
  if (profile) writeFileSync(join(dir, '.claude', 'backlog-groom-profile.json'), JSON.stringify(profile));

  const git = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'test');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'seed.txt'), 'seed\n');
  if (profile) git('add', '-A');
  else writeFileSync(join(dir, 'seed.txt'), 'seed\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'seed', '--no-gpg-sign');
  git('branch', '-f', 'base-for-floor');

  return { dir, bin, log };
}

function run(args, { dir, bin }) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
}

const ghCalls = (box) => (existsSync(box.log) ? readFileSync(box.log, 'utf8').trim().split('\n').filter(Boolean) : []);

/** A groomed set with exactly one closable issue. */
function setFile(box, { contentHash = 'h1' } = {}) {
  const p = join(box.dir, 'groomed.json');
  writeFileSync(
    p,
    JSON.stringify({
      schemaVersion: 2,
      issues: [{ number: 705, verdict: 'fixed', contentHash, evidence: 'the cited line is gone', labels: [], units: [] }],
      proposals: [],
    })
  );
  return p;
}

test('--apply without --set is refused before anything is spawned', () => {
  const box = sandbox();
  const r = run(['--apply'], box);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--set/);
  assert.deepEqual(ghCalls(box), [], 'nothing may be invoked before the arguments are valid');
});

test('--apply with an unreadable set exits 1 and writes nothing', () => {
  const box = sandbox();
  const r = run(['--apply', '--set', join(box.dir, 'missing.json')], box);
  assert.equal(r.status, 1);
  assert.deepEqual(ghCalls(box), []);
});

test('with no declared providers the reviewer is never spawned and nothing is written', () => {
  // The default profile declares no providers, so the distinct-reviewer rule is
  // unsatisfiable and every action demotes. The run must still succeed.
  const box = sandbox();
  const set = setFile(box);
  const r = run(['--apply', '--set', set, '--base-ref', 'base-for-floor'], box);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(ghCalls(box), [], 'no reviewer, no writes');
  assert.match(r.stderr, /demote/i);
  const out = JSON.parse(r.stdout);
  assert.equal(out.executed.length, 0);
  assert.equal(out.proposed, 1, 'the run still reports what it would have done');
});

test('a floored close is never written, even with an approving reviewer', () => {
  // The default floor is ["close"], so this is the shipped-default behaviour: a
  // fresh adopter gets proposals, not closures.
  const box = sandbox({ reviewExit: 0, profile: { schemaVersion: 1, providers: { decider: 'anthropic', reviewer: 'openai' } } });
  const set = setFile(box);
  const r = run(['--apply', '--set', set, '--base-ref', 'base-for-floor'], box);
  assert.equal(r.status, 0, r.stderr);
  const calls = ghCalls(box);
  assert.equal(calls.filter((c) => c.startsWith('issue close')).length, 0, 'the floor must block the close');
  const out = JSON.parse(r.stdout);
  assert.equal(out.demoted[0].reason, 'floor');
});

test('an approved, unfloored close comments first and then closes', () => {
  const box = sandbox({
    reviewExit: 0,
    profile: { schemaVersion: 1, autonomyFloor: [], providers: { decider: 'anthropic', reviewer: 'openai' } },
  });
  const set = setFile(box);
  const r = run(['--apply', '--set', set, '--base-ref', 'base-for-floor'], box);
  assert.equal(r.status, 0, r.stderr);

  const calls = ghCalls(box).filter((c) => !c.startsWith('review'));
  const commentAt = calls.findIndex((c) => c.startsWith('issue comment'));
  const closeAt = calls.findIndex((c) => c.startsWith('issue close'));
  assert.ok(commentAt >= 0, `expected a comment, got: ${JSON.stringify(calls)}`);
  assert.ok(closeAt >= 0, 'expected a close');
  assert.ok(commentAt < closeAt, 'the evidence must reach the issue before it goes quiet');
});

test('a reviewer that refuses blocks the close entirely', () => {
  const box = sandbox({
    reviewExit: 2,
    profile: { schemaVersion: 1, autonomyFloor: [], providers: { decider: 'anthropic', reviewer: 'openai' } },
  });
  const set = setFile(box);
  const r = run(['--apply', '--set', set, '--base-ref', 'base-for-floor'], box);
  assert.equal(r.status, 0, r.stderr);
  const calls = ghCalls(box);
  assert.equal(calls.filter((c) => c.startsWith('issue close')).length, 0);
  assert.equal(calls.filter((c) => c.startsWith('issue comment')).length, 0, 'a refused action leaves no trace');
});

test('a reviewer that ERRORS blocks the close — an error is not an approve', () => {
  const box = sandbox({
    reviewExit: 1,
    profile: { schemaVersion: 1, autonomyFloor: [], providers: { decider: 'anthropic', reviewer: 'openai' } },
  });
  const set = setFile(box);
  const r = run(['--apply', '--set', set, '--base-ref', 'base-for-floor'], box);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(ghCalls(box).filter((c) => c.startsWith('issue close')).length, 0);
});

test('the gate ledger persists, so a second run does not re-review the same revision', () => {
  const box = sandbox({
    reviewExit: 2,
    profile: { schemaVersion: 1, autonomyFloor: [], providers: { decider: 'anthropic', reviewer: 'openai' } },
  });
  const set = setFile(box);
  run(['--apply', '--set', set, '--base-ref', 'base-for-floor'], box);
  const afterFirst = ghCalls(box).filter((c) => c.startsWith('review')).length;
  assert.equal(afterFirst, 1);

  run(['--apply', '--set', set, '--base-ref', 'base-for-floor'], box);
  const afterSecond = ghCalls(box).filter((c) => c.startsWith('review')).length;
  assert.equal(afterSecond, 1, 'the same revision must not be reviewed twice across runs');
});

test('an unwritable ledger warns but does not fail a run that already decided', () => {
  const box = sandbox({
    reviewExit: 2,
    profile: { schemaVersion: 1, autonomyFloor: [], providers: { decider: 'anthropic', reviewer: 'openai' } },
  });
  const set = setFile(box);
  const r = run(['--apply', '--set', set, '--ledger', join(box.dir, 'nope', 'ledger.json'), '--base-ref', 'base-for-floor'], box);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /warning/i);
});
