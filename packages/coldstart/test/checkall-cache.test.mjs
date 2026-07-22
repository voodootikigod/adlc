// checkall-cache.test.mjs — issue #278: checkAll's content-addressed caching,
// exercised with injected checkTicketFn/loadCacheEntriesFn/resolveModelFn so
// these are fast, offline, deterministic call-count assertions — no network,
// no real gate-manifest files. See coldstart-cache-e2e.test.mjs for the
// real-ledger, real-record()-round-trip version of the same behavior.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkAll } from '../lib/gate.mjs';
import { ticketHash } from '@adlc/tickets';

const MODEL = 'claude-haiku-4-5';

/**
 * An in-memory stand-in for the gate-manifest ledger: a plain array the test
 * controls directly, plus a call-counting checkTicketFn that "records" into
 * it exactly like the real bin does after a real audit.
 */
function makeFixture({ model = MODEL } = {}) {
  const ledger = []; // manifest-entry-shaped objects, keyed loosely by ticket via .ticket
  let callCount = 0;
  const callsFor = [];

  const checkTicketFn = async (ticket) => {
    callCount++;
    callsFor.push(ticket.id);
    // Deterministic "verdict": pass unless the ticket's title contains "gap".
    const gaps = /gap/i.test(ticket.title ?? '') ? [{ what: 'X', why_blocking: 'Y' }] : [];
    return { id: ticket.id, gaps, usage: null };
  };

  const record = (ticket, gaps, modelUsed = model) => {
    ledger.push({ gate: 'coldstart', ticket: ticket.id, ts: new Date().toISOString(), data: { cache: { ticketHash: ticketHash(ticket), model: modelUsed, gaps } } });
  };

  const loadCacheEntriesFn = (ticketId) => ledger.filter((e) => e.ticket === ticketId);
  const resolveModelFn = () => model;

  return {
    get callCount() { return callCount; },
    callsFor,
    record,
    checkTicketFn,
    loadCacheEntriesFn,
    resolveModelFn,
  };
}

test('two consecutive checkAll runs over an unchanged store call checkTicketFn only on the first run', async () => {
  const fx = makeFixture();
  const tickets = [{ id: 'T1', title: 'Login form' }, { id: 'T2', title: 'Checkout flow' }];

  const first = await checkAll(tickets, 'cheap', {
    checkTicketFn: fx.checkTicketFn,
    loadCacheEntriesFn: fx.loadCacheEntriesFn,
    resolveModelFn: fx.resolveModelFn,
  });
  for (const [i, ticket] of tickets.entries()) fx.record(ticket, first[i].gaps);
  assert.equal(fx.callCount, 2, 'first run audits both tickets fresh');

  const second = await checkAll(tickets, 'cheap', {
    checkTicketFn: fx.checkTicketFn,
    loadCacheEntriesFn: fx.loadCacheEntriesFn,
    resolveModelFn: fx.resolveModelFn,
  });
  assert.equal(fx.callCount, 2, 'second run over the SAME tickets must not call checkTicketFn again');
  assert.ok(second.every((r) => r.cached === true), 'every result on the second run must be served from cache');
  assert.deepEqual(second.map((r) => r.gaps), first.map((r) => r.gaps), 'cached gaps must match what was recorded');
});

test('editing one ticket re-audits only that ticket on the second run', async () => {
  const fx = makeFixture();
  const tickets = [{ id: 'T1', title: 'Login form' }, { id: 'T2', title: 'Checkout flow' }];

  const first = await checkAll(tickets, 'cheap', {
    checkTicketFn: fx.checkTicketFn, loadCacheEntriesFn: fx.loadCacheEntriesFn, resolveModelFn: fx.resolveModelFn,
  });
  for (const [i, ticket] of tickets.entries()) fx.record(ticket, first[i].gaps);
  assert.equal(fx.callCount, 2);

  // T1's content changes (different hash); T2 stays identical.
  const editedTickets = [{ id: 'T1', title: 'Login form, now with 2FA' }, { id: 'T2', title: 'Checkout flow' }];
  const second = await checkAll(editedTickets, 'cheap', {
    checkTicketFn: fx.checkTicketFn, loadCacheEntriesFn: fx.loadCacheEntriesFn, resolveModelFn: fx.resolveModelFn,
  });

  assert.equal(fx.callCount, 3, 'only the edited ticket should trigger a fresh audit');
  assert.deepEqual(fx.callsFor, ['T1', 'T2', 'T1'], 'the re-audit call must be for the edited ticket, T1');
  assert.equal(second.find((r) => r.id === 'T1').cached, false);
  assert.equal(second.find((r) => r.id === 'T2').cached, true);
});

