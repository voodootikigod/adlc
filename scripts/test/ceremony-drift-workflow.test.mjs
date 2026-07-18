// ceremony-drift-workflow.test.mjs — invariants of the drift workflow itself.
//
// The workflow file is the part of this feature nothing else can check: the
// script's own tests cannot see how it is invoked, and a misconfigured trigger
// or a leaked credential is invisible until it is exploited. Three properties
// here are security- or correctness-critical and were each a real review
// finding, so they get a committed regression test rather than a comment.
//
// Parsed as text with targeted assertions (no YAML dependency in this repo's
// test tree); each assertion is anchored to a distinctive line so a reformat
// does not silently pass.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const WF = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.github', 'workflows', 'ceremony-drift.yml'),
  'utf8'
);

// A job holding issues:write must not leave that credential where later steps —
// above all dependency install scripts — can recover it from git config.
test('checkout does not persist the job credential', () => {
  assert.match(WF, /persist-credentials:\s*false/);
});

// This lockfile contains packages with install scripts. None are needed here,
// and running them inside an issues:write job is an unnecessary supply-chain
// path to a token that can rewrite and close issues.
test('dependency install runs no lifecycle scripts', () => {
  assert.match(WF, /npm ci --ignore-scripts/);
  assert.doesNotMatch(WF, /run:\s*npm install\s*$/m);
});

// workflow_dispatch can be launched against any branch or tag. Without an
// explicit ref, checkout takes the triggering one — so a dispatch from a feature
// branch would compute drift from that branch's ticket store and then rewrite or
// close the repository-wide tracker from a non-authoritative snapshot.
test('checkout is pinned to main for every trigger', () => {
  assert.match(WF, /ref:\s*main/);
});

// The ticket store read and the base ref compared against must be the SAME
// snapshot. Pinning checkout to main and then passing origin/main separately
// reintroduces the mixed-snapshot bug by another route.
test('drift is computed against the checked-out snapshot', () => {
  assert.match(WF, /BASE_REF:\s*HEAD/);
  assert.doesNotMatch(WF, /BASE_REF:\s*origin\/main/);
});

// The whole design premise: an ordinary PR cannot clear this drift, so making it
// a PR gate would block contributors on something none of them can fix.
test('the workflow never runs on pull_request', () => {
  assert.doesNotMatch(WF, /^\s*pull_request:/m);
});

// Least privilege: this job's only side effect is maintaining its issue.
test('permissions are limited to reading contents and writing issues', () => {
  assert.match(WF, /permissions:/);
  assert.match(WF, /contents:\s*read/);
  assert.match(WF, /issues:\s*write/);
  for (const scope of ['packages:', 'id-token:', 'actions:', 'deployments:']) {
    assert.doesNotMatch(WF, new RegExp(`^\\s*${scope}\\s*write`, 'm'), `unexpected ${scope} write`);
  }
});

// push and schedule can overlap; without serialization each run could see "no
// existing issue" and open its own duplicate.
test('runs are serialized so overlapping triggers cannot duplicate the tracker', () => {
  assert.match(WF, /concurrency:/);
  assert.match(WF, /group:\s*ceremony-drift/);
});
