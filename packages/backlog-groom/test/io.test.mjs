// io.test.mjs — the CLI's filesystem wiring.
//
// These branches used to live in the binary, where the only way to reach them
// was to spawn the process with a live `gh` behind it. A flipped guard — writing
// the cache only when there is NO cache — passed every suite.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { floorWidening } from '../lib/floor.mjs';

/** Capture a thrown error — assert.throws returns undefined, not the error. */
function thrownIo(fn) {
  try { fn(); } catch (err) { return err; }
  return null;
}
import { IMPLIED_SCHEMA_VERSION, baseFloorFromGit, resolveTrustedBaseRef, loadCache, loadLedger, saveLedger, acquireApplyLock, loadProfile, saveCache, serialiseJson } from '../lib/io.mjs';

test('a MISSING profile is not an error — the defaults are a complete profile', () => {
  const p = loadProfile('nope.json', { exists: () => false, readFile: () => { throw new Error('must not read'); } });
  assert.equal(p.schemaVersion, IMPLIED_SCHEMA_VERSION);
  assert.deepEqual(p.autonomyFloor, ['close'], 'and the implied profile is the conservative one');
});

test('the implied schema version is one this build supports', () => {
  // A default the parser would reject makes the tool unusable on exactly the
  // repos it is meant to work on out of the box.
  assert.equal(IMPLIED_SCHEMA_VERSION, 1);
  assert.doesNotThrow(() => loadProfile('x', { exists: () => false }));
});

test('a MALFORMED profile IS an error — that is a statement the operator got wrong', () => {
  assert.throws(() => loadProfile('p.json', { exists: () => true, readFile: () => '{ not json' }));
  const bad = loadProfileError('p.json', { exists: () => true, readFile: () => JSON.stringify({ schemaVersion: 1, nope: 1 }) });
  assert.equal(bad.isOpError, true);
});

function loadProfileError(path, io) {
  try {
    loadProfile(path, io);
  } catch (err) {
    return err;
  }
  return assert.fail('expected a throw');
}

test('a corrupt cache degrades to empty — a slow run, never a wrong answer', () => {
  assert.deepEqual(loadCache('c.json', { exists: () => true, readFile: () => 'not json' }), {});
});

test('an absent cache file is an empty cache, not an error', () => {
  assert.deepEqual(loadCache('c.json', { exists: () => false }), {});
});

test('a present cache is loaded', () => {
  const got = loadCache('c.json', { exists: () => true, readFile: () => JSON.stringify({ 1: { verdict: 'valid' } }) });
  assert.equal(got['1'].verdict, 'valid');
});

test('saveCache writes when there IS a cache, and does nothing when there is not', () => {
  const writes = [];
  assert.equal(saveCache('c.json', { a: 1 }, { write: (p, d) => writes.push([p, d]) }), null);
  assert.equal(writes.length, 1, 'a cache must be persisted');
  assert.equal(writes[0][0], 'c.json');

  const none = [];
  assert.equal(saveCache('c.json', null, { write: (p, d) => none.push([p, d]) }), null);
  assert.equal(none.length, 0, '--no-cache must not write a cache file');
});

test('an unwritable cache warns rather than failing a run that already has its answer', () => {
  const warning = saveCache('c.json', { a: 1 }, { write: () => { throw new Error('EROFS'); } });
  assert.match(warning, /EROFS/);
});

test('JSON artifacts are 2-space indented and newline-terminated, like the rest of the repo', () => {
  const out = serialiseJson({ a: { b: 1 } });
  assert.ok(out.endsWith('\n'));
  assert.match(out, /\n  "a"/, 'two spaces, so a diff of the cache or the emitted set reads like every other JSON here');
  assert.doesNotMatch(out, /\n {3}"a"/);
});

test('a valid JSON PRIMITIVE is not a cache — it degrades to empty rather than crashing later', () => {
  // Raised in cross-model review. `"bad"` and `7` parse cleanly and are truthy,
  // so a truthiness check passes them through and the first assignment throws —
  // killing a run that had a perfectly good answer to give.
  for (const raw of ['"bad"', '7', 'true', '"[]"', 'null', '[1,2]']) {
    assert.deepEqual(loadCache('c.json', { exists: () => true, readFile: () => raw }), {}, `${raw} must not be treated as a cache`);
  }
});

// ---- baseFloorFromGit — AC24's read side ------------------------------------

