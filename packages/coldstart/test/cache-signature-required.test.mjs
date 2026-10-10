// cache-signature-required.test.mjs — issue #595: a cached coldstart verdict is
// served only from a manifest entry whose signature verifies under the
// operator's key. The ledger is committed repo content, so an entry anyone can
// write must not be able to green the gate; without a key the cache is simply
// unavailable and the ticket is re-audited.
//
// Same injected-ledger style as checkall-cache.test.mjs: no network, no files.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkAll, cacheLookupState, isMockSeamActive } from '../lib/gate.mjs';
import { trustedCacheEntries } from '../lib/cache.mjs';
import { ticketHash } from '@adlc/tickets';
import { signEntry } from '@adlc/gate-manifest/lib/sign.mjs';
import { TICKET_TEXT_MAX_CHARS } from '../lib/prompt.mjs';

const MODEL = 'claude-haiku-4-5';
const KEY = 'test-signing-key-595';
const OTHER_KEY = 'a-different-key';

function entryFor(ticket, { gaps = [], model = MODEL, key = null, seq = 1 } = {}) {
  const entry = {
    seq,
    gate: 'coldstart',
    ts: new Date().toISOString(),
    ticket: ticket.id,
    data: { tier: 'cheap', cache: { ticketHash: ticketHash(ticket), model, gaps } },
    files: {},
    prev: null,
  };
  return key ? { ...entry, sig: signEntry(key, entry) } : entry;
}

function makeFixture({ entries = [], skipped = [] } = {}) {
  let callCount = 0;
  const checkTicketFn = async (ticket) => {
    callCount++;
    return { id: ticket.id, gaps: [], usage: null };
  };
  const loadCacheEntriesFn = (ticketId) => ({
    entries: entries.filter((e) => e.ticket === ticketId),
    skipped,
  });
  return { get callCount() { return callCount; }, checkTicketFn, loadCacheEntriesFn, resolveModelFn: () => MODEL };
}

const T1 = { id: 'T1', title: 'Login form', body: 'Create login.' };

test('AC1: an UNSIGNED entry whose ticketHash and model match is not served — the ticket is re-audited', async () => {
  const fx = makeFixture({ entries: [entryFor(T1)] });
  const results = await checkAll([T1], 'cheap', { key: KEY, ...fx });
  assert.equal(fx.callCount, 1, 'checkTicketFn must run: an unsigned entry proves nothing');
  assert.equal(results[0].cached, false);
});

test('AC2: an entry signed under a DIFFERENT key is not served', async () => {
  const fx = makeFixture({ entries: [entryFor(T1, { key: OTHER_KEY })] });
  const results = await checkAll([T1], 'cheap', { key: KEY, ...fx });
  assert.equal(fx.callCount, 1);
  assert.equal(results[0].cached, false);
});

test('AC2: an entry whose gaps were tampered after signing is not served', async () => {
  const signed = entryFor(T1, { gaps: [{ what: 'missing schema', why_blocking: 'cannot start' }], key: KEY });
  const tampered = { ...signed, data: { ...signed.data, cache: { ...signed.data.cache, gaps: [] } } };
  const fx = makeFixture({ entries: [tampered] });
  const results = await checkAll([T1], 'cheap', { key: KEY, ...fx });
  assert.equal(fx.callCount, 1, 'a tampered PASS must not be served');
  assert.equal(results[0].cached, false);
});

test('AC3: a correctly signed entry under the supplied key IS served and the provider is not called', async () => {
  const gaps = [{ what: 'missing schema', why_blocking: 'cannot start' }];
  const fx = makeFixture({ entries: [entryFor(T1, { gaps, key: KEY })] });
  const results = await checkAll([T1], 'cheap', { key: KEY, ...fx });
  assert.equal(fx.callCount, 0, 'a verified entry is a real cache hit');
  assert.equal(results[0].cached, true);
  assert.deepEqual(results[0].gaps, gaps);
});

test('AC4: with no key, a correctly signed entry is NOT consulted — the cache is unavailable, the provider runs', async () => {
  const fx = makeFixture({ entries: [entryFor(T1, { key: KEY })] });
  const results = await checkAll([T1], 'cheap', { key: null, ...fx });
  assert.equal(fx.callCount, 1);
  assert.equal(results[0].cached, false);
  assert.equal(results[0].cacheSkipped, 0, 'the ledger was never read, so nothing was skipped');
});

