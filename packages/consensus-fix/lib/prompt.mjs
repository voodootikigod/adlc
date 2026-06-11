/**
 * prompt.mjs — Build the LLM prompt for a fix candidate.
 * Pure: no I/O, no network.
 */

/** Tail the last `maxChars` characters of a string. */
export function tail(str, maxChars = 4000) {
  if (str.length <= maxChars) return str;
  return str.slice(str.length - maxChars);
}

/**
 * Build the user prompt for asking the LLM to produce a minimal fix.
 * @param {object} opts
 * @param {string} opts.testCmd
 * @param {string} opts.testOutput  — raw output from the failing test run
 * @param {{ [path]: string }} opts.snapshot — { path: content }
 * @returns {string}
 */
export function buildPrompt({ testCmd, testOutput, snapshot }) {
  const tailedOutput = tail(testOutput, 4000);

  const fileBlocks = Object.entries(snapshot)
    .map(([path, content]) => `### ${path}\n\`\`\`\n${content}\n\`\`\``)
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
    `{"changes": [{"file": "<path>", "content": "<full new content of changed file>"}]}`,
    ``,
    `Rules:`,
    `- Only include files that actually need changes.`,
    `- Use only the file paths listed above.`,
    `- "content" must be the complete new file content, not a diff.`,
    `- Output ONLY valid JSON. No prose before or after.`,
  ].join('\n');
}
