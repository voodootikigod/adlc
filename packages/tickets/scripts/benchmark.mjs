#!/usr/bin/env node
import { performance } from 'node:perf_hooks';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACTIVE_MANIFEST, DirectoryTicketStore, TicketService, prettyCanonicalJson, ticketFilename } from '../index.mjs';

const argv = process.argv.slice(2);
const valueAfter = (flag, fallback) => {
  const index = argv.indexOf(flag);
  return index < 0 ? fallback : Number(argv[index + 1]);
};
const count = valueAfter('--tickets', 1000);
const assertCeilings = argv.includes('--assert-ceilings');
const json = argv.includes('--json');
const ceilings = { createFixtureMs: 15000, coldLoadMs: 5000, lookupsMs: 1000, singleWriteMs: 5000 };
const root = mkdtempSync(join(tmpdir(), 'adlc-ticket-benchmark-'));
try {
  const storePath = join(root, '.adlc/tickets');
  mkdirSync(storePath, { recursive: true });
  const startFixture = performance.now();
  writeFileSync(join(storePath, '.store.json'), prettyCanonicalJson(ACTIVE_MANIFEST));
  for (let index = 0; index < count; index += 1) {
    const ticket = { id: `BENCH-${String(index).padStart(6, '0')}`, title: `Benchmark ${index}`, scope: [], rails: [], edges: [] };
    writeFileSync(join(storePath, ticketFilename(ticket.id)), prettyCanonicalJson(ticket));
  }
  const createFixtureMs = performance.now() - startFixture;
  const store = new DirectoryTicketStore(storePath);
  const startLoad = performance.now();
  const snapshot = store.load();
  const coldLoadMs = performance.now() - startLoad;
  const startLookups = performance.now();
  for (const ticket of snapshot.tickets) if (!snapshot.get(ticket.id)) throw new Error(`lookup failed: ${ticket.id}`);
  const lookupsMs = performance.now() - startLookups;
  const service = new TicketService(store, { root });
  const first = snapshot.tickets[0];
  const plan = service.planUpdate(first.id, { ...first, title: `${first.title} updated` }, { expect: snapshot.ticketHashes[first.id] });
  const startWrite = performance.now();
  service.apply(plan);
  const singleWriteMs = performance.now() - startWrite;
  const measurements = { tickets: count, createFixtureMs, coldLoadMs, lookupsMs, singleWriteMs };
  const failures = assertCeilings ? Object.entries(ceilings).filter(([name, limit]) => measurements[name] > limit).map(([name, limit]) => `${name} ${measurements[name].toFixed(2)}ms > ${limit}ms`) : [];
  const report = { ok: failures.length === 0, measurements, ceilings, failures };
  if (json) console.log(JSON.stringify(report, null, 2));
  else console.log(report);
  if (failures.length) process.exitCode = 2;
} finally { rmSync(root, { recursive: true, force: true }); }
