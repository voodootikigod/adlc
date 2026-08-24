import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { applyLegacyTransaction } from '../transaction.mjs';
import { LEGACY_FILE } from '../constants.mjs';
import { invalid, operational } from '../errors.mjs';
import { validateTickets } from '../schema.mjs';
import { TicketSnapshot } from '../snapshot.mjs';

/**
 * Reads the 1.x single-file store. It has exactly one writer, `write`, and that
 * writer is AUDITED — there is no unaudited door on this class.
 *
 * `write(tickets)` used to validate and replace the whole store directly — no rails
 * check, no key, no evidence — while being a declared, public entrypoint. Once any
 * ticket declares a rail the store is a frozen trust root and every write to it is
 * an audited override, so a writer that skips that is a hole in the contract
 * regardless of who calls it.
 *
 * It is kept as a COMPATIBILITY ADAPTER rather than deleted or turned into a
 * refusal: it was in the published .d.ts, so a 1.x caller keeps working. What
 * changed is what it does underneath — it now routes through applyLegacyTransaction,
 * which journals the change, verifies it, and applies the frozen-trust-root
 * contract. On a store that is not a trust root that is the same observable
 * behaviour as before; on one that is, it refuses without a key instead of writing
 * unaudited, which is the whole point.
 */
export class LegacyTicketStore {
  constructor(path = LEGACY_FILE) {
    this.path = path;
  }

  exists() {
    return existsSync(this.path);
  }

  /**
   * `root` defaults to the repository this store lives in — `<root>/.adlc/tickets.json`
   * — so the 1.x one-argument call keeps working and still resolves the archive and
   * manifest that decide whether this is a trust root.
   */
  write(tickets, { key = null, allowUnsigned = false, root = dirname(dirname(this.path)) } = {}) {
    return applyLegacyTransaction(this, tickets, { root, operation: 'update', key, allowUnsigned });
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
