// format.mjs — human-readable + JSON rendering for a runTicketPrune() result.

export function renderReport(result) {
  const { baseRef, write, stale, active, tombstoned = [], needsCeremony = [] } = result;
  const lines = [];
  // `--ceremony` is deprecated (#208) and returns before rendering, so the only
  // in-place write this tool reports is tombstoning under --write.
  const mode = write ? 'write' : 'dry-run';
  lines.push(`ticket-prune — base ref: ${baseRef} (${mode})`);
  lines.push('');

  if (write) {
    if (tombstoned.length === 0) {
      lines.push('No stale tickets tombstoned.');
    } else {
      lines.push(`Tombstoned ${tombstoned.length} rails-less stale ticket(s) with completed:true in place:`);
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
      `Stale but not auto-tombstonable — complete each per-ticket on the protected-base ` +
        `path with \`adlc ticket complete <id> --write --authorize --json\` (${needsCeremony.length}):`,
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
  const { baseRef, write, ceremony = false, stale, active, tombstoned = [], ceremonyCompleted = [], needsCeremony = [] } = result;
  return { baseRef, write, ceremony, stale, active, tombstoned, ceremonyCompleted, needsCeremony };
}
