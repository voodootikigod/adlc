// Unit tests for the in-flight record's decisions.
//
// These exist because the properties that matter are invisible to an integration
// test: "signal 0, never anything else" cannot be observed by watching a real
// process (a killed CHILD of the test process becomes a zombie and keeps
// answering kill(pid, 0) until reaped, so a probe that really delivered SIGHUP
// still looks harmless), EPERM needs a process owned by another user, and the
// recovery decision spans states that are painful to stage with real crashes.
//
// They are also cheap, which matters: the mutation gate re-runs this package's
// tests once per mutant, so pinning behaviour here rather than with another
// spawned run is what keeps that gate affordable.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, symlinkSync, existsSync, readdirSync, statSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  probeOwner, isWellFormed, decideRecovery, isContainedRelPath, resolveTarget,
  writeFileDurable, writeRecord, readRecord, clearRecord, RECORD_VERSION,
} from '../lib/inflight.mjs';

function killError(code) {
  const err = new Error(code);
  err.code = code;
  return err;
}

const record = (over = {}) => ({
  version: RECORD_VERSION,
  pid: 4242,
  file: 'src/thing.mjs',
  original: 'ORIGINAL',
  mutated: 'MUTANT',
  ...over,
});

// ── probeOwner ───────────────────────────────────────────────────────────────

test('probes with signal 0, which delivers nothing', () => {
  const calls = [];
  probeOwner(4242, (pid, signal) => { calls.push({ pid, signal }); });

  assert.deepEqual(calls, [{ pid: 4242, signal: 0 }]);
  // Any other signal number is DELIVERED. 1 is SIGHUP, which would terminate the
  // concurrent run this probe exists to protect.
  assert.notEqual(calls[0].signal, 1);
});

test('a pid that can be signalled is alive', () => {
  assert.equal(probeOwner(4242, () => {}), 'alive');
});

test('ESRCH is the only definite death', () => {
  assert.equal(probeOwner(4242, () => { throw killError('ESRCH'); }), 'dead');
});

test('EPERM means it exists but is not ours — alive, do not touch its file', () => {
  assert.equal(probeOwner(4242, () => { throw killError('EPERM'); }), 'alive');
});

test('an unrecognised probe failure is UNKNOWN, never dead', () => {
  // The distinction is the whole point: only definite death authorises
  // overwriting a file, so an odd platform error must not green-light recovery.
  assert.equal(probeOwner(4242, () => { throw killError('EINVAL'); }), 'unknown');
});

test('the lowest legitimate pid is still probed', () => {
  // The guard rejects pid <= 0. Off by one and pid 1 — init, and a perfectly
  // real owner inside a container — would be dismissed as unknown, silently
  // disabling recovery there.
  let seen = null;
  assert.equal(probeOwner(1, (pid) => { seen = pid; }), 'alive');
  assert.equal(seen, 1);
});

test('a malformed pid is unknown rather than probed', () => {
  for (const bad of [0, -1, 1.5, '4242', null, undefined, NaN]) {
    let probed = false;
    assert.equal(probeOwner(bad, () => { probed = true; }), 'unknown', `pid ${String(bad)}`);
    assert.equal(probed, false, `pid ${String(bad)} should never reach kill()`);
  }
});

// ── decideRecovery ───────────────────────────────────────────────────────────

test('restores only when the file is byte-identical to the recorded mutant', () => {
  assert.deepEqual(
    decideRecovery({ ownerState: 'dead', currentContent: 'MUTANT', record: record() }),
    { action: 'restore', reason: null },
  );
});

test('a file that matches neither original nor mutant is a CONFLICT, never a restore', () => {
  // The data-loss case: the run died, then the developer edited that file. Writing
  // `original` over their work would be the same loss this feature prevents,
  // pointed the other way.
  const decision = decideRecovery({
    ownerState: 'dead',
    currentContent: 'THE DEVELOPER FIXED THIS BY HAND',
    record: record(),
  });
  assert.equal(decision.action, 'conflict');
  assert.ok(decision.reason);
});

test('a file already back at the original leaves nothing to do', () => {
  assert.equal(
    decideRecovery({ ownerState: 'dead', currentContent: 'ORIGINAL', record: record() }).action,
    'none',
  );
});

test('a live or unknown owner is never recovered from, whatever the bytes say', () => {
  for (const ownerState of ['alive', 'unknown']) {
    assert.equal(
      decideRecovery({ ownerState, currentContent: 'MUTANT', record: record() }).action,
      'skip',
      ownerState,
    );
  }
});

// ── record validation ────────────────────────────────────────────────────────

