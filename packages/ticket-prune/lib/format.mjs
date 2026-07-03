// format.mjs — human-readable + JSON rendering for a runTicketPrune() result.

export function renderReport(result) {
  const { baseRef, write, stale, active, archived } = result;
  const lines = [];
  lines.push(`ticket-prune — base ref: ${baseRef} (${write ? 'write' : 'dry-run'})`);
  lines.push('');

  if (write) {
    if (archived.length === 0) {
      lines.push('No stale tickets archived.');
    } else {
      lines.push(`Archived ${archived.length} stale ticket(s) to .adlc/tickets.archive.json:`);
      for (const t of archived) lines.push(`  - ${t.id}: ${t.archiveReason}`);
    }
  } else if (stale.length === 0) {
    lines.push('No stale tickets found.');
  } else {
    lines.push(`Stale tickets (${stale.length}) — re-run with --write to archive them:`);
    for (const r of stale) lines.push(`  - ${r.id}: ${r.reason}`);
  }

  lines.push('');
  lines.push(`Active tickets (${active.length}):`);
  if (active.length === 0) {
    lines.push('  (none)');
  } else {
    for (const r of active) lines.push(`  - ${r.id}: ${r.reason}`);
  }

  return lines.join('\n');
}

export function toJson(result) {
  const { baseRef, write, stale, active, archived } = result;
  return { baseRef, write, stale, active, archived };
}
