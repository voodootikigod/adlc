import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { applyLegacyTransaction } from '../transaction.mjs';
import { LEGACY_FILE } from '../constants.mjs';
import { invalid, operational } from '../errors.mjs';
import { validateTickets } from '../schema.mjs';
import { TicketSnapshot } from '../snapshot.mjs';

/**
 * The repository whose trust-root evidence governs a write to `path`.
 *
 * `dirname(dirname(path))` is correct for `<root>/.adlc/tickets.json` and for nothing
 * else. A store configured somewhere else — ADLC_TICKET_STORE, --ticket-store, a 1.x
 * caller passing its own path — would resolve to an unrelated directory, and the
 * predicate would go looking for the archive, the manifest and the recorded overrides
 * THERE. Finding none, it would read "not a trust root" and let a keyless, unrecorded
 * write through while the store's actual repository is frozen. That is the precise
 * hole this contract exists to close, arrived at from the other direction.
 *
 * So the inference is allowed only where it is sound, and every other path must say
 * which repository it belongs to. Refusing to answer beats answering wrongly.
 */
function repositoryRootFor(path, explicit) {
  if (explicit !== null && explicit !== undefined) return explicit;
  const parent = dirname(path);
  if (basename(path) === basename(LEGACY_FILE) && basename(parent) === dirname(LEGACY_FILE)) {
    return dirname(parent);
  }
  throw invalid(
    'AMBIGUOUS_STORE_ROOT',
    `cannot infer which repository governs ${path}: it is not the canonical <root>/${LEGACY_FILE} layout, ` +
    'so the trust-root evidence (archive, manifest, recorded overrides) would be read from the wrong ' +
    'directory and a frozen store could be written keylessly. Pass an explicit { root }.',
  );
}

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
   * `root` is where the trust-root evidence is read from — the archive, the manifest,
   * and the recorded overrides that decide whether this store is frozen. It is
   * INFERRED only for the canonical `<root>/.adlc/tickets.json` layout, which keeps
   * the 1.x one-argument call working; anywhere else it must be passed, because
   * guessing wrong is not a cosmetic error (see repositoryRootFor).
   */
  write(tickets, { key = null, allowUnsigned = false, root = null } = {}) {
    return applyLegacyTransaction(this, tickets, {
      root: repositoryRootFor(this.path, root), operation: 'update', key, allowUnsigned,
    });
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
