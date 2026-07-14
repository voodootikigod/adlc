import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DirectoryTicketStore, doctorTicketStore } from '../index.mjs';
import { ticket, writeDirectory } from './helpers.mjs';

test('doctor is read-only and reports active/archive/runtime health', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-tickets-doctor-'));
  try {
    const path = writeDirectory(root, [ticket('A')]);
    const before = readdirSync(join(root, '.adlc')).sort();
    const report = doctorTicketStore(new DirectoryTicketStore(path), { root, archive: true });
    assert.equal(report.ok, true);
    assert.deepEqual(readdirSync(join(root, '.adlc')).sort(), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
