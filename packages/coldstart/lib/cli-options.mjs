// cli-options.mjs — the coldstart CLI's usage string and parseArgs option
// config, extracted from bin/coldstart.mjs so their DEFAULT VALUES are
// directly unit-testable (the bin itself is not importable — it runs on
// load). This is what a mutation gate exercises against: flip `force`'s
// default to true and a test importing this file must fail.

export const USAGE = 'usage: coldstart <ticket-id> [--ticket <id>] [--tickets path] [--all] [--tier cheap|mid|frontier] [--offline] [--force] [--max-age <days>] [--prompt-only] [--record-verdict <file|->] [--json]';

export const OPTIONS = {
  ticket: { type: 'string' },
  tickets: { type: 'string', default: '.adlc/tickets.json' },
  all: { type: 'boolean', default: false },
  tier: { type: 'string', default: 'cheap' },
  offline: { type: 'boolean', default: false },
  force: { type: 'boolean', default: false },
  'max-age': { type: 'string', default: '30' },
  'prompt-only': { type: 'boolean', default: false },
  'record-verdict': { type: 'string' },
  json: { type: 'boolean', default: false },
};

/**
 * Resolve the target ticket id from positional `<ticket-id>` and/or `--ticket <id>`.
 * Fails closed when both are supplied and disagree.
 *
 * @param {string | undefined} positionalId
 * @param {string | undefined} flagId
 * @returns {{ok: true, ticketId: string | null, error: null} | {ok: false, ticketId: null, error: string}}
 */
export function resolveTicketArg(positionalId, flagId) {
  if (positionalId && flagId && positionalId !== flagId) {
    return {
      ok: false,
      ticketId: null,
      error: `conflicting ticket ids: positional "${positionalId}" vs --ticket "${flagId}"`,
    };
  }
  return { ok: true, ticketId: positionalId ?? flagId ?? null, error: null };
}

/**
 * Validate and convert the `--max-age` flag (days) to milliseconds.
 * 0 is valid and means "treat every cache entry as stale" (issue #278) — a
 * DIFFERENT thing than the `null` sentinel checkAll/findCachedVerdict use
 * for "no age limit"; this function never returns null, only a finite ms
 * value or an error.
 *
 * @param {string} raw - the raw --max-age flag value
 * @returns {{ok: true, maxAgeMs: number} | {ok: false, error: string}}
 */
export function parseMaxAgeDays(raw) {
  const days = Number(raw);
  if (!Number.isFinite(days) || days < 0) {
    return { ok: false, error: `--max-age must be a non-negative number of days, got: ${raw}` };
  }
  return { ok: true, maxAgeMs: days * 24 * 60 * 60 * 1000 };
}
