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
 * Recursively extract tool-use file targets from a parsed JSONL event object.
 *
 * Real Claude Code transcripts carry the written/edited file at a nested
 * `input.file_path` inside a `tool_use` block (Write/Edit/MultiEdit), which
 * typically lives in an assistant message's `content` array. The plain
 * `extractStrings` pass never surfaces these (it only pulls content/text/
 * message string values), so the scope-violation and edit-churn signals —
 * which key off file paths — could never fire on the one format that exists.
 *
 * This walks the structure and collects `file_path` values from the known
 * tool-input container keys: `input`, `tool_input`, `parameters`. It also
 * collects any bare nested `file_path` string as a defensive fallback.
 *
 * Returns an array of file-path strings (one entry per occurrence, so a path
 * edited twice yields two entries — preserving churn counts).
 */
function extractFileTargets(obj) {
  const TOOL_INPUT_KEYS = ['input', 'tool_input', 'parameters'];
  const results = [];

  const pushFromContainer = (container) => {
    if (!container || typeof container !== 'object') return;
    const fp = container.file_path;
    if (typeof fp === 'string' && fp.length > 0) {
      results.push(fp);
    }
    // MultiEdit-style: an `edits`/`files` array each carrying a file_path.
    for (const key of ['edits', 'files']) {
      if (Array.isArray(container[key])) {
        for (const item of container[key]) {
          if (item && typeof item === 'object' && typeof item.file_path === 'string') {
            results.push(item.file_path);
          }
        }
      }
    }
  };

  const walk = (node) => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (!node || typeof node !== 'object') return;

    // Known tool-input containers: pull file_path directly.
    for (const key of TOOL_INPUT_KEYS) {
      if (node[key] && typeof node[key] === 'object') {
        pushFromContainer(node[key]);
      }
    }

    // Recurse into all object/array children to find nested tool_use blocks.
    for (const key of Object.keys(node)) {
      const val = node[key];
      if (val && typeof val === 'object') {
        walk(val);
      }
    }
  };

  walk(obj);
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
        // Structured tool-use file targets (real Claude Code transcripts):
        // emit a synthetic "Writing <path>" line so the existing extractPath
        // patterns — and therefore the scope-violation and edit-churn signals —
        // recognize the file without any change to the signal detectors.
        for (const fp of extractFileTargets(obj)) {
          lines.push(`Writing ${fp}`);
        }
        // Prose / "file_path" substring heuristics (legacy fixtures): keep as
        // a fallback so older log formats still work.
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
