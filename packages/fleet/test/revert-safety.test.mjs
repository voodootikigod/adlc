import { test } from 'node:test';
import assert from 'node:assert/strict';
import { revertMerge } from '../lib/worktrees.mjs';

// A fake git runner: `head` is what `rev-parse <branch>` returns; records calls.
function fakeGit({ head, failRevert = false }) {
  const calls = [];
  const run = (...args) => {
    calls.push(args.join(' '));
    if (args[0] === 'rev-parse') return head;
    if (args[0] === 'revert' && failRevert) throw new Error('revert conflict');
    return '';
  };
  run.calls = calls;
  return run;
}

test('resets to pre-merge SHA when integration HEAD is still the merge commit (AC9 happy)', () => {
  const git = fakeGit({ head: 'MERGE' });
  const r = revertMerge('/repo', 'fleet/run-1', { mergeSha: 'MERGE', preMergeSha: 'PRE' }, git);
  assert.equal(r.method, 'reset');
  assert.equal(r.ok, true);
  assert.ok(git.calls.some((c) => c === 'reset --hard PRE'), 'must reset to the recorded pre-merge SHA');
});

test('HEAD moved: reverts our merge (preserving the intervening commit) but QUARANTINES it (AC9 / F4 / N2)', () => {
  const git = fakeGit({ head: 'SOMEONE_ELSES_COMMIT' });
  const r = revertMerge('/repo', 'fleet/run-1', { mergeSha: 'MERGE', preMergeSha: 'PRE' }, git);
  assert.equal(r.method, 'revert', 'moved HEAD takes the revert path, not a blind reset');
  // Preserve the intervening commit — do NOT drop unrelated work.
  assert.ok(!git.calls.some((c) => c.startsWith('reset --hard')), 'must NOT reset and drop the moved-in commit');
  assert.ok(git.calls.some((c) => c === 'revert --no-edit -m 1 MERGE'), 'our merge is reverted');
  // But the intervening commit was never gated, so recovery is NOT clean — the caller
  // must quarantine, so the ungated commit cannot reach the PR.
  assert.equal(r.ok, false, 'not clean recovery: an ungated intervening commit remains');
  assert.match(r.reason, /UNGATED|quarantin/i);
});

test('refuses (manual recovery) when HEAD moved and revert fails', () => {
  const git = fakeGit({ head: 'MOVED', failRevert: true });
  const r = revertMerge('/repo', 'fleet/run-1', { mergeSha: 'MERGE', preMergeSha: 'PRE' }, git);
  assert.equal(r.method, 'refused');
  assert.equal(r.ok, false);
  assert.match(r.reason, /manual recovery/);
});
