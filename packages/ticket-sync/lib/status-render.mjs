// status-render.mjs — turn a derived status into the DISPLAY-ONLY artifacts pushed
// to an issue: a mutually-exclusive `adlc:` label set and a canonical,
// timestamp-free status comment (pure). Nothing here is authoritative — the local
// manifest is the source of truth; these are for humans looking at the tracker.
// Timestamp-free so re-rendering the same status is byte-identical (push idempotency).

export const STATUS_COMMENT_MARKER = '<!-- adlc:status -->';

const DEFAULT_TEXT = {
  'p5-pass': 'ADLC P5 prosecution: CLEAR — change earned its merge.',
  'p5-fail': 'ADLC P5 prosecution: BLOCKED — see findings.',
  wip: 'ADLC: in progress.',
};

/** The canonical comment body for a status (anchored, timestamp-free). */
export function renderComment(status) {
  const body = status ? DEFAULT_TEXT[status] ?? `ADLC status: ${status}` : 'ADLC: no gate evidence recorded yet.';
  return `${STATUS_COMMENT_MARKER}\n${body}`;
}

/**
 * @param {string|null} status
 * @param {{statusLabels?: Record<string,string>}} cfg
 * @returns {{ add: string[], remove: string[], comment: string }}
 *   `add` = the single label for this status (mutually exclusive); `remove` = the
 *   other `adlc:` status labels to clear.
 */
export function renderStatus(status, { statusLabels = {} } = {}) {
  const all = [...new Set(Object.values(statusLabels))];
  const wanted = status && statusLabels[status] ? statusLabels[status] : null;
  return {
    add: wanted ? [wanted] : [],
    remove: all.filter((l) => l !== wanted),
    comment: renderComment(status),
  };
}
