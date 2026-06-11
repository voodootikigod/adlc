// parse-log.mjs — input ingestion for flail-detector.
// Handles both plain-text logs and JSONL logs.
// Returns { lines: string[], bytes: number }

/**
 * Recursively extract string values from keys: content, text, message in an object.
 * Returns all found string values (depth-first).
 */
function extractStrings(obj) {
  if (typeof obj === 'string') return [obj];
  if (!obj || typeof obj !== 'object') return [];
  const KEYS = ['content', 'text', 'message'];
  const results = [];
  for (const key of Object.keys(obj)) {
    if (KEYS.includes(key)) {
      if (typeof obj[key] === 'string') {
        results.push(obj[key]);
      } else {
        results.push(...extractStrings(obj[key]));
      }
    } else if (obj[key] && typeof obj[key] === 'object') {
      // Only recurse into non-target keys when the value is an object,
      // never extract bare strings from non-target keys.
      results.push(...extractStrings(obj[key]));
    }
  }
  return results;
}

/**
 * Try to parse a single line as JSON.
 * Returns the parsed object, or null if parsing fails.
 */
function tryParseJson(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/**
 * Parse a log file content into an array of text lines.
 * If more than half of the non-empty lines parse as JSON objects,
 * treat the file as JSONL and extract string values from content/text/message keys.
 * Otherwise, treat each line as plain text.
 *
 * @param {string} content - Raw file content
 * @returns {{ lines: string[], bytes: number }}
 */
export function parseLog(content) {
  const bytes = Buffer.byteLength(content, 'utf8');
  const rawLines = content.split('\n');
  const nonEmpty = rawLines.filter((l) => l.trim().length > 0);

  // Detect JSONL: try to parse each non-empty line; if majority parse, it's JSONL
  const parsed = nonEmpty.map((l) => tryParseJson(l));
  const jsonCount = parsed.filter(Boolean).length;
  const isJsonl = nonEmpty.length > 0 && jsonCount >= nonEmpty.length / 2;

  let lines;
  if (isJsonl) {
    lines = [];
    for (let i = 0; i < nonEmpty.length; i++) {
      const obj = parsed[i];
      if (obj !== null) {
        lines.push(...extractStrings(obj));
      } else {
        lines.push(nonEmpty[i]);
      }
    }
  } else {
    lines = rawLines;
  }

  return { lines, bytes };
}
