// skill-mutation-matcher.test.mjs — the matcher behind the SKILL.md guard.
//
// The guard is only as good as the shapes it recognises. gh takes persistent
// flags before the subcommand, the API endpoint before the method, and treats
// any field as an implicit POST — each a mutation a substring check misses.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mutatingGhInvocations } from './gh-mutation-matcher.mjs';

const MUTATIONS = [
  'gh issue close 7',
  'gh   issue\n  close $N',
  'gh issue --repo o/r close 7',
  'gh issue -R o/r comment 7 --body-file -',
  'gh pr merge 12 --squash',
  'gh label delete stale',
  'gh api -X PATCH repos/o/r/issues/7',
  'gh api repos/o/r/issues/7 -X PATCH -f state=closed',
  'gh api repos/o/r/issues/7 --method=PATCH',
  'gh api repos/o/r/issues/7 -XDELETE',
  'gh api repos/o/r/issues/7/comments -f body=hi',
  'gh api repos/o/r/issues/7/labels -F labels[]=bug',
  'gh api repos/o/r/issues/7/labels --input labels.json',
  'gh api --method POST repos/o/r/issues/7/comments',
];

const READS = [
  'gh issue list --state open',
  'gh issue view 7 --json body',
  'gh issue list --search close',
  'gh pr view 12',
  'gh api user',
  'gh api repos/o/r/issues/7',
  'gh api -X GET search/issues -f q=is:open',
  'gh api --method HEAD repos/o/r',
  'Reading is fine: `gh issue list`, `gh issue view` and any other query',
];

for (const text of MUTATIONS) {
  test(`caught: ${text.replace(/\s+/g, ' ')}`, () => {
    assert.equal(mutatingGhInvocations(`Run \`${text}\` next.`).length, 1);
  });
}

for (const text of READS) {
  test(`not flagged: ${text}`, () => {
    assert.deepEqual(mutatingGhInvocations(text), []);
  });
}

test('an invocation ends at a code-span or shell boundary', () => {
  assert.deepEqual(mutatingGhInvocations('`gh issue view 7` then we close it'), []);
  assert.equal(mutatingGhInvocations('gh issue view 7; gh issue close 7').length, 1);
});
