// supervise-cli.test.mjs — the whole zero-touch loop, driven by the REAL
// `handoff supervise` subcommand against a fake harness binary.
//
// See supervise-cli-support.mjs for the fixture and for the optional live check.
// The degrade path lives in supervise-cli-degrade.test.mjs: both files wait on
// the real poll and quiescence intervals, and `node --test` runs FILES in
// parallel but the tests inside one file in sequence — so splitting them costs
// one interval instead of two, which the mutation gate pays once per mutant.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import {
  BIN,
  SUMMARY,
  TEST_KEY,
  contentPathFor,
  denyPathFor,
  fixture,
  readJson,
  readSpawns,
  supervise,
} from './supervise-cli-support.mjs';

const resumeAuthFiles = (root) =>
  readdirSync(join(root, '.adlc', 'handoffs'))
    .filter((n) => n.endsWith('.resume-auth.json'))
    .sort();

test('supervise drives deny → continue → respawn with no operator action', async (t) => {
  t.diagnostic('this test waits on the real quiescence + poll intervals (~15s)');
  const fx = fixture();
  try {
    const run = await supervise(fx);
    assert.equal(run.code, 0, `supervise failed: ${run.stderr}`);

    const spawns = readSpawns(fx.log);
    assert.equal(spawns.length, 2, `expected a denied session and its successor, got ${spawns.length}`);

    const [first, second] = spawns;
    assert.equal(first.argv[0], '--session-id');
    const denier = first.argv[1];
    assert.equal(first.argv.length, 2, 'the first session gets no prompt — it is the operator’s');

    assert.equal(second.argv[0], '--session-id');
    const successor = second.argv[1];
    assert.notEqual(successor, denier, 'the successor must be a different session');
    assert.equal(second.argv.length, 3, 'the successor is spawned with the bootstrap prompt');

    // The prompt is the spec's bootstrap payload: fenced, and carrying the
    // previous session's own final message.
    const prompt = second.argv[2];
    assert.match(prompt, new RegExp(`Continuation of session ${denier}`));
    assert.ok(prompt.includes(SUMMARY), 'the successor must receive the narrative from the transcript');
    assert.ok(prompt.includes('<<<UNTRUSTED-CAPTURE-DATA'), 'the untrusted fence must survive into the prompt');
    assert.ok(prompt.includes('END-UNTRUSTED>>>'));

    // Contract item 24, on every spawn — the fact the whole loop depends on.
    for (const spawn of spawns) {
      for (const marker of [
        'CLAUDECODE',
        'CLAUDE_CODE_CHILD_SESSION',
        'CLAUDE_CODE_SESSION_ID',
        'CLAUDE_CODE_ENTRYPOINT',
      ]) {
        assert.equal(spawn.env[marker], undefined, `${marker} reached the harness child`);
      }
      assert.equal(spawn.env.ADLC_MANIFEST_KEY, undefined, 'the signing key must never reach the child');
      assert.equal(spawn.env.ADLC_HANDOFF_SUPERVISED, '1');
    }

    // The deny was consumed EXACTLY once, for exactly this successor.
    const deny = readJson(denyPathFor(fx.root, denier));
    assert.equal(deny.status, 'consumed');
    assert.equal(deny.consumed_by, successor);
    assert.deepEqual(resumeAuthFiles(fx.root), [`${successor}.resume-auth.json`]);

    const capture = readFileSync(contentPathFor(fx.root, denier), 'utf8');
    assert.ok(capture.includes(SUMMARY));
    assert.ok(capture.includes('## Ticket'));

    const manifest = readFileSync(join(fx.root, '.adlc', 'manifest.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.gate === 'context-handoff-continue');
    assert.equal(manifest.length, 1, 'exactly one continuation was recorded');

    const payload = JSON.parse(run.stdout);
    assert.equal(payload.continuations, 1);
    assert.deepEqual(payload.sessions, [denier, successor]);
    assert.equal(payload.reason, 'child_exited');
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('supervise refuses to start without the separator or the key', async () => {
  const fx = fixture();
  try {
    const noSeparator = await new Promise((resolve) => {
      execFile(
        process.execPath,
        [BIN, 'supervise', 'claude'],
        { cwd: fx.root, encoding: 'utf8', env: { ...process.env, ADLC_MANIFEST_KEY: TEST_KEY } },
        (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }),
      );
    });
    assert.equal(noSeparator.code, 1);
    assert.match(noSeparator.stderr + noSeparator.stdout, /after `--`/);

    // The key is demanded UP FRONT: discovering it after an hour-long session
    // hit its deny would waste the very session being supervised.
    const noKey = await new Promise((resolve) => {
      const env = { ...process.env };
      delete env.ADLC_MANIFEST_KEY;
      execFile(
        process.execPath,
        [BIN, 'supervise', '--', fx.fake],
        { cwd: fx.root, encoding: 'utf8', env },
        (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }),
      );
    });
    assert.equal(noKey.code, 1);
    assert.match(noKey.stderr + noKey.stdout, /ADLC_MANIFEST_KEY/);
    assert.deepEqual(readSpawns(fx.log), [], 'no harness process may start without the key');
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});
