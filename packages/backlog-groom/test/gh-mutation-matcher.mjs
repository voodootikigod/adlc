/**
 * Finds `gh` invocations that change something on GitHub, in free text.
 *
 * Parsed per invocation rather than matched as fixed substrings, because gh
 * accepts the same mutation in several shapes: persistent flags before the
 * subcommand (`gh issue --repo o/r close 7`), the endpoint before the method
 * (`gh api repos/o/r/issues/7 -X PATCH`), and an implicit POST whenever a field
 * is supplied (`gh api …/comments -f body=hi`).
 */

/** Subcommands that write, per command group. */
export const MUTATING_SUBCOMMANDS = Object.freeze({
  issue: ['close', 'reopen', 'edit', 'comment', 'create', 'delete', 'lock', 'unlock', 'pin', 'unpin', 'transfer', 'develop'],
  pr: ['close', 'reopen', 'merge', 'edit', 'comment', 'create', 'review', 'ready', 'lock', 'unlock'],
  label: ['create', 'edit', 'delete', 'clone'],
});

/** Flags that consume the following token as their value. */
const VALUED_FLAGS = new Set(['-R', '--repo', '--hostname', '-X', '--method', '-f', '-F', '--field', '--raw-field', '--input', '-H', '--header', '-q', '--jq', '-t', '--template']);

/** Characters that end one shell invocation inside prose or a code span. */
const TERMINATOR = /[`;|&()]/;

const WINDOW_TOKENS = 24;

function invocationTokens(flat, start) {
  const rest = flat.slice(start);
  const end = rest.search(TERMINATOR);
  return (end === -1 ? rest : rest.slice(0, end)).trim().split(' ').filter(Boolean).slice(0, WINDOW_TOKENS);
}

/** Positional tokens, with flags and the values of valued flags removed. */
function positionals(tokens) {
  const out = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t.startsWith('-')) {
      if (VALUED_FLAGS.has(t)) i += 1;
      continue;
    }
    out.push(t);
  }
  return out;
}

/** The HTTP method `gh api` will use, or null when none is given explicitly. */
function apiMethod(tokens) {
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t === '-X' || t === '--method') return (tokens[i + 1] ?? '').toUpperCase();
    if (/^-X./.test(t)) return t.slice(2).toUpperCase();
    if (t.startsWith('--method=')) return t.slice('--method='.length).toUpperCase();
  }
  return null;
}

function apiHasFields(tokens) {
  return tokens.some((t) => /^(?:-f|-F|--field|--raw-field|--input)(?:=|$)/.test(t) || /^-[fF]\S/.test(t));
}

function isMutating(tokens) {
  const [group, sub] = positionals(tokens);
  if (group === 'api') {
    const method = apiMethod(tokens);
    return method ? !['GET', 'HEAD'].includes(method) : apiHasFields(tokens);
  }
  return Boolean(MUTATING_SUBCOMMANDS[group]?.includes(sub));
}

/**
 * Every mutating `gh …` invocation in `text`, as the normalised text of each.
 * Whitespace (including line wraps) is collapsed first, so padding or wrapping
 * an invocation does not hide it.
 */
export function mutatingGhInvocations(text) {
  const flat = String(text).replace(/\s+/g, ' ');
  const found = [];
  for (const m of flat.matchAll(/(?:^|[^\w-])gh /g)) {
    const start = m.index + m[0].length;
    const tokens = invocationTokens(flat, start);
    if (isMutating(tokens)) found.push(`gh ${tokens.join(' ')}`);
  }
  return found;
}
