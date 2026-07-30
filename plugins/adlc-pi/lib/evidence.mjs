// evidence.mjs — the gate-evidence rail for pi (spec Phase 2.4).
//
// Every gate event is recorded twice: (a) into the pi SESSION file via
// pi.appendEntry('adlc-gate-event', …) so enforcement history survives in the
// session tree, and (b) into the repo's .adlc/manifest.jsonl. The manifest is
// HASH-CHAINED (seq/prev per @adlc/gate-manifest), so the mirror goes through
// gate-manifest's record() — a raw ledger append would corrupt the chain for
// every later entry (see @adlc/build-gate/lib/override.mjs for the same rule).
//
// pi's appendEntry returns void (no entry id), so /tree labels via setLabel
// cannot be attached to these entries today — revisit if pi exposes ids.
//
// Recording is best-effort by contract: a failure degrades to a UI warning
// and must NEVER affect the gate decision that triggered it.

import { join } from 'node:path';
import { record } from '@adlc/gate-manifest/lib/record.mjs';

/**
 * @param {object} opts
 * @param {object} opts.pi - the ExtensionAPI (for session appendEntry)
 * @param {object|null} opts.ctx - event ctx (for degrade-to-warning)
 * @param {string} opts.root - repo root
 * @param {string|null} opts.ticketId
 * @param {string} opts.type - kebab event type, e.g. 'rail-deny', 'suppression-revert'
 * @param {object} [opts.detail]
 */
export function recordGateEvent({ key = null, pi, ctx, root, ticketId, type, detail = {} }) {
  const payload = { type, ticketId: ticketId ?? null, at: new Date().toISOString(), ...detail };

  try {
    pi.appendEntry('adlc-gate-event', payload);
  } catch (err) {
    ctx?.ui?.notify?.(`ADLC: session evidence write failed: ${err.message}`, 'warning');
  }

  try {
    record({
      gate: `pi-${type}`,
      ticket: ticketId ?? undefined,
      rawData: JSON.stringify(detail),
      dir: join(root, '.adlc'),
      key,
    });
  } catch (err) {
    ctx?.ui?.notify?.(`ADLC: manifest evidence write failed: ${err.message}`, 'warning');
  }
}
