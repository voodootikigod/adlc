// doctor-forest-invalid-lineage.test.mjs — issues #794 and #795.
//
// #794: `manifestForestCheck` destructured only `valid` from
// `discoverSegments`, so a planted symlink or nested directory under
// `.adlc/manifest.d/` — which every writer refuses with INVALID_MANIFEST —
// produced `manifest-forest: { ok: true }`.
//
// #795: the `.lineage` token was judged stale with no regard for its `branch`.
// `.lineage` is gitignored and survives `git checkout`; segment files are
// committed and do not, so a token left by another branch turned doctor red on
// a healthy checkout. Every resolver already applies the branch predicate
// (`peekOpenSegment` falls through unless `token.branch === branch`).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmp } from '@adlc/core/test-kit';
import { DirectoryTicketStore, TicketService, doctorTicketStore } from '../index.mjs';
import { classifyLineageToken } from '../lib/doctor.mjs';
import { ticket, writeDirectory } from './helpers.mjs';

const BIN = fileURLToPath(new URL('../bin/adlc-tickets.mjs', import.meta.url));
const BRANCH = 'feat/doctor-forest-lineage';
const forestCheck = (report) => report.checks.find((c) => c.name === 'manifest-forest');
const segDir = (root) => join(root, '.adlc', 'manifest.d');
const tokenPath = (root) => join(segDir(root), '.lineage');

/**
 * A segmented repo on a NAMED branch whose root carries evidence and whose
 * branch then opened one segment (the same shape doctor.test.mjs builds; copied
 * here because that file is a rail).
 */
function gitStoreWithSegment(t) {
  const root = tmp(t, 'adlc-doctor-forest-lineage-');
  const g = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  g('init', '-q', '-b', BRANCH);
  g('config', 'user.email', 't@t.co');
  g('config', 'user.name', 'tester');
  g('config', 'commit.gpgsign', 'false');
  writeFileSync(join(root, 'README.md'), 'fixture\n');
  g('add', '.');
  g('commit', '-q', '-m', 'init');
  writeDirectory(root, []);
  const store = new DirectoryTicketStore(join(root, '.adlc', 'tickets'));
  const service = new TicketService(store, { root });
  service.apply(service.planCreate(ticket('A')));
  service.apply(service.planComplete('A')); // evidence-required → lands in ROOT
  mkdirSync(segDir(root), { recursive: true });
  writeFileSync(join(segDir(root), '.store.json'), JSON.stringify({ format: 'adlc-manifest-segments', version: 1 }));
  service.apply(service.planCreate(ticket('B')));
  service.apply(service.planComplete('B')); // → mints a segment and writes .lineage for BRANCH
  const segments = readdirSync(segDir(root)).filter((n) => n.endsWith('.jsonl'));
  assert.equal(segments.length, 1, 'the fixture opened exactly one segment');
  const token = JSON.parse(readFileSync(tokenPath(root), 'utf8'));
  assert.equal(token.branch, BRANCH, 'the fixture token names the fixture branch');
  return { root, store, segment: segments[0], token, g };
}

function runDoctor(root) {
  try {
    const stdout = execFileSync(process.execPath, [BIN, 'doctor', '--json'], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, report: JSON.parse(stdout) };
  } catch (err) {
    return { status: err.status, report: err.stdout ? JSON.parse(err.stdout) : null };
  }
}

/** The AC1 fixture: a nested directory and a symlink planted under manifest.d. */
function plantInvalidObjects(root) {
  mkdirSync(join(segDir(root), 'evil-dir'));
  const symlinkName = 'aaa-01ABCDEFGHJKMNPQRSTVWXYZ22.jsonl';
  symlinkSync(join(root, 'README.md'), join(segDir(root), symlinkName));
  return { names: ['evil-dir', symlinkName] };
}

// ---------------------------------------------------------------------------
// #794 — invalid objects under manifest.d fail the check and are listed.
// ---------------------------------------------------------------------------

test('AC1: a nested directory and a symlink under manifest.d fail the check and are listed in invalidSegments', (t) => {
  const { root, store } = gitStoreWithSegment(t);
  const { names } = plantInvalidObjects(root);

  const check = forestCheck(doctorTicketStore(store, { root }));
  assert.equal(check.ok, false, JSON.stringify(check));
  assert.equal(check.invalidSegments.length, 2);
  assert.deepEqual(check.invalidSegments.map((i) => i.name).sort(), [...names].sort());
  for (const entry of check.invalidSegments) {
    assert.equal(typeof entry.reason, 'string');
    assert.ok(entry.reason.length > 0, 'each invalid object carries discoverSegments\' reason');
  }
  // The valid segment is still counted; the invalid ones are not folded into it.
  assert.equal(check.segments, 1);
  assert.deepEqual(check.orphanedAnchors, []);
  assert.equal(check.staleLineage, null);
});

test('regression: a healthy forest reports ok with an empty invalidSegments and no foreignLineage', (t) => {
  const { root, store } = gitStoreWithSegment(t);
  const check = forestCheck(doctorTicketStore(store, { root }));
  assert.equal(check.ok, true, JSON.stringify(check));
  assert.deepEqual(check.invalidSegments, []);
  assert.equal(check.foreignLineage, null);
  assert.equal(check.staleLineage, null);
});

test('regression: a repo that never segmented is inert and carries no forest fields', (t) => {
  const root = tmp(t, 'adlc-doctor-forest-flat-');
  const path = writeDirectory(root, [ticket('A')]);
  const check = forestCheck(doctorTicketStore(new DirectoryTicketStore(path), { root }));
  assert.deepEqual(check, { name: 'manifest-forest', ok: true, segmented: false });
});

// ---------------------------------------------------------------------------
// #795 — a token left by ANOTHER branch is informational, never a failure.
// ---------------------------------------------------------------------------