test('only a complete, current-version record is well formed', () => {
  assert.equal(isWellFormed(record()), true);
  assert.equal(isWellFormed({ ...record(), version: 1 }), false, 'old version');
  assert.equal(isWellFormed({ ...record(), mutated: undefined }), false, 'pre-mutant-bytes record');
  assert.equal(isWellFormed({ ...record(), file: '' }), false, 'empty path');
  assert.equal(isWellFormed({ ...record(), original: 5 }), false, 'non-string bytes');
  assert.equal(isWellFormed(null), false);
  assert.equal(isWellFormed('nope'), false);
});

// ── containment ──────────────────────────────────────────────────────────────

test('rejects any path that is absolute or climbs out of the repo', () => {
  assert.equal(isContainedRelPath('src/thing.mjs'), true);
  assert.equal(isContainedRelPath('/etc/passwd'), false);
  assert.equal(isContainedRelPath('../outside.mjs'), false);
  assert.equal(isContainedRelPath('src/../../outside.mjs'), false);
  assert.equal(isContainedRelPath(''), false);
  assert.equal(isContainedRelPath(null), false);
});

test('resolveTarget refuses to hand back a path outside the repo or via a symlink', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hollow-target-'));
  try {
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'thing.mjs'), 'x');
    assert.equal(resolveTarget(dir, 'src/thing.mjs'), join(dir, 'src', 'thing.mjs'));

    // Escapes the repo.
    assert.equal(resolveTarget(dir, '../escape.mjs'), null);
    assert.equal(resolveTarget(dir, '/etc/passwd'), null);

    // A symlink at an in-repo path turns a contained write into an arbitrary one.
    const outside = join(dir, 'outside.txt');
    writeFileSync(outside, 'do not touch');
    symlinkSync(outside, join(dir, 'src', 'link.mjs'));
    assert.equal(resolveTarget(dir, 'src/link.mjs'), null);

    // Nothing there to restore.
    assert.equal(resolveTarget(dir, 'src/missing.mjs'), null);

    // An INTERMEDIATE symlink escapes just as effectively as a symlinked leaf,
    // and lstat on the leaf still reports an ordinary file — so containment has
    // to be checked against real paths, not the lexical ones.
    const elsewhere = mkdtempSync(join(tmpdir(), 'hollow-elsewhere-'));
    try {
      writeFileSync(join(elsewhere, 'victim.mjs'), 'do not touch');
      symlinkSync(elsewhere, join(dir, 'escape'));
      assert.equal(
        resolveTarget(dir, 'escape/victim.mjs'), null,
        'a symlinked PARENT directory escaped containment',
      );
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── durability ───────────────────────────────────────────────────────────────

test('writeFileDurable replaces content atomically and leaves no temp file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hollow-durable-'));
  try {
    const target = join(dir, 'record.json');
    writeFileDurable(target, 'first');
    assert.equal(readFileSync(target, 'utf8'), 'first');
    writeFileDurable(target, 'second');
    assert.equal(readFileSync(target, 'utf8'), 'second');
    assert.deepEqual(
      readdirSync(dir).filter((e) => e.includes('.tmp-')),
      [],
      'a temp file survived the write',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a durable write preserves the file mode it replaced', () => {
  // rename installs a NEW inode. Without carrying the mode across, restoring a
  // tracked executable would turn 0755 into 0644 and break whatever runs it.
  const dir = mkdtempSync(join(tmpdir(), 'hollow-mode-'));
  try {
    const target = join(dir, 'tool.mjs');
    writeFileSync(target, 'original');
    chmodSync(target, 0o755);

    writeFileDurable(target, 'restored');

    assert.equal(readFileSync(target, 'utf8'), 'restored');
    assert.equal(statSync(target).mode & 0o777, 0o755, 'restore dropped the executable bit');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeRecord THROWS rather than silently leaving a mutation unprotected', () => {
  // A swallowed failure here means the file gets mutated with no way back — the
  // exact SIGKILL case the record exists for, quietly unguarded.
  assert.throws(() => writeRecord(join('/definitely/not/a/dir', 'r.json'), {
    pid: 1, relFile: 'a.mjs', original: 'o', mutated: 'm',
  }));
});

test('a record round-trips, and an unreadable one reads as absent rather than as an instruction', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hollow-rt-'));
  try {
    const path = join(dir, 'record.json');
    writeRecord(path, { pid: 7, relFile: 'src/a.mjs', original: 'o', mutated: 'm' });
    const parsed = readRecord(path);
    assert.equal(parsed.version, RECORD_VERSION);
    // Pinned as a LITERAL as well: RECORD_VERSION alone would move with the code,
    // and this is an on-disk format that older and newer runs must agree on.
    assert.equal(parsed.version, 2, 'bumping the record format needs a deliberate migration');
    assert.equal(parsed.file, 'src/a.mjs');
    assert.equal(parsed.mutated, 'm');

    writeFileSync(path, '{ not json');
    assert.equal(readRecord(path), null);

    clearRecord(path);
    assert.equal(existsSync(path), false);
    clearRecord(path); // idempotent
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