test('baseFloorFromGit returns the floor recorded at the merge base', () => {
  // The argv is asserted IN FULL, not by its first element: a dropped argument
  // would silently change which revision is read, and a fake that only inspects
  // args[0] would report success for a git call that asked a different question.
  const seen = [];
  const run = (args) => {
    seen.push(args);
    if (args[0] === 'merge-base') return 'deadbeef\n';
    if (args[0] === 'ls-tree') return '.claude/backlog-groom-profile.json\n';
    return JSON.stringify({ schemaVersion: 1, autonomyFloor: ['close', 'relabel'] });
  };
  assert.deepEqual(baseFloorFromGit('.claude/backlog-groom-profile.json', { run, baseRef: 'origin/main' }), ['close', 'relabel']);
  assert.deepEqual(seen[0], ['merge-base', 'HEAD', 'origin/main']);
  assert.deepEqual(seen[1], ['ls-tree', '--name-only', 'deadbeef', '--', '.claude/backlog-groom-profile.json']);
  assert.deepEqual(seen[2], ['show', 'deadbeef:.claude/backlog-groom-profile.json']);
});

test('baseFloorFromGit compares against the ref it was given', () => {
  const seen = [];
  const run = (args) => {
    seen.push(args);
    if (args[0] === 'merge-base') return 'cafe\n';
    if (args[0] === 'ls-tree') return 'p.json\n';
    return JSON.stringify({ schemaVersion: 1 });
  };
  baseFloorFromGit('p.json', { run, baseRef: 'upstream/trunk' });
  assert.deepEqual(seen[0], ['merge-base', 'HEAD', 'upstream/trunk']);
});

test('baseFloorFromGit returns the DEFAULT floor when the base profile omits the key', () => {
  // Omission at the base means the base floor was the conservative default, not
  // nothing — so a head that empties the floor is still a widening.
  const run = (args) => {
    if (args[0] === 'merge-base') return 'deadbeef\n';
    if (args[0] === 'ls-tree') return 'p.json\n';
    return JSON.stringify({ schemaVersion: 1 });
  };
  assert.deepEqual(baseFloorFromGit('p.json', { run }), ['close']);
});

test('baseFloorFromGit treats an ABSENT base profile as the default floor', () => {
  // Not null, and emphatically not []. Nothing was declared at the base, so the
  // default was in force — and because the default is the most conservative
  // floor, deleting the profile at the base still cannot widen anything. The
  // alternative, refusing, would make the tool unusable on any repo that has not
  // adopted a profile yet.
  const run = (args) => {
    if (args[0] === 'merge-base') return 'deadbeef\n';
    if (args[0] === 'ls-tree') return '';
    throw new Error('should not read a file that is not there');
  };
  assert.deepEqual(baseFloorFromGit('p.json', { run }), ['close']);
});

test('a git FAILURE is not read as an absent profile', () => {
  // `git show` fails the same way for "no such path" and for a corrupt object
  // store, and treating every failure as absence hands back the permissive
  // default floor exactly when the repository cannot be read.
  const run = (args) => {
    if (args[0] === 'merge-base') return 'deadbeef\n';
    throw new Error('fatal: not a git repository');
  };
  assert.equal(baseFloorFromGit('p.json', { run }), null);
});

test('an absent base profile still catches a head floor that widens on the default', () => {
  // The safety property that makes the choice above sound, asserted rather than
  // argued: emptying the floor is a widening even when the base declared nothing.
  const run = (args) => {
    if (args[0] === 'merge-base') return 'deadbeef\n';
    if (args[0] === 'ls-tree') return '';
    throw new Error('unreachable');
  };
  const base = baseFloorFromGit('p.json', { run });
  assert.deepEqual(floorWidening(base, []), ['close']);
});

test('baseFloorFromGit returns null when the base profile is PRESENT but unreadable', () => {
  // Distinct from absent: a file that exists may have declared a FULLER floor
  // than the default, so assuming the default would under-detect a widening.
  const run = (args) => {
    if (args[0] === 'merge-base') return 'deadbeef\n';
    if (args[0] === 'ls-tree') return 'p.json\n';
    return '{ not json';
  };
  assert.equal(baseFloorFromGit('p.json', { run }), null);
});

test('baseFloorFromGit returns null when the merge base cannot be resolved', () => {
  const run = () => { throw new Error('fatal: no merge base'); };
  assert.equal(baseFloorFromGit('p.json', { run }), null);
});

test('baseFloorFromGit returns null when the base profile has an unknown key', () => {
  // A base profile this build cannot parse is a base floor this build does not
  // know — the same unknown, reached a different way.
  const run = (args) => {
    if (args[0] === 'merge-base') return 'deadbeef\n';
    if (args[0] === 'ls-tree') return 'p.json\n';
    return JSON.stringify({ schemaVersion: 1, autonmyFloor: [] });
  };
  assert.equal(baseFloorFromGit('p.json', { run }), null);
});

// ---- the ledger fails closed where the cache fails soft ---------------------

