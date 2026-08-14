// continue-rollback-ownership.test.mjs — a failed run must undo ITS work, not
// the work of whoever beat it.
//
// The failure that triggers a rollback is frequently a concurrent writer. A
// rollback that restores a pre-command snapshot unconditionally therefore has a
// mode where it deletes the record that just won the race — turning a detected
// conflict into silent data loss. Every restore is a compare-and-swap on the
// bytes this run wrote.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { conflictReport, currentBytes, restoreIfOurs } from '../lib/rollback.mjs';
import { writeCheckpoint, rollbackCheckpoint } from '../lib/checkpoint.mjs';
import { buildFinal } from '../lib/final.mjs';
import { ensureDenyMarker, readDenyMarker, denyPath } from '../lib/deny-marker.mjs';
import { repairDenyBinds } from '../lib/deny-persist.mjs';
import { finalPath } from '../lib/paths.mjs';

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'handoff-rollback-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a restore puts back what this run replaced', () => {
  withTempDir((dir) => {
    const path = join(dir, 'artifact.json');
    writeFileSync(path, 'prior\n', 'utf8');
    const prior = currentBytes(path);
    writeFileSync(path, 'ours\n', 'utf8');

    const got = restoreIfOurs({ path, wroteBytes: 'ours\n', priorBytes: prior, label: 'artifact' });
    assert.deepEqual(got, { restored: true, conflict: false, label: 'artifact' });
    assert.equal(readFileSync(path, 'utf8'), 'prior\n');
  });
});

test('a file this run created is removed, not resurrected as empty', () => {
  withTempDir((dir) => {
    const path = join(dir, 'fresh.json');
    writeFileSync(path, 'ours\n', 'utf8');
    const got = restoreIfOurs({ path, wroteBytes: 'ours\n', priorBytes: null, label: 'fresh' });
    assert.equal(got.restored, true);
    assert.equal(existsSync(path), false);
  });
});

test("a third party's bytes are left alone and reported as a conflict", () => {
  withTempDir((dir) => {
    const path = join(dir, 'artifact.json');
    writeFileSync(path, 'prior\n', 'utf8');
    writeFileSync(path, 'theirs\n', 'utf8'); // somebody else won the race

    const got = restoreIfOurs({ path, wroteBytes: 'ours\n', priorBytes: 'prior\n', label: 'artifact' });
    assert.deepEqual(got, { restored: false, conflict: true, label: 'artifact' });
    assert.equal(readFileSync(path, 'utf8'), 'theirs\n', 'their state must survive our undo');
    assert.match(conflictReport([got]), /rollback left artifact as found/);
  });
});

test('a vanished artifact is a conflict too, not a silent re-creation', () => {
  withTempDir((dir) => {
    const path = join(dir, 'gone.json');
    const got = restoreIfOurs({ path, wroteBytes: 'ours\n', priorBytes: 'prior\n', label: 'gone' });
    assert.equal(got.conflict, true);
    assert.equal(existsSync(path), false, 'a deleted artifact is not resurrected from a stale snapshot');
  });
});

test('conflictReport is empty when everything came back', () => {
  assert.equal(conflictReport([{ restored: true, conflict: false, label: 'final' }]), '');
  assert.equal(conflictReport([]), '');
});

test('a checkpoint rollback restores the final and the marker it moved', () => {
  withTempDir((root) => {
    ensureDenyMarker(root, { sessionId: 'd', ticketId: 'T155', contentHash: 'a'.repeat(64), host: 't' });
    const claimed = readDenyMarker(root, 'd').record;
    const markerBefore = readFileSync(denyPath(root, 'd'), 'utf8');

    const cp = writeCheckpoint(
      root,
      'd',
      buildFinal({ sessionId: 'd', ticketId: 'T155', contentHash: 'b'.repeat(64), host: 't' }),
      { expected: claimed },
    );
    assert.equal(cp.ok, true);

    const results = rollbackCheckpoint(root, 'd', cp);
    assert.ok(results.every((r) => r.restored), 'both artifacts are ours to put back');
    assert.equal(conflictReport(results), '');
    assert.equal(readFileSync(denyPath(root, 'd'), 'utf8'), markerBefore);
    assert.equal(existsSync(finalPath(root, 'd')), false, 'the final this run created is gone');
  });
});

test('a marker rewritten after the checkpoint survives the rollback', () => {
  withTempDir((root) => {
    ensureDenyMarker(root, { sessionId: 'd', ticketId: 'T155', contentHash: 'a'.repeat(64), host: 't' });
    const claimed = readDenyMarker(root, 'd').record;
    const cp = writeCheckpoint(
      root,
      'd',
      buildFinal({ sessionId: 'd', ticketId: 'T155', contentHash: 'b'.repeat(64), host: 't' }),
      { expected: claimed },
    );
    assert.equal(cp.ok, true);

    // A writer that never took the lock lands between the checkpoint and the
    // rollback — exactly the case where restoring a snapshot destroys evidence.
    repairDenyBinds(root, 'd', { ticketId: 'T155', contentHash: 'c'.repeat(64), host: 'someone-else' });

    const results = rollbackCheckpoint(root, 'd', cp);
    const marker = readDenyMarker(root, 'd').record;
    assert.equal(marker.content_hash, 'c'.repeat(64), 'their bind stands');
    assert.equal(marker.host, 'someone-else');
    assert.match(conflictReport(results), /deny marker/);
    // The final was still ours, so it is still rolled back.
    assert.equal(existsSync(finalPath(root, 'd')), false);
  });
});
