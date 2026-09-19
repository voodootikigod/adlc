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
 * Scripted git and gh.
 *
 * Every call is recorded, so a test can assert on the call that did NOT happen —
 * which is the whole point for the read path.
 */
function seams({
  remoteUrl = 'git@github.com:voodootikigod/adlc.git',
  defaultBranch = 'main',
  lsRemote = `${REMOTE_HEAD}\trefs/heads/main\n`,
  mergeBase = MERGE_BASE,
  isAncestor = true,
  profileAtBase = '{"schemaVersion":1,"autonomyFloor":["close"]}',
  failGh = false,
  // A stale clone: the remote's head is not in the local object database until
  // it is fetched. `shaPresent` is what `cat-file -e` reports, and it flips to
  // true once a fetch succeeds — the sequence a real clone goes through.
  shaPresent = true,
  fetchWorks = true,
} = {}) {
  let present = shaPresent;
  const calls = [];
  const run = (args) => {
    calls.push(['git', ...args].join(' '));
    const [cmd] = args;
    if (cmd === 'remote') {
      if (remoteUrl === null) throw new Error('fatal: No such remote');
      return remoteUrl;
    }
    if (cmd === 'ls-remote') {
      if (lsRemote === null) throw new Error('fatal: could not read from remote');
      return lsRemote;
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
    if (cmd === 'cat-file') {
      if (!present) throw new Error('fatal: Not a valid object name');
      return '';
    }
    if (cmd === 'fetch') {
      if (!fetchWorks) throw new Error('fatal: could not fetch');
      present = true;
      return '';
    }
    if (cmd === 'ls-tree') return profileAtBase === null ? '' : PROFILE;
    if (cmd === 'show') return profileAtBase;
    throw new Error(`unexpected git call: ${args.join(' ')}`);
  };
  const ghRun = (args) => {
    calls.push(['gh', ...args].join(' '));
    if (failGh) throw new Error('gh: command not found');
    return JSON.stringify({ default_branch: defaultBranch });
  };
  return { run, ghRun, calls };
}

test('AC7: the baseline sha comes from the remote, not from a local ref', () => {
  const { run, ghRun, calls } = seams();

  assert.equal(resolveRemoteBaseSha({ run, ghRun }), REMOTE_HEAD);
  // The local refs that used to decide this must not be consulted at all: reading
  // them is what made `git update-ref` sufficient to move the baseline.
  assert.ok(!calls.some((c) => c.includes('symbolic-ref')), `local symbolic-ref consulted: ${JSON.stringify(calls)}`);
  assert.ok(!calls.some((c) => /refs\/remotes/.test(c)), `local remote-tracking ref consulted: ${JSON.stringify(calls)}`);
  assert.ok(calls.some((c) => c.startsWith('git ls-remote')), 'the remote must be asked for the branch head');
});

test('AC7: a moved local ref cannot change the baseline the profile is read at', () => {
  // The attack: origin/main pointed at HEAD locally. With the remote as the
  // anchor, the profile is still read at the REMOTE-derived merge base.
  const { run, ghRun } = seams();
  const profile = baseProfileFromGit(PROFILE, { run, ghRun });

  assert.deepEqual(profile?.autonomyFloor, ['close'], 'the base floor must be the one committed on the remote');
});

test('AC8: every remote-resolution failure refuses rather than falling back', () => {
  const cases = [
    ['no origin remote', { remoteUrl: null }],
    ['gh unavailable', { failGh: true }],
    ['ls-remote fails', { lsRemote: null }],
    ['ls-remote returns nothing', { lsRemote: '' }],
    ['ls-remote returns a malformed sha', { lsRemote: 'not-a-sha\trefs/heads/main\n' }],
    ['no merge base with the remote head', { mergeBase: null }],
    ['the merge base is not reachable from the remote head', { isAncestor: false }],
  ];

  for (const [name, opts] of cases) {
    const { run, ghRun } = seams(opts);
    assert.equal(baseProfileFromGit(PROFILE, { run, ghRun }), null, `${name}: must refuse, not fall back`);
  }
});

test('AC8: an unparseable remote URL refuses', () => {
  for (const remoteUrl of ['', 'not a url', 'https://github.com/only-owner']) {
    const { run, ghRun } = seams({ remoteUrl });
    assert.equal(resolveRemoteBaseSha({ run, ghRun }), null, `${JSON.stringify(remoteUrl)} must not resolve`);
  }
});

test('both SSH and HTTPS origins resolve to the same owner/repo', () => {
  for (const remoteUrl of [
    'git@github.com:voodootikigod/adlc.git',
    'https://github.com/voodootikigod/adlc.git',
    'https://github.com/voodootikigod/adlc',
  ]) {
    const { run, ghRun, calls } = seams({ remoteUrl });
    assert.equal(resolveRemoteBaseSha({ run, ghRun }), REMOTE_HEAD, `${remoteUrl} must resolve`);
    assert.ok(
      calls.some((c) => c.includes('repos/voodootikigod/adlc')),
      `${remoteUrl} must ask the forge about voodootikigod/adlc, got ${JSON.stringify(calls)}`
    );
  }
});

test('the default branch is whatever the forge says, not a hardcoded main', () => {
  const { run, ghRun, calls } = seams({ defaultBranch: 'trunk', lsRemote: `${REMOTE_HEAD}\trefs/heads/trunk\n` });

  assert.equal(resolveRemoteBaseSha({ run, ghRun }), REMOTE_HEAD);
  assert.ok(calls.some((c) => c.includes('trunk')), `the remote branch must be the forge's default: ${JSON.stringify(calls)}`);
});

test('a deep remote path takes the LAST two segments as owner/repo', () => {
  // A self-hosted forge or a filesystem remote carries a deeper path. Taking any
  // other pair asks the forge about a repository nobody named — and the answer to
  // the wrong question is not a baseline.
  const { run, ghRun, calls } = seams({ remoteUrl: 'ssh://git@gh.example.com:22/team/sub/repo.git' });

  assert.equal(resolveRemoteBaseSha({ run, ghRun }), REMOTE_HEAD);
  assert.ok(
    calls.some((c) => c.includes('repos/sub/repo')),
    `the last two segments name the repo, got ${JSON.stringify(calls)}`
  );
});

test('a malformed segment refuses even when the other one is fine', () => {
  // Either half being unusable makes the pair unusable: a slug is both segments
  // or it is nothing.
  for (const remoteUrl of ['https://github.com/owner/re po', 'https://github.com/ow ner/repo']) {
    const { run, ghRun } = seams({ remoteUrl });
    assert.equal(resolveRemoteBaseSha({ run, ghRun }), null, `${remoteUrl} must not resolve`);
  }
});

test('the forge is asked for the default branch specifically', () => {
  // The whole argv, not just the path: dropping the jq filter returns the entire
  // repository document, and a JSON blob is not a branch name.
  const { run, ghRun, calls } = seams();
  resolveRemoteBaseSha({ run, ghRun });

  const query = calls.find((c) => c.startsWith('gh api'));
  assert.match(query, /repos\/voodootikigod\/adlc/, `the query must name the repo: ${query}`);
  assert.match(query, /--jq \.default_branch/, `the query must ask for the default branch: ${query}`);
});

test('an empty or blank default branch refuses rather than asking for refs/heads/', () => {
  // `refs/heads/` with no branch is a prefix, and ls-remote would answer it with
  // whatever comes first — a baseline nobody chose.
  for (const defaultBranch of ['', '   ', 'two words']) {
    const { run, ghRun } = seams({ defaultBranch });
    assert.equal(resolveRemoteBaseSha({ run, ghRun }), null, `branch ${JSON.stringify(defaultBranch)} must refuse`);
  }
});

test('a stale clone fetches the remote head rather than refusing', () => {
  // ls-remote answers with where the branch points NOW, which a clone that has
  // not fetched recently has never seen. Refusing there would block every apply
  // on an ordinary working copy — a refusal nobody can act on is not a safety
  // property.
  const { run, ghRun, calls } = seams({ shaPresent: false });

  assert.equal(resolveRemoteBaseSha({ run, ghRun }), REMOTE_HEAD);
  assert.ok(calls.some((c) => c.startsWith('git fetch')), `the missing commit must be fetched: ${JSON.stringify(calls)}`);
  // And no local ref is moved by any of it.
  assert.ok(!calls.some((c) => c.includes('update-ref')), 'the baseline must not write a local ref');
});

test('a commit that cannot be fetched refuses rather than guessing a baseline', () => {
  const { run, ghRun } = seams({ shaPresent: false, fetchWorks: false });
  assert.equal(resolveRemoteBaseSha({ run, ghRun }), null);
});

test('a fetched-but-still-absent commit refuses', () => {
  // The fetch reported success and the object is still not there: something is
  // wrong with the object store, and a baseline that cannot be read is no
  // baseline. `present` deliberately stays false here.
  const calls = [];
  const run = (args) => {
    calls.push(args[0]);
    if (args[0] === 'remote') return 'git@github.com:acme/widgets.git';
    if (args[0] === 'ls-remote') return `${REMOTE_HEAD}\trefs/heads/main\n`;
    if (args[0] === 'cat-file') throw new Error('fatal: Not a valid object name');
    if (args[0] === 'fetch') return '';
    throw new Error(`unexpected git call: ${args.join(' ')}`);
  };
  assert.equal(resolveRemoteBaseSha({ run, ghRun: () => 'main\n' }), null);
});

test('the forge query names the origin HOST, so an enterprise remote is not asked on github.com', () => {
  // `gh` resolves a host from its own configuration. Asking it about owner/repo
  // without saying where would look up a same-named repository on whatever forge
  // gh defaults to, and use THAT repo's default branch as this one's baseline.
  const { run, ghRun, calls } = seams({ remoteUrl: 'git@corp-forge.example.com:org/repo.git' });

  assert.equal(resolveRemoteBaseSha({ run, ghRun }), REMOTE_HEAD);
  const query = calls.find((c) => c.startsWith('gh api'));
  assert.match(query, /--hostname corp-forge\.example\.com/, `the host must be named: ${query}`);
});

test('a remote with no host names none, rather than inventing one', () => {
  // A filesystem remote has no forge to ask; gh is left to its own resolution
  // rather than being handed a path segment as a hostname.
  const { run, ghRun, calls } = seams({ remoteUrl: '/srv/git/team/repo.git' });

  resolveRemoteBaseSha({ run, ghRun });
  const query = calls.find((c) => c.startsWith('gh api'));
  assert.ok(query && !query.includes('--hostname'), `no host should be claimed: ${query}`);
});

test('every child of the baseline path is bounded and key-free', () => {
  // The apply lock is held while these run, and they are network calls: gh api,
  // ls-remote, and sometimes fetch. Unbounded, a remote that accepts the
  // connection and then stops answering hangs the run holding the lock, and every
  // later apply refuses behind it.
  const opts = childRunOpts();

  assert.ok(Number.isFinite(opts.timeout) && opts.timeout > 0, `a finite timeout is required, got ${opts.timeout}`);
  assert.equal(opts.killSignal, 'SIGKILL', 'a child that ignores TERM must still be reaped');
  assert.equal('ADLC_MANIFEST_KEY' in opts.env, false, 'no child may inherit the signing key');
});
