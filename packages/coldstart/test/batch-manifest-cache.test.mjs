import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ticketHash } from '@adlc/tickets';
import { signEntry } from '@adlc/gate-manifest/lib/sign.mjs';
import { checkAll, DEFAULT_LLM_CONCURRENCY } from '../lib/gate.mjs';
import { indexManifestByTicket, buildCacheData } from '../lib/cache.mjs';
import { TICKET_TEXT_MAX_CHARS, ticketToText } from '../lib/prompt.mjs';

const KEY = 'batch-manifest-cache-test-key';
const MODEL = 'claude-haiku-4-5';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeSignedEntry(ticket, gaps, seq = 1, model = MODEL) {
  const entry = {
    seq,
    gate: 'coldstart',
    ts: new Date().toISOString(),
    ticket: ticket.id,
    files: {},
    prev: null,
    data: {
      cache: buildCacheData({
        ticketHash: ticketHash(ticket),
        model,
        gaps,
        textChars: ticketToText(ticket).length,
        cap: TICKET_TEXT_MAX_CHARS,
      }),
    },
  };
  return { ...entry, sig: signEntry(KEY, entry) };
}

test('indexManifestByTicket groups only coldstart entries with non-empty string ticket ids', () => {
  const idx = indexManifestByTicket([
    { gate: 'coldstart', ticket: 'T1', seq: 1 },
    { gate: 'other-gate', ticket: 'T1', seq: 2 },
    { gate: 'coldstart', ticket: 'T2', seq: 3 },
    { gate: 'coldstart', ticket: 'T1', seq: 4 },
    { gate: 'coldstart', ticket: '', seq: 5 },
    null,
  ]);
  assert.equal(idx.size, 2);
  assert.deepEqual(idx.get('T1').map((e) => e.seq), [1, 4]);
  assert.deepEqual(idx.get('T2').map((e) => e.seq), [3]);
});

test('checkAll loads the manifest forest exactly once across N tickets (O(T + M))', async () => {
  const tickets = Array.from({ length: 8 }, (_, i) => ({
    id: `T-${i + 1}`,
    title: `Ticket ${i + 1}`,
    body: `Implement feature ${i + 1}`,
  }));
  const oversize = {
    id: 'T-OVER',
    title: 'Oversize',
    body: 'x'.repeat(TICKET_TEXT_MAX_CHARS + 500),
  };

  // Pre-cache tickets 1..5; tickets 6..8 will miss cache.
  const entries = tickets.slice(0, 5).map((t, i) => makeSignedEntry(t, [], i + 1));
  entries.push({ seq: 99, gate: 'prosecute', ticket: 'T-1', ts: new Date().toISOString(), files: {}, prev: null, data: {} });

  let loadCalls = 0;
  let auditedIds = [];
  const res = await checkAll([...tickets, oversize], 'cheap', {
    key: KEY,
    resolveModelFn: () => MODEL,
    loadAllCacheEntriesFn: () => {
      loadCalls++;
      return { entries, skipped: [{ line: 1, raw: '{bad' }] };
    },
    checkTicketFn: async (ticket) => {
      auditedIds.push(ticket.id);
      return { id: ticket.id, gaps: [], usage: null };
    },
  });

  assert.equal(loadCalls, 1, 'manifest forest must be loaded exactly once per checkAll');
  assert.equal(res.length, 9);
  for (let i = 0; i < 5; i++) {
    assert.equal(res[i].cached, true);
    assert.equal(res[i].cacheSkipped, 1);
  }
  for (let i = 5; i < 8; i++) {
    assert.equal(res[i].cached, false);
    assert.equal(res[i].cacheSkipped, 1);
  }
  assert.equal(res[8].oversize, true);
  assert.deepEqual(auditedIds, ['T-6', 'T-7', 'T-8']);
});

test('checkAll reads real root manifest.jsonl and manifest.d/*.jsonl segments in a single pass', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-coldstart-batch-'));
  try {
    mkdirSync(join(dir, 'manifest.d'), { recursive: true });
    const t1 = { id: 'T-ROOT', title: 'Root cached', body: 'Body 1' };
    const t2 = { id: 'T-SEG', title: 'Segment cached', body: 'Body 2' };
    const t3 = { id: 'T-MISS', title: 'Uncached', body: 'Body 3' };

    writeFileSync(join(dir, 'manifest.jsonl'), `${JSON.stringify(makeSignedEntry(t1, [], 1))}\n`);
    writeFileSync(
      join(dir, 'manifest.d', 'feat-test-01ARZ3NDEKTSV4RRFFQ69G5FAV.jsonl'),
      `${JSON.stringify(makeSignedEntry(t2, [{ what: 'gap', why_blocking: 'reason' }], 1))}\n`,
    );

    const audited = [];
    const results = await checkAll([t1, t2, t3], 'cheap', {
      dir,
      key: KEY,
      resolveModelFn: () => MODEL,
      checkTicketFn: async (ticket) => {
        audited.push(ticket.id);
        return { id: ticket.id, gaps: [], usage: null };
      },
    });

    assert.equal(results[0].cached, true);
    assert.deepEqual(results[0].gaps, []);
    assert.equal(results[1].cached, true);
    assert.equal(results[1].gaps.length, 1);
    assert.equal(results[2].cached, false);
    assert.deepEqual(audited, ['T-MISS']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkAll executes uncached audits with bounded concurrency, preserves order, and fails fast', async () => {
  assert.equal(DEFAULT_LLM_CONCURRENCY, 4);
  const tickets = Array.from({ length: 6 }, (_, i) => ({
    id: `T-${i}`,
    title: `Ticket ${i}`,
    body: `Body ${i}`,
  }));

  let inFlight = 0;
  let maxInFlight = 0;
  const results = await checkAll(tickets, 'cheap', {
    force: true,
    concurrency: 2,
    checkTicketFn: async (ticket) => {
      inFlight++;
      if (inFlight > maxInFlight) maxInFlight = inFlight;
      // Reverse completion timing to prove output order matches input order.
      const idx = Number(ticket.id.split('-')[1]);
      await delay((6 - idx) * 6);
      inFlight--;
      return { id: ticket.id, gaps: [], usage: null };
    },
  });

  assert.equal(maxInFlight, 2);
  assert.deepEqual(results.map((r) => r.id), tickets.map((t) => t.id));

  // Fail-fast stops dequeuing remaining items.
  let started = 0;
  await assert.rejects(
    () => checkAll(tickets, 'cheap', {
      force: true,
      concurrency: 2,
      checkTicketFn: async (ticket) => {
        started++;
        if (ticket.id === 'T-0') throw new Error('boom-0');
        await delay(20);
        return { id: ticket.id, gaps: [], usage: null };
      },
    }),
    /boom-0/,
  );
  assert.ok(started <= 3, `fail-fast should stop starting queued items (started=${started})`);
});

test('checkAll falls back to DEFAULT_LLM_CONCURRENCY on invalid concurrency value', async () => {
  const res = await checkAll([{ id: 'T-1', title: 'A', body: 'B' }], 'cheap', {
    force: true,
    concurrency: 0,
    checkTicketFn: async (t) => ({ id: t.id, gaps: [], usage: null }),
  });
  assert.equal(res[0].id, 'T-1');
});
