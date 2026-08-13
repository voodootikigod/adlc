/**
 * Deterministic handoff brief — the composed body of a capture.
 *
 * Pure by construction: every input is passed in, nothing is read from disk or
 * a subprocess here. The same inputs must always produce the same bytes,
 * because those bytes are what `content_hash` binds the successor's
 * authorization to — a timestamp or a shuffled section would make the bind
 * unreproducible and the tamper check meaningless.
 *
 * Every section is emitted even when empty, with an explicit `_none_`. A
 * missing section reads as "the composer did not know about this", which is a
 * different claim from "there was nothing".
 */

const NONE = '_none_';

/**
 * @param {unknown} value
 * @returns {string[]} non-empty trimmed lines
 */
function toLines(value) {
  const raw = Array.isArray(value) ? value : [value];
  return raw
    .filter((v) => typeof v === 'string' || typeof v === 'number')
    .flatMap((v) => String(v).split('\n'))
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => line.trim().length > 0);
}

function bullets(value) {
  const lines = toLines(value);
  return lines.length === 0 ? NONE : lines.map((line) => `- ${line}`).join('\n');
}

function block(value) {
  const lines = toLines(value);
  return lines.length === 0 ? NONE : ['```', ...lines, '```'].join('\n');
}

function field(label, value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return `- ${label}: ${text.length > 0 ? text : NONE}`;
}

/**
 * Compose the markdown brief.
 *
 * @param {object} inputs
 * @param {string|null} [inputs.ticketId]
 * @param {string|null} [inputs.ticketTitle]
 * @param {string[]|string|null} [inputs.evidenceTail] recent gate-manifest lines
 * @param {string|null} [inputs.gitBranch]
 * @param {string[]|string|null} [inputs.gitStatus] porcelain status lines
 * @param {string[]|string|null} [inputs.flailSignals] observed flail signals
 * @param {string|null} [inputs.modelNarrative] trailing assistant message
 * @returns {string} markdown
 */
export function composeBrief({
  ticketId = null,
  ticketTitle = null,
  evidenceTail = null,
  gitBranch = null,
  gitStatus = null,
  flailSignals = null,
  modelNarrative = null,
} = {}) {
  const sections = [
    ['Ticket', [field('id', ticketId), field('title', ticketTitle)].join('\n')],
    ['State', [field('branch', gitBranch), '', '**Working tree**', block(gitStatus), '', '**Flail signals**', bullets(flailSignals)].join('\n')],
    ['Evidence', bullets(evidenceTail)],
    ['Model handoff', typeof modelNarrative === 'string' && modelNarrative.trim().length > 0 ? modelNarrative.trim() : NONE],
  ];
  return `${sections.map(([heading, body]) => `## ${heading}\n\n${body}`).join('\n\n')}\n`;
}
