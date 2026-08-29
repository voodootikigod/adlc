/**
 * frontmatter.mjs — parse and upsert YAML frontmatter in SKILL.md files.
 *
 * Frontmatter format:
 *   ---
 *   key: value
 *   ---
 *
 * We only handle the simple key: value format we need — not a full YAML parser.
 */

/**
 * Parse frontmatter from markdown content.
 * Returns { frontmatter: Record<string,string>, body: string, hasFrontmatter: boolean }.
 *
 * This is a lossy key:value reader for callers that only need scalar values
 * (e.g. claim extraction). It intentionally drops list items, folded-scalar
 * continuation lines, and comments — upsertFrontmatter does NOT route through
 * this for writes (see below), which is what keeps those lines intact on disk.
 */
export function parseFrontmatter(content) {
  const lines = content.split('\n');
  if (lines[0] !== '---') {
    return { frontmatter: {}, body: content, hasFrontmatter: false };
  }

  const endIdx = lines.indexOf('---', 1);
  if (endIdx === -1) {
    return { frontmatter: {}, body: content, hasFrontmatter: false };
  }

  const fmLines = lines.slice(1, endIdx);
  const frontmatter = {};
  for (const line of fmLines) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    frontmatter[key] = value;
  }

  const body = lines.slice(endIdx + 1).join('\n');
  return { frontmatter, body, hasFrontmatter: true };
}

/** Detect the file's line-ending convention so a write round-trips it unchanged. */
function detectEol(content) {
  return content.includes('\r\n') ? '\r\n' : '\n';
}

/**
 * Upsert a key-value pair into the frontmatter and return updated content.
 *
 * Operates on the RAW frontmatter lines, not a re-serialized key/value map:
 * an existing top-level `key:` line is replaced in place, everything else
 * (folded scalars, YAML list items, comments, blank lines) is left
 * byte-identical. A missing key gets one new line inserted directly before
 * the closing `---`. Creates a frontmatter block if absent (unchanged
 * behaviour from before this fix — there is nothing to preserve).
 *
 * @param {string} content - original file content
 * @param {string} key - frontmatter key to set
 * @param {string} value - value to set
 * @returns {string} updated content
 */
export function upsertFrontmatter(content, key, value) {
  const eol = detectEol(content);
  const lines = content.split(eol);
  const newLine = `${key}: ${value}`;

  if (lines[0] !== '---') {
    return ['---', newLine, '---', ...lines].join(eol);
  }

  const endIdx = lines.indexOf('---', 1);
  if (endIdx === -1) {
    return ['---', newLine, '---', ...lines].join(eol);
  }

  // Top-level match only: a list item or folded-scalar continuation is
  // indented, so it never starts a line with `${key}:`.
  const fmLines = lines.slice(1, endIdx);
  const keyLineIdx = fmLines.findIndex((line) => line.startsWith(`${key}:`));

  const newFmLines = keyLineIdx === -1
    ? [...fmLines, newLine]
    : fmLines.map((line, i) => (i === keyLineIdx ? newLine : line));

  return ['---', ...newFmLines, '---', ...lines.slice(endIdx + 1)].join(eol);
}
