import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { LEGACY_FILE } from '../constants.mjs';
import { invalid, operational, policy } from '../errors.mjs';
import { validateTickets } from '../schema.mjs';
import { TicketSnapshot } from '../snapshot.mjs';

/**
 * READ-ONLY, like every other store class here.
 *
 * This used to expose a `write(tickets)` that validated and replaced the whole
 * store directly — no rails check, no key, no evidence — while being a declared,
 * public entrypoint. Once any ticket declares a rail the store is a frozen trust
 * root and every write to it is an audited override, so a writer that skips that
 * is a hole in the contract regardless of who calls it. Writes go through
 * applyLegacyTransaction, which journals, verifies, and records.
 *
 * `write` survives as a refusal rather than being deleted: it was in the published
 * .d.ts, so a downstream caller that still reaches for it gets a message naming the
 * replacement instead of `write is not a function`. It never writes.
 */
export class LegacyTicketStore {
  constructor(path = LEGACY_FILE) {
    this.path = path;
  }

  exists() {
    return existsSync(this.path);
  }

  write() {
    throw policy(
      'READ_ONLY_STORE',
      'LegacyTicketStore.write was removed: it replaced the whole store with no rails check, no signing ' +
      'key and no manifest evidence, which is an unaudited write to a trust root. Use ' +
      'applyLegacyTransaction (or TicketService), which journals the change, verifies it, and records ' +
      'the audit entry.',
    );
  }

  load() {
    if (!this.exists()) throw operational('STORE_NOT_FOUND', `tickets file not found: ${this.path}`);
    const stat = lstatSync(this.path);
    if (stat.isSymbolicLink() || !stat.isFile()) throw invalid('UNSAFE_STORE_PATH', `${this.path} must be a regular file`);
    const parentStat = lstatSync(dirname(this.path));
    if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) throw invalid('UNSAFE_STORE_PATH', `${dirname(this.path)} must be a real directory`);
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(this.path, 'utf8'));
    } catch (error) {
      throw invalid('INVALID_JSON', `invalid JSON in ${this.path}: ${error.message}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.tickets)) {
      throw invalid('INVALID_ENVELOPE', `${this.path} must contain { "tickets": [...] }`);
    }
    validateTickets(parsed.tickets);
    return new TicketSnapshot({ backend: 'legacy', formatVersion: 0, tickets: parsed.tickets });
  }
}
