// outcomes.mjs — reduce gate-manifest evidence to a per-ticket status (pure).
//
// Entries are the append-only ledger rows; only TICKET-BOUND entries
// ({ ticket, gate, seq|ts, data? }) contribute. Reduction = latest entry per
// (ticket, gate). The published status is derived from the latest P5 entry only:
// NO P5 entry → null (never fabricate a pass). This is the single source mapping
// raw evidence to the display status that status-render turns into a label/comment.

const P5_GATES = new Set(['p5', 'p5-complete', 'prosecution']);

const seqOf = (e) => (typeof e?.seq === 'number' ? e.seq : Date.parse(e?.ts ?? '') || 0);

function deriveStatus(gates) {
  let p5 = null;
  for (const g of P5_GATES) {
    const e = gates[g];
    if (e && (!p5 || seqOf(e) >= seqOf(p5))) p5 = e;
  }
  if (!p5) return null; // no P5 evidence → no status (no fabricated pass)
  const v = p5.data?.verdict;
  if (v === 'clear' || v === 'pass' || v === 'passed') return 'p5-pass';
  if (v === 'blocked' || v === 'fail' || v === 'failed') return 'p5-fail';
  return 'wip';
}

/**
 * @param {Array<{ticket?, gate, seq?, ts?, data?}>} entries
 * @returns {Map<string, {ticket, gates: object, status: string|null}>}
 */
export function reduceTicketOutcomes(entries) {
  const byTicket = new Map();
  for (const e of entries ?? []) {
    if (!e || typeof e.ticket !== 'string' || typeof e.gate !== 'string') continue;
    let rec = byTicket.get(e.ticket);
    if (!rec) { rec = { ticket: e.ticket, gates: {} }; byTicket.set(e.ticket, rec); }
    const prev = rec.gates[e.gate];
    if (!prev || seqOf(e) >= seqOf(prev)) rec.gates[e.gate] = e; // latest per gate
  }
  for (const rec of byTicket.values()) rec.status = deriveStatus(rec.gates);
  return byTicket;
}

/** Convenience: the derived status for one ticket id, or null. */
export function statusForTicket(entries, ticketId) {
  return reduceTicketOutcomes(entries).get(ticketId)?.status ?? null;
}
