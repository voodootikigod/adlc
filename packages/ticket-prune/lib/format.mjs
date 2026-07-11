// format.mjs — human-readable + JSON rendering for a runTicketPrune() result.

export function renderReport(result) {
  const { baseRef, write, stale, active, tombstoned = [], needsCeremony = [] } = result;
  const lines = [];
  lines.push(`ticket-prune — base ref: ${baseRef} (${write ? 'write' : 'dry-run'})`);
  lines.push('');

  if (write) {
    if (tombstoned.length === 0) {
      lines.push('No stale tickets tombstoned.');
    } else {
      lines.push(`Tombstoned ${tombstoned.length} stale ticket(s) with completed:true in place:`);
      for (const t of tombstoned) lines.push(`  - ${t.id}: ${t.reason}`);
    }
  } else if (stale.length === 0) {
    lines.push('No stale tickets found.');
  } else {
    lines.push(`Stale tickets (${stale.length}) — re-run with --write to tombstone them:`);
    for (const r of stale) lines.push(`  - ${r.id}: ${r.reason}`);
  }

  if (needsCeremony.length > 0) {
    lines.push('');
    lines.push(
      `Stale but not auto-tombstonable — needs the protected-base admin ceremony (${needsCeremony.length}):`,
    );
    for (const t of needsCeremony) {
      const detail =
        t.blocker === 'rails-freeze'
          ? `freezes: ${t.rails.join(', ')}`
          : 'already has a completed field';
      lines.push(`  - ${t.id}: ${t.reason} [${detail}]`);
    }
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
  const { baseRef, write, stale, active, tombstoned = [], needsCeremony = [] } = result;
  return { baseRef, write, stale, active, tombstoned, needsCeremony };
}
