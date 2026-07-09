// rollback.mjs — session-tree-native rollback candidate selection (spec 4.6).
//
// pi's ExtensionCommandContext exposes `fork(entryId)`, which creates a new
// session branching from an earlier entry — a native "undo" that no sibling
// integration has. This module turns the read-only session branch
// (ctx.sessionManager.getBranch(), oldest→leaf) into a NEWEST-FIRST list of
// fork-eligible targets, each labeled with a short digest, PREFERRING entries
// that sit immediately before a recorded gate deny/revert (the state the agent
// was in just before it was stopped — the natural point to roll back to).
//
// The builder is PURE (branch entries in, labeled candidates out) so it is
// fully unit-testable; commands.mjs wires it to ctx.ui.select + ctx.fork.

const ROLLBACK_MAX = 12;
const DIGEST_LEN = 48;

// A gate-event custom entry (recorded by evidence.mjs) that represents a STOP —
// a deny or a revert. These are the anchors we roll back to the state before.
function isStopGateEvent(entry) {
  return (
    entry &&
    entry.type === 'custom' &&
    entry.customType === 'adlc-gate-event' &&
    entry.data &&
    typeof entry.data.type === 'string' &&
    /(-deny|-revert)$/.test(entry.data.type)
  );
}

// Collapse an AgentMessage's content down to a single short line for the label.
// Tolerant of the shapes pi/pi-ai use: content may be a string, an array of
// parts carrying `.text`, or a top-level `.text`.
function messageDigest(entry) {
  const msg = entry.message ?? {};
  const role = typeof msg.role === 'string' ? msg.role : 'msg';
  let text = '';
  const content = msg.content;
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .filter((p) => p && (p.type === 'text' || typeof p.text === 'string'))
      .map((p) => (typeof p.text === 'string' ? p.text : ''))
      .join(' ');
  } else if (typeof msg.text === 'string') {
    text = msg.text;
  }
  const oneLine = text.replace(/\s+/g, ' ').trim();
  const short = oneLine.length > DIGEST_LEN ? `${oneLine.slice(0, DIGEST_LEN - 1)}…` : oneLine || '(no text)';
  const idTag = typeof entry.id === 'string' ? entry.id.slice(0, 8) : '????????';
  return `#${idTag} ${role}: ${short}`;
}

/**
 * Turn a session branch (oldest→leaf, from getBranch()) into a newest-first list
 * of fork-eligible candidates. Only MESSAGE entries are eligible (forking to a
 * model_change/label/custom bookkeeping entry is meaningless). Entries that sit
 * immediately before a recorded deny/revert gate event are marked `preferred`
 * and float to the top of the list, annotated with the gate type they precede.
 *
 * @param {object[]} branch  session entries, oldest first (getBranch())
 * @param {object} [opts]
 * @param {number} [opts.max] cap on returned candidates (default 12)
 * @returns {{id: string, digest: string, label: string, preferred: boolean}[]}
 */
export function buildRollbackCandidates(branch, { max = ROLLBACK_MAX } = {}) {
  const entries = Array.isArray(branch) ? branch : [];

  // For each stop gate event, find the nearest preceding message entry — that
  // is the pre-failure state — and remember the gate type it precedes.
  const annotationByIndex = new Map();
  entries.forEach((e, i) => {
    if (!isStopGateEvent(e)) return;
    for (let j = i - 1; j >= 0; j--) {
      if (entries[j] && entries[j].type === 'message') {
        if (!annotationByIndex.has(j)) annotationByIndex.set(j, e.data.type);
        break;
      }
    }
  });

  const rows = [];
  entries.forEach((e, i) => {
    if (!e || e.type !== 'message' || typeof e.id !== 'string' || e.id === '') return;
    const annotation = annotationByIndex.get(i) ?? null;
    rows.push({
      id: e.id,
      digest: messageDigest(e),
      annotation,
      preferred: annotation != null,
    });
  });

  // Newest first, then stable-partition the preferred (pre-failure) entries to
  // the top so the human's first options are the natural rollback points.
  rows.reverse();
  const preferred = rows.filter((r) => r.preferred);
  const rest = rows.filter((r) => !r.preferred);
  return [...preferred, ...rest].slice(0, max).map((r) => ({
    id: r.id,
    digest: r.digest,
    preferred: r.preferred,
    label: r.annotation ? `⚠ before ${r.annotation} — ${r.digest}` : r.digest,
  }));
}
