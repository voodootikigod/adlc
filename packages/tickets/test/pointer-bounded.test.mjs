// The pointer read must be BOUNDED and NON-BLOCKING against a hostile
// `.adlc/current-ticket.json` (issue #341). The pointer path can be an untrusted,
// event-supplied root (herdr Phase 2 was its first such caller), so a FIFO must
// not block the reader and an enormous file must not be slurped whole.
//
// Fail-CLOSED contract (see pointer.mjs): a file that EXISTS but we cannot
// safely read is a deny (ok:false), never "no active ticket" (present:true/false
// with ok:true) — that would silently disable enforcement.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readActiveTicketPointer } from '../lib/pointer.mjs';

/** A repo root with a `.adlc/` dir; `place` populates the pointer path. */
function repo(place) {
  const root = mkdtempSync(join(tmpdir(), 'adlc-pointer-dos-'));
  mkdirSync(join(root, '.adlc'), { recursive: true });
  place(join(root, '.adlc', 'current-ticket.json'), root);
  return root;
}

test('a directory at the pointer path fails CLOSED (not present:false, not a throw)', () => {
  const root = repo((p) => mkdirSync(p, { recursive: true })); // non-regular file
  const res = readActiveTicketPointer(root);
  assert.equal(res.ok, false, 'a non-regular pointer must deny, never resolve to "no active ticket"');
});

test('a pointer larger than the read cap is not slurped whole — it fails CLOSED', () => {
  // A well-formed pointer whose id value alone exceeds the cap: an UNBOUNDED read
  // would parse it and resolve; a BOUNDED read truncates mid-string → invalid
  // JSON → deny. This is what distinguishes bounded from unbounded.
  const huge = 'a'.repeat(256 * 1024);
  const root = repo((p) => writeFileSync(p, JSON.stringify({ id: huge })));
  const res = readActiveTicketPointer(root);
  assert.equal(res.ok, false, 'an over-cap pointer must be rejected, not read in full');
});

test('a well-formed small pointer still resolves (bounding must not regress the happy path)', () => {
  const root = repo((p) => writeFileSync(p, JSON.stringify({ id: 'T1', ticketHash: 'a'.repeat(64) })));
  const res = readActiveTicketPointer(root);
  assert.equal(res.ok, true);
  assert.equal(res.value.present, true);
  assert.equal(res.value.id, 'T1');
});

test('a genuinely absent pointer resolves to "no active ticket" (fail-open is correct ONLY here)', () => {
  const root = repo(() => {}); // nothing written
  const res = readActiveTicketPointer(root);
  assert.equal(res.ok, true);
  assert.equal(res.value.present, false);
});

// POSIX only: a FIFO makes a blocking read hang forever. The bounded reader opens
// O_NONBLOCK, so it must return (fail-closed) instead of hanging. On Windows there
// is no mkfifo; the directory case above already covers the non-regular branch.
test('a FIFO at the pointer path does not block the reader (POSIX)', { skip: process.platform === 'win32' }, () => {
  const root = repo((p) => execFileSync('mkfifo', [p]));
  const res = readActiveTicketPointer(root); // must NOT hang; the test-runner timeout would catch a block
  assert.equal(res.ok, false, 'a FIFO pointer must deny without blocking');
});
