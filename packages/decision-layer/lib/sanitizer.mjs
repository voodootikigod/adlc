// The pre-dispatch sanitizer. A provider only ever receives its output:
//
//   collected local state -> projection onto the pack's declared inputs -> type check
//     -> UTF-8 / control-character normalization -> credential redaction
//     -> per-field and total size limits -> canonical sanitizedInput
//
// Any failure throws a SanitizationError before anything is sent, and there is
// no fallback to raw input. Redaction is a privacy control, not proof that
// nothing sensitive remains: the metadata-only pack rule is the primary
// boundary.
import { canonicalBytes, canonicalHash, canonicalJson } from './canonical.mjs';
import { MAX_FIELD_BYTES, MAX_TOTAL_BYTES } from './pack.mjs';

export class SanitizationError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'SanitizationError';
    this.code = code;
  }
}

const CREDENTIAL_PATTERNS = [
  { category: 'private-key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g },
  { category: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g },
  { category: 'credential', pattern: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g },
  { category: 'credential', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/g },
  { category: 'credential', pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/g },
  { category: 'credential', pattern: /\bglpat-[A-Za-z0-9_-]{20,}/g },
  { category: 'credential', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { category: 'credential', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { category: 'credential', pattern: /\bAIza[0-9A-Za-z_-]{35}/g },
  { category: 'credential', pattern: /\bnpm_[A-Za-z0-9]{36}\b/g },
];
const TOKEN_CANDIDATE = /[A-Za-z0-9+/=_-]{24,}/g;
const MIN_TOKEN_ENTROPY = 4.2;
// Hex has 16 symbols, so it can never reach MIN_TOKEN_ENTROPY: it is judged
// against its own ceiling, log2(16) = 4. v1 inputs never carry a commit SHA, so
// long, evenly spread hex is treated as a secret.
const HEX_CANDIDATE = /\b[0-9a-fA-F]{32,}\b/g;
const MIN_HEX_ENTROPY = 3.5;

function shannonEntropy(text) {
  const counts = new Map();
  for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / text.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/**
 * Replace credential-shaped content in `text` with typed tokens such as
 * `<redacted:credential>`. Returns the new text and how many spans were replaced.
 * @param {string} text
 * @returns {{ text: string, redactions: number }}
 */
export function scanText(text) {
  let redactions = 0;
  let result = text;
  for (const { category, pattern } of CREDENTIAL_PATTERNS) {
    result = result.replace(pattern, () => { redactions += 1; return `<redacted:${category}>`; });
  }
  result = result.replace(TOKEN_CANDIDATE, (token) => {
    if (shannonEntropy(token) < MIN_TOKEN_ENTROPY) return token;
    redactions += 1;
    return '<redacted:high-entropy>';
  });
  result = result.replace(HEX_CANDIDATE, (token) => {
    if (shannonEntropy(token) < MIN_HEX_ENTROPY) return token;
    redactions += 1;
    return '<redacted:credential>';
  });
  return { text: result, redactions };
}

/** Drop control characters, replace lone surrogates (not valid UTF-8), and NFC-normalize. */
function normalizeString(value) {
  return value
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '�')
    .normalize('NFC');
}

const isCount = (value) => Number.isSafeInteger(value) && value >= 0;

function checkType(name, type, value) {
  const ok = {
    integer: () => isCount(value),
    'integer-or-none': () => value === 'none' || isCount(value),
    string: () => typeof value === 'string',
    'count-map': () => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every(isCount),
  }[type]();
  if (!ok) throw new SanitizationError('invalid-type', `input "${name}" is not a valid ${type}`);
}

function cleanString(value, scanner, tally) {
  let scanned;
  try {
    scanned = scanner(normalizeString(value));
  } catch (error) {
    throw new SanitizationError('scanner-failure', `credential scanner failed: ${error.message}`);
  }
  if (typeof scanned?.text !== 'string' || !Number.isInteger(scanned.redactions)) {
    throw new SanitizationError('scanner-failure', 'credential scanner returned an unusable result');
  }
  tally.redactions += scanned.redactions;
  return scanned.text;
}

function cleanValue(value, scanner, tally) {
  if (typeof value === 'string') return cleanString(value, scanner, tally);
  // checkType has already refused null, so an object here is a count map.
  if (typeof value === 'object') {
    const merged = new Map();
    for (const [key, count] of Object.entries(value)) {
      const cleanKey = cleanString(key, scanner, tally);
      merged.set(cleanKey, (merged.get(cleanKey) ?? 0) + count);
    }
    return Object.fromEntries(merged);
  }
  return value;
}

/**
 * @param {Record<string, unknown>} raw collected inputs, before any cleaning; only the
 *   pack's declared inputs are kept, and anything else is dropped unread
 * @param {object} pack a validated pack
 * @param {{ scanner?: (text: string) => { text: string, redactions: number } }} [options]
 * @returns {{ sanitizedInput: Record<string, unknown>, inputHash: string, redactions: number }}
 */
export function sanitize(raw, pack, { scanner = scanText } = {}) {
  const declared = pack.inputs;
  const fieldLimit = Math.min(pack.limits.fieldBytes, MAX_FIELD_BYTES);
  const tally = { redactions: 0 };
  const cleaned = {};
  for (const [name, field] of Object.entries(declared)) {
    if (!Object.hasOwn(raw, name)) throw new SanitizationError('missing-field', `input "${name}" was not collected`);
    checkType(name, field.type, raw[name]);
    const value = cleanValue(raw[name], scanner, tally);
    const limit = Math.min(field.maxBytes, fieldLimit);
    if (canonicalBytes(value) > limit) throw new SanitizationError('field-too-large', `input "${name}" exceeds ${limit} bytes`);
    cleaned[name] = value;
  }
  const sanitizedInput = JSON.parse(canonicalJson(cleaned));
  const totalLimit = Math.min(pack.limits.totalBytes, MAX_TOTAL_BYTES);
  if (canonicalBytes(sanitizedInput) > totalLimit) throw new SanitizationError('total-too-large', `sanitized input exceeds ${totalLimit} bytes`);
  return { sanitizedInput, inputHash: canonicalHash(sanitizedInput), redactions: tally.redactions };
}
