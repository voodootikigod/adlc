// Flail detection runs adlc after every tool call. When the only adlc on PATH
// is one the hook refuses to run, flail says so once per session, the way the
// session-start and Stop checks do, instead of silently never running.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmp } from '@adlc/core/test-kit';
import { spawnHook } from './helpers/run-hook.mjs';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', 'adlc-hook.mjs');

/** A node_modules/.bin dir whose `adlc` leaves `marker` behind if it ever runs. */
function plantedAdlc(t, marker) {
  const dir = join(tmp(t, 'adlc-flail-planted-'), 'node_modules', '.bin');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'adlc'), `#!/bin/sh\ntouch '${marker}'\necho '{}'\n`);
  chmodSync(join(dir, 'adlc'), 0o755);
  return dir;
}

/** An ADLC repo plus a transcript for flail to scan. */
function session(t) {
  const repo = tmp(t, 'adlc-flail-repo-');
  mkdirSync(join(repo, '.adlc'), { recursive: true });
  const transcript = join(tmp(t, 'adlc-flail-transcript-'), 'session.jsonl');
  writeFileSync(transcript, '{"type":"user"}\n');
  return { repo, transcript };
}

/** Run flail with `pathDirs` ahead of the system dirs and a private temp dir for hook state. */
function runFlail(cwd, transcript, pathDirs, stateTmp) {
  const PATH = [...pathDirs, '/usr/bin', '/bin'].join(':');
  return spawnHook([HOOK, 'flail'], {
    cwd,
    input: JSON.stringify({ transcript_path: transcript }),
    env: { ...process.env, PATH, TMPDIR: stateTmp },
  });
}

function messages(stdout) {
  return (stdout ?? '').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

test('a refused adlc is named on the first flail call of a session', (t) => {
  const marker = join(tmp(t, 'adlc-flail-marker-'), 'ran');
  const planted = plantedAdlc(t, marker);
  const { repo, transcript } = session(t);
  const r = runFlail(repo, transcript, [planted], tmp(t, 'adlc-flail-state-'));
  assert.equal(r.status, 0, r.stderr);
  const out = messages(r.stdout);
  assert.equal(out.length, 1, r.stdout);
  const msg = out[0].systemMessage;
  assert.match(msg, /^ADLC flail-detector did not run: /);
  assert.ok(msg.includes(join(planted, 'adlc')), msg);
  assert.match(msg, /node_modules/);
  assert.equal(out[0].hookSpecificOutput?.hookEventName, 'PostToolUse');
  assert.equal(out[0].hookSpecificOutput?.additionalContext, msg);
  assert.equal(existsSync(marker), false, 'the refused adlc ran');
});

test('the refusal is reported once per session, and again for a new session', (t) => {
  const planted = plantedAdlc(t, join(tmp(t, 'adlc-flail-marker-'), 'ran'));
  const { repo, transcript } = session(t);
  const state = tmp(t, 'adlc-flail-state-');
  assert.equal(messages(runFlail(repo, transcript, [planted], state).stdout).length, 1);
  assert.equal(runFlail(repo, transcript, [planted], state).stdout, '');
  const other = join(dirname(transcript), 'other.jsonl');
  writeFileSync(other, '{"type":"user"}\n');
  assert.equal(messages(runFlail(repo, other, [planted], state).stdout).length, 1);
});

test('with no adlc on PATH flail stays silent', (t) => {
  const { repo, transcript } = session(t);
  const r = runFlail(repo, transcript, [tmp(t, 'adlc-flail-empty-')], tmp(t, 'adlc-flail-state-'));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
});

test('when no private state dir can be made, the refusal is not reported', (t) => {
  const planted = plantedAdlc(t, join(tmp(t, 'adlc-flail-marker-'), 'ran'));
  const { repo, transcript } = session(t);
  const blocker = join(tmp(t, 'adlc-flail-state-'), 'not-a-dir');
  writeFileSync(blocker, '');
  const r = runFlail(repo, transcript, [planted], blocker);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
});

test('outside an ADLC repo flail stays silent even with a refused adlc', (t) => {
  const planted = plantedAdlc(t, join(tmp(t, 'adlc-flail-marker-'), 'ran'));
  const { transcript } = session(t);
  const r = runFlail(tmp(t, 'adlc-flail-plain-'), transcript, [planted], tmp(t, 'adlc-flail-state-'));
  assert.equal(r.stdout, '');
});
