// cache-truncated-audit.test.mjs — a cached verdict is reusable only when the
// audit it came from saw the WHOLE ticket.
//
// The cache is keyed on the hash of the full ticket, but the auditor only ever
// sees the first TICKET_TEXT_MAX_CHARS of its serialization. A verdict recorded
// while a smaller cap was in force was an audit of a prefix, and the manifest
// still binds it to the full ticket's hash. Raising the cap must therefore not
// turn those entries into cache hits: a 14,000-char ticket audited under the
// 8000 cap would otherwise be served as "fully audited" for 30 days after the
// fix shipped. Each entry records the cap it was audited under; entries that
// predate the field were audited under the legacy 8000.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findCachedVerdict,
  buildCacheData,
  buildRecordPlan,
  GATE_NAME,
  LEGACY_TICKET_TEXT_CAP,
} from '../lib/cache.mjs';
import { TICKET_TEXT_MAX_CHARS, ticketToText } from '../lib/prompt.mjs';
import { ticketHash } from '@adlc/tickets';

function entry({ gate = GATE_NAME, ts = '2026-01-01T00:00:00.000Z', cache } = {}) {
  return { gate, ts, data: { cache } };
}

const KEY = { ticketHash: 'H1', model: 'm' };

test('the legacy cap is the 8000 that every pre-field entry was audited under', () => {
  assert.equal(LEGACY_TICKET_TEXT_CAP, 8000);
  assert.ok(TICKET_TEXT_MAX_CHARS > LEGACY_TICKET_TEXT_CAP, 'the current cap must be the larger one, or the legacy rule is moot');
});

test('buildCacheData records the serialized length and the cap in force, next to hash/model/gaps', () => {
  const data = buildCacheData({ ticketHash: 'H1', model: 'm', gaps: [], textChars: 14_296, cap: 64_000 });
  assert.deepEqual(data, { ticketHash: 'H1', model: 'm', gaps: [], textChars: 14_296, cap: 64_000 });
});

test('buildCacheData fails closed on a missing or malformed textChars/cap rather than writing an unbounded record', () => {
  for (const bad of [undefined, null, -1, 1.5, '8000', NaN]) {
    assert.throws(() => buildCacheData({ ticketHash: 'H1', model: 'm', gaps: [], textChars: bad, cap: 64_000 }), /textChars/);
    assert.throws(() => buildCacheData({ ticketHash: 'H1', model: 'm', gaps: [], textChars: 10, cap: bad }), /cap/);
  }
});

test('zero is a valid length and a valid cap — the guard rejects negatives, not the boundary', () => {
  const data = buildCacheData({ ticketHash: 'H1', model: 'm', gaps: [], textChars: 0, cap: 0 });
  assert.equal(data.textChars, 0);
  assert.equal(data.cap, 0);
  const entries = [entry({ cache: { ticketHash: 'H1', model: 'm', gaps: [], textChars: 0, cap: 0 } })];
  assert.deepEqual(findCachedVerdict(entries, { ...KEY, textChars: 0 }), { gaps: [] });
  assert.equal(findCachedVerdict(entries, { ...KEY, textChars: 1 }), null, 'one char over a zero cap is over');
});

test('a legacy entry (no cap recorded) for a ticket LONGER than 8000 chars is a miss — it was an audit of a prefix', () => {
  const entries = [entry({ cache: { ticketHash: 'H1', model: 'm', gaps: [] } })];
  assert.equal(findCachedVerdict(entries, { ...KEY, textChars: 14_296 }), null);
});

test('a legacy entry for a ticket that fit under 8000 chars is still a hit — that audit saw the whole ticket', () => {
  const entries = [entry({ cache: { ticketHash: 'H1', model: 'm', gaps: [] } })];
  assert.deepEqual(findCachedVerdict(entries, { ...KEY, textChars: 8000 }), { gaps: [] });
});

test('an entry recorded under the current cap is a hit for a ticket within that cap and a miss for one over it', () => {
  const entries = [entry({ cache: { ticketHash: 'H1', model: 'm', gaps: [], textChars: 20_000, cap: 64_000 } })];
  assert.deepEqual(findCachedVerdict(entries, { ...KEY, textChars: 20_000 }), { gaps: [] });
  assert.equal(findCachedVerdict(entries, { ...KEY, textChars: 64_001 }), null);
});

test('an entry whose recorded cap is not a non-negative integer is skipped, never trusted', () => {
  for (const bad of ['64000', -1, 1.5, null, {}]) {
    const entries = [entry({ cache: { ticketHash: 'H1', model: 'm', gaps: [], textChars: 10, cap: bad } })];
    assert.equal(findCachedVerdict(entries, { ...KEY, textChars: 10 }), null, `cap=${JSON.stringify(bad)}`);
  }
});

test('findCachedVerdict refuses a lookup that does not say how long the current ticket is', () => {
  const entries = [entry({ cache: { ticketHash: 'H1', model: 'm', gaps: [] } })];
  assert.throws(() => findCachedVerdict(entries, { ...KEY }), /textChars/);
  assert.throws(() => findCachedVerdict(entries, { ...KEY, textChars: '10' }), /textChars/);
});

test('the newest-first walk skips a truncated legacy entry and still finds an older whole-ticket one', () => {
  // Ticket shrank below the legacy cap, was audited whole (older), then grew
  // past it and was audited as a prefix (newer, legacy). Same hash is
  // impossible for different content — so model this as two entries under
  // different caps for the SAME content: the newer one audited under a cap it
  // did not fit, the older one under a cap it did.
  const entries = [
    entry({ ts: '2026-01-01T00:00:00.000Z', cache: { ticketHash: 'H1', model: 'm', gaps: [{ what: 'old', why_blocking: 'real' }], textChars: 9000, cap: 64_000 } }),
    entry({ ts: '2026-01-02T00:00:00.000Z', cache: { ticketHash: 'H1', model: 'm', gaps: [], textChars: 9000, cap: 8000 } }),
  ];
  const result = findCachedVerdict(entries, { ...KEY, textChars: 9000 });
  assert.deepEqual(result, { gaps: [{ what: 'old', why_blocking: 'real' }] });
});

test('buildRecordPlan records the ticket serialization length and the live cap, so the entry can be judged later', () => {
  const ticket = { id: 'T1', title: 'Long', body: 'x'.repeat(12_000) };
  const results = [{ id: 'T1', gaps: [], usage: null, cached: false }];
  const plan = buildRecordPlan(results, [ticket], { model: 'm', tier: 'cheap' });
  const data = JSON.parse(plan[0].rawData);
  assert.equal(data.cache.ticketHash, ticketHash(ticket));
  assert.equal(data.cache.textChars, ticketToText(ticket).length);
  assert.equal(data.cache.cap, TICKET_TEXT_MAX_CHARS);
});
