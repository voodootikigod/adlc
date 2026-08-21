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
  superviseEnv,
  contentPathFor,
  denyPathFor,
  documentedCodeFor,
  fixture,
  helpText,
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

    // The control for the crashed-intermediate warning: here the denied child
    // stayed alive and the SUPERVISOR ended it, which is the ordinary handoff
    // and must stay quiet. A warning that fired unconditionally would make
    // every successful handoff look like a crash.
    assert.deepEqual(payload.abnormalExits, [], 'a child the supervisor killed is not a crash');
    assert.doesNotMatch(run.stderr, /exited abnormally/);

    // The help promises a code for this outcome. An operator scripting around
    // `supervise` reads that table once and never re-checks it, so it is
    // compared against what the command ACTUALLY returned above rather than
    // against a number repeated here.
    assert.equal(documentedCodeFor(helpText(fx.root), 'the supervised session ended'), run.code);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('the advertised synopsis is the calling convention the command enforces', () => {
  const fx = fixture();
  try {
    const help = helpText(fx.root);
    const synopsis = help.split('\n')[0];
    // The separator is the whole reason this command has a synopsis worth
    // printing: without it a wrapper flag and the harness's own flags are
    // indistinguishable. A synopsis that stopped naming `-- <command>` would
    // hand operators a form the command rejects.
    assert.equal(synopsis, 'handoff supervise [--dir .adlc] -- <command> [args...]');
    assert.ok(synopsis.includes('-- <command>'));
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('supervise refuses to start without the separator or the key', async () => {
  const fx = fixture();
  try {
    const help = helpText(fx.root);
    const documented = documentedCodeFor(help, 'operational error');

    const noSeparator = await new Promise((resolve) => {
      execFile(
        process.execPath,
        [BIN, 'supervise', 'claude'],
        // Bounded: if the key check ever stops running UP FRONT, the harness
        // starts and idles, and an unbounded execFile would hang here instead
        // of reporting the regression.
        { cwd: fx.root, encoding: 'utf8', timeout: 30_000, env: superviseEnv(fx) },
        (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }),
      );
    });
    assert.equal(noSeparator.code, 1);
    assert.equal(noSeparator.code, documented, 'the help documents a different code than this returns');
    assert.match(noSeparator.stderr + noSeparator.stdout, /after `--`/);

    // The key is demanded UP FRONT: discovering it after an hour-long session
    // hit its deny would waste the very session being supervised.
    const noKey = await new Promise((resolve) => {
      // A full, HOME-safe supervised environment MINUS the key: the fake
      // harness can therefore record itself if it ever runs, which is what
      // makes the "nothing ever ran" assertion below mean anything. An env
      // without FAKE_CLAUDE_LOG leaves the log empty either way, and one
      // without HOME points the fake at the real ~/.claude.
      const env = superviseEnv(fx);
      delete env.ADLC_MANIFEST_KEY;
      execFile(
        process.execPath,
        [BIN, 'supervise', '--', fx.fake],
        { cwd: fx.root, encoding: 'utf8', timeout: 30_000, env },
        (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }),
      );
    });
    assert.equal(noKey.code, 1);
    assert.equal(noKey.code, documented);
    assert.match(noKey.stderr + noKey.stdout, /ADLC_MANIFEST_KEY/);
    assert.deepEqual(readSpawns(fx.log), [], 'no harness process may start without the key');
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});
