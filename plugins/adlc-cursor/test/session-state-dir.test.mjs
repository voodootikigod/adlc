// session-state-dir.test.mjs — where user-scoped Cursor state is allowed to live.
//
// `.adlc/` is the marker meaning "this directory is an ADLC repo". Keeping this
// plugin's session state in `~/.adlc` therefore made $HOME read as a repo to
// every ancestor walk, capturing unrelated projects below it. Host-specific
// state belongs in the host's own namespace (the convention @adlc/gemini
// follows with ~/.gemini/antigravity-cli), so it lives in ~/.cursor/adlc.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveStateDir } from '../lib/session-state.mjs';

test('defaults to the Cursor host namespace, not ~/.adlc', () => {
  const dir = resolveStateDir({});
  assert.equal(dir, join(homedir(), '.cursor', 'adlc'));
});

test('never resolves inside ~/.adlc, for any home', () => {
  for (const home of ['/Users/someone', '/home/someone', '/tmp/fake-home']) {
    const dir = resolveStateDir({ HOME: home });
    // `homedir()` reads $HOME on POSIX, so this exercises the real resolution.
    assert.ok(
      !dir.startsWith(join(homedir(), '.adlc')),
      `state dir must never sit under ~/.adlc (got ${dir})`,
    );
  }
});

test('an explicit ADLC_CURSOR_STATE_DIR still wins', () => {
  assert.equal(resolveStateDir({ ADLC_CURSOR_STATE_DIR: '/tmp/custom-state' }), '/tmp/custom-state');
  assert.equal(resolveStateDir({ ADLC_CURSOR_STATE_DIR: '  /tmp/trimmed  ' }), '/tmp/trimmed');
});

test('a blank override falls back to the default rather than to cwd', () => {
  for (const blank of ['', '   ']) {
    assert.equal(resolveStateDir({ ADLC_CURSOR_STATE_DIR: blank }), join(homedir(), '.cursor', 'adlc'));
  }
});
