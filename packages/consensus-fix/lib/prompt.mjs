/**
 * prompt.mjs — Build the LLM prompt for a fix candidate.
 * Pure: no I/O, no network.
 */

import { buildFileExcerpt } from './region.mjs';

/** Tail the last `maxChars` characters of a string. */
export function tail(str, maxChars = 4000) {
  if (str.length <= maxChars) return str;
  return str.slice(str.length - maxChars);
}

/**
 * Build the user prompt for asking the LLM to produce a minimal fix.
 *
 * Source files are embedded as EXCERPTS (issue #279), not whole files: the
 * window around whatever lines the test output references each file at,
 * falling back to a length-capped tail when no reference is found. Every
 * excerpt is line-numbered and states the file's real total line count, so
 * the model knows exactly which lines a hunk's startLine/endLine addresses
 * even though it isn't seeing every line.
 *
 * @param {object} opts
 * @param {string} opts.testCmd
 * @param {string} opts.testOutput  — raw output from the failing test run
 * @param {{ [path]: string }} opts.snapshot — { path: content }
 * @returns {string}
 */
export function buildPrompt({ testCmd, testOutput, snapshot }) {
  const tailedOutput = tail(testOutput, 4000);

  const fileBlocks = Object.entries(snapshot)
    .map(([path, content]) => {
      const excerpt = buildFileExcerpt({ content, testOutput, filePath: path });
      const note = excerpt.windowed
        ? ` (excerpt — file has ${excerpt.totalLines} lines total; line numbers shown below are the REAL file's line numbers)`
        : ` (${excerpt.totalLines} lines, shown in full)`;
      return `### ${path}${note}\n\`\`\`\n${excerpt.text}\n\`\`\``;
    })
    .join('\n\n');

  return [
    `This test command fails:`,
    `\`\`\``,
    testCmd,
    `\`\`\``,
    ``,
    `Test output (last 4000 chars):`,
    `\`\`\``,
    tailedOutput,
    `\`\`\``,
    ``,
    `Source files:`,
    ``,
    fileBlocks,
    ``,
    `Produce a MINIMAL fix. Output JSON with this exact shape:`,
    `{"changes": [{"file": "<path>", "hunks": [{"startLine": <n>, "endLine": <n>, "replacement": "<new lines>"}]}]}`,
    ``,
    `Rules:`,
    `- Only include files that actually need changes.`,
    `- Use only the file paths listed above.`,
    `- startLine/endLine are 1-indexed, INCLUSIVE line numbers in the file's REAL numbering`,
    `  (shown in the excerpts above — a windowed excerpt still uses the file's true line`,
    `  numbers, not excerpt-relative ones).`,
    `- "replacement" is the new text for that exact line range — it may span more or fewer`,
    `  lines than the original range, or be an empty string to delete the range entirely.`,
    `- To INSERT lines without deleting any, set endLine = startLine - 1 (a zero-length range`,
    `  means "insert replacement immediately before startLine").`,
    `- A file may need more than one hunk; hunks in the same file must not overlap.`,
    `- Output ONLY valid JSON. No prose before or after.`,
  ].join('\n');
}
