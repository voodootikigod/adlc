// lib/report.mjs — human-readable report rendering for compare output

/**
 * Render a compare result as a human-readable report string.
 */
export function renderReport(result) {
  const { identical, changed, onlyInBefore, onlyInAfter } = result;

  const totalChanged = changed.length + onlyInBefore.length + onlyInAfter.length;
  const errored = changed.filter((c) => hasErrorDiff(c)).length;

  const lines = [];

  // Headline
  lines.push(
    `${identical.length} route${identical.length !== 1 ? 's' : ''} identical, ` +
    `${totalChanged} changed, ` +
    `${errored} errored`
  );
  lines.push('');

  // Routes only in before
  for (const key of onlyInBefore) {
    lines.push(`  - ${key}: route removed (present in before, absent in after)`);
  }

  // Routes only in after
  for (const key of onlyInAfter) {
    lines.push(`  + ${key}: route added (absent in before, present in after)`);
  }

  // Changed routes
  for (const c of changed) {
    lines.push(`  ~ ${c.route}:`);
    for (const d of c.diffs) {
      lines.push(`      ${renderDiff(d)}`);
    }
  }

  return lines.join('\n');
}

function hasErrorDiff(change) {
  return change.diffs.some((d) => d.field === 'error');
}

function renderDiff(d) {
  if (d.field === 'status') {
    return `status: ${d.before} → ${d.after}`;
  }
  if (d.field === 'contentType') {
    return `contentType: "${d.before}" → "${d.after}"`;
  }
  if (d.field === 'error') {
    const before = d.before ?? '(none)';
    const after = d.after ?? '(none)';
    return `error: "${before}" → "${after}"`;
  }
  if (d.field === 'body') {
    if (d.type === 'text') {
      const beforeBytes = d.before?.bytes ?? '?';
      const afterBytes = d.after?.bytes ?? '?';
      return `body (text): hash changed (${beforeBytes}B → ${afterBytes}B)`;
    }
    if (d.type === 'json') {
      const suppressed = d.capped ? (d.total - d.changes.length) : 0;
      const cappedSuffix = d.capped ? ` +${suppressed} more` : '';
      const lines = [`body (json): ${d.changes.length} change${d.changes.length !== 1 ? 's' : ''}${cappedSuffix}:`];
      for (const ch of d.changes) {
        lines.push(`        ${renderJsonChange(ch)}`);
      }
      return lines.join('\n');
    }
  }
  return JSON.stringify(d);
}

function renderJsonChange(ch) {
  switch (ch.type) {
    case 'keyAdded':
      return `+ ${ch.path}: ${JSON.stringify(ch.after)}`;
    case 'keyRemoved':
      return `- ${ch.path}: ${JSON.stringify(ch.before)}`;
    case 'valueChanged':
      return `~ ${ch.path}: ${JSON.stringify(ch.before)} → ${JSON.stringify(ch.after)}`;
    case 'typeChanged':
      return `~ ${ch.path}: type ${typeOf(ch.before)} → ${typeOf(ch.after)}`;
    case 'arrayLengthChanged':
      return `~ ${ch.path}[].length: ${ch.before} → ${ch.after}`;
    default:
      return JSON.stringify(ch);
  }
}

function typeOf(val) {
  if (val === null) return 'null';
  if (Array.isArray(val)) return 'array';
  return typeof val;
}