test('an absent ledger is a legitimate first run', () => {
  assert.deepEqual(loadLedger('nope.json', { exists: () => false }), {});
});

test('a PRESENT but unreadable ledger is an operational error, not an empty one', () => {
  // The cache degrades to {} because a lost cache costs a slow run. A ledger
  // that degrades to {} degrades replay protection to nothing: delete the file
  // and the same revision can be reviewed until it approves.
  const err = thrownIo(() => loadLedger('l.json', { exists: () => true, readFile: () => '{ not json' }));
  assert.equal(err.isOpError, true);
  assert.match(err.message, /refusing to act/);
});

test('a ledger that is not an object is refused rather than treated as empty', () => {
  for (const raw of ['"x"', '7', '[]', 'null']) {
    const err = thrownIo(() => loadLedger('l.json', { exists: () => true, readFile: () => raw }));
    assert.equal(err.isOpError, true, `${raw} must be refused`);
  }
});

test('a good ledger loads', () => {
  assert.deepEqual(loadLedger('l.json', { exists: () => true, readFile: () => '{"7:h":{"verdict":"approve"}}' }), {
    '7:h': { verdict: 'approve' },
  });
});

test('a ledger that cannot be persisted is an operational error', () => {
  // Unlike the cache's warn-and-continue: a decision the next run will not see
  // is authorization nothing can later prove was spent.
  const err = thrownIo(() => saveLedger('l.json', {}, { write: () => { throw new Error('EACCES'); } }));
  assert.equal(err.isOpError, true);
  assert.match(err.message, /refusing to act/);
});

test('the apply lock is exclusive, and releasing is idempotent', () => {
  let made = 0;
  const release = acquireApplyLock('/tmp/x.lock', { mkdir: () => { made += 1; }, rmdir: () => {} });
  assert.equal(made, 1);
  release();
  release();
});

test('a held apply lock refuses the second run', () => {
  // Without it, two runs both read a ledger with no entry for a revision, both
  // obtain an approval, and both close the same issue.
  const err = thrownIo(() =>
    acquireApplyLock('/tmp/x.lock', { mkdir: () => { throw Object.assign(new Error('exists'), { code: 'EEXIST' }); } })
  );
  assert.equal(err.isOpError, true);
  assert.match(err.message, /another apply run/);
});

// ---- the trusted comparison ref, which the caller must NOT choose ----------

test('the trusted base ref is read from the repository', () => {
  const seen = [];
  const run = (args) => { seen.push(args); return 'origin/trunk\n'; };
  assert.equal(resolveTrustedBaseRef({ run }), 'origin/trunk');
  assert.deepEqual(seen[0], ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
    'the ref must be resolved from origin/HEAD, not guessed');
});

test('an empty symbolic-ref answer falls back to the conventional default', () => {
  // Returning the empty string would hand `git merge-base HEAD ''` an argument
  // it cannot resolve, and the floor check would then fail closed for a repo
  // that is perfectly fine.
  assert.equal(resolveTrustedBaseRef({ run: () => '\n' }), 'origin/main');
});

test('no origin/HEAD configured falls back to the conventional default', () => {
  assert.equal(resolveTrustedBaseRef({ run: () => { throw new Error('not a symbolic ref'); } }), 'origin/main');
});

test('baseFloorFromGit uses the resolved ref when given none', () => {
  // The important half: with no explicit ref the comparison still happens
  // against something the caller did not choose.
  const seen = [];
  const run = (args) => {
    seen.push(args);
    if (args[0] === 'symbolic-ref') return 'origin/trunk\n';
    if (args[0] === 'merge-base') return 'deadbeef\n';
    if (args[0] === 'ls-tree') return 'p.json\n';
    return JSON.stringify({ schemaVersion: 1, autonomyFloor: ['close'] });
  };
  baseFloorFromGit('p.json', { run });
  assert.deepEqual(seen[1], ['merge-base', 'HEAD', 'origin/trunk']);
});

test('a lock held by a LIVE process is refused', () => {
  const err = thrownIo(() =>
    acquireApplyLock('/tmp/x.lock', {
      mkdir: () => { throw Object.assign(new Error('exists'), { code: 'EEXIST' }); },
      read: () => JSON.stringify({ pid: 4242, startedAt: 'now' }),
      alive: () => true,
    })
  );
  assert.equal(err.isOpError, true);
  assert.match(err.message, /4242/);
});

