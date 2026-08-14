// continue-race.test.mjs — the marker re-check taken immediately after the
// denier's lock, driven end to end through the real CLI.
//
// MECHANISM. `continue` gathers git state for the brief BEFORE it takes the
// lock, so a `git` earlier on PATH runs in exactly the window between the
// marker read that preflights the run and the re-check under the lock. That
// makes a lock-bypassing writer deterministic rather than a sleep race: the
// stand-in rewrites the deny marker and the CLI meets a record it never
// preflighted on. Without the re-check the run rebinds straight over that
// writer's record and consumes the deny anyway.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  KEYED,
  contentPathFor,
  denyPathFor,
  manifestEntries,
  readJson,
  resumeAuthFiles,
  run,
  seedBoundDeny,
  withTempRepo,
} from './continue-cli-support.mjs';

/**
 * Put a `git` on PATH that rewrites the deny marker, then answers like git.
 * Idempotent: the CLI calls it more than once per run.
 */
function plantLockBypassingWriter(cwd, session, record) {
  const binDir = join(cwd, 'fake-bin');
  mkdirSync(binDir, { recursive: true });
  const script = join(binDir, 'git');
  writeFileSync(
    script,
    [
      '#!/bin/sh',
      `cat > "$(dirname "$0")/../.adlc/handoffs/denies/${session}.json" <<'MARKER'`,
      JSON.stringify(record, null, 2),
      'MARKER',
      'exit 0',
      '',
    ].join('\n'),
    'utf8',
  );
  chmodSync(script, 0o755);
  return binDir;
}

test('a writer that bypasses the lock is not clobbered by the continuation', () => {
  withTempRepo((cwd) => {
    seedBoundDeny(cwd, 'denier-race', 'T155');
    const before = readJson(denyPathFor(cwd, 'denier-race'));
    // Still open, still the same ticket — only the bind moved, which is exactly
    // the change a `handoff repair` from another host would have made.
    const moved = { ...before, content_hash: 'e'.repeat(64), host: 'someone-else' };
    const binDir = plantLockBypassingWriter(cwd, 'denier-race', moved);

    const r = run(
      ['continue', '--deny-session', 'denier-race', '--session', 'successor-race', '--write', '--json'],
      { cwd, env: { ...KEYED, PATH: `${binDir}:${process.env.PATH}` }, expectOk: false },
    );
    assert.equal(r.code, 2);
    assert.match(r.stderr, /changed under this command/);

    // The other writer's record stands, and this run left nothing behind.
    assert.deepEqual(readJson(denyPathFor(cwd, 'denier-race')), moved);
    assert.equal(existsSync(contentPathFor(cwd, 'denier-race')), false);
    assert.deepEqual(resumeAuthFiles(cwd), []);
    assert.equal(manifestEntries(cwd, 'context-handoff-continue').length, 0);
  });
});

test('the PATH stand-in only fires when the CLI actually shells out to git', () => {
  // The control for the test above: the same stand-in, no continuation running,
  // proves the mechanism is the CLI's git call and not something ambient.
  withTempRepo((cwd) => {
    seedBoundDeny(cwd, 'denier-control', 'T155');
    const before = readJson(denyPathFor(cwd, 'denier-control'));
    plantLockBypassingWriter(cwd, 'denier-control', { ...before, content_hash: 'f'.repeat(64) });
    assert.deepEqual(readJson(denyPathFor(cwd, 'denier-control')), before);

    // …and with the stand-in absent, the same command completes normally.
    const ok = run(
      ['continue', '--deny-session', 'denier-control', '--session', 'successor-control', '--write', '--json'],
      { cwd, env: KEYED },
    );
    assert.equal(ok.code, 0);
    assert.equal(readJson(denyPathFor(cwd, 'denier-control')).status, 'consumed');
    assert.equal(
      readFileSync(JSON.parse(ok.stdout).content_path, 'utf8').length > 0,
      true,
      'the happy path still writes a capture',
    );
  });
});
