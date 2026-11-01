// Mask credentials on the REMOVED side of a unified diff before it is sent to a
// review model. A change that deletes a hardcoded secret still carries the value
// on its `-` lines, so a raw `git diff` hands it to every lens provider even
// though the change exists to get rid of it. Added and context lines are left
// alone: they are in the tree at HEAD, and a reviewer must still be able to flag
// a secret the change ADDS.
//
// Best-effort by construction (see secret-shapes.mjs): it covers the known
// provider shapes, `name = value` credential assignments (any case, any
// identifier style, quoted or not, `=`/`:`/`:=`/`=>`), URL userinfo passwords,
// Basic auth, high-entropy tokens, and private key blocks. A value under 8
// characters, or a low-entropy password with no telltale name, is not caught. Over-masking only hides removed text from the reviewer, so
// every ambiguous case masks.

import { INLINE_ASSIGNMENT, SECRET_PATTERNS, TOKEN_SEPARATORS, isRandomSecretToken } from './secret-shapes.mjs';

export const MASKED_SECRET = '[redacted]';
export const MASKED_PRIVATE_KEY = '[redacted private key]';
export const MASKED_LONG_LINE = '[redacted long line]';

// A removed line longer than this is masked whole: it is generated or minified
// text no reviewer reads line by line, and it bounds the regex work per line.
export const MAX_MASKED_LINE = 2000;

const PEM_BEGIN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const PEM_END = /-----END [A-Z ]*PRIVATE KEY-----/;
// A PEM body line: base64 only, optionally padded.
const PEM_BODY = /^[A-Za-z0-9+/]+={0,2}$/;

// A credential-like name, in any case and inside any identifier: `password`,
// `API_TOKEN`, `clientSecret`, `aws_secret_access_key`, `"apiKey"`, `db.passwd`.
// The ledger's own assignment shape needs a word boundary, which `_` and
// camelCase defeat; this one only needs the name not to start mid-word.
// Both identifier parts are bounded: unbounded, a long run of identifier
// characters with no `=` after it backtracks in cubic time. The padding around
// the operator stays unbounded so column-aligned configs still match; it
// cannot overlap the name characters, so it costs one linear scan.
const NAME = String.raw`(?<![A-Za-z0-9])[A-Za-z0-9_.-]{0,48}?(?:secret|token|passw(?:or)?d|pwd|credentials?|api[-_]?key|access[-_]?key|private[-_]?key|auth[-_]?key)[A-Za-z0-9_.-]{0,48}["']?\s*(?::=|=>|[:=])\s*`;

// Mask-only rules, applied before the shared shapes. Each keeps the name (and
// any quotes) and replaces the value.
const ASSIGNMENT_RULES = [
  // `name = "value with anything"` — the quoted value, escapes included, up to
  // its closing quote or the end of the line (a multi-line string, a trailing
  // line-continuation backslash, or a hunk header git cut short).
  [new RegExp(`(${NAME})(["'\`])((?:\\\\[^]|\\\\$|(?!\\2)[^\\\\]){8,}?)(\\2|$)`, 'gi'), (_m, prefix, quote, _value, close) => `${prefix}${quote}${MASKED_SECRET}${close}`],
  // `name = value` — an unquoted value up to whitespace or a quote.
  [new RegExp(`(${NAME})(?!["'\`])[^\\s"'\`]{8,}`, 'gi'), (_m, prefix) => `${prefix}${MASKED_SECRET}`],
  // `scheme://user:password@host` — the password in URL userinfo.
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]*:)[^\s@/]+(?=@)/gi, (_m, prefix) => `${prefix}${MASKED_SECRET}`],
  // `Authorization: Basic <base64 user:pass>`.
  [/(\bBasic\s+)[A-Za-z0-9+/]{8,}={0,2}/g, (_m, prefix) => `${prefix}${MASKED_SECRET}`],
];

