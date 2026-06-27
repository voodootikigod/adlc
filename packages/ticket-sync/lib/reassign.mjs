// reassign.mjs — id reassignment on create/transfer (design D8/D9). When a local
// `T<n>` ticket is created on the tracker it gets the gh-qualified id; a
// transferred/renumbered issue likewise changes its `gh:` id string. Both must
// rewrite EVERY edge that pointed at the old id (single id space → no dangling
// edges) and carry the ticket's prior gate evidence forward.
//
// Manifest evidence migration is **append-only re-attestation**, NOT an in-place
// rewrite. `.adlc/manifest.jsonl` is a hash-chained, optionally HMAC-signed
// append-only ledger: editing a past entry's `ticket` field would invalidate the
// `prev` chain of every later line and break any `sig`. Instead we APPEND new
// entries that re-bind the old id's latest-per-gate evidence to the new id, with
// a correct chain link and (when a key is set) a fresh signature. `outcomes.mjs`
// reduces latest-per-gate by ticket id, so the new id inherits the status without
// touching history. (Display-only evidence; the ledger stays tamper-evident.)

import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readEntries, appendEntry, sha256 } from '@adlc/core';

/**
 * Reassign one ticket id store-wide (pure, immutable). Returns a NEW ticket array
 * where the ticket whose id === oldId is renamed to newId AND every `edges[].to`
 * equal to oldId (in any ticket) is rewritten to newId. Nothing else changes.
 */
export function reassignId(tickets, oldId, newId) {
  return tickets.map((t) => {
    const sameId = t.id === oldId;
    const hasEdge = Array.isArray(t.edges) && t.edges.some((e) => e?.to === oldId);
    if (!sameId && !hasEdge) return t;
    const next = { ...t };
    if (sameId) next.id = newId;
    if (Array.isArray(t.edges)) next.edges = t.edges.map((e) => (e?.to === oldId ? { ...e, to: newId } : e));
    return next;
  });
}

/**
 * Plan the manifest re-attestation: the latest-per-gate entries currently bound
 * to `oldId` are the evidence to carry forward. Pure (no I/O). Latest wins per
 * gate so a re-attestation never resurrects a superseded verdict.
 * @returns {Array<object>} source entries (one per gate) to re-attest under newId
 */
export function planManifestMigration(entries, oldId) {
  const latestByGate = new Map();
  for (const e of entries ?? []) {
    if (!e || e.ticket !== oldId || typeof e.gate !== 'string') continue;
    const prev = latestByGate.get(e.gate);
    if (!prev || (typeof e.seq === 'number' ? e.seq : 0) >= (typeof prev.seq === 'number' ? prev.seq : 0)) {
      latestByGate.set(e.gate, e);
    }
  }
  return [...latestByGate.values()];
}

// Mirror of @adlc/gate-manifest sign.mjs canonicalEntryBytes — the signed payload
// is { seq, gate, ts, ticket?, data?, files, prev } in this fixed key order, sig
// excluded. Kept local (zero cross-package coupling); pinned by a test.
function canonicalEntryBytes(entry) {
  const c = { seq: entry.seq, gate: entry.gate, ts: entry.ts };
  if (entry.ticket !== undefined) c.ticket = entry.ticket;
  if (entry.data !== undefined) c.data = entry.data;
  c.files = entry.files;
  c.prev = entry.prev;
  return JSON.stringify(c);
}

function lastRawLine(text) {
  const lines = (text ?? '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i].trim()) return lines[i];
  return null;
}

/**
 * Append-only re-attestation of `oldId`'s evidence under `newId`.
 *
 * @param {string} dir         repo root (manifest lives at <dir>/.adlc/manifest.jsonl)
 * @param {string} oldId
 * @param {string} newId
 * @param {object} opts
 * @param {string} opts.now    ISO timestamp for the new entries
 * @param {NodeJS.ProcessEnv} [opts.env]  for the optional ADLC_MANIFEST_KEY
 * @param {(name,dir)=>{entries}} [opts.read]   injectable reader (test seam)
 * @param {(name,entry,dir)=>void} [opts.append] injectable appender (test seam)
 * @param {() => string|null} [opts.readRaw]  raw-ledger reader for chain linking
 * @returns {{ migrated: number, entries: object[] }}
 */
export function migrateManifestEvidence(dir, oldId, newId, { now, env = process.env, read = readEntries, append = appendEntry, readRaw } = {}) {
  const adlcDir = `${dir}/.adlc`;
  const { entries } = read('manifest', adlcDir);
  const sources = planManifestMigration(entries, oldId);
  if (sources.length === 0) return { migrated: 0, entries: [] };

  const key = (() => { const k = env?.ADLC_MANIFEST_KEY; return typeof k === 'string' && k.length ? k : null; })();
  // Chain link: prev = sha256(last raw ledger line). Use the injected raw reader
  // when present (tests), else re-read the file via the same primitive the
  // recorder uses so the byte-exact previous line is hashed.
  const rawTail = typeof readRaw === 'function'
    ? readRaw()
    : lastRawLine(safeReadFile(`${adlcDir}/manifest.jsonl`));
  let prev = rawTail !== null ? sha256(rawTail) : null;
  let seq = entries.length ? Math.max(...entries.map((e) => (typeof e.seq === 'number' ? e.seq : 0))) : 0;

  const out = [];
  for (const src of sources) {
    seq += 1;
    const entry = { seq, gate: src.gate, ts: now };
    entry.ticket = newId;
    entry.data = { ...(src.data ?? {}), migratedFrom: oldId };
    entry.files = src.files ?? {};
    entry.prev = prev;
    if (key) entry.sig = createHmac('sha256', key).update(canonicalEntryBytes(entry)).digest('hex');
    append('manifest', entry, adlcDir);
    out.push(entry);
    // The next entry chains off THIS one's raw bytes (same serialization append uses).
    prev = sha256(JSON.stringify(entry));
  }
  return { migrated: out.length, entries: out };
}

function safeReadFile(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}
