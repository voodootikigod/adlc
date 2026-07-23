// Zero-dep parser/validator for the subset of TOML this plugin's manifest
// uses: full-line comments, `key = "string"`, `key = ["a", "b"]`, and
// `[[section]]` array-of-tables headers. Anything outside the subset fails
// closed with a thrown error — the manifest is ours, so unparseable means
// broken, not exotic.
const SECTION_RE = /^\[\[([A-Za-z0-9_.-]+)\]\]$/;
const KEY_RE = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/;

export const ENTRYPOINT_SECTIONS = ['build', 'startup', 'actions', 'events', 'panes', 'link_handlers'];
const KNOWN_SECTIONS = new Set([...ENTRYPOINT_SECTIONS, 'keys.command']);

/** Parse manifest text into {top, sections:[{name, entries}]}. Throws on any
 *  line outside the supported subset. */
export function parseManifest(text) {
  if (typeof text !== 'string') throw new TypeError('manifest text must be a string');
  const top = {};
  const sections = [];
  let target = top;
  for (const [index, raw] of text.split('\n').entries()) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const section = line.match(SECTION_RE);
    if (section) {
      const entry = { name: section[1], entries: {} };
      sections.push(entry);
      target = entry.entries;
      continue;
    }
    const kv = line.match(KEY_RE);
    if (kv) {
      const rhs = kv[2].trim();
      if (!rhs.startsWith('"') && !rhs.startsWith('[')) {
        throw new Error(`manifest line ${index + 1}: unsupported value syntax: ${rhs}`);
      }
      let value;
      try {
        value = JSON.parse(rhs);
      } catch {
        throw new Error(`manifest line ${index + 1}: unparseable value: ${rhs}`);
      }
      target[kv[1]] = value;
      continue;
    }
    throw new Error(`manifest line ${index + 1}: unparseable: ${line}`);
  }
  return { top, sections };
}

const isNonEmptyString = (v) => typeof v === 'string' && v.length > 0;
const isStringArray = (v) => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string');

/** Validate a parsed manifest. Returns an array of error strings (empty =
 *  valid). Unknown sections and malformed entrypoints are errors. */
export function validateManifest({ top, sections }) {
  const errors = [];
  for (const field of ['id', 'name', 'version', 'min_herdr_version']) {
    if (!isNonEmptyString(top[field])) errors.push(`top-level ${field} must be a non-empty string`);
  }
  if (top.platforms !== undefined && !isStringArray(top.platforms)) {
    errors.push('platforms must be a non-empty array of strings');
  }
  for (const { name, entries } of sections) {
    if (!KNOWN_SECTIONS.has(name)) {
      errors.push(`unknown section [[${name}]]`);
      continue;
    }
    if (name === 'link_handlers') {
      for (const field of ['id', 'pattern', 'action']) {
        if (!isNonEmptyString(entries[field])) errors.push(`[[${name}]] requires string ${field}`);
      }
      continue;
    }
    if (name === 'keys.command') continue;
    if (!isStringArray(entries.command)) errors.push(`[[${name}]] requires a command array of strings`);
    if (name === 'actions') {
      for (const field of ['id', 'title']) {
        if (!isNonEmptyString(entries[field])) errors.push(`[[actions]] requires string ${field}`);
      }
      if (!isStringArray(entries.contexts)) errors.push('[[actions]] requires a contexts array of strings');
    }
    if (name === 'events' && !isNonEmptyString(entries.on)) errors.push('[[events]] requires string on');
    if (name === 'panes' && !isNonEmptyString(entries.id)) errors.push('[[panes]] requires string id');
  }
  return errors;
}