test('--force re-audits everything even when every ticket has a fresh cache hit available', async () => {
  const fx = makeFixture();
  const tickets = [{ id: 'T1', title: 'Login form' }];

  const first = await checkAll(tickets, 'cheap', {
    checkTicketFn: fx.checkTicketFn, loadCacheEntriesFn: fx.loadCacheEntriesFn, resolveModelFn: fx.resolveModelFn,
  });
  fx.record(tickets[0], first[0].gaps);
  assert.equal(fx.callCount, 1);

  const forced = await checkAll(tickets, 'cheap', {
    force: true,
    checkTicketFn: fx.checkTicketFn, loadCacheEntriesFn: fx.loadCacheEntriesFn, resolveModelFn: fx.resolveModelFn,
  });
  assert.equal(fx.callCount, 2, '--force must bypass the cache entirely');
  assert.equal(forced[0].cached, false);
});

test('--max-age 0 treats every cache entry as stale — re-audits despite an unchanged ticket', async () => {
  const fx = makeFixture();
  const tickets = [{ id: 'T1', title: 'Login form' }];

  const first = await checkAll(tickets, 'cheap', {
    checkTicketFn: fx.checkTicketFn, loadCacheEntriesFn: fx.loadCacheEntriesFn, resolveModelFn: fx.resolveModelFn,
  });
  fx.record(tickets[0], first[0].gaps);
  assert.equal(fx.callCount, 1);

  const withMaxAgeZero = await checkAll(tickets, 'cheap', {
    maxAgeMs: 0,
    now: Date.now() + 1, // strictly after the recorded entry's timestamp
    checkTicketFn: fx.checkTicketFn, loadCacheEntriesFn: fx.loadCacheEntriesFn, resolveModelFn: fx.resolveModelFn,
  });
  assert.equal(fx.callCount, 2, '--max-age 0 must not honor even a just-written cache entry');
  assert.equal(withMaxAgeZero[0].cached, false);
});

test('a cache entry recorded under one model does not cover a run under a different resolved model (ADLC_MODEL_CHEAP changed)', async () => {
  const fx = makeFixture({ model: 'claude-haiku-4-5' });
  const tickets = [{ id: 'T1', title: 'Login form' }];

  const first = await checkAll(tickets, 'cheap', {
    checkTicketFn: fx.checkTicketFn, loadCacheEntriesFn: fx.loadCacheEntriesFn, resolveModelFn: fx.resolveModelFn,
  });
  fx.record(tickets[0], first[0].gaps, 'claude-haiku-4-5');
  assert.equal(fx.callCount, 1);

  // Simulate ADLC_MODEL_CHEAP now resolving to a different model id.
  const second = await checkAll(tickets, 'cheap', {
    checkTicketFn: fx.checkTicketFn,
    loadCacheEntriesFn: fx.loadCacheEntriesFn,
    resolveModelFn: () => 'gemini-2.5-flash',
  });
  assert.equal(fx.callCount, 2, 'a model change must invalidate the cache, even for an unchanged ticket');
  assert.equal(second[0].cached, false);
});

test('when no provider is configured (resolveModelFn returns null), the cache is skipped and checkTicketFn still runs (existing no-provider error path is untouched)', async () => {
  const fx = makeFixture();
  const tickets = [{ id: 'T1', title: 'Login form' }];
  const result = await checkAll(tickets, 'cheap', {
    checkTicketFn: fx.checkTicketFn,
    loadCacheEntriesFn: fx.loadCacheEntriesFn,
    resolveModelFn: () => null,
  });
  assert.equal(fx.callCount, 1);
  assert.equal(result[0].cached, false);
});
