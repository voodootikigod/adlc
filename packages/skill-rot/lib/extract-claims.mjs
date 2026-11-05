/**
 * extract-claims.mjs — extract verifiable claims from SKILL.md content.
 *
 * Claim types:
 *  - command: an invocation's first word — an inline span shaped like an
 *    invocation, or a line of a shell (or unlabelled) fenced block
 *  - path: tokens that look like repo-relative file paths (contain / and an extension)
 *  - script: npm/pnpm/yarn run <name> references
 *
 * A word in backticks is usually a NAME (an option, a tool, a model id, a file),
 * not something to run. Treating every one as a command made almost every skill
 * stale, so a span only claims a command when it is shaped like an invocation.
 * See .adlc/specs/skill-rot-command-claims.md for the rules and measurements.
 */

/** Regex to detect obvious placeholder tokens — skip these. */
const PLACEHOLDER_RE = /^<[^>]*>$|^[A-Z][A-Z0-9_]{2,}$/;

/**
 * A word shaped like a command name. A dot (file names, dotted keys, versions)
 * or an uppercase letter (camelCase, PascalCase) means a name, not a binary.
 */
const COMMAND_WORD_RE = /^[a-z][a-z0-9_-]*$/;

/** First words that make an inline span an invocation on their own. */
const LAUNCHERS = new Set(
  'adlc npx npm pnpm yarn bun bunx node deno git gh docker make python python3 pip cargo go curl sh bash'.split(' ')
);

/** A later token that marks an inline span as an invocation. A bare `-` or `--` does not. */
const FLAG_RE = /^--?[A-Za-z]/;

/** Fence info-string languages whose lines are shell commands. An empty info string counts too. */
const SHELL_FENCE_LANGS = new Set(['sh', 'bash', 'zsh', 'shell', 'console', 'shell-session', 'terminal', 'fish', 'ksh']);

/** Regex to detect path-like tokens: contains / and has a file extension. */
const PATH_RE = /^(?:\.\/|\.\.\/|[a-zA-Z0-9_.-]+\/)[^\s'"`,]+\.[a-zA-Z0-9]{1,10}$/;

/** Regex for npm/pnpm/yarn script references. npx is intentionally excluded — it runs registry packages, not package.json scripts. */
const SCRIPT_REF_RE = /\bnpm\s+run\s+([a-zA-Z0-9_:.-]+)|\b(?:pnpm|yarn)\s+run\s+([a-zA-Z0-9_:.-]+)|\b(?:pnpm|yarn)\s+([a-zA-Z0-9_:.-]+)/g;

/** Built-in pnpm/yarn CLI subcommands that are not package.json scripts when invoked without `run`. */
const PM_SUBCOMMANDS = new Set(
  'add approve-builds audit autoclean bin cache cat-file cat-index check config create dedupe deploy dlx doctor env exec explain fetch find-hash generate-lock-entry global help i ignored-builds import info init install la licenses link list ll ln login logout ls node outdated owner pack patch patch-commit patch-remove policies prune publish rb rebuild remove rm root search server set setup stage store tag team uninstall unlink unplug up update upgrade upgrade-interactive version versions why workspace workspaces'.split(' ')
);

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
    if (isAbsoluteLinkText(content, m.index, m[0].length)) continue;
    const inner = m[1].trim();
    processInlineCode(inner, add);
  }

  // Triple-backtick fenced blocks — only shell (or unlabelled) ones hold commands
  const fencedRe = /```([^\n]*)\n([\s\S]*?)```/g;
  while ((m = fencedRe.exec(content)) !== null) {
    if (!isShellFence(m[1])) continue;
    const block = m[2];
    for (const line of block.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      processCodeLine(trimmed, add);
    }
  }

  // --- Script refs anywhere in content ---
  SCRIPT_REF_RE.lastIndex = 0;
  while ((m = SCRIPT_REF_RE.exec(content)) !== null) {
    const explicitScript = m[1] || m[2];
    const shorthandScript = m[3] && !PM_SUBCOMMANDS.has(m[3]) ? m[3] : null;
    const scriptName = explicitScript || shorthandScript;
    if (scriptName && !PLACEHOLDER_RE.test(scriptName)) {
      add({ type: 'script', value: scriptName, raw: m[0].trim() });
    }
  }

  return claims;
}

/**
 * Whether the code span at `start` is the entire text of a markdown link whose
 * target is an absolute http(s) URL — [`docs/x.md`](https://…). Such a link
 * says where the file lives, not that it exists in this repository.
 */
function isAbsoluteLinkText(content, start, length) {
  if (content[start - 1] !== '[') return false;
  return /^\]\(\s*<?https?:\/\//i.test(content.slice(start + length, start + length + 16));
}

/** Whether a fence's info string names a shell language (or nothing). */
function isShellFence(info) {
  const lang = info.trim().split(/\s+/)[0].toLowerCase();
  return lang === '' || SHELL_FENCE_LANGS.has(lang);
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

  // An explicit `$ ` prompt marks the span as a command whatever follows.
  const prompted = /^\$\s/.test(inner);
  const tokens = (prompted ? inner.replace(/^\$\s+/, '') : inner).split(/\s+/);
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

  // A command only when shaped like an invocation: a bare word that is not a
  // launcher is a name (an option, a tool, a model id), not something to run.
  if (!COMMAND_WORD_RE.test(first)) return;
  if (prompted || LAUNCHERS.has(first) || tokens.slice(1).some((t) => FLAG_RE.test(t))) {
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

  // Treat as command — a capitalized first word is prose (a diagram, a heading), not a binary
  if (COMMAND_WORD_RE.test(first)) {
    add({ type: 'command', value: first, raw: stripped });
  }
}