test('a lock left by a DEAD process is recovered rather than blocking forever', () => {
  // A run killed mid-write leaves a lock nobody can safely clear by hand: doing
  // so might race a writer that is still going. Owner metadata makes the
  // distinction decidable.
  let mkdirCalls = 0;
  let removed = false;
  const release = acquireApplyLock('/tmp/x.lock', {
    mkdir: () => { mkdirCalls += 1; if (mkdirCalls === 1) throw Object.assign(new Error('exists'), { code: 'EEXIST' }); },
    read: () => JSON.stringify({ pid: 4242, startedAt: 'then' }),
    alive: () => false,
    rename: () => {},
    rmdir: () => { removed = true; },
    write: () => {},
  });
  assert.equal(removed, true, 'the stale lock must be cleared');
  assert.equal(mkdirCalls, 2, 'and retaken');
  release();
});

test('an UNREADABLE owner is treated as live, not as dead', () => {
  // Guessing "dead" on a lock we cannot read would let two writers run, which is
  // the failure the lock exists to prevent — worse than a stuck lock.
  const err = thrownIo(() =>
    acquireApplyLock('/tmp/x.lock', {
      mkdir: () => { throw Object.assign(new Error('exists'), { code: 'EEXIST' }); },
      read: () => { throw new Error('ENOENT'); },
      alive: () => false,
    })
  );
  assert.equal(err.isOpError, true);
});

test('losing the race to recover a stale lock refuses rather than proceeding', () => {
  const err = thrownIo(() =>
    acquireApplyLock('/tmp/x.lock', {
      mkdir: () => { throw Object.assign(new Error('exists'), { code: 'EEXIST' }); },
      read: () => JSON.stringify({ pid: 4242 }),
      alive: () => false,
      rename: () => {},
      rmdir: () => {},
    })
  );
  assert.equal(err.isOpError, true);
  assert.match(err.message, /another run took it first/);
});

test('the lock records its owner so a later run can decide', () => {
  const written = [];
  const release = acquireApplyLock('/tmp/x.lock', {
    mkdir: () => {},
    write: (p, body) => written.push([p, JSON.parse(body)]),
    rmdir: () => {},
    pid: 99,
  });
  assert.match(written[0][0], /owner\.json$/);
  assert.equal(written[0][1].pid, 99);
  release();
});

test('two recoverers of one stale lock cannot both win', () => {
  // rmdir-then-mkdir interleaves: A removes and recreates, B removes A's NEW
  // lock and recreates it, and both proceed to mutate GitHub. The claim is an
  // atomic rename, so exactly one wins and the loser refuses.
  let renames = 0;
  const attempt = () =>
    acquireApplyLock('/tmp/x.lock', {
      mkdir: () => { throw Object.assign(new Error('exists'), { code: 'EEXIST' }); },
      read: () => JSON.stringify({ pid: 4242 }),
      alive: () => false,
      rename: () => { renames += 1; if (renames > 1) throw Object.assign(new Error('gone'), { code: 'ENOENT' }); },
      rmdir: () => {},
    });
  // First recoverer claims the stale dir, then fails to retake (mkdir still
  // throws in this fake) — but it got the claim.
  assert.ok(thrownIo(attempt));
  // Second recoverer loses the rename and says so, rather than clearing the
  // winner's lock.
  const err = thrownIo(attempt);
  assert.equal(err.isOpError, true);
  assert.match(err.message, /recovered the stale lock.*first/);
});

test('an owner-less lock is live until the TTL, then presumed abandoned', () => {
  // A process killed between mkdir and writing its metadata leaves a lock with
  // nothing to prove it is dead. Permanent is the wrong answer; so is instantly
  // stealable.
  const fresh = thrownIo(() =>
    acquireApplyLock('/tmp/x.lock', {
      mkdir: () => { throw Object.assign(new Error('exists'), { code: 'EEXIST' }); },
      read: () => { throw new Error('ENOENT'); },
      stat: () => ({ mtimeMs: Date.now() - 1000 }),
    })
  );
  assert.equal(fresh.isOpError, true, 'a recent owner-less lock is still respected');

  let made = 0;
  const release = acquireApplyLock('/tmp/x.lock', {
    mkdir: () => { made += 1; if (made === 1) throw Object.assign(new Error('exists'), { code: 'EEXIST' }); },
    read: () => { throw new Error('ENOENT'); },
    stat: () => ({ mtimeMs: Date.now() - (2 * 60 * 60 * 1000) }),
    rename: () => {},
    rmdir: () => {},
    write: () => {},
  });
  assert.equal(made, 2, 'an expired owner-less lock is recovered');
  release();
});

test('an owner-less lock whose age cannot be read stays live', () => {
  const err = thrownIo(() =>
    acquireApplyLock('/tmp/x.lock', {
      mkdir: () => { throw Object.assign(new Error('exists'), { code: 'EEXIST' }); },
      read: () => { throw new Error('ENOENT'); },
      stat: () => { throw new Error('ENOENT'); },
    })
  );
  assert.equal(err.isOpError, true);
});
