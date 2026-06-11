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

/**
 * Upsert a key-value pair into the frontmatter and return updated content.
 * Creates a frontmatter block if absent.
 * @param {string} content - original file content
 * @param {string} key - frontmatter key to set
 * @param {string} value - value to set
 * @returns {string} updated content
 */
export function upsertFrontmatter(content, key, value) {
  const { frontmatter, hasFrontmatter } = parseFrontmatter(content);

  // Update or add the key
  frontmatter[key] = value;

  const fmLines = Object.entries(frontmatter).map(([k, v]) => `${k}: ${v}`);
  const newFm = ['---', ...fmLines, '---'].join('\n');

  if (hasFrontmatter) {
    // Replace existing frontmatter block
    const lines = content.split('\n');
    const endIdx = lines.indexOf('---', 1);
    const rest = lines.slice(endIdx + 1).join('\n');
    return newFm + '\n' + rest;
  } else {
    // Prepend new frontmatter block
    return newFm + '\n' + content;
  }
}
