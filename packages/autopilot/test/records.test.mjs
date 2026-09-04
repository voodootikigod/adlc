// Run records: the canonical deletion rule's final step (§2.1) — tombstone FIRST, then the record.
import { test } from './helpers/node-test.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRecordStore, newRecord } from '../lib/records.mjs';
import { createRedactor } from '../lib/redact.mjs';

export async function ac97_tombstoneBeforeUnlink() {
  const root = mkdtempSync(join(tmpdir(), 'ap-records-'));
  try {
    const runs = join(root, 'runs'); mkdirSync(runs);
    const paths = { runsDir: runs, record: (n) => join(runs, `${n}.json`), tombstone: (n) => join(runs, `${n}.tombstone.json`) };
    const store = createRecordStore({ paths, redactor: createRedactor({ secretValues: [] }) });
    store.save({ ...newRecord({ issue: 7, token: 'a'.repeat(64), baseOid: 'b'.repeat(40), branch: 'adlc/autopilot/issue-7', stagingBranch: null, stagingPath: null, finalPath: join(root, 'wt') }), lastPushedOid: 'c'.repeat(40) });
    // The tombstone write is made to FAIL (its path is a directory): the record must survive.
    mkdirSync(paths.tombstone(7));
    assert.throws(() => store.remove(7), /EISDIR|ENOTDIR|EEXIST|EPERM|is a directory/i, 'a failed tombstone write is an error');
    assert.ok(existsSync(paths.record(7)), 'the record is NOT deleted when its tombstone could not be written');
    rmSync(paths.tombstone(7), { recursive: true, force: true });
    const cur = store.remove(7);
    assert.equal(cur.lastPushedOid, 'c'.repeat(40));
    assert.ok(!existsSync(paths.record(7)) && store.tombstone(7)?.lastPushedOid === 'c'.repeat(40), 'tombstone carries lastPushedOid and the record is gone');
  } finally { rmSync(root, { recursive: true, force: true }); }
}
test('AC97: a run record is removed only AFTER its tombstone is durable — a failed tombstone write leaves the record in place', ac97_tombstoneBeforeUnlink);
