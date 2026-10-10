// coldstart-cache-e2e.test.mjs — issue #278: the real gate-manifest ledger
// round-trip. checkall-cache.test.mjs proves the caching LOGIC with injected
// fixtures; this proves the actual record() -> loadFiltered() ->
// trustedCacheEntries() -> findCachedVerdict() wiring works against real
// files, the same way bin/coldstart.mjs uses it. checkTicketFn is still
// injected (a call-counting stub) — no network — but the manifest reads/writes
// are real.
//
// Issue #595: the cache is served only from entries whose signature verifies
// under the operator's key, so every record() here signs under KEY and every
// checkAll call that expects a hit passes the same KEY. An entry recorded with
// `key: null` is no longer a cache hit — that was the defect, not a regression.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { tmp } from '@adlc/core/test-kit';
import { checkAll } from '../lib/gate.mjs';
import { buildCacheData } from '../lib/cache.mjs';
import { TICKET_TEXT_MAX_CHARS, ticketToText } from '../lib/prompt.mjs';
import { ticketHash } from '@adlc/tickets';
import { record } from '@adlc/gate-manifest/lib/record.mjs';

const KEY = 'coldstart-cache-e2e-key';
const MODEL = 'claude-haiku-4-5';

function makeCallCountingCheckTicketFn() {
  let count = 0;
  const fn = async (ticket) => {
    count++;
    return { id: ticket.id, gaps: [], usage: null };
  };
  fn.count = () => count;
  return fn;
}

function recordPass(dir, ticket, { key = KEY, gaps = [] } = {}) {
  record({
    key,
    gate: 'coldstart',
    ticket: ticket.id,
    dir,
    rawData: JSON.stringify({ tier: 'cheap', cache: buildCacheData({ ticketHash: ticketHash(ticket), model: MODEL, gaps, textChars: ticketToText(ticket).length, cap: TICKET_TEXT_MAX_CHARS }) }),
  });
}

test('real gate-manifest round-trip: a run over an unchanged ticket, against a REAL signed prior manifest entry, is a cache hit', async (t) => {
  const dir = tmp(t, 'coldstart-cache-e2e-');
  const ticket = { id: 'T1', title: 'Login form', body: 'Create login.' };

  // Simulate a prior real coldstart run having recorded a PASS under the key.
  recordPass(dir, ticket);

  const checkTicketFn = makeCallCountingCheckTicketFn();
  const results = await checkAll([ticket], 'cheap', {
    dir,
    key: KEY,
    checkTicketFn,
    resolveModelFn: () => MODEL,
  });

  assert.equal(checkTicketFn.count(), 0, 'a real cache hit against the real ledger must skip checkTicketFn entirely');
  assert.equal(results[0].cached, true);
  assert.deepEqual(results[0].gaps, []);
  assert.equal(results[0].cacheSkipped, 0);
});

test('real gate-manifest round-trip: a genuinely unrecorded ticket runs fresh, then a second checkAll call against the same dir sees it in the ledger', async (t) => {
  const dir = tmp(t, 'coldstart-cache-e2e-');
  const ticket = { id: 'T1', title: 'Login form', body: 'Create login.' };
  const checkTicketFn = makeCallCountingCheckTicketFn();

  const first = await checkAll([ticket], 'cheap', { dir, key: KEY, checkTicketFn, resolveModelFn: () => MODEL });
  assert.equal(checkTicketFn.count(), 1, 'nothing recorded yet — must run fresh');
  assert.equal(first[0].cached, false);

  // Mirror what bin/coldstart.mjs does after checkAll returns: record the result under the key.
  recordPass(dir, ticket, { gaps: first[0].gaps });

  const second = await checkAll([ticket], 'cheap', { dir, key: KEY, checkTicketFn, resolveModelFn: () => MODEL });
  assert.equal(checkTicketFn.count(), 1, 'the second checkAll call must find the just-recorded entry and skip the LLM call');
  assert.equal(second[0].cached, true);
});

