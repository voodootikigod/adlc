// doctor.mjs — `adlc ticket doctor`: a flat list of READ-ONLY, OFFLINE health
// checks (design D11, MVP). No --fix, no network, no registry — those move to a
// follow-up spec. Exit 2 if any check fails, else 0. The whole module is pure
// filesystem reads: it takes no provider/runner and never writes, so "doctor is
// safe to run anytime" is structurally true, not just asserted.

import { existsSync, statSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTickets } from '@adlc/core';
import { loadConfig } from './config.mjs';
import { validateSyncState } from './validate.mjs';
import { generateAll } from '../scripts/gen-schema.mjs';

// The package's own committed schemas (resolved relative to THIS file, not the
// target repo) — the drift check verifies the installed tool, independent of dir.
const PKG_SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'schemas');
const DEFAULT_LOCK_MAX_AGE_MS = 10 * 60 * 1000; // 10 min; a younger lock = active op

/**
 * Run the offline checks against a repo root.
 * @param {object} opts
 * @param {string} [opts.dir]
 * @param {number} [opts.now]            ms clock (injected for the stale-lock test)
 * @param {number} [opts.lockMaxAgeMs]
 * @param {string} [opts.schemaDir]      override the package schema dir (tests)
 * @returns {{ exitCode: 0|2, ok: boolean, checks: Array<{name,ok,detail}> }}
 */
export function doctor({ dir = '.', now = Date.now(), lockMaxAgeMs = DEFAULT_LOCK_MAX_AGE_MS, schemaDir = PKG_SCHEMA_DIR } = {}) {
  const checks = [];
  const add = (name, ok, detail = null) => checks.push({ name, ok, detail: ok ? null : detail });

  // 1. config present + valid against adlc-config.schema.json (schema-driven validator).
  const cfg = loadConfig(dir);
  add('config-valid', cfg.ok, cfg.errors?.join('; '));

  // 2. tickets.json loads with no relational/schema errors (catches hand-edits).
  const lt = loadTickets(join(dir, '.adlc', 'tickets.json'));
  add('tickets-load', lt.errors.length === 0, lt.errors.join('; '));

  // 3. committed JSON Schemas == regenerated (bedrock drift / tampered install).
  const drift = [];
  try {
    for (const [file, content] of Object.entries(generateAll())) {
      const p = join(schemaDir, file);
      if (!existsSync(p)) { drift.push(`${file} missing`); continue; }
      if (readFileSync(p, 'utf8') !== content) drift.push(`${file} drifted`);
    }
  } catch (e) {
    drift.push(`schema generation failed: ${e.message}`);
  }
  add('schema-drift', drift.length === 0, `${drift.join('; ')} — run: node scripts/gen-schema.mjs`);

  // 4. sidecar checks — ONLY when the file exists. An absent sidecar is healthy
  //    (it is a rebuildable, gitignored cache; fresh clones have none).
  const sidecarPath = join(dir, '.adlc', 'ticket-sync.state.json');
  if (existsSync(sidecarPath)) {
    let parsed = null;
    try {
      parsed = JSON.parse(readFileSync(sidecarPath, 'utf8'));
    } catch (e) {
      add('sidecar-valid', false, `unparseable: ${e.message}`);
    }
    if (parsed) {
      const errs = validateSyncState(parsed);
      add('sidecar-valid', errs.length === 0, errs.join('; '));

      const entries = Object.entries(parsed.tickets ?? {});
      // no two ids may map to one nodeId (a transfer/renumber corruption signal).
      const byNode = new Map();
      for (const [id, e] of entries) {
        if (e?.nodeId) {
          if (!byNode.has(e.nodeId)) byNode.set(e.nodeId, []);
          byNode.get(e.nodeId).push(id);
        }
      }
      const dups = [...byNode.entries()].filter(([, ids]) => ids.length > 1);
      add('sidecar-nodeid-unique', dups.length === 0, dups.map(([n, ids]) => `${n} <- ${ids.join(', ')}`).join('; '));

      // every synced entry carries a syncedHash key (null is fine: a block-less ticket).
      const missing = entries.filter(([, e]) => !(e && 'syncedHash' in e)).map(([id]) => id);
      add('sidecar-syncedhash', missing.length === 0, `entries missing syncedHash: ${missing.join(', ')}`);

      // a leftover pendingCreates entry may mean a create orphaned a remote issue.
      const pend = Object.keys(parsed.pendingCreates ?? {});
      add('sidecar-no-stale-pending', pend.length === 0, `stale pendingCreates (possible orphaned create — reconcile): ${pend.join(', ')}`);
    }
  }

  // 5. stale .adlc/tickets.lock — age-guarded; REPORTED, never removed (mkdir lock
  //    has no holder pid, so age is the only safe signal).
  const lockPath = join(dir, '.adlc', 'tickets.lock');
  if (existsSync(lockPath)) {
    const ageMs = now - statSync(lockPath).mtimeMs;
    const stale = ageMs > lockMaxAgeMs;
    add('lock-not-stale', !stale, `stale lock held ${Math.round(ageMs / 1000)}s (> ${Math.round(lockMaxAgeMs / 1000)}s) — if no ticket op is running, remove .adlc/tickets.lock by hand`);
  }

  const ok = checks.every((c) => c.ok);
  return { exitCode: ok ? 0 : 2, ok, checks };
}
