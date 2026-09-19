// remote-base.test.mjs — the floor's baseline must come from the REMOTE (#1036).
//
// The floor is compared against the profile at the merge base, so a caller
// cannot widen it locally and act on it. That only holds if the caller does not
// choose the comparison point. `--base-ref` was removed for exactly this reason
// — passing HEAD made the merge base the working copy, so a widened floor
// compared equal to itself — but the replacement read `refs/remotes/origin/HEAD`
// and `origin/main`, which are ordinary LOCAL refs:
//
//     git update-ref refs/remotes/origin/main HEAD
//
// reproduces the removed flag with no flag. These tests pin that the baseline is
// resolved from the remote, and that every way of failing to reach it REFUSES
// rather than falling back to a local ref.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveRemoteBaseSha, baseProfileFromGit, childRunOpts } from '../lib/io.mjs';

const REMOTE_HEAD = 'f'.repeat(40);
const MERGE_BASE = 'e'.repeat(40);
const PROFILE = '.claude/backlog-groom-profile.json';

/**
 * Scripted git.
 *
 * Every call is recorded, so a test can assert on the call that did NOT happen —
 * which is the whole point for the local refs this must no longer consult.
 */
function seams({
  lsRemote = `ref: refs/heads/main\tHEAD\n${REMOTE_HEAD}\tHEAD\n`,
  mergeBase = MERGE_BASE,
  isAncestor = true,
  profileAtBase = '{"schemaVersion":1,"autonomyFloor":["close"]}',
  // A stale clone: the remote's head is not in the local object database until
  // it is fetched. `shaPresent` is what `cat-file -e` reports, and it flips to
  // true once a fetch succeeds — the sequence a real clone goes through.
  shaPresent = true,
  fetchWorks = true,
} = {}) {
  const calls = [];
  let present = shaPresent;
  const run = (args) => {
    calls.push(['git', ...args].join(' '));
    const [cmd] = args;
    if (cmd === 'ls-remote') {
      if (lsRemote === null) throw new Error('fatal: could not read from remote');
      return lsRemote;
    }
    if (cmd === 'cat-file') {
      if (!present) throw new Error('fatal: Not a valid object name');
      return '';
    }
    if (cmd === 'fetch') {
      if (!fetchWorks) throw new Error('fatal: could not fetch');
      present = true;
      return '';
    }
    if (cmd === 'merge-base') {
      // `--is-ancestor` is the reachability check; it exits non-zero (throws here)
      // when the base is not reachable from the remote head.
      if (args.includes('--is-ancestor')) {
        if (!isAncestor) throw new Error('not an ancestor');
        return '';
      }
      if (mergeBase === null) throw new Error('fatal: no merge base');
      return mergeBase;
    }
    if (cmd === 'ls-tree') return profileAtBase === null ? '' : PROFILE;
    if (cmd === 'show') return profileAtBase;
    throw new Error(`unexpected git call: ${args.join(' ')}`);
  };
  return { run, calls };
}

test('AC7: the baseline sha comes from the remote, not from a local ref', () => {
  const { run, calls } = seams();

  assert.equal(resolveRemoteBaseSha({ run }), REMOTE_HEAD);
  // The local refs that used to decide this must not be consulted at all: reading
  // them is what made `git update-ref` sufficient to move the baseline.
  assert.ok(!calls.some((c) => c.includes('symbolic-ref')), `local symbolic-ref consulted: ${JSON.stringify(calls)}`);
  assert.ok(!calls.some((c) => /refs\/remotes/.test(c)), `local remote-tracking ref consulted: ${JSON.stringify(calls)}`);
  assert.ok(calls.some((c) => c.startsWith('git ls-remote')), 'the remote must be asked');
});

test('the default branch and its head come from the SAME remote, in one question', () => {
  // An earlier version asked the forge for the branch name and then resolved it
  // against origin, which could not bind the two: `gh` answers from whatever host
  // it is configured for, so an SSH alias, an enterprise remote or a filesystem
  // remote could have its branch name chosen by a different forge holding a
  // same-named repository.
  const { run, calls } = seams();
  resolveRemoteBaseSha({ run });

  assert.ok(
    calls.includes('git ls-remote --symref origin HEAD'),
    `the remote must be asked for its own HEAD: ${JSON.stringify(calls)}`
  );
  assert.ok(!calls.some((c) => c.startsWith('gh ')), 'no forge API stands between the branch and its sha');
});

