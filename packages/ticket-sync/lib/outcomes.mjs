// outcomes.mjs — reduce gate-manifest evidence to a per-ticket status (pure).
//
// Entries are the append-only ledger rows; only TICKET-BOUND entries
// ({ ticket, gate, seq|ts, data? }) contribute. Reduction = latest entry per
// (ticket, gate). The published status is derived from the latest P5 entry only:
// NO P5 entry → null (never fabricate a pass). This is the single source mapping
// raw evidence to the display status that status-render turns into a label/comment.

const P5_GATES = new Set(['p5', 'p5-complete', 'prosecution']);

// `seq` is only monotonic WITHIN one manifest chain. Once the manifest is
// segmented (docs/specs/segmented-gate-manifest.md), root and each lineage
// segment restart `seq` at 1, so comparing raw seq VALUES across chains is
// meaningless — a segment's seq=1 could lose to the root's seq=50 even though
// it was recorded later. Note the ts fallback is intentionally VALUE-based and
// order-independent within a single chain (see outcomes.test.mjs's "NOT array
// order" test); `reduceTicketOutcomes` below layers chain-position priority on
// TOP of this for the cross-chain case, so both properties hold.
const seqOf = (e) => (typeof e?.seq === 'number' ? e.seq : Date.parse(e?.ts ?? '') || 0);

function deriveStatus(gates, chainIndexOf) {
  let p5 = null;
  let p5ChainIndex = null; // no numeric sentinel needed — the p5-is-still-unset check alone gates the first assignment
  for (const g of P5_GATES) {
    const e = gates[g];
    if (!e) continue;
    const ci = chainIndexOf(g);
    if (p5 === null || ci > p5ChainIndex || (ci === p5ChainIndex && seqOf(e) >= seqOf(p5))) { p5 = e; p5ChainIndex = ci; }
  }
  if (!p5) return null; // no P5 evidence → no status (no fabricated pass)
  const v = p5.data?.verdict;
  if (v === 'clear' || v === 'pass' || v === 'passed') return 'p5-pass';
  if (v === 'blocked' || v === 'fail' || v === 'failed') return 'p5-fail';
  return 'wip';
}

/**
 * `input` is either a flat array of entries from ONE chain (plain `seq`/`ts`
 * comparison decides "latest", robust to entries arriving out of array
 * order), or — for T-MANIFEST-FOREST's readOwnChains — an array of chains in
 * causal order (root first, at most one segment last). A later chain's entry
 * ALWAYS outranks an earlier chain's for the same (ticket, gate) regardless
 * of the seq values involved (adversarial-review finding: each chain
 * restarts `seq` at 1, so a raw comparison could let a stale root entry
 * outrank a causally-later segment one); only entries already known to be
 * from the SAME chain are compared by seq/ts.
 * @param {Array<object>|Array<Array<object>>} input
 * @returns {Map<string, {ticket, gates: object, status: string|null}>}
 */
export function reduceTicketOutcomes(input) {
  const chains = Array.isArray(input?.[0]) ? input : [input ?? []];
  const byTicket = new Map(); // ticket -> { ticket, gates, gateChainIndex: Map(gate -> chainIndex), status }
  chains.forEach((chain, chainIndex) => {
    for (const e of chain ?? []) {
      if (!e || typeof e.ticket !== 'string' || typeof e.gate !== 'string') continue;
      let rec = byTicket.get(e.ticket);
      if (!rec) { rec = { ticket: e.ticket, gates: {}, gateChainIndex: new Map() }; byTicket.set(e.ticket, rec); }
      const prev = rec.gates[e.gate];
      const prevChainIndex = rec.gateChainIndex.get(e.gate);
      const wins = !prev || chainIndex > prevChainIndex
        || (chainIndex === prevChainIndex && seqOf(e) >= seqOf(prev));
      if (wins) { rec.gates[e.gate] = e; rec.gateChainIndex.set(e.gate, chainIndex); } // latest per gate
    }
  });
  for (const rec of byTicket.values()) {
    rec.status = deriveStatus(rec.gates, (gate) => rec.gateChainIndex.get(gate) ?? 0);
    delete rec.gateChainIndex; // internal bookkeeping only, not part of the returned shape
  }
  return byTicket;
}

/** Convenience: the derived status for one ticket id, or null. */
export function statusForTicket(entries, ticketId) {
  return reduceTicketOutcomes(entries).get(ticketId)?.status ?? null;
}
