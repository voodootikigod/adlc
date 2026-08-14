// continue-consume.test.mjs — the authorize-and-consume sequence, including the
// marker re-check that runs AFTER the evidence append.
//
// The session lock keeps handoff processes off each other, so the writer these
// tests simulate is the one the lock cannot stop: something that never took it
// (a hand-edited marker, an older CLI, a restored backup) landing in the window
// while the manifest entry is being written. `recordEvidence` is the seam — it
// is the only thing that runs inside that window, so a test that mutates the
// marker from it lands exactly where a real racing writer would.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { authorizeSuccessor } from '../lib/consume.mjs';
import { ensureDenyMarker, readDenyMarker } from '../lib/deny-marker.mjs';
import { repairDenyBinds, writeDenyRecord } from '../lib/deny-persist.mjs';
import { readResumeAuth, writeResumeAuth } from '../lib/resume-auth.mjs';
import { resumeAuthPath } from '../lib/paths.mjs';

const KEY = 'd'.repeat(64);
const TICKET = 'T155';
const HASH = 'a'.repeat(64);

function withArmedDeny(fn) {
  const root = mkdtempSync(join(tmpdir(), 'handoff-consume-'));
  try {
    ensureDenyMarker(root, { sessionId: 'denier', ticketId: TICKET, contentHash: HASH, host: 'test' });
    const marker = readDenyMarker(root, 'denier');
    assert.equal(marker.ok, true);
    assert.equal(marker.record.status, 'open');
    return fn(root, marker.record);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const base = (root, expected, overrides = {}) => ({
  root,
  denySessionId: 'denier',
  successorId: 'successor',
  ticketId: TICKET,
  contentHash: HASH,
  key: KEY,
  expected,
  recordEvidence: () => ({ seq: 7 }),
  ...overrides,
});

test('the happy path consumes the deny and returns the signed authorization', () => {
  withArmedDeny((root, expected) => {
    const got = authorizeSuccessor(base(root, expected));
    assert.equal(got.ok, true);
    assert.equal(got.record.status, 'consumed');
    assert.equal(got.record.consumed_by, 'successor');
    assert.equal(got.resumeAuth.verified, true);
    assert.equal(got.evidence.seq, 7);
    assert.equal(readDenyMarker(root, 'denier').record.status, 'consumed');
    assert.equal(readResumeAuth(root, 'successor', { key: KEY }).verified, true);
  });
});

test('a marker that moved while the evidence was being written is not clobbered', () => {
  withArmedDeny((root, expected) => {
    // A writer that never took the lock, landing in the one window this run
    // cannot hold closed: between the consume decision and the marker write.
    const racing = { ...expected, content_hash: 'b'.repeat(64) };
    const got = authorizeSuccessor(
      base(root, expected, {
        recordEvidence: () => {
          const wrote = repairDenyBinds(root, 'denier', {
            ticketId: TICKET,
            contentHash: racing.content_hash,
            host: 'someone-else',
          });
          assert.equal(wrote.ok, true, 'the racing writer must land');
          return { seq: 7 };
        },
      }),
    );

    assert.equal(got.ok, false);
    assert.equal(got.exitCode, 2);
    assert.match(got.error, /changed under this command/);

    // The racing writer's record survives untouched…
    const after = readDenyMarker(root, 'denier');
    assert.equal(after.record.status, 'open', 'the deny must not be consumed out from under it');
    assert.equal(after.record.content_hash, racing.content_hash);
    // …and no authorization outlives the run that failed to complete.
    assert.equal(existsSync(resumeAuthPath(root, 'successor')), false);
  });
});

test('a marker consumed by someone else mid-run leaves that consume alone', () => {
  withArmedDeny((root, expected) => {
    const got = authorizeSuccessor(
      base(root, expected, {
        recordEvidence: () => {
          writeDenyRecord(root, {
            ...expected,
            status: 'consumed',
            consumed_by: 'someone-elses-successor',
            consumed_at: new Date().toISOString(),
          });
          return { seq: 7 };
        },
      }),
    );
    assert.equal(got.ok, false);
    assert.equal(got.exitCode, 2);
    assert.equal(
      readDenyMarker(root, 'denier').record.consumed_by,
      'someone-elses-successor',
      'the first consumer keeps the deny it won',
    );
    assert.equal(existsSync(resumeAuthPath(root, 'successor')), false);
  });
});

test('a failed evidence append rolls the authorization back', () => {
  withArmedDeny((root, expected) => {
    const got = authorizeSuccessor(
      base(root, expected, {
        recordEvidence: () => {
          throw new Error('manifest contains malformed JSON at line 2');
        },
      }),
    );
    assert.equal(got.ok, false);
    assert.match(got.error, /failed to record evidence: manifest contains malformed JSON/);
    assert.equal(readDenyMarker(root, 'denier').record.status, 'open');
    assert.equal(existsSync(resumeAuthPath(root, 'successor')), false);
  });
});

test('a successor that already holds a resume-auth is refused before anything is written', () => {
  withArmedDeny((root, expected) => {
    const prior = writeResumeAuth(
      root,
      'successor',
      { ticketId: TICKET, contentHash: 'c'.repeat(64), denySessionId: 'another-denier' },
      { key: KEY },
    );
    assert.equal(prior.ok, true);

    let evidenceRan = false;
    const got = authorizeSuccessor(
      base(root, expected, { recordEvidence: () => { evidenceRan = true; return { seq: 7 }; } }),
    );
    assert.equal(got.ok, false);
    assert.equal(got.exitCode, 2);
    assert.match(got.error, /already holds a resume-auth/);
    assert.equal(evidenceRan, false, 'a refused run records nothing');

    // The prior authorization is intact — not rebound, not deleted.
    const held = readResumeAuth(root, 'successor', { key: KEY });
    assert.equal(held.verified, true);
    assert.equal(held.deny_session_id, 'another-denier');
    assert.equal(readDenyMarker(root, 'denier').record.status, 'open');
  });
});

test('a marker that moved BEFORE the run is refused by consumeDenyRecord, minting nothing', () => {
  withArmedDeny((root, expected) => {
    // The caller preflighted on `expected`; the record on disk is already
    // consumed. Nothing may be minted against a stale expectation.
    writeDenyRecord(root, { ...expected, status: 'consumed', consumed_by: 'earlier' });
    const got = authorizeSuccessor(
      base(root, { ...expected, status: 'consumed', consumed_by: 'earlier' }),
    );
    assert.equal(got.ok, false);
    assert.equal(existsSync(resumeAuthPath(root, 'successor')), false);
  });
});