test('AC4: omitting opts.key altogether behaves as no key (secure default)', async () => {
  const fx = makeFixture({ entries: [entryFor(T1, { key: KEY })] });
  const results = await checkAll([T1], 'cheap', { ...fx });
  assert.equal(fx.callCount, 1);
  assert.equal(results[0].cached, false);
});

test('AC5: trustedCacheEntries returns a NEW array of only the entries that verify, and [] without a key', () => {
  const good = entryFor(T1, { key: KEY, seq: 1 });
  const bad = entryFor(T1, { key: OTHER_KEY, seq: 2 });
  const unsigned = entryFor(T1, { seq: 3 });
  const input = [good, bad, unsigned];
  const out = trustedCacheEntries(input, { key: KEY });
  assert.deepEqual(out, [good]);
  assert.notEqual(out, input, 'must not return the input array');
  assert.deepEqual(input, [good, bad, unsigned], 'input must not be mutated');
  assert.deepEqual(trustedCacheEntries(input, { key: null }), []);
  assert.deepEqual(trustedCacheEntries(input, { key: '' }), []);
  assert.deepEqual(trustedCacheEntries(input, {}), []);
  assert.deepEqual(trustedCacheEntries([], { key: KEY }), []);
  const onlyGood = trustedCacheEntries([good], { key: KEY });
  assert.notEqual(onlyGood, [good]);
  assert.deepEqual(onlyGood, [good]);
});

test('AC5: cacheSkipped equals the number of unreadable lines the loader reported for that lookup', async () => {
  const skipped = [{ segment: 'root', line: 3, error: 'bad json' }, { segment: 'seg-a', line: 1, error: 'bad json' }];
  const fx = makeFixture({ entries: [entryFor(T1, { key: KEY })], skipped });
  const results = await checkAll([T1], 'cheap', { key: KEY, ...fx });
  assert.equal(results[0].cached, true);
  assert.equal(results[0].cacheSkipped, 2);
});

test('AC5: cacheSkipped is 0 when the cache was not consulted (--force)', async () => {
  const fx = makeFixture({ entries: [entryFor(T1, { key: KEY })], skipped: [{ segment: 'root', line: 1, error: 'x' }] });
  const results = await checkAll([T1], 'cheap', { key: KEY, force: true, ...fx });
  assert.equal(fx.callCount, 1);
  assert.equal(results[0].cached, false);
  assert.equal(results[0].cacheSkipped, 0);
});

test('a loader that returns a bare array (the pre-#595 contract) is an explicit error, not a silent cache miss', async () => {
  const fx = makeFixture({ entries: [entryFor(T1, { key: KEY })] });
  const legacyLoader = (ticketId) => fx.loadCacheEntriesFn(ticketId).entries;
  await assert.rejects(
    () => checkAll([T1], 'cheap', { key: KEY, ...fx, loadCacheEntriesFn: legacyLoader }),
    /cache loader must return \{ entries, skipped \}/
  );
});

test('cacheLookupState: the single decision the bin and checkAll share', () => {
  assert.equal(cacheLookupState({ force: false, model: MODEL, key: KEY, mockSeamActive: false }), 'enabled');
  assert.equal(cacheLookupState({ force: true, model: MODEL, key: KEY, mockSeamActive: false }), 'disabled');
  assert.equal(cacheLookupState({ force: false, model: null, key: KEY, mockSeamActive: false }), 'disabled');
  assert.equal(cacheLookupState({ force: false, model: MODEL, key: KEY, mockSeamActive: true }), 'disabled');
  assert.equal(cacheLookupState({ force: false, model: MODEL, key: null, mockSeamActive: false }), 'no-key');
  assert.equal(cacheLookupState({ force: false, model: MODEL, key: '', mockSeamActive: false }), 'no-key');
  assert.equal(cacheLookupState({ force: false, model: MODEL, key: undefined, mockSeamActive: false }), 'no-key');
  // --force with no key is 'disabled', not 'no-key': the operator chose to skip the cache, so no notice is owed.
  assert.equal(cacheLookupState({ force: true, model: MODEL, key: null, mockSeamActive: false }), 'disabled');
});

test('a one-character key is a key: an entry signed under it is served (the empty-string check is exact)', async () => {
  const shortKey = 'k';
  const fx = makeFixture({ entries: [entryFor(T1, { key: shortKey })] });
  const results = await checkAll([T1], 'cheap', { key: shortKey, ...fx });
  assert.equal(fx.callCount, 0);
  assert.equal(results[0].cached, true);
  assert.deepEqual(trustedCacheEntries([entryFor(T1, { key: shortKey })], { key: shortKey }).length, 1);
});

