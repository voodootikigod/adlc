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

  // 2. Same-origin allowlist.
  const reqOrigin = safeOrigin(getHeader('origin')) || safeOrigin(getHeader('referer'));
  if (!originAllowed(reqOrigin, deps.allowedOrigins)) {
    return { status: 403, body: { ok: false, error: 'forbidden_origin' } };
  }

  // 3. Rate limit (per-instance, best-effort).
  if (deps.rateLimit) {
    const key = firstHop(getHeader('x-forwarded-for')) || 'unknown';
    const { allowed } = deps.rateLimit(key);
    if (!allowed) {
      return { status: 429, body: { ok: false, error: 'rate_limited' } };
    }
  }

  // 4. Validate.
  const parsed = parseLead(body);
  if (!parsed.ok) {
    return { status: 400, body: { ok: false, error: 'invalid', fields: parsed.errors } };
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
