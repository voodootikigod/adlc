/**
 * Credential redaction for capture content.
 *
 * A handoff capture quotes whatever the previous session was looking at — a
 * terminal paste, an error message, a config line — and then it is written to
 * disk AND pasted into the successor's prompt. Both are places a credential
 * outlives the session that leaked it, so text is redacted on the way in rather
 * than trusted to have been clean.
 *
 * The credential shapes mirror `packages/core/lib/ledger.mjs`, which refuses to
 * COMMIT a finding containing one. That module detects; this one rewrites, so
 * the table cannot simply be imported — `test/capture-redact.test.mjs` pins the
 * two behaviourally instead, over a shared corpus, so a shape learned there
 * cannot silently go unredacted here.
 *
 * Best-effort by construction: new credential formats appear constantly and no
 * table catches them all. It lowers the blast radius of the common ones; it is
 * not a proof that a capture is secret-free.
 */

/** Marker left in place of a redacted span. Explicit so a reader knows. */
export const redactionMarker = (kind) => `[adlc: redacted ${kind}]`;

/**
 * Ordered: specific shapes first, so a JWT or a PEM block is named as such
 * rather than being swallowed by the generic assignment or entropy rules.
 * @type {[RegExp, string][]}
 */
export const REDACTION_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, 'private key block'],
  // An unterminated block still starts with the header; redact the header line
  // rather than leaving the body of a truncated key in place.
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----.*/g, 'private key block'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/g, 'JWT'],
  [/\bAKIA[0-9A-Z]{16}\b/g, 'AWS access key id'],
  [/\bASIA[0-9A-Z]{16}\b/g, 'AWS temporary access key id'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, 'GitHub fine-grained token'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, 'GitHub token'],
  [/\bglpat-[A-Za-z0-9_-]{20,}\b/g, 'GitLab token'],
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/g, 'API key'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, 'Slack token'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, 'Google API key'],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/gi, 'bearer token'],
];

/**
 * `key = value` where the key names a credential. The VALUE is replaced and the
 * key is kept: "password=[adlc: redacted credential]" tells a reader what was
 * removed, which "[adlc: redacted credential]" alone does not.
 */
const ASSIGNMENT =
  /\b(api[-_]?key|secret|passwd|password|token|access[-_]?key|client[-_]?secret)\b(\s*[:=]\s*)("[^"]{8,}"|'[^']{8,}'|\S{8,})/gi;

/**
 * Punctuation a value wears in real text but is not part of the value: quotes,
 * brackets, and the comma or colon that follows it in JSON or prose.
 *
 * Splitting it off before classification is load-bearing, not tidiness. A
 * capture quotes its own `content_hash` in JSON, and with the quotes attached
 * the token is no longer pure hex — so it misses the hex exemption AND scores
 * HIGHER entropy than the bare value (4.07 vs 4.00 for a uniform digest,
 * because the quotes add symbols). The hash the successor verifies against
 * would be redacted out of the capture, and only for some digests, which is
 * worse than always.
 *
 * `+/=` stay in the core: they are base64 alphabet, not punctuation.
 */
const LEADING_PUNCTUATION = /^["'`([{<,;:]+/;
const TRAILING_PUNCTUATION = /["'`)\]}>,;:.!?]+$/;

/** @returns {{ lead: string, core: string, trail: string }} */
export function splitPunctuation(token) {
  const lead = token.match(LEADING_PUNCTUATION)?.[0] ?? '';
  const rest = token.slice(lead.length);
  const trail = rest.match(TRAILING_PUNCTUATION)?.[0] ?? '';
  return { lead, core: rest.slice(0, rest.length - trail.length), trail };
}

/** Shannon entropy in bits/char — high for random secrets, low for prose. */
function tokenEntropy(text) {
  const freq = new Map();
  for (const ch of text) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of freq.values()) {
    const p = n / text.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/**
 * An unlabelled random-looking token: long, mixed case AND digits, high
 * entropy — the shape of a key that no named pattern caught.
 *
 * PURE HEX IS EXEMPT AT ANY LENGTH, and this is a deliberate divergence from
 * the findings ledger, which treats hex longer than a git sha as a hex-encoded
 * key. A brief's whole job includes quoting sha256 content hashes: the value
 * binding the capture the successor is about to verify is 64 hex characters,
 * and redacting it would remove the one field that makes the handoff
 * checkable. Hex is also not where credentials hide — every credential shape
 * above is mixed-alphabet — so the exemption costs nothing this table covers.
 */
function looksLikeRandomSecret(token) {
  if (token.length < 32) return false;
  if (/^[0-9a-f]+$/i.test(token)) return false;
  if (!/[a-z]/.test(token) || !/[A-Z0-9]/.test(token)) return false;
  return tokenEntropy(token) >= 4.0;
}

/**
 * Redact credentials from text.
 *
 * @param {unknown} value
 * @returns {{ text: string, redactions: string[] }} kinds removed, in order,
 *          so a caller can say what happened without quoting what was removed
 */
export function redactSecrets(value) {
  let text = typeof value === 'string' ? value : '';
  if (text.length === 0) return { text, redactions: [] };
  const redactions = [];

  for (const [pattern, kind] of REDACTION_PATTERNS) {
    text = text.replace(pattern, () => {
      redactions.push(kind);
      return redactionMarker(kind);
    });
  }

  text = text.replace(ASSIGNMENT, (whole, key, separator, secret) => {
    // Already redacted by an earlier rule (`api_key: "[adlc: redacted JWT]"`) —
    // leave it rather than nesting a marker inside a marker and losing the
    // specific category the first rule identified. Quotes only, not the general
    // punctuation strip: a marker OPENS with `[`, so stripping brackets here
    // would eat the very character being looked for.
    if (secret.replace(/^["'`]+/, '').startsWith('[adlc:')) return whole;
    redactions.push('credential');
    return `${key}${separator}${redactionMarker('credential')}`;
  });

  // Entropy pass last: by now the labelled shapes are markers, which are prose
  // and score low, so this only sees what the table did not recognize.
  text = text
    .split(/(\s+)/)
    .map((token) => {
      const { lead, core, trail } = splitPunctuation(token);
      if (!looksLikeRandomSecret(core)) return token;
      redactions.push('high-entropy token');
      // Keep the punctuation: the surrounding JSON or prose still has to parse.
      return `${lead}${redactionMarker('high-entropy token')}${trail}`;
    })
    .join('');

  return { text, redactions };
}