test('the ADLC_GATE_MOCK_RESPONSE test seam still never reads the cache, even with a key and a signed hit available', async () => {
  const origMock = process.env.ADLC_GATE_MOCK_RESPONSE;
  const origNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  process.env.ADLC_GATE_MOCK_RESPONSE = '{"gaps":[]}';
  try {
    const fx = makeFixture({ entries: [entryFor(T1, { key: KEY })], skipped: [{ segment: 'root', line: 1, error: 'x' }] });
    const results = await checkAll([T1], 'cheap', { key: KEY, ...fx });
    assert.equal(fx.callCount, 1, 'the injected checkTicketFn must run — the cache must not shadow the seam');
    assert.equal(results[0].cached, false);
    assert.equal(results[0].cacheSkipped, 0, 'the ledger was not consulted');
  } finally {
    if (origMock === undefined) delete process.env.ADLC_GATE_MOCK_RESPONSE; else process.env.ADLC_GATE_MOCK_RESPONSE = origMock;
    if (origNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = origNodeEnv;
  }
});

test('isMockSeamActive needs BOTH the mock response and NODE_ENV=test — either alone leaves the cache in force', () => {
  assert.equal(isMockSeamActive({ ADLC_GATE_MOCK_RESPONSE: '{"gaps":[]}', NODE_ENV: 'test' }), true);
  assert.equal(isMockSeamActive({ ADLC_GATE_MOCK_RESPONSE: '{"gaps":[]}', NODE_ENV: 'production' }), false, 'the seam is test-only (F5)');
  assert.equal(isMockSeamActive({ ADLC_GATE_MOCK_RESPONSE: '{"gaps":[]}' }), false);
  assert.equal(isMockSeamActive({ NODE_ENV: 'test' }), false, 'NODE_ENV=test alone must not disable the cache');
  assert.equal(isMockSeamActive({}), false);
});

test('under NODE_ENV=test with NO mock response, a signed entry is still a cache hit', async () => {
  const origNodeEnv = process.env.NODE_ENV;
  const origMock = process.env.ADLC_GATE_MOCK_RESPONSE;
  process.env.NODE_ENV = 'test';
  delete process.env.ADLC_GATE_MOCK_RESPONSE;
  try {
    const fx = makeFixture({ entries: [entryFor(T1, { key: KEY })] });
    const results = await checkAll([T1], 'cheap', { key: KEY, ...fx });
    assert.equal(fx.callCount, 0);
    assert.equal(results[0].cached, true);
  } finally {
    if (origNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = origNodeEnv;
    if (origMock !== undefined) process.env.ADLC_GATE_MOCK_RESPONSE = origMock;
  }
});

test('a loader that returns null or undefined is the same explicit error, never a TypeError', async () => {
  const fx = makeFixture({ entries: [entryFor(T1, { key: KEY })] });
  for (const bad of [null, undefined, {}, { entries: [] }, { skipped: [] }]) {
    await assert.rejects(
      () => checkAll([T1], 'cheap', { key: KEY, ...fx, loadCacheEntriesFn: () => bad }),
      /^Error: coldstart: cache loader must return \{ entries, skipped \}/,
      `loader returning ${JSON.stringify(bad)}`
    );
  }
});

test('an over-cap ticket is refused before the cache: the loader is never called and cacheSkipped is 0 even when the ledger has unreadable lines', async () => {
  const huge = { id: 'T-HUGE', title: 'Too big to audit', body: 'x'.repeat(TICKET_TEXT_MAX_CHARS + 1) };
  let loaderCalls = 0;
  const fx = makeFixture({ entries: [entryFor(huge, { key: KEY })], skipped: [{ segment: 'root', line: 2, error: 'bad json' }] });
  const loadCacheEntriesFn = (id) => { loaderCalls++; return fx.loadCacheEntriesFn(id); };
  const results = await checkAll([huge], 'cheap', { key: KEY, ...fx, loadCacheEntriesFn });
  assert.equal(loaderCalls, 0, 'no cache lookup for a ticket the auditor cannot see whole');
  assert.equal(fx.callCount, 0, 'no audit either — the overflow is the gap');
  assert.equal(results[0].oversize, true);
  assert.equal(results[0].cached, false);
  assert.equal(results[0].cacheSkipped, 0, 'nothing was read, so nothing was skipped');
  assert.equal(results[0].gaps.length, 1);
});
