// T74 — the p6-accept → ticket-complete reminder bridge. A pure, side-effect-free
// hint: recording an acceptance verdict is evidence, not completion. The reminder
// never mutates the ticket or the ledger — it only points at the command that does.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ticketCompletionReminder, record } from '../lib/record.mjs';

test('reminds for a p6-accept gate that names a ticket', () => {
  const r = ticketCompletionReminder('p6-accept', 'T74');
  assert.match(r, /adlc ticket complete T74 --write/);
  assert.match(r, /--authorize/, 'mentions the railed-ticket authorization');
});

test('also matches the p6-acceptance-packet gate the acceptance path records', () => {
  assert.match(ticketCompletionReminder('p6-acceptance-packet', 'T9'), /adlc ticket complete T9 --write/);
});

test('is silent when there is nothing to remind about', () => {
  assert.equal(ticketCompletionReminder('p6-accept', undefined), null, 'no ticket → no reminder');
  assert.equal(ticketCompletionReminder('p6-accept', ''), null, 'empty ticket → no reminder');
  assert.equal(ticketCompletionReminder('p4-gate', 'T1'), null, 'non-acceptance gate → no reminder');
  assert.equal(ticketCompletionReminder(undefined, 'T1'), null, 'no gate → no reminder');
});

test('the reminder does NOT change recording semantics (no auto-mutation)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gm-reminder-'));
  try {
    const entry = record({ gate: 'p6-accept', ticket: 'T1', dir });
    // What was recorded is exactly a p6-accept evidence entry for T1 — no
    // completed flag, no ticket mutation, nothing the reminder injected.
    assert.equal(entry.gate, 'p6-accept');
    assert.equal(entry.ticket, 'T1');
    assert.equal(entry.data, undefined, 'reminder adds no payload to the recorded entry');
    const manifest = readFileSync(join(dir, 'manifest.jsonl'), 'utf8').trim().split('\n');
    assert.equal(manifest.length, 1, 'exactly one entry recorded — the reminder writes nothing');
    assert.doesNotMatch(manifest[0], /completed/, 'no completion state leaked into the ledger');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
