// oversized-ticket.test.mjs — a ticket the auditor cannot see whole is not
// audited at all; it fails the gate deterministically.
//
// The fence hands the model at most TICKET_TEXT_MAX_CHARS of the serialized
// ticket. Past that, a clean verdict is a verdict on a prefix: the acceptance
// criteria after the cut were never read, yet the recorded result is bound to
// the FULL ticket's hash. No model call can make that sound, so the gate does
// not make one — it reports the overflow as the gap, costs nothing, and the
// operator splits the ticket.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCheckTicket, checkAll, oversizeGap } from '../lib/gate.mjs';
import { TICKET_TEXT_MAX_CHARS, ticketToText } from '../lib/prompt.mjs';
import { ticketHash } from '@adlc/tickets';

/** A ticket whose serialization is exactly `chars` long (ticketToText adds JSON framing). */
function ticketOfExactly(chars, id = 'T-SIZE', extra = {}) {
  // An empty body is omitted from the serialization, so measure the framing
  // with a one-char body and subtract that char. `extra` fields count too.
  const base = { id, title: 'Sized', ...extra };
  const framing = ticketToText({ ...base, body: 'x' }).length - 1;
  const t = { ...base, body: 'x'.repeat(chars - framing) };
  assert.equal(ticketToText(t).length, chars, 'fixture must serialize to exactly the requested length');
  return t;
}

const refuseToCall = async () => { throw new Error('the model must not be called for an over-cap ticket'); };
const neverParses = () => { throw new Error('nothing to parse'); };

test('oversizeGap: null at the cap, a gap one char past it — the boundary is the cap itself', () => {
  assert.equal(oversizeGap(ticketOfExactly(TICKET_TEXT_MAX_CHARS)), null);
  const gap = oversizeGap(ticketOfExactly(TICKET_TEXT_MAX_CHARS + 1));
  assert.ok(gap, 'one char over the cap is over');
  assert.equal(typeof gap.what, 'string');
  assert.match(gap.why_blocking, new RegExp(`${TICKET_TEXT_MAX_CHARS + 1}`), 'names the actual size');
  assert.match(gap.why_blocking, new RegExp(`${TICKET_TEXT_MAX_CHARS}`), 'names the cap');
});

test('checkTicket does not call the model for an over-cap ticket and returns the overflow as the only gap', async () => {
  const check = buildCheckTicket(refuseToCall, neverParses, 'cheap');
  const result = await check(ticketOfExactly(TICKET_TEXT_MAX_CHARS + 500, 'T-BIG'));
  assert.equal(result.id, 'T-BIG');
  assert.equal(result.gaps.length, 1, 'exactly one gap: the overflow');
  assert.deepEqual(result.gaps[0], oversizeGap(ticketOfExactly(TICKET_TEXT_MAX_CHARS + 500, 'T-BIG')));
  assert.equal(result.usage, null, 'no model call, so no usage to report');
});

test('checkTicket still calls the model for a ticket exactly at the cap', async () => {
  let calls = 0;
  const complete = async () => { calls++; return '{"gaps": []}'; };
  const check = buildCheckTicket(complete, JSON.parse, 'cheap');
  const result = await check(ticketOfExactly(TICKET_TEXT_MAX_CHARS));
  assert.equal(calls, 1);
  assert.deepEqual(result.gaps, []);
});

test('checkAll: a legacy clean cache entry cannot rescue an over-cap ticket — it fails without a model call', async () => {
  const big = ticketOfExactly(TICKET_TEXT_MAX_CHARS + 1, 'T-HUGE');
  const ledger = [{ gate: 'coldstart', ticket: big.id, ts: new Date().toISOString(), data: { cache: { ticketHash: ticketHash(big), model: 'm', gaps: [] } } }];
  let modelCalls = 0;
  const results = await checkAll([big], 'cheap', {
    checkTicketFn: buildCheckTicket(async () => { modelCalls++; return '{"gaps": []}'; }, JSON.parse, 'cheap'),
    loadCacheEntriesFn: (id) => ledger.filter((e) => e.ticket === id),
    resolveModelFn: () => 'm',
  });
  assert.equal(modelCalls, 0);
  assert.equal(results[0].cached, false, 'a prefix audit is not evidence about the whole ticket');
  assert.equal(results[0].gaps.length, 1);
  assert.match(results[0].gaps[0].why_blocking, /split/);
});

