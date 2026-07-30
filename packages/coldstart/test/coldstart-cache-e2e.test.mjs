// coldstart-cache-e2e.test.mjs — issue #278: the real gate-manifest ledger
// round-trip. checkall-cache.test.mjs proves the caching LOGIC with injected
// fixtures; this proves the actual record() -> loadFiltered() ->
// findCachedVerdict() wiring works against real files, the same way
// bin/coldstart.mjs uses it. checkTicketFn is still injected (a call-counting
// stub) — no network — but the manifest reads/writes are real.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { checkAll } from '../lib/gate.mjs';
import { buildCacheData } from '../lib/cache.mjs';
import { ticketHash } from '@adlc/tickets';
import { record } from '@adlc/gate-manifest/lib/record.mjs';

function makeTmp() {
  return mkdtempSync(join(tmpdir(), 'coldstart-cache-e2e-'));
}

function cleanTmp(dir) {
  rmSync(dir, { recursive: true, force: true });
}

function makeCallCountingCheckTicketFn() {
  let count = 0;
  const fn = async (ticket) => {
    count++;
    return { id: ticket.id, gaps: [], usage: null };
  };
  fn.count = () => count;
  return fn;
}

test('real gate-manifest round-trip: a run over an unchanged ticket, against a REAL prior manifest entry, is a cache hit', async () => {
  const dir = makeTmp();
  try {
    const ticket = { id: 'T1', title: 'Login form', body: 'Create login.' };
    const model = 'claude-haiku-4-5';

    // Simulate a prior real coldstart run having recorded a PASS.
    record({
      key: null,
      gate: 'coldstart',
      ticket: ticket.id,
      dir,
      rawData: JSON.stringify({ tier: 'cheap', cache: buildCacheData({ ticketHash: ticketHash(ticket), model, gaps: [] }) }),
    });

    const checkTicketFn = makeCallCountingCheckTicketFn();
    const results = await checkAll([ticket], 'cheap', {
      dir,
      checkTicketFn,
      resolveModelFn: () => model,
    });

    assert.equal(checkTicketFn.count(), 0, 'a real cache hit against the real ledger must skip checkTicketFn entirely');
    assert.equal(results[0].cached, true);
    assert.deepEqual(results[0].gaps, []);
  } finally {
    cleanTmp(dir);
  }
});

test('real gate-manifest round-trip: a genuinely unrecorded ticket runs fresh, then a second checkAll call against the same dir sees it in the ledger', async () => {
  const dir = makeTmp();
  try {
    const ticket = { id: 'T1', title: 'Login form', body: 'Create login.' };
    const model = 'claude-haiku-4-5';
    const checkTicketFn = makeCallCountingCheckTicketFn();

    const first = await checkAll([ticket], 'cheap', { dir, checkTicketFn, resolveModelFn: () => model });
    assert.equal(checkTicketFn.count(), 1, 'nothing recorded yet — must run fresh');
    assert.equal(first[0].cached, false);

    // Mirror what bin/coldstart.mjs does after checkAll returns: record the result.
    record({
      key: null,
      gate: 'coldstart',
      ticket: ticket.id,
      dir,
      rawData: JSON.stringify({ tier: 'cheap', cache: buildCacheData({ ticketHash: ticketHash(ticket), model, gaps: first[0].gaps }) }),
    });

    const second = await checkAll([ticket], 'cheap', { dir, checkTicketFn, resolveModelFn: () => model });
    assert.equal(checkTicketFn.count(), 1, 'the second checkAll call must find the just-recorded entry and skip the LLM call');
    assert.equal(second[0].cached, true);
  } finally {
    cleanTmp(dir);
  }
});

test('real gate-manifest round-trip: a recorded --record-verdict entry (no data.cache) is not mistaken for a cache hit', async () => {
  const dir = makeTmp();
  try {
    const ticket = { id: 'T1', title: 'Login form' };
    const model = 'claude-haiku-4-5';

    // A --prompt-only --record-verdict entry has data.verdict, not data.cache.
    record({ key: null, gate: 'coldstart', ticket: ticket.id, dir, rawData: JSON.stringify({ promptOnly: true, verdict: 'PASS: looks fine.' }) });

    const checkTicketFn = makeCallCountingCheckTicketFn();
    const results = await checkAll([ticket], 'cheap', { dir, checkTicketFn, resolveModelFn: () => model });

    assert.equal(checkTicketFn.count(), 1, 'a promptOnly/record-verdict entry must never be treated as a cache hit');
    assert.equal(results[0].cached, false);
  } finally {
    cleanTmp(dir);
  }
});