test('AC2: a .lineage from another branch naming an absent segment is reported as foreignLineage and does not fail', (t) => {
  const { root, store, token } = gitStoreWithSegment(t);
  const foreign = { segment: `other-x-${'0'.repeat(26)}.jsonl`, ulid: '0'.repeat(26), branch: 'other-x' };
  writeFileSync(tokenPath(root), JSON.stringify(foreign));

  const check = forestCheck(doctorTicketStore(store, { root }));
  assert.equal(check.ok, true, JSON.stringify(check));
  assert.equal(check.staleLineage, null);
  assert.deepEqual(check.foreignLineage, { segment: foreign.segment, ulid: foreign.ulid, branch: 'other-x' });
  assert.notEqual(token.branch, 'other-x', 'the fixture branch differs from the token branch');
});

test('AC2: on a detached HEAD every token is foreign (matching peekOpenSegment\'s fall-through), not stale', (t) => {
  const { root, store, segment, token, g } = gitStoreWithSegment(t);
  rmSync(join(segDir(root), segment)); // would be STALE on the owning branch
  g('checkout', '-q', '--detach');

  const check = forestCheck(doctorTicketStore(store, { root }));
  assert.equal(check.ok, true, JSON.stringify(check));
  assert.equal(check.staleLineage, null);
  assert.deepEqual(check.foreignLineage, { segment: token.segment, ulid: token.ulid, branch: BRANCH });
});

test('AC3 regression: a same-branch token naming an absent segment is still stale and still fails', (t) => {
  const { root, store, segment } = gitStoreWithSegment(t);
  rmSync(join(segDir(root), segment));

  const check = forestCheck(doctorTicketStore(store, { root }));
  assert.equal(check.ok, false);
  assert.equal(check.foreignLineage, null);
  assert.equal(check.staleLineage.segment, segment);
  assert.equal(check.staleLineage.reason, `.lineage names segment '${segment}', which no longer exists`);
});

test('AC3 regression: a same-branch token with a mismatched ULID is still stale with the existing reason', (t) => {
  const { root, store, segment, token } = gitStoreWithSegment(t);
  writeFileSync(tokenPath(root), JSON.stringify({ ...token, ulid: 'Z'.repeat(26) }));

  const check = forestCheck(doctorTicketStore(store, { root }));
  assert.equal(check.ok, false);
  assert.equal(check.foreignLineage, null);
  assert.equal(check.staleLineage.segment, segment);
  assert.equal(check.staleLineage.ulid, 'Z'.repeat(26));
  assert.match(check.staleLineage.reason, /whose own ULID is/);
});

// ---------------------------------------------------------------------------
// AC4 — the pure classifier.
// ---------------------------------------------------------------------------

test('AC4: classifyLineageToken decides none / foreign / stale / ok from its arguments alone', () => {
  const seg = `feat-x-01ABCDEFGHJKMNPQRSTVWXYZ22.jsonl`;
  const ulid = '01ABCDEFGHJKMNPQRSTVWXYZ22';
  const same = Object.freeze({ segment: seg, ulid, branch: 'feat/x' });

  assert.deepEqual(classifyLineageToken(null, 'feat/x', [seg]), { kind: 'none' });
  assert.deepEqual(classifyLineageToken(undefined, 'feat/x', [seg]), { kind: 'none' });
  assert.deepEqual(classifyLineageToken(same, null, [seg]), { kind: 'foreign', segment: seg, ulid, branch: 'feat/x' });
  assert.deepEqual(classifyLineageToken(same, 'main', [seg]), { kind: 'foreign', segment: seg, ulid, branch: 'feat/x' });
  assert.deepEqual(classifyLineageToken(same, 'feat/x', [seg]), { kind: 'ok', segment: seg, ulid });
  assert.deepEqual(classifyLineageToken(same, 'feat/x', []), {
    kind: 'stale', segment: seg, ulid, reason: `.lineage names segment '${seg}', which no longer exists`,
  });
  const wrongUlid = Object.freeze({ segment: seg, ulid: 'Z'.repeat(26), branch: 'feat/x' });
  assert.deepEqual(classifyLineageToken(wrongUlid, 'feat/x', [seg]), {
    kind: 'stale', segment: seg, ulid: 'Z'.repeat(26),
    reason: `.lineage caches ULID '${'Z'.repeat(26)}' for segment '${seg}', whose own ULID is '${ulid}'`,
  });
  // Pure: the token and the segment list are untouched.
  assert.deepEqual(same, { segment: seg, ulid, branch: 'feat/x' });
  const list = [seg];
  classifyLineageToken(same, 'feat/x', list);
  assert.deepEqual(list, [seg]);
});

// ---------------------------------------------------------------------------
// AC5 — through the real CLI, exit code included.
// ---------------------------------------------------------------------------

test('AC5: `adlc ticket doctor --json` exits 2 and shows invalidSegments on a planted forest', (t) => {
  const { root } = gitStoreWithSegment(t);
  plantInvalidObjects(root);
  const { status, report } = runDoctor(root);
  assert.equal(status, 2);
  assert.equal(report.ok, false);
  assert.equal(forestCheck(report).invalidSegments.length, 2);
});

test('AC5: `adlc ticket doctor --json` exits 0 on a healthy forest carrying another branch\'s token', (t) => {
  const { root } = gitStoreWithSegment(t);
  writeFileSync(tokenPath(root), JSON.stringify({ segment: `other-${'0'.repeat(26)}.jsonl`, ulid: '0'.repeat(26), branch: 'other' }));
  const { status, report } = runDoctor(root);
  assert.equal(status, 0);
  assert.equal(report.ok, true);
  assert.equal(forestCheck(report).foreignLineage.branch, 'other');
});
