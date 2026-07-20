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

  const railsFreeze = needsCeremony.filter((t) => t.blocker === 'rails-freeze');
  const manual = needsCeremony.filter((t) => t.blocker !== 'rails-freeze');

  if (railsFreeze.length > 0) {
    lines.push('');
    lines.push(
      `Shipped but still freezing rails — complete each per-ticket on the protected-base ` +
        `path with \`adlc ticket complete <id> --write --authorize --json\` (${railsFreeze.length}):`,
    );
    for (const t of railsFreeze) lines.push(`  - ${t.id}: ${t.reason} [freezes: ${t.rails.join(', ')}]`);
  }

  if (manual.length > 0) {
    // These carry a `completed` value set on purpose. `adlc ticket complete` would
    // OVERWRITE it — so do NOT advertise the command for them; they need a human
    // decision, not a mechanical completion (mirrors the drift reporter).
    lines.push('');
    lines.push(
      `Already carry a \`completed\` field (someone set it) — needs a manual decision, ` +
        `NOT \`adlc ticket complete\` (which would overwrite it) (${manual.length}):`,
    );
    for (const t of manual) lines.push(`  - ${t.id}: ${t.reason}`);
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
