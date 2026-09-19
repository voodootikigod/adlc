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

import { resolveRemoteBaseSha, baseProfileFromGit } from '../lib/io.mjs';

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
} = {}) {
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

  assert.ok(
    calls.includes('gh api repos/voodootikigod/adlc --jq .default_branch'),
    `the default-branch query must be explicit, got ${JSON.stringify(calls)}`
  );
});

test('an empty or blank default branch refuses rather than asking for refs/heads/', () => {
  // `refs/heads/` with no branch is a prefix, and ls-remote would answer it with
  // whatever comes first — a baseline nobody chose.
  for (const defaultBranch of ['', '   ', 'two words']) {
    const { run, ghRun } = seams({ defaultBranch });
    assert.equal(resolveRemoteBaseSha({ run, ghRun }), null, `branch ${JSON.stringify(defaultBranch)} must refuse`);
  }
});
