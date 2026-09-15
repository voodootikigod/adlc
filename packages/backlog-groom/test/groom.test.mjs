// groom.test.mjs — the assembled read pipeline, and the cache actually hitting.
//
// The cache is the whole of §4's incrementality claim. A pipeline that writes
// cache entries and never reads them looks identical in every other assertion:
// the verdicts are right, the report is right, and every run silently re-verifies
// the entire backlog. So the HIT is asserted by observing that the second run
// does not re-read the files.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { groom, MAX_TOTAL_REFERENCES } from '../lib/groom.mjs';
import { renderReport } from '../lib/report.mjs';
import { parseProfile } from '../lib/profile.mjs';

const PROFILE = parseProfile({ schemaVersion: 1, units: [{ name: 'core', paths: ['packages/core/**'] }] });

const BODY = '**Location** `packages/core/lib/text.mjs:37`\n\n```\nconst tag = one;\n```\n';

function world({ updatedAt = 'T1', content = 'const tag = one;\n' } = {}) {
  const reads = [];
  return {
    reads,
    io: {
      fetchIssues: () => ({
        truncated: null,
        unconsultable: null,
        issues: [{ number: 1, title: 't', body: BODY, labels: ['P1-high'], url: 'u', updatedAt }],
      }),
      readFile: (p) => {
        reads.push(p);
        return content;
      },
      pathExists: () => true,
      lastCommitFor: () => 'abc',
      everExisted: () => true,
    },
  };
}

test('a warm cache is actually READ — a hit skips verification, not merely the write', () => {
  // AN HONEST LIMIT, worth stating: a hit cannot skip ALL file I/O, because the
  // cache key contains the contentHash and computing it requires reading the
  // referenced files. What incrementality buys is the verification work —
  // snippet matching and the git calls behind it — not the read.
  //
  // The assertion matters because a pipeline that writes cache entries and never
  // reads them is invisible in every other test: the verdicts are right, the
  // report is right, and every run silently re-verifies the whole backlog.
  const cache = {};
  const first = world();
  const a = groom({ profile: PROFILE, cache, io: first.io });
  assert.equal(a.set.issues[0].verdict, 'valid');
  assert.equal(first.reads.length, 2, 'cold: once to hash, once to verify');

  const second = world();
  const b = groom({ profile: PROFILE, cache, io: second.io });
  assert.equal(b.set.issues[0].verdict, 'valid', 'the cached verdict is returned');
  assert.equal(second.reads.length, 1, 'warm: the hash read remains, the verify read is gone');
});

test('a changed issue body invalidates the cache and is re-verified', () => {
  const cache = {};
  groom({ profile: PROFILE, cache, io: world().io });
  const second = world({ updatedAt: 'T2' });
  groom({ profile: PROFILE, cache, io: second.io });
  assert.ok(second.reads.length > 0, 'an edited issue must be looked at again');
});

test('changed code invalidates the cache even when the issue did not change', () => {
  // This is the decay case: the issue text is identical, the code moved on.
  const cache = {};
  groom({ profile: PROFILE, cache, io: world().io });
  const second = world({ content: 'something else entirely\n' });
  const r = groom({ profile: PROFILE, cache, io: second.io });
  assert.ok(second.reads.length > 0, 'changed code must be re-verified');
  assert.equal(r.set.issues[0].verdict, 'fixed');
});

test('with no cache supplied, every run verifies from scratch', () => {
  const first = world();
  groom({ profile: PROFILE, cache: null, io: first.io });
  const second = world();
  groom({ profile: PROFILE, cache: null, io: second.io });
  assert.ok(second.reads.length > 0);
});

test('an unconsultable fetch short-circuits before any verification', () => {
  const w = world();
  w.io.fetchIssues = () => ({ issues: [], unconsultable: 'gh exploded', truncated: null });
  const r = groom({ profile: PROFILE, cache: {}, io: w.io });
  assert.equal(r.ok, false);
  assert.equal(w.reads.length, 0);
});

test('the global citation budget is 5000 — the sweep-wide work ceiling', () => {
  // Pinned like the other operator-visible bounds. At roughly three synchronous
  // git subprocesses per citation this is already ~15,000 of them, which is the
  // most a routine maintenance run should ever spend.
  assert.equal(MAX_TOTAL_REFERENCES, 5000);
});

test('a sweep enforces a GLOBAL citation budget, and says the run was incomplete', () => {
  // The per-issue cap bounds one hostile body; this bounds the backlog. Without
  // it, 500 issues at 50 citations each is 25,000 references and roughly three
  // synchronous git subprocesses apiece — a run that never finishes usefully.
  const body = '**Location** `packages/core/lib/text.mjs:1`\n\n```\nconst tag = one;\n```\n';
  const issues = Array.from({ length: MAX_TOTAL_REFERENCES + 50 }, (_, i) => ({
    number: i + 1, title: 't', body, labels: [], url: 'u', updatedAt: 'T1',
  }));
  const reads = [];
  const io = {
    fetchIssues: () => ({ issues, unconsultable: null, truncated: null }),
    readFile: (p) => { reads.push(p); return 'const tag = one;\n'; },
    pathExists: () => true,
    lastCommitFor: () => 'abc',
    everExisted: () => true,
    headCommit: () => 'rev',
  };
  const { set } = groom({ profile: PROFILE, cache: null, io });
  assert.equal(set.coverage.budgetExhausted, true);
  assert.match(renderReport(set), /exhausted its citation budget/);

  const beyond = set.issues.at(-1);
  assert.equal(beyond.verdict, 'unverifiable', 'an issue past the budget is not verified, and says so');
  assert.notEqual(beyond.verdict, 'fixed', 'and can never close');
});

test('an issue that would CROSS the budget is refused entirely, not partly processed', () => {
  // Checking only whether the budget was already spent lets a straddling issue
  // process every citation and drive the counter negative, while the run still
  // reports itself complete.
  const many = '**Location** `packages/core/lib/text.mjs:1`\n\n```\nconst tag = one;\n```\n';
  const issues = Array.from({ length: MAX_TOTAL_REFERENCES + 5 }, (_, i) => ({
    number: i + 1, title: 't', body: many, labels: [], url: 'u', updatedAt: 'T1',
  }));
  let reads = 0;
  const { set } = groom({
    profile: PROFILE,
    cache: null,
    io: {
      fetchIssues: () => ({ issues, unconsultable: null, truncated: null }),
      readFile: () => { reads += 1; return 'const tag = one;\n'; },
      pathExists: () => true,
      lastCommitFor: () => 'abc',
      everExisted: () => true,
      headCommit: () => 'rev',
    },
  });
  assert.equal(set.coverage.budgetExhausted, true);
  // Two reads per verified citation (hash + verify), so the ceiling bounds reads.
  assert.ok(reads <= MAX_TOTAL_REFERENCES * 2, `reads must respect the ceiling (got ${reads})`);
});

test('an unresolvable revision is an operational FAILURE, not a quiet sweep of unverifiables', () => {
  // Failing to resolve a revision means the tool cannot read the code at all.
  // Degrading to a full sweep of `unverifiable` verdicts and exiting 0 would
  // hand the operator a normal-looking report for a run that examined nothing —
  // the exact false green this package exists to detect, produced by itself.
  const w = world();
  w.io.headCommit = () => null;
  const r = groom({ profile: PROFILE, cache: {}, io: w.io });
  assert.equal(r.ok, false);
  assert.equal(r.set, null);
  assert.match(r.unconsultable, /could not resolve a git revision/);
});
