/**
 * extract-claims.mjs — extract verifiable claims from SKILL.md content.
 *
 * Claim types:
 *  - command: backtick-enclosed tokens whose first word is a command
 *  - path: tokens that look like repo-relative file paths (contain / and an extension)
 *  - script: npm/pnpm/yarn run <name> references
 */

/** Regex to detect obvious placeholder tokens — skip these. */
const PLACEHOLDER_RE = /^<[^>]*>$|^[A-Z][A-Z0-9_]{2,}$/;

/** Regex to detect path-like tokens: contains / and has a file extension. */
const PATH_RE = /^(?:\.\/|\.\.\/|[a-zA-Z0-9_.-]+\/)[^\s'"`,]+\.[a-zA-Z0-9]{1,10}$/;

/** Regex for npm/pnpm/yarn script references. npx is intentionally excluded — it runs registry packages, not package.json scripts. */
const SCRIPT_REF_RE = /\bnpm\s+run\s+([a-zA-Z0-9_:.-]+)|(?:pnpm|yarn)\s+(?:run\s+)?([a-zA-Z0-9_:.-]+)/g;

/**
 * Extract all claims from a SKILL.md content string.
 * @param {string} content
 * @returns {{ type: 'command'|'path'|'script', value: string, raw: string }[]}
 */
export function extractClaims(content) {
  const claims = [];
  const seen = new Set();

  function add(claim) {
    const key = `${claim.type}:${claim.value}`;
    if (!seen.has(key)) {
      seen.add(key);
      claims.push(claim);
    }
  }

  // --- Backtick code spans (inline) ---
  // Match single-backtick spans and triple-backtick blocks
  const inlineRe = /`([^`\n]+)`/g;
  let m;
  while ((m = inlineRe.exec(content)) !== null) {
    const inner = m[1].trim();
    processInlineCode(inner, add);
  }

  // Triple-backtick fenced blocks
  const fencedRe = /```[^\n]*\n([\s\S]*?)```/g;
  while ((m = fencedRe.exec(content)) !== null) {
    const block = m[1];
    for (const line of block.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      processCodeLine(trimmed, add);
    }
  }

  // --- Script refs anywhere in content ---
  SCRIPT_REF_RE.lastIndex = 0;
  while ((m = SCRIPT_REF_RE.exec(content)) !== null) {
    // group 1 = npm run X, group 2 = pnpm/yarn X
    const scriptName = m[1] || m[2];
    if (scriptName && !PLACEHOLDER_RE.test(scriptName)) {
      add({ type: 'script', value: scriptName, raw: m[0].trim() });
    }
  }

  return claims;
}

/**
 * Process a single inline code span (from backticks).
 * May contain a command invocation or a path.
 */
function processInlineCode(inner, add) {
  // Path-like?
  if (PATH_RE.test(inner)) {
    add({ type: 'path', value: inner, raw: inner });
    return;
  }

  // Could be a command invocation — take first token
  const tokens = inner.split(/\s+/);
  const first = tokens[0];
  if (!first || PLACEHOLDER_RE.test(first)) return;

  // Skip obvious non-commands: quoted strings, numbers, punctuation starting
  if (/^['"0-9\-{[]/.test(first)) return;
  // Skip if it looks like a flag
  if (first.startsWith('-')) return;

  // Skip if it looks like a path (handled above)
  if (PATH_RE.test(first)) {
    add({ type: 'path', value: first, raw: inner });
    return;
  }

  // Treat as command
  if (/^[a-zA-Z][a-zA-Z0-9_.-]*$/.test(first)) {
    add({ type: 'command', value: first, raw: inner });
  }
}

/**
 * Process a line from a fenced code block.
 * Each line may start with a shell command.
 */
function processCodeLine(line, add) {
  // Strip common shell prompts
  const stripped = line.replace(/^\$\s*/, '').replace(/^>\s*/, '').trim();
  if (!stripped) return;

  // Path check first
  if (PATH_RE.test(stripped)) {
    add({ type: 'path', value: stripped, raw: line });
    return;
  }

  const tokens = stripped.split(/\s+/);
  const first = tokens[0];
  if (!first || PLACEHOLDER_RE.test(first)) return;
  if (first.startsWith('-')) return;
  if (/^['"0-9{[]/.test(first)) return;

  // Check for path-like first token
  if (PATH_RE.test(first)) {
    add({ type: 'path', value: first, raw: line });
    return;
  }

  // Treat as command
  if (/^[a-zA-Z][a-zA-Z0-9_.-]*$/.test(first)) {
    add({ type: 'command', value: first, raw: stripped });
  }
}
