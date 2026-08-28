// The single fail-closed redactor (spec §6.6, §10, AC 88/91/96/99/105).
//
// Every byte that leaves the process — a comment, the digest, a status file, a
// dead-end file, a model-bound prompt — passes through ONE function that
// replaces matches of the secret pattern set (the same shapes adversarial-review
// scans its own payload for, plus ADLC key-shaped values and .env-style
// assignments) and every literal secret the orchestrator holds with
// `[REDACTED:<pattern>]`. It FAILS CLOSED: if redaction throws, exceeds its
// budget, or its output still matches a pattern on a second pass, the caller
// gets the withheld sentinel and never the raw text.

import { active } from './mutations.mjs';

export const WITHHELD_DEAD_END = '[dead-end material withheld: redaction failed]';
export const WITHHELD_BODY = '[withheld: redaction failed — see local status]';

// adversarial-review src/secrets.js SECRET_PATTERNS (2.9.1), restated verbatim
// so the autopilot's outward scan and the reviewer's payload scan agree, plus
// the ADLC-specific shapes §6.5a(iv) names.
export const SECRET_PATTERNS = Object.freeze([
  { name: 'AWS access key ID', regex: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'Private key (PEM)', regex: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g },
  { name: 'OpenAI/Anthropic-style key', regex: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { name: 'GitHub token', regex: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { name: 'Slack token', regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: 'Google API key', regex: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: 'JWT', regex: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { name: 'Hardcoded credential assignment', regex: /\b(?:api[_-]?key|secret|passwd|password|auth[_-]?token|access[_-]?token)\b["']?\s*[:=]\s*["'][^"'\s]{12,}["']/gi },
  // ADLC_MANIFEST_KEY-shaped values: the key is a long hex/base64 blob.
  { name: 'ADLC manifest key', regex: /\bADLC_MANIFEST_KEY\s*[:=]\s*["']?[A-Za-z0-9+/=_-]{16,}["']?/g },
  // .env-style assignments of *_KEY|*_TOKEN|*_SECRET.
  { name: 'env secret assignment', regex: /^\s*(?:export\s+)?[A-Z][A-Z0-9_]*(?:_KEY|_TOKEN|_SECRET)\s*=\s*\S+/gm },
  // OAuth bearer tokens in headers.
  { name: 'Bearer token', regex: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/g },
]);

const PATTERN_NAMES = Object.freeze(SECRET_PATTERNS.map((p) => p.name));
export const PATTERN_COUNT = SECRET_PATTERNS.length;

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** The longest-first literal-value pass: every orchestrator secret value, verbatim. */
function literalPatterns(secretValues) {
  return [...new Set(secretValues.filter((v) => typeof v === 'string' && v.length >= 8))]
    .sort((a, b) => b.length - a.length)
    .map((v) => ({ name: 'orchestrator secret value', regex: new RegExp(escapeRegex(v), 'g') }));
}

function applyOnce(text, patterns) {
  let out = text; const hits = [];
  for (const { name, regex } of patterns) {
    regex.lastIndex = 0;
    let count = 0;
    out = out.replace(regex, () => { count++; return `[REDACTED:${name}]`; });
    if (count) hits.push({ pattern: name, count });
  }
  return { out, hits };
}

function matchesAny(text, patterns) {
  return patterns.some(({ regex }) => { regex.lastIndex = 0; return regex.test(text); });
}

/**
 * Build a redactor bound to the orchestrator's literal secret values.
 *
 * @param opts.secretValues  literal values to replace (key-bearing env values, tokens)
 * @param opts.maxChars      fence cap applied AFTER redaction (tail-biased truncation)
 * @param opts.budgetMs      wall budget; exceeding it fails closed
 * @param opts.now           injectable clock
 * @param opts.impl          injectable inner pass (tests inject a throwing/leaky fake)
 */
export function createRedactor({ secretValues = [], maxChars = null, budgetMs = 5_000, now = Date.now, impl = null } = {}) {
  const patterns = [...literalPatterns(secretValues), ...SECRET_PATTERNS];
  const inner = impl ?? ((text) => applyOnce(text, patterns).out);
  /**
   * @returns {{ ok: boolean, text: string, hits: Array, reason?: string }}
   *   ok:false → `text` is ALREADY the withheld sentinel the caller must use.
   */
  function redact(input, { withheld = WITHHELD_DEAD_END } = {}) {
    const text = String(input ?? '');
    // Mutation seam `redactor.disable`: the raw text goes out and claims ok.
    if (active('redactor.disable')) return { ok: true, text, hits: [] };
    const started = now();
    let out; let hits = [];
    try {
      const first = applyOnce(text, patterns);
      hits = first.hits;
      out = inner(text);
      if (typeof out !== 'string') return { ok: false, text: withheld, hits, reason: 'redactor-returned-non-string' };
    } catch (e) {
      return { ok: false, text: withheld, hits, reason: `redactor-threw:${e.message}` };
    }
    if (now() - started > budgetMs) return { ok: false, text: withheld, hits, reason: 'redactor-timeout' };
    // Second pass: the output must not match any pattern — a leaky implementation
    // is caught here and the material is withheld, never emitted raw.
    if (!active('redactor.skipSecondPass') && matchesAny(out, patterns)) return { ok: false, text: withheld, hits, reason: 'residual-match' };
    if (maxChars != null && out.length > maxChars) out = out.slice(out.length - maxChars);
    return { ok: true, text: out, hits };
  }
  return { redact, patternNames: PATTERN_NAMES };
}

/**
 * Structured redaction (§10, AC 105): only the named free-text fields pass
 * through the redactor; identifiers/state never do. A failing field is set to
 * null and listed under `redactionFailed`, so the document keeps its schema.
 */
export function redactRecord(record, freeTextFields, redactor) {
  const out = { ...record };
  const failed = [];
  for (const field of freeTextFields) {
    if (out[field] == null) continue;
    const r = redactor.redact(String(out[field]), { withheld: null });
    if (r.ok) out[field] = r.text; else { out[field] = null; failed.push(field); }
  }
  if (failed.length) out.redactionFailed = [...new Set([...(record.redactionFailed ?? []), ...failed])];
  return out;
}

/**
 * Chunked redaction for large captures (§6.6, AC 99): 64 KiB chunks with a
 * pattern-boundary overlap so a secret straddling a chunk edge is still caught;
 * only the redacted LAST `keepChars` is retained.
 */
export const CHUNK_BYTES = 64 * 1024;
export const CHUNK_OVERLAP = 4 * 1024;
export function redactStream(chunks, redactor, { keepChars = CHUNK_BYTES } = {}) {
  let carry = '';
  let tail = '';
  let ok = true;
  for (const c of chunks) {
    const text = carry + String(c);
    const r = redactor.redact(text);
    if (!r.ok) { ok = false; break; }
    // Everything except the overlap window is final; the window is re-scanned with the next chunk.
    const finalPart = r.text.slice(0, Math.max(0, r.text.length - CHUNK_OVERLAP));
    carry = text.slice(Math.max(0, text.length - CHUNK_OVERLAP));
    tail = (tail + finalPart).slice(-keepChars);
  }
  if (!ok) return { ok: false, text: WITHHELD_DEAD_END };
  const last = redactor.redact(carry);
  if (!last.ok) return { ok: false, text: WITHHELD_DEAD_END };
  return { ok: true, text: (tail + last.text).slice(-keepChars) };
}
