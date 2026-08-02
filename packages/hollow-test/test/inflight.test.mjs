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
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, symlinkSync, existsSync, readdirSync, statSync, chmodSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import {
  probeOwner, isWellFormed, decideRecovery, isContainedRelPath, resolveTarget,
  writeFileAtomic, writeRecord, readRecord, clearRecord, RECORD_VERSION,
  makeTempPath, ownerStateFor, sweepStaleTemps,
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

test('a record carrying OUR OWN pid is a corpse, not a live owner', () => {
  // Recovery runs before this process writes any record, so a record with our pid
  // is one the OS reused. Probing it would say 'alive' (we are), and the stranded
  // mutant plus the dirty-tree refusal would then be permanent.
  let probed = false;
  assert.equal(ownerStateFor(4242, 4242, () => { probed = true; return 'alive'; }), 'dead');
  assert.equal(probed, false, 'probed a pid it already knows is ours');
});

test('any other pid is delegated to the probe unchanged', () => {
  assert.equal(ownerStateFor(999, 4242, () => 'alive'), 'alive');
  assert.equal(ownerStateFor(999, 4242, () => 'dead'), 'dead');
  assert.equal(ownerStateFor(999, 4242, () => 'unknown'), 'unknown');
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

test('resolveTarget follows symlinks but keeps the write inside the repo', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hollow-target-'));
  const outside = mkdtempSync(join(tmpdir(), 'hollow-elsewhere-'));
  try {
    mkdirSync(join(dir, 'src'));
    mkdirSync(join(dir, 'versions'));
    writeFileSync(join(dir, 'src', 'thing.mjs'), 'x');
    // realpath both sides: on macOS a temp dir is itself reached through a symlink.
    assert.equal(resolveTarget(dir, 'src/thing.mjs'), realpathSync(join(dir, 'src', 'thing.mjs')));

    // An IN-REPO symlink resolves to its target and is accepted — the mutation
    // path writes through links, so recovery has to recognise them or an
    // interrupted run on a symlinked source could never be recovered.
    const real = join(dir, 'versions', 'impl.mjs');
    writeFileSync(real, 'y');
    symlinkSync(real, join(dir, 'src', 'alias.mjs'));
    assert.equal(resolveTarget(dir, 'src/alias.mjs'), realpathSync(real));

    // A link that LEAVES the repository is still refused: containment is checked
    // on the resolved path, which is the one that actually gets written.
    const victim = join(outside, 'victim.mjs');
    writeFileSync(victim, 'do not touch');
    symlinkSync(victim, join(dir, 'src', 'escape.mjs'));
    assert.equal(resolveTarget(dir, 'src/escape.mjs'), null);

    // An intermediate symlinked DIRECTORY cannot smuggle it out either.
    symlinkSync(outside, join(dir, 'outdir'));
    assert.equal(resolveTarget(dir, 'outdir/victim.mjs'), null);

    // Lexical escapes and absolutes stay refused.
    assert.equal(resolveTarget(dir, '../escape.mjs'), null);
    assert.equal(resolveTarget(dir, '/etc/passwd'), null);

    // Nothing there, or a dangling link: nothing safe to restore.
    assert.equal(resolveTarget(dir, 'src/missing.mjs'), null);
    symlinkSync(join(dir, 'src', 'nope.mjs'), join(dir, 'src', 'dangling.mjs'));
    assert.equal(resolveTarget(dir, 'src/dangling.mjs'), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

// ── durability ───────────────────────────────────────────────────────────────

test('writeFileAtomic replaces content atomically and leaves no temp file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hollow-durable-'));
  try {
    const target = join(dir, 'record.json');
    writeFileAtomic(target, 'first');
    assert.equal(readFileSync(target, 'utf8'), 'first');
    writeFileAtomic(target, 'second');
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

test('an atomic write preserves the file mode it replaced', () => {
  // rename installs a NEW inode. Without carrying the mode across, restoring a
  // tracked executable would turn 0755 into 0644 and break whatever runs it.
  const dir = mkdtempSync(join(tmpdir(), 'hollow-mode-'));
  try {
    const target = join(dir, 'tool.mjs');
    writeFileSync(target, 'original');
    chmodSync(target, 0o755);

    writeFileAtomic(target, 'restored');

    assert.equal(readFileSync(target, 'utf8'), 'restored');
    assert.equal(statSync(target).mode & 0o777, 0o755, 'restore dropped the executable bit');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the temp path is unpredictable, so it cannot be pre-empted', () => {
  // A deterministic `<target>.tmp-<pid>` is a name an attacker can create FIRST,
  // turning the durable write into a write through their symlink.
  const a = makeTempPath('/repo/src/thing.mjs');
  const b = makeTempPath('/repo/src/thing.mjs');
  assert.notEqual(a, b);
  assert.match(a, /^\/repo\/src\/thing\.mjs\.tmp-\d+-[0-9a-f]{16}$/);
});

test('an atomic write refuses a pre-existing temp path instead of following it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hollow-tmpsym-'));
  const outside = mkdtempSync(join(tmpdir(), 'hollow-victim-'));
  try {
    const target = join(dir, 'thing.mjs');
    writeFileSync(target, 'original');
    const victim = join(outside, 'victim.txt');
    writeFileSync(victim, 'DO NOT TOUCH');

    // Booby-trap the exact temp path with a symlink pointing outside the repo.
    const trap = join(dir, 'thing.mjs.trap');
    symlinkSync(victim, trap);

    assert.throws(
      () => writeFileAtomic(target, 'restored', { tempPath: trap }),
      /EEXIST/,
      'followed a planted symlink instead of refusing it',
    );
    assert.equal(readFileSync(victim, 'utf8'), 'DO NOT TOUCH', 'wrote through the symlink');
    assert.equal(readFileSync(target, 'utf8'), 'original', 'target was replaced by the symlink');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('an atomic write REPLACES WHAT A SYMLINK POINTS AT, and leaves the link intact', () => {
  // rename replaces an inode, so renaming over a symlink would destroy the link and
  // leave a regular file — a permanent workspace change on a SUCCESSFUL run, to a
  // file the tool only meant to mutate temporarily. The in-place write this
  // replaced followed the link, so atomicity must not be bought by breaking it.
  const dir = mkdtempSync(join(tmpdir(), 'hollow-symlink-'));
  try {
    mkdirSync(join(dir, 'versions'));
    const real = join(dir, 'versions', 'impl.mjs');
    const link = join(dir, 'current.mjs');
    writeFileSync(real, 'original');
    symlinkSync(real, link);

    writeFileAtomic(link, 'mutated');

    assert.equal(lstatSync(link).isSymbolicLink(), true, 'the atomic write destroyed the symlink');
    assert.equal(readFileSync(real, 'utf8'), 'mutated', 'wrote somewhere other than the link target');
    assert.equal(readFileSync(link, 'utf8'), 'mutated');

    // And back again, as the per-trial restore does.
    writeFileAtomic(link, 'original');
    assert.equal(lstatSync(link).isSymbolicLink(), true);
    assert.equal(readFileSync(real, 'utf8'), 'original');

    assert.deepEqual(
      readdirSync(dir).filter((e) => e.includes('.tmp-')), [],
      'left a temp beside the link',
    );
    assert.deepEqual(
      readdirSync(join(dir, 'versions')).filter((e) => e.includes('.tmp-')), [],
      'left a temp beside the resolved target',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed atomic write leaves no temp file behind to wedge the next run', () => {
  // An orphaned *.tmp-* is untracked, and hollow-test refuses to run on a dirty
  // tree, so litter from a failed write would block the NEXT run entirely.
  //
  // The failure is injected AFTER the temp file exists. An earlier version of this
  // test used a nonexistent parent directory, which made openSync fail before any
  // temp was created — so deleting the cleanup code would not have failed it.
  const dir = mkdtempSync(join(tmpdir(), 'hollow-litter-'));
  try {
    const target = join(dir, 'thing.mjs');
    writeFileSync(target, 'original');

    // A Symbol cannot be written, so writeFileSync throws once the temp is open.
    assert.throws(() => writeFileAtomic(target, Symbol('unwritable')));

    assert.deepEqual(
      readdirSync(dir).filter((e) => e.includes('.tmp-')), [],
      'a failed write left its temp file behind',
    );
    assert.equal(readFileSync(target, 'utf8'), 'original', 'target was damaged by the failed write');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stale temps from a DEAD run are swept, and a live run\'s are left alone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hollow-sweep-'));
  try {
    const target = join(dir, 'thing.mjs');
    writeFileSync(target, 'original');
    writeFileSync(`${target}.tmp-4242-abc`, 'orphan from a killed run');
    writeFileSync(`${target}.tmp-9999-def`, 'a live run is mid-write');

    const swept = sweepStaleTemps(target, { probe: (pid) => (pid === 4242 ? 'dead' : 'alive') });

    assert.equal(swept, 1);
    assert.equal(existsSync(`${target}.tmp-4242-abc`), false, 'dead run\'s orphan was not swept');
    assert.equal(existsSync(`${target}.tmp-9999-def`), true, 'pulled a temp out from under a LIVE run');
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
