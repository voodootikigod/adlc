// supervise-cli-failures.test.mjs — outcomes a wrapper must not report as
// success, driven end-to-end through the real `handoff supervise`.
//
// A supervisor is the process a script waits on. If it exits 0 because it
// wrapped something successfully while the thing it wrapped never started, or
// crashed, every caller downstream believes a session ran.
//
// Separate file so these fast cases run in parallel with the two that wait on
// real poll/quiescence intervals — see supervise-cli.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import {
  contentPathFor,
  denyPathFor,
  documentedCodeFor,
  fixture,
  helpText,
  readJson,
  readSpawns,
  supervise,
} from './supervise-cli-support.mjs';

test('a harness that exits non-zero before any deny is a failure, not a supervised session', async () => {
  const fx = fixture();
  try {
    const run = await supervise({ ...fx, exitCode: 7 });

    assert.notEqual(run.code, 0, 'exit 0 here tells a script the session ran');
    assert.equal(run.code, documentedCodeFor(helpText(fx.root), 'the supervised command failed'));

    const payload = JSON.parse(run.stdout);
    assert.equal(payload.reason, 'child_failed');
    assert.equal(payload.continuations, 0);
    // The harness's real code is reported rather than passed through: 1 and 2
    // already mean something about the supervision itself.
    assert.equal(payload.childExit.code, 7);
    assert.notEqual(run.code, 7);
    assert.equal(readSpawns(fx.log).length, 1, 'the harness did start — it just failed');
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('a command that cannot be started at all is its own outcome', async () => {
  const fx = fixture();
  try {
    const run = await supervise({ ...fx, command: join(fx.root, 'no-such-harness') });

    assert.notEqual(run.code, 0);
    assert.equal(run.code, documentedCodeFor(helpText(fx.root), 'could not be started'));

    const payload = JSON.parse(run.stdout);
    assert.equal(payload.reason, 'spawn_failed');
    assert.match(run.stderr + run.stdout, /could not be started/);
    assert.match(payload.childExit.error, /ENOENT/, 'the operator needs to know WHY it did not start');
    assert.deepEqual(readSpawns(fx.log), [], 'nothing ever ran');
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('a clean exit with no deny is still a success', async () => {
  // The control for the two above: without it, a supervisor that reported
  // EVERY exit as a failure would pass them both.
  const fx = fixture();
  try {
    const run = await supervise({ ...fx, exitCode: 0 });
    assert.equal(run.code, 0, `expected success, got ${run.code}: ${run.stderr}`);
    const payload = JSON.parse(run.stdout);
    assert.equal(payload.reason, 'child_exited');
    assert.equal(payload.childExit.code, 0);
    assert.equal(run.code, documentedCodeFor(helpText(fx.root), 'the supervised session ended'));
    // Its siblings check this and this one did not: without it, a supervisor
    // that spawned NOTHING and returned "the session ended" would pass — which
    // is the same class of false success the two tests above exist to catch.
    assert.equal(readSpawns(fx.log).length, 1, 'the harness really did run');
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('a session that crashes after writing its deny is handed off, and the crash is reported', async () => {
  // The deny already said this session was being replaced; the supervisor
  // terminates it on the ordinary path anyway. So a crash here is not a failed
  // supervision — but an operator still needs to know the handoff came from a
  // session that died rather than one that stopped when asked.
  const fx = fixture();
  try {
    const run = await supervise({ ...fx, denyThenExit: 7 });

    assert.equal(run.code, 0, `a handed-off crash must not fail the run: ${run.stderr}`);
    const payload = JSON.parse(run.stdout);
    assert.equal(payload.reason, 'child_exited');
    assert.equal(payload.continuations, 1, 'the successor still took over');

    const [denier, successor] = payload.sessions;
    assert.deepEqual(payload.abnormalExits, [{ sessionId: denier, code: 7, signal: null }]);
    assert.match(run.stderr, new RegExp(`session ${denier} wrote a handoff deny then exited abnormally`));
    assert.match(run.stderr, /code 7/);

    // And the continuation itself really happened.
    const deny = readJson(denyPathFor(fx.root, denier));
    assert.equal(deny.status, 'consumed');
    assert.equal(deny.consumed_by, successor);
    assert.equal(readSpawns(fx.log).length, 2);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('a deny with no transcript still continues on the deterministic brief', async () => {
  // The child arms its deny and exits before any transcript exists — the exact
  // shape of the contract item 24 failure. The narrative is optional; the
  // continuation is not. Passing the derived (nonexistent) path to `continue`
  // would degrade the whole thing over a missing file.
  const fx = fixture();
  try {
    const run = await supervise({ ...fx, noTranscript: true, idleMs: 1 });

    assert.equal(run.code, 0, `expected the continuation to succeed: ${run.stderr}`);
    const payload = JSON.parse(run.stdout);
    assert.equal(payload.continuations, 1, 'the deny must still be continued');

    const [denier, successor] = payload.sessions;
    const deny = readJson(denyPathFor(fx.root, denier));
    assert.equal(deny.status, 'consumed', 'the deny was consumed without a narrative');
    assert.equal(deny.consumed_by, successor);
    assert.deepEqual(
      readdirSync(join(fx.root, '.adlc', 'handoffs')).filter((n) => n.endsWith('.resume-auth.json')),
      [`${successor}.resume-auth.json`],
    );

    // The capture exists and carries the brief — just no model narrative.
    const capture = readFileSync(contentPathFor(fx.root, denier), 'utf8');
    assert.ok(capture.includes('## Ticket'));
    assert.ok(capture.includes('## Model handoff'));
    assert.ok(capture.includes('_none_'), 'the absent narrative is stated, not silently omitted');

    // And the operator is told, because a missing transcript is how the
    // env-scrub contract fails.
    assert.match(run.stderr, /no transcript at/);
    assert.match(run.stderr, /suppressing transcript saving/);

    const spawns = readSpawns(fx.log);
    assert.equal(spawns.length, 2, 'the successor still starts');
    assert.equal(spawns[1].argv.length, 3, 'and still receives a bootstrap prompt');
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});
