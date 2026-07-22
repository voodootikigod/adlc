/**
 * region.mjs — extract the relevant window(s) of a source file instead of
 * embedding it whole (issue #279). Pure: no I/O.
 *
 * Strategy: scan the test output for `<basename>:<line>` references (the
 * shape stack traces and most test runners emit), window ±contextLines
 * around each referenced line, and merge overlapping/adjacent windows. When
 * no reference is found for a file (or the file is small enough that
 * windowing wouldn't save anything), fall back to showing it in full, capped
 * by the same tail() length limit already used for test output.
 */

import { tail } from './prompt.mjs';

/**
 * Find every line number the test output references for one file, by
 * basename (stack traces rarely repeat the full path the caller passed in,
 * but they do repeat the filename).
 *
 * @param {string} testOutput
 * @param {string} basename
 * @returns {number[]} sorted, deduped line numbers
 */
export function extractLineReferences(testOutput, basename) {
  const escaped = basename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`${escaped}:(\\d+)`, 'g');
  const lines = new Set();
  let match;
  while ((match = re.exec(testOutput)) !== null) {
    const n = Number(match[1]);
    if (Number.isInteger(n) && n > 0) lines.add(n);
  }
  return [...lines].sort((a, b) => a - b);
}

/**
 * Build merged, non-overlapping [start, end] windows (1-indexed, inclusive)
 * around each referenced line, clipped to the file's actual line count.
 * Windows within one line of touching are merged into one, so the excerpt
 * doesn't print a one-line "... 0 lines omitted ..." gap.
 *
 * @param {number[]} refLines
 * @param {number} totalLines
 * @param {number} contextLines
 * @returns {Array<[number, number]>}
 */
export function buildWindows(refLines, totalLines, contextLines) {
  if (refLines.length === 0) return [];
  const raw = refLines
    .map((n) => [Math.max(1, n - contextLines), Math.min(totalLines, n + contextLines)])
    .sort((a, b) => a[0] - b[0]);
  const merged = [raw[0]];
  for (let i = 1; i < raw.length; i++) {
    const last = merged[merged.length - 1];
    const [start, end] = raw[i];
    if (start <= last[1] + 1) {
      last[1] = Math.max(last[1], end);
    } else {
      merged.push([start, end]);
    }
  }
  return merged;
}

/**
 * Render windows as a line-numbered excerpt, marking gaps between windows
 * so the model knows it is NOT seeing the whole file.
 *
 * @param {string} content
 * @param {Array<[number, number]>} windows
 * @returns {string}
 */
export function renderExcerpt(content, windows) {
  const lines = content.split('\n');
  const out = [];
  let prevEnd = 0;
  for (const [start, end] of windows) {
    if (start > prevEnd + 1) out.push(`... ${start - prevEnd - 1} line(s) omitted ...`);
    for (let i = start; i <= end; i++) out.push(`${i}: ${lines[i - 1]}`);
    prevEnd = end;
  }
  if (prevEnd < lines.length) out.push(`... ${lines.length - prevEnd} line(s) omitted ...`);
  return out.join('\n');
}

/**
 * Build the excerpt to embed in the prompt for one file: the windows around
 * every line the test output references it at, or the whole file when it's
 * small enough that windowing buys nothing, or a length-capped tail when
 * neither applies (a real file, no line reference found in the output).
 *
 * @param {object} opts
 * @param {string} opts.content - the file's full current content
 * @param {string} opts.testOutput
 * @param {string} opts.filePath
 * @param {number} [opts.contextLines] - lines of context on each side of a reference
 * @param {number} [opts.smallFileLineThreshold] - files at or under this line count are shown whole
 * @param {number} [opts.fallbackMaxChars] - length cap when no line reference is found
 * @returns {{ text: string, totalLines: number, windowed: boolean }}
 */
export function buildFileExcerpt({
  content,
  testOutput,
  filePath,
  contextLines = 15,
  smallFileLineThreshold = 40,
  fallbackMaxChars = 6000,
} = {}) {
  const lines = content.split('\n');
  const totalLines = lines.length;

  if (totalLines <= smallFileLineThreshold) {
    return { text: content, totalLines, windowed: false };
  }

  const basename = filePath.split('/').pop();
  const refLines = extractLineReferences(testOutput, basename);
  if (refLines.length > 0) {
    const windows = buildWindows(refLines, totalLines, contextLines);
    return { text: renderExcerpt(content, windows), totalLines, windowed: true };
  }

  const tailed = tail(content, fallbackMaxChars);
  return { text: tailed, totalLines, windowed: tailed.length < content.length };
}
