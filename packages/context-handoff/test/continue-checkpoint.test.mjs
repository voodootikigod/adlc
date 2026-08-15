// continue-checkpoint.test.mjs — the final-and-rebind step, and the
// compare-and-swap that keeps it from overwriting a writer it never saw.
//
// The caller claims a record, then writes a capture and a final before the
// rebind. That gap is several filesystem operations wide, and the session lock
// only covers processes that take it. `expected` turns the rebind into a
// compare-and-swap so a marker that moved in the gap aborts the run instead of
// being silently overwritten.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeCheckpoint, rollbackCheckpoint } from '../lib/checkpoint.mjs';
import { buildFinal, readFinal, CONTENT_KIND_CAPTURE } from '../lib/final.mjs';
import { ensureDenyMarker, readDenyMarker } from '../lib/deny-marker.mjs';
import { repairDenyBinds, writeDenyRecord } from '../lib/deny-persist.mjs';

const TICKET = 'T155';

function withArmedDeny(fn) {
  const root = mkdtempSync(join(tmpdir(), 'handoff-checkpoint-'));
  try {
    ensureDenyMarker(root, {
      sessionId: 'denier',
      ticketId: TICKET,
      contentHash: 'a'.repeat(64),
      host: 'test',
    });
    return fn(root, readDenyMarker(root, 'denier').record);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const planFor = (hash, kind = null) =>
  buildFinal({ sessionId: 'denier', ticketId: TICKET, contentHash: hash, contentKind: kind, host: 'test' });

test('a checkpoint binds the final and the marker to the same hash and kind', () => {
  withArmedDeny((root, claimed) => {
    const planned = planFor('b'.repeat(64), CONTENT_KIND_CAPTURE);
    const got = writeCheckpoint(root, 'denier', planned, { expected: claimed });
    assert.equal(got.ok, true);
    assert.equal(got.rebound, true);
    assert.equal(got.final.content_hash, planned.content_hash);
    assert.equal(got.final.content_kind, CONTENT_KIND_CAPTURE);

    const marker = readDenyMarker(root, 'denier').record;
    assert.equal(marker.content_hash, planned.content_hash);
    assert.equal(marker.content_kind, CONTENT_KIND_CAPTURE);
    assert.equal(marker.status, 'open');
  });
});

test('a marker that moved since the claim aborts the rebind, writing no marker', () => {
  withArmedDeny((root, claimed) => {
    // A writer that never took the lock, landing after the claim.
    const moved = repairDenyBinds(root, 'denier', {
      ticketId: TICKET,
      contentHash: 'c'.repeat(64),
      host: 'someone-else',
    });
    assert.equal(moved.ok, true);

    const planned = planFor('d'.repeat(64), CONTENT_KIND_CAPTURE);
    const got = writeCheckpoint(root, 'denier', planned, { expected: claimed });
    assert.equal(got.ok, false);
    assert.equal(got.exitCode, 2);
    assert.match(got.error, /changed under this command/);

    // Their record stands, and our final is rolled back rather than left
    // pointing at a bind that never landed.
    const after = readDenyMarker(root, 'denier').record;
    assert.equal(after.content_hash, 'c'.repeat(64));
    assert.equal(after.host, 'someone-else');
    assert.equal(after.content_kind, undefined);
    assert.equal(existsSync(join(root, '.adlc', 'handoffs', 'finals', 'denier.json')), false);
  });
});

test('without a claim the rebind keeps its previous behavior', () => {
  withArmedDeny((root) => {
    // `write` has no claimed record when it mints a marker, so the CAS is
    // opt-in — absent `expected`, a moved marker is still rebound.
    writeDenyRecord(root, {
      ...readDenyMarker(root, 'denier').record,
      content_hash: 'e'.repeat(64),
    });
    const planned = planFor('f'.repeat(64));
    const got = writeCheckpoint(root, 'denier', planned);
    assert.equal(got.ok, true);
    assert.equal(readDenyMarker(root, 'denier').record.content_hash, 'f'.repeat(64));
  });
});

test('an unchanged marker passes the compare-and-swap', () => {
  withArmedDeny((root, claimed) => {
    const got = writeCheckpoint(root, 'denier', planFor('b'.repeat(64)), { expected: claimed });
    assert.equal(got.ok, true);
    assert.equal(readDenyMarker(root, 'denier').record.content_hash, 'b'.repeat(64));
  });
});

test('rebinding away from a capture clears content_kind rather than carrying it', () => {
  withArmedDeny((root, claimed) => {
    const bound = writeCheckpoint(root, 'denier', planFor('b'.repeat(64), CONTENT_KIND_CAPTURE), {
      expected: claimed,
    });
    assert.equal(bound.ok, true);
    const captured = readDenyMarker(root, 'denier').record;
    assert.equal(captured.content_kind, CONTENT_KIND_CAPTURE);

    // A later refresh that is NOT capture-backed must not leave the marker
    // demanding a capture for a hash no capture produced.
    const plain = writeCheckpoint(root, 'denier', planFor('c'.repeat(64)), { expected: captured });
    assert.equal(plain.ok, true);
    const after = readDenyMarker(root, 'denier').record;
    assert.equal(after.content_kind, undefined);
    assert.equal(after.content_hash, 'c'.repeat(64));
  });
});

test('an UNBOUND deny is refreshed in place rather than refused', () => {
  // The pre-bind state: a marker armed with no ticket. `repairDenyBinds`
  // demands both binds, so this path persists the record directly — and an
  // unbound deny is the stricter state, so a legitimate no-ticket refresh must
  // not be turned into a failure.
  const root = mkdtempSync(join(tmpdir(), 'handoff-checkpoint-unbound-'));
  try {
    ensureDenyMarker(root, { sessionId: 'denier', ticketId: null, contentHash: null, host: 'test' });
    const claimed = readDenyMarker(root, 'denier').record;
    assert.equal(claimed.ticket_id, null);

    const planned = buildFinal({ sessionId: 'denier', ticketId: null, contentHash: 'b'.repeat(64), host: 'test' });
    const got = writeCheckpoint(root, 'denier', planned, { expected: claimed });
    assert.equal(got.ok, true, `unbound refresh must succeed: ${got.error}`);
    assert.equal(got.rebound, true);

    const marker = readDenyMarker(root, 'denier').record;
    assert.equal(marker.content_hash, 'b'.repeat(64), 'the new hash is persisted');
    assert.equal(marker.ticket_id, null, 'and it stays unbound');
    assert.equal(marker.status, 'open');
    assert.equal(marker.since, claimed.since, 'a refresh must not restart the deny');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a rollback restores both the final and the binds the checkpoint moved', () => {
  withArmedDeny((root, claimed) => {
    const first = writeCheckpoint(root, 'denier', planFor('b'.repeat(64), CONTENT_KIND_CAPTURE), {
      expected: claimed,
    });
    assert.equal(first.ok, true);
    const afterFirst = readDenyMarker(root, 'denier').record;
    const finalAfterFirst = readFinal(root, 'denier').final;

    const second = writeCheckpoint(root, 'denier', planFor('c'.repeat(64)), { expected: afterFirst });
    assert.equal(second.ok, true);
    rollbackCheckpoint(root, 'denier', second);

    assert.deepEqual(readDenyMarker(root, 'denier').record, afterFirst);
    assert.deepEqual(readFinal(root, 'denier').final, finalAfterFirst);
  });
});