test('AC7: a moved local ref cannot change the baseline the profile is read at', () => {
  // The attack: origin/main pointed at HEAD locally. With the remote as the
  // anchor, the profile is still read at the REMOTE-derived merge base.
  const { run } = seams();
  const profile = baseProfileFromGit(PROFILE, { run });

  assert.deepEqual(profile?.autonomyFloor, ['close'], 'the base floor must be the one committed on the remote');
});

test('AC8: every remote-resolution failure refuses rather than falling back', () => {
  const cases = [
    ['no origin / unreachable remote', { lsRemote: null }],
    ['the remote answered with nothing', { lsRemote: '' }],
    ['the remote answered with no sha line', { lsRemote: 'ref: refs/heads/main\tHEAD\n' }],
    ['a malformed sha', { lsRemote: 'not-a-sha\tHEAD\n' }],
    ['a short sha', { lsRemote: `${'a'.repeat(39)}\tHEAD\n` }],
    ['no merge base with the remote head', { mergeBase: null }],
    ['the merge base is not reachable from the remote head', { isAncestor: false }],
  ];

  for (const [name, opts] of cases) {
    const { run } = seams(opts);
    assert.equal(baseProfileFromGit(PROFILE, { run }), null, `${name}: must refuse, not fall back`);
  }
});

test('the sha is taken from the HEAD line, not from whichever line came first', () => {
  // git may emit several lines, the symref one first and other refs after.
  // Indexing by position would read a branch name as a commit, or another ref's
  // tip as the baseline.
  const { run } = seams({
    lsRemote: `ref: refs/heads/trunk\tHEAD\n${REMOTE_HEAD}\tHEAD\n${'b'.repeat(40)}\trefs/heads/other\n`,
  });
  assert.equal(resolveRemoteBaseSha({ run }), REMOTE_HEAD);
});

test('a stale clone fetches the remote head rather than refusing', () => {
  // ls-remote answers with where HEAD points NOW, which a clone that has not
  // fetched recently has never seen. Refusing there would block every apply on an
  // ordinary working copy — a refusal nobody can act on is not a safety property.
  const { run, calls } = seams({ shaPresent: false });

  assert.equal(resolveRemoteBaseSha({ run }), REMOTE_HEAD);
  assert.ok(calls.some((c) => c.startsWith('git fetch')), `the missing commit must be fetched: ${JSON.stringify(calls)}`);
  assert.ok(!calls.some((c) => c.includes('update-ref')), 'the baseline must not write a local ref');
});

test('a commit that cannot be fetched refuses rather than guessing a baseline', () => {
  const { run } = seams({ shaPresent: false, fetchWorks: false });
  assert.equal(resolveRemoteBaseSha({ run }), null);
});

test('a fetched-but-still-absent commit refuses', () => {
  // The fetch reported success and the object is still not there: something is
  // wrong with the object store, and a baseline that cannot be read is no
  // baseline.
  const run = (args) => {
    if (args[0] === 'ls-remote') return `${REMOTE_HEAD}\tHEAD\n`;
    if (args[0] === 'cat-file') throw new Error('fatal: Not a valid object name');
    if (args[0] === 'fetch') return '';
    throw new Error(`unexpected git call: ${args.join(' ')}`);
  };
  assert.equal(resolveRemoteBaseSha({ run }), null);
});

test('every child of the baseline path is bounded and key-free', () => {
  // The apply lock is held while these run, and they are network calls: ls-remote
  // and sometimes fetch. Unbounded, a remote that accepts the connection and then
  // stops answering hangs the run holding the lock, and every later apply refuses
  // behind it.
  const opts = childRunOpts();

  assert.ok(Number.isFinite(opts.timeout) && opts.timeout > 0, `a finite timeout is required, got ${opts.timeout}`);
  assert.equal(opts.killSignal, 'SIGKILL', 'a child that ignores TERM must still be reaped');
  assert.equal('ADLC_MANIFEST_KEY' in opts.env, false, 'no child may inherit the signing key');
});
