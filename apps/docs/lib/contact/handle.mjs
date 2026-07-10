// handleContact — the framework-agnostic core of POST /api/contact. Pure and
// dependency-injected so every branch is unit-testable without the Vercel or
// Next runtime (design decision 8). The thin route.ts wires the real deps.
//
// Gate order (PM-C): honeypot -> same-origin -> rate limit -> validate -> BotID
// -> sink. A BotID *infra error* fails open (the request proceeds) because a
// real enterprise lead should never be lost to a platform blip; the honeypot,
// same-origin, and rate-limit gates still applied. Nothing that may embed a
// secret or PII is ever logged or returned (PM-D / AC8).

import { parseLead } from './schema.mjs';

// Hidden field a real user never fills; bots that auto-fill inputs will.
export const HONEYPOT_FIELD = 'company_website';

// Hard cap on the request body. A legitimate lead is a few KB (message maxes at
// 5000 chars); 64KB is generous headroom. The route rejects anything larger
// BEFORE parsing so a huge body can't burn CPU/memory ahead of the abuse gates.
export const MAX_BODY_BYTES = 64 * 1024;

// Accept only a present, non-negative Content-Length within the cap. Requiring
// the header (present ⇒ not chunked) bounds the subsequent read to `max` bytes,
// closing the undeclared/chunked-body buffering path. A browser form fetch with
// a JSON string body always sets Content-Length.
export function bodyLengthAcceptable(contentLength, max = MAX_BODY_BYTES) {
  if (contentLength === null || contentLength === undefined || contentLength === '') return false;
  const n = Number(contentLength);
  return Number.isFinite(n) && n >= 0 && n <= max;
}

export function firstHop(xff) {
  return xff ? String(xff).split(',')[0].trim() : '';
}

export function safeOrigin(value) {
  if (!value) return '';
  try {
    return new URL(value).origin;
  } catch {
    return '';
  }
}

function originAllowed(reqOrigin, allowed) {
  if (!allowed || allowed.length === 0) return true; // enforcement off when unconfigured
  if (!reqOrigin) return false;
  return allowed.includes(reqOrigin);
}

// The request's own origin, reconstructed from the Host header. Used as the
// same-origin default so enforcement never silently disables when no explicit
// allowlist is configured (a genuine same-origin POST has Origin === this).
function expectedOriginFromHost(getHeader) {
  const host = getHeader('host');
  if (!host) return '';
  const proto = getHeader('x-forwarded-proto') || 'https';
  // Normalize through URL so a Host with an explicit default port
  // (e.g. "host:443") compares equal to a browser Origin without one.
  return safeOrigin(`${proto}://${host}`);
}

/**
 * @param {{
 *   body?: Record<string, unknown>,
 *   getHeader?: (name: string) => string | null,
 *   deps?: {
 *     checkBot?: () => Promise<{ isBot: boolean }>,
 *     selectSink?: () => { submit: (lead: object) => Promise<{ ok: boolean }> },
 *     rateLimit?: (key: string) => { allowed: boolean },
 *     allowedOrigins?: string[],
 *   },
 * }} args
 * @returns {Promise<{ status: number, body: object }>}
 */
export async function handleContact({ body = {}, getHeader = () => null, deps = {} }) {
  // 1. Honeypot — silent success, never reveal the tell, never touch the sink.
  if (body[HONEYPOT_FIELD]) {
    return { status: 200, body: { ok: true } };
  }

  // 2. Same-origin allowlist. Prefer an explicit list; otherwise fall back to
  // the request's own Host-derived origin so enforcement never fails open just
  // because CONTACT_ALLOWED_ORIGINS was not set (PM-C).
  const reqOrigin = safeOrigin(getHeader('origin')) || safeOrigin(getHeader('referer'));
  const allowed =
    deps.allowedOrigins && deps.allowedOrigins.length > 0
      ? deps.allowedOrigins
      : [expectedOriginFromHost(getHeader)].filter(Boolean);
  if (!originAllowed(reqOrigin, allowed)) {
    return { status: 403, body: { ok: false, error: 'forbidden_origin' } };
  }

  // 3. Validate BEFORE consuming rate-limit quota, so cheap malformed spam
  // from one IP can't exhaust the quota and lock out a real lead behind the
  // same NAT. Validation is local and free.
  const parsed = parseLead(body);
  if (!parsed.ok) {
    return { status: 400, body: { ok: false, error: 'invalid', fields: parsed.errors } };
  }

  // 4. Rate limit (per-instance, best-effort) — counts only well-formed attempts.
  if (deps.rateLimit) {
    const key = firstHop(getHeader('x-forwarded-for')) || 'unknown';
    const { allowed } = deps.rateLimit(key);
    if (!allowed) {
      return { status: 429, body: { ok: false, error: 'rate_limited' } };
    }
  }

  // 5. BotID — definitive bot => 403; infra error => fail open (see header note).
  if (deps.checkBot) {
    try {
      const verdict = await deps.checkBot();
      if (verdict && verdict.isBot) {
        return { status: 403, body: { ok: false, error: 'bot_detected' } };
      }
    } catch {
      // Deliberately swallow: the error object may embed PII/secrets. Other
      // gates already ran; treat as human rather than lose a real lead.
    }
  }

  // 6. Sink.
  let sink;
  try {
    sink = deps.selectSink();
  } catch (e) {
    if (e && e.code === 'sink_unconfigured') {
      return { status: 503, body: { ok: false, error: 'sink_unconfigured' } };
    }
    return { status: 502, body: { ok: false, error: 'sink_failed' } };
  }
  try {
    await sink.submit(parsed.value);
  } catch {
    // Never surface or log the underlying error — it may carry the token/PII.
    return { status: 502, body: { ok: false, error: 'sink_failed' } };
  }

  return { status: 200, body: { ok: true } };
}
