/**
 * Human-readable table formatter for model-router output.
 */

const COL_WIDTHS = {
  id: 12,
  tier: 10,
  mode: 8,
  railDensity: 11,
  float: 6,
  reason: 0, // unbounded
};

function pad(str, width) {
  if (width === 0) return String(str);
  return String(str).padEnd(width);
}

/** Format assignments as a human-readable table. */
export function formatTable(assignments) {
  const header = [
    pad('id', COL_WIDTHS.id),
    pad('tier', COL_WIDTHS.tier),
    pad('mode', COL_WIDTHS.mode),
    pad('railDensity', COL_WIDTHS.railDensity),
    pad('float', COL_WIDTHS.float),
    pad('reason', COL_WIDTHS.reason),
  ].join('  ');

  const sep = '-'.repeat(header.length);

  const rows = assignments.map((a) =>
    [
      pad(a.id, COL_WIDTHS.id),
      pad(a.tier, COL_WIDTHS.tier),
      pad(a.mode, COL_WIDTHS.mode),
      pad(a.railDensity.toFixed(3), COL_WIDTHS.railDensity),
      pad(a.float, COL_WIDTHS.float),
      pad(a.reason, COL_WIDTHS.reason),
    ].join('  ')
  );

  return [header, sep, ...rows].join('\n');
}