// The shared shapes, made global so one line can hold several. The ledger's
// inline-assignment shape is left out: ASSIGNMENT_RULES cover every name it
// knows, and running it after them would swallow the quotes they keep.
const SHAPE_RULES = SECRET_PATTERNS
  .filter(([pattern]) => pattern !== INLINE_ASSIGNMENT)
  .map(([pattern]) => [new RegExp(pattern.source, `${pattern.flags}g`), () => MASKED_SECRET]);

const MASK_RULES = [...ASSIGNMENT_RULES, ...SHAPE_RULES];

function maskTokens(text) {
  return text
    .split(new RegExp(`(${TOKEN_SEPARATORS.source})`))
    .map((part) => (isRandomSecretToken(part) ? MASKED_SECRET : part))
    .join('');
}

/** Mask every credential shape in one line of removed content. */
export function maskSecretText(text) {
  let out = String(text);
  if (out.length > MAX_MASKED_LINE) return MASKED_LONG_LINE;
  for (const [rule, replace] of MASK_RULES) out = out.replace(rule, replace);
  return maskTokens(out);
}

// `@@ -a,b +c,d @@ <function context>`: git copies the context text from a
// nearby line of the file, which can be the very line the change removes.
const HUNK_HEADER = /^(@@+ [^@]*@@+)(.*)$/s;

function maskHunkHeader(line) {
  const m = HUNK_HEADER.exec(line);
  return m ? `${m[1]}${maskSecretText(m[2])}` : line;
}

/**
 * Return `diff` with credentials masked on its removed lines.
 *
 * The diff is walked per file section. Only lines inside a hunk (after `@@`)
 * are content; `---`/`+++` headers are never touched. The function-context
 * text git appends to a `@@` header is masked like a removed line, because git
 * copies it from the file and it can be the removed line itself. The input
 * must be plain `git diff` output: run git with `--no-color --no-ext-diff`, or
 * a colored or external-driver diff is not recognised and nothing is masked. Private key blocks are
 * tracked on the OLD side of the file (removed and context lines): an added
 * END line cannot close a block that is still being removed. A block whose
 * BEGIN line falls outside the diff context is caught at its END line, which
 * masks the run of removed base64 lines directly above it.
 *
 * @param {string} diff  unified diff text (`git diff` output)
 * @returns {string}
 */
export function maskRemovedSecrets(diff) {
  if (typeof diff !== 'string' || diff === '') return diff;
  const lines = diff.split('\n');
  const out = lines.slice();
  let inHunk = false;
  let inKey = false;
  // Output indices of old-side lines since the last hunk header, for the END back-fill.
  let oldSide = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      inHunk = false;
      inKey = false;
      oldSide = [];
      continue;
    }
    if (line.startsWith('@@')) {
      inHunk = true;
      oldSide = [];
      out[i] = maskHunkHeader(line);
      continue;
    }
    if (!inHunk) continue;

    const marker = line[0];
    if (marker !== '-' && marker !== ' ') continue; // added lines and `\ No newline` markers
    const content = line.slice(1);
    const removed = marker === '-';

    if (PEM_BEGIN.test(content)) inKey = true;
    if (inKey) {
      if (removed) out[i] = `-${MASKED_PRIVATE_KEY}`;
      if (PEM_END.test(content)) inKey = false;
      oldSide.push(i);
      continue;
    }
    if (PEM_END.test(content)) {
      // BEGIN was outside the diff context: mask the base64 run above the END line.
      for (let j = oldSide.length - 1; j >= 0; j -= 1) {
        const k = oldSide[j];
        if (!PEM_BODY.test(lines[k].slice(1).trim())) break;
        if (lines[k][0] === '-') out[k] = `-${MASKED_PRIVATE_KEY}`;
      }
      if (removed) out[i] = `-${MASKED_PRIVATE_KEY}`;
      oldSide.push(i);
      continue;
    }
    if (removed) out[i] = `-${maskSecretText(content)}`;
    oldSide.push(i);
  }
  return out.join('\n');
}
