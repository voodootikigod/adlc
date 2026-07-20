// format.mjs — human-readable + JSON rendering for a runTicketPrune() result.

export function renderReport(result) {
  const { baseRef, write, stale, active, tombstoned = [], archived = [], needsCeremony = [] } = result;
  const lines = [];
  // `--ceremony` is deprecated (#208) and returns before rendering, so the only
  // in-place write this tool reports is tombstoning under --write.
  const mode = write ? 'write' : 'dry-run';
  lines.push(`ticket-prune — base ref: ${baseRef} (${mode})`);
  lines.push('');

  if (write) {
    // Legacy stores tombstone (completed:true in place); directory stores archive
    // (move the shard). Surface BOTH — an archived ticket is removed from the
    // active store, so omitting it would let output claim "nothing changed" after
    // a real mutation.
    if (tombstoned.length === 0 && archived.length === 0) {
      lines.push('No stale tickets tombstoned or archived.');
    }
    if (tombstoned.length > 0) {
      lines.push(`Tombstoned ${tombstoned.length} rails-less stale ticket(s) with completed:true in place:`);
      for (const t of tombstoned) lines.push(`  - ${t.id}: ${t.reason}`);
    }
    if (archived.length > 0) {
      lines.push(`Archived ${archived.length} rails-less stale ticket(s) out of the active directory store:`);
      for (const a of archived) lines.push(`  - ${a?.id ?? a}`);
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
  const { baseRef, write, ceremony = false, stale, active, tombstoned = [], archived = [], ceremonyCompleted = [], needsCeremony = [] } = result;
  // `archived` is the directory-store mutation (moved shards); omitting it would
  // make `--json` under-report what --write actually changed on that backend.
  return { baseRef, write, ceremony, stale, active, tombstoned, archived, ceremonyCompleted, needsCeremony };
}