test('real gate-manifest round-trip: a recorded --record-verdict entry (no data.cache) is not mistaken for a cache hit', async (t) => {
  const dir = tmp(t, 'coldstart-cache-e2e-');
  const ticket = { id: 'T1', title: 'Login form' };

  // A --prompt-only --record-verdict entry has data.verdict, not data.cache.
  record({ key: KEY, gate: 'coldstart', ticket: ticket.id, dir, rawData: JSON.stringify({ promptOnly: true, verdict: 'PASS: looks fine.' }) });

  const checkTicketFn = makeCallCountingCheckTicketFn();
  const results = await checkAll([ticket], 'cheap', { dir, key: KEY, checkTicketFn, resolveModelFn: () => MODEL });

  assert.equal(checkTicketFn.count(), 1, 'a promptOnly/record-verdict entry must never be treated as a cache hit');
  assert.equal(results[0].cached, false);
});

test('AC6 (#595): a ledger line appended by hand WITHOUT a signature is not a cache hit, while the signed entry beside it still is', async (t) => {
  const dir = tmp(t, 'coldstart-cache-e2e-');
  const signedTicket = { id: 'T1', title: 'Login form', body: 'Create login.' };
  const forgedTicket = { id: 'T2', title: 'Checkout flow', body: 'Create checkout.' };

  // A real prior run recorded T1 under the key.
  recordPass(dir, signedTicket);

  // Someone appends a PASS for T2 by hand — correct hash, correct model, no sig.
  const ledgerFile = join(dir, 'manifest.jsonl');
  const lines = readFileSync(ledgerFile, 'utf8').trim().split('\n');
  const forged = {
    seq: lines.length + 1,
    gate: 'coldstart',
    ts: new Date().toISOString(),
    ticket: forgedTicket.id,
    data: { tier: 'cheap', cache: buildCacheData({ ticketHash: ticketHash(forgedTicket), model: MODEL, gaps: [], textChars: ticketToText(forgedTicket).length, cap: TICKET_TEXT_MAX_CHARS }) },
    files: {},
    prev: null,
  };
  appendFileSync(ledgerFile, `${JSON.stringify(forged)}\n`);

  const checkTicketFn = makeCallCountingCheckTicketFn();
  const results = await checkAll([signedTicket, forgedTicket], 'cheap', { dir, key: KEY, checkTicketFn, resolveModelFn: () => MODEL });

  assert.equal(results.find((r) => r.id === 'T1').cached, true, 'the signed entry is still served');
  assert.equal(results.find((r) => r.id === 'T2').cached, false, 'the hand-written unsigned line must not green T2');
  assert.equal(checkTicketFn.count(), 1, 'exactly the forged ticket was re-audited');
});

test('#595: an entry recorded WITHOUT a key (the pre-fix fixture) is not served even when checkAll has a key', async (t) => {
  const dir = tmp(t, 'coldstart-cache-e2e-');
  const ticket = { id: 'T1', title: 'Login form', body: 'Create login.' };
  recordPass(dir, ticket, { key: null });

  const checkTicketFn = makeCallCountingCheckTicketFn();
  const results = await checkAll([ticket], 'cheap', { dir, key: KEY, checkTicketFn, resolveModelFn: () => MODEL });
  assert.equal(checkTicketFn.count(), 1, 'an unsigned entry proves nothing — re-audit');
  assert.equal(results[0].cached, false);
});

test('#595: a correctly signed entry is NOT served when checkAll runs without a key (no key, no cache)', async (t) => {
  const dir = tmp(t, 'coldstart-cache-e2e-');
  const ticket = { id: 'T1', title: 'Login form', body: 'Create login.' };
  recordPass(dir, ticket);

  const checkTicketFn = makeCallCountingCheckTicketFn();
  const results = await checkAll([ticket], 'cheap', { dir, checkTicketFn, resolveModelFn: () => MODEL });
  assert.equal(checkTicketFn.count(), 1);
  assert.equal(results[0].cached, false);
  assert.equal(results[0].cacheSkipped, 0, 'the ledger was not read at all');
});

test('#595: an unreadable ledger line is counted in cacheSkipped rather than silently dropped', async (t) => {
  const dir = tmp(t, 'coldstart-cache-e2e-');
  const ticket = { id: 'T1', title: 'Login form', body: 'Create login.' };
  recordPass(dir, ticket);
  appendFileSync(join(dir, 'manifest.jsonl'), 'this is not json\n');

  const checkTicketFn = makeCallCountingCheckTicketFn();
  const results = await checkAll([ticket], 'cheap', { dir, key: KEY, checkTicketFn, resolveModelFn: () => MODEL });
  assert.equal(results[0].cached, true, 'the readable signed entry is still served');
  assert.equal(results[0].cacheSkipped, 1, 'the corrupt line is reported, not hidden');
});