// An overflow is a refusal to audit, not an audit: there is no model verdict
// to cache and the ledger must not grow by one unusable entry per rerun.
test('checkAll marks an over-cap result oversize and buildRecordPlan records nothing for it', async () => {
  const { buildRecordPlan } = await import('../lib/cache.mjs');
  const big = ticketOfExactly(TICKET_TEXT_MAX_CHARS + 1, 'T-HUGE');
  const results = await checkAll([big], 'cheap', {
    checkTicketFn: buildCheckTicket(refuseToCall, neverParses, 'cheap'),
    loadCacheEntriesFn: () => [],
    resolveModelFn: () => 'm',
  });
  assert.equal(results[0].oversize, true);
  assert.deepEqual(buildRecordPlan(results, [big], { model: 'm', tier: 'cheap' }), []);
});

test('checkAll refuses an over-cap ticket BEFORE the cache lookup and before any checkTicketFn', async () => {
  const big = ticketOfExactly(TICKET_TEXT_MAX_CHARS + 1, 'T-HUGE');
  let lookups = 0;
  const results = await checkAll([big], 'cheap', {
    checkTicketFn: async () => { throw new Error('must not be reached'); },
    loadCacheEntriesFn: () => { lookups++; return []; },
    resolveModelFn: () => 'm',
  });
  assert.equal(lookups, 0, 'a prefix audit can never be a valid hit, so nothing is looked up');
  assert.equal(results[0].gaps.length, 1);
  assert.equal(results[0].cached, false);
});

test('the ADLC_GATE_MOCK_RESPONSE test seam cannot pass an over-cap ticket', async (t) => {
  const prev = { mock: process.env.ADLC_GATE_MOCK_RESPONSE, env: process.env.NODE_ENV };
  process.env.ADLC_GATE_MOCK_RESPONSE = '{"gaps": []}';
  process.env.NODE_ENV = 'test';
  t.after(() => {
    if (prev.mock === undefined) delete process.env.ADLC_GATE_MOCK_RESPONSE; else process.env.ADLC_GATE_MOCK_RESPONSE = prev.mock;
    if (prev.env === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prev.env;
  });
  const big = ticketOfExactly(TICKET_TEXT_MAX_CHARS + 1, 'T-HUGE');
  const results = await checkAll([big], 'cheap');
  assert.equal(results[0].gaps.length, 1, 'the mocked clean verdict must not be served for a ticket the auditor could not see whole');
  assert.equal(results[0].oversize, true);
});

// --offline is the deterministic input-contract check; "the auditor cannot see
// this ticket whole" is an input-contract failure, so offline reports it too.
test('checkTicketOffline reports an over-cap ticket as a gap, alongside its other checks', async () => {
  const { checkTicketOffline } = await import('../lib/gate.mjs');
  const big = ticketOfExactly(TICKET_TEXT_MAX_CHARS + 1, 'T-HUGE', { scope: ['src/**'] });
  const result = checkTicketOffline(big, [big]);
  assert.equal(result.offline, true);
  assert.deepEqual(result.gaps, [oversizeGap(big)], 'an otherwise valid over-cap ticket has exactly the overflow gap');
  const fits = ticketOfExactly(TICKET_TEXT_MAX_CHARS, 'T-FITS', { scope: ['src/**'] });
  assert.deepEqual(checkTicketOffline(fits, [fits]).gaps, [], 'exactly at the cap is not over');
});
