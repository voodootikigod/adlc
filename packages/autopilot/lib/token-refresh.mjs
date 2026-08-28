// The credential-lifetime gate and the gated token refresh (spec §6.4 item 14,
// §12.1; AC 158).
//
// Phase B only RECORDS `tokenShort`; the refresh is its own Claude-consuming
// step after the loop-head quota gate: the pinned `claude -p` with the exact
// §12.1 argv, `ok\n` on stdin, an empty private cwd under the run directory,
// the helper's minimal env plus the real HOME (never the manifest key),
// counted as a start and reconciled like shaping. Then the file is re-read;
// still short → the iteration ends with `token-expiring`.

import { readFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tokenMargin } from './preflight-b.mjs';
import { preStrikeEnv } from './fleet-args.mjs';
import { DEADLINES } from './spawn.mjs';
import { validateModel } from './input.mjs';
import { registerSeams, active } from './mutations.mjs';

registerSeams(['tokenRefresh.keepKey', 'tokenRefresh.skipRecheck']);

export const REFRESH_STDIN = 'ok\n';
export const REFRESH_STDOUT_CAP = 64 * 1024;

export const credentialsPath = (home) => join(home, '.claude', '.credentials.json');

/** The host credential file's text, or null when unreadable. */
export function readCredentials(home) {
  try { return readFileSync(credentialsPath(home), 'utf8'); } catch { return null; }
}

/** The OAuth access token of the host credential file (for the usage endpoint), or null. */
export function readAccessToken(home) {
  const text = readCredentials(home);
  if (text == null) return null;
  try { const doc = JSON.parse(text); return typeof doc?.claudeAiOauth?.accessToken === 'string' ? doc.claudeAiOauth.accessToken : null; } catch { return null; }
}

/** `expiresAt − now ≥ wallClock + 30 min` over the CURRENT file (re-read every call). */
export function tokenMarginFor({ ctx, wallClockMs }) {
  const m = tokenMargin({ credentialsText: readCredentials(ctx.env.home), now: ctx.now(), wallClockMs });
  return { ...m, minutesLeft: m.remainingMs == null ? 0 : Math.floor(m.remainingMs / 60_000) };
}

/** The exact §12.1 refresh argv. */
export function refreshArgv({ ctx, model = ctx.local?.model }) {
  return [ctx.pinned.claude, '-p', '--model', validateModel(model ?? 'opus', 'model'), '--output-format', 'json', '--permission-mode', 'plan', '--max-turns', '1'];
}

/**
 * Run the gated refresh, then re-read the margin. Returns { ok, spawned,
 * reason, minutesLeft }. `ok:false` → the iteration ends with token-expiring.
 */
export async function tokenRefresh({ ctx, quota, wallClockMs = (ctx.config?.autopilot?.wallClockMinutes ?? 90) * 60_000 }) {
  const before = tokenMarginFor({ ctx, wallClockMs });
  if (!before.tokenShort) return { ok: true, spawned: false, reason: 'margin-sufficient', minutesLeft: before.minutesLeft };
  const ordinal = ctx.status.incrementStarts();
  const sample = await quota.sample({ ordinal, fresh: true });
  if (!sample.ok) return { ok: false, spawned: false, reason: `quota:${sample.reason}`, minutesLeft: before.minutesLeft };
  const cwd = join(ctx.paths.runsDir, `token-refresh-${ctx.iterationId}`);
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  const env = { ...preStrikeEnv({ ctx }), HOME: ctx.env.home };
  // Mutation seam `tokenRefresh.keepKey`: the manifest key rides into the refresh call.
  if (active('tokenRefresh.keepKey') && ctx.key) env.ADLC_MANIFEST_KEY = ctx.key;
  const res = await ctx.spawn({ argv: refreshArgv({ ctx }), cwd, env, stdinBytes: REFRESH_STDIN, deadlineMs: DEADLINES.claude, stdoutCap: REFRESH_STDOUT_CAP, label: 'claude token-refresh' });
  try { rmSync(cwd, { recursive: true, force: true }); } catch { /* best effort */ }
  try { await quota.reconcile?.('token-refresh', sample); } catch (e) { ctx.log(`token-refresh reconcile failed: ${e.message}`); }
  if (active('tokenRefresh.skipRecheck')) return { ok: true, spawned: true, reason: 'unchecked', minutesLeft: before.minutesLeft, status: res.status };
  const after = tokenMarginFor({ ctx, wallClockMs });
  if (after.tokenShort) return { ok: false, spawned: true, reason: after.reason ?? 'token-expiring', minutesLeft: after.minutesLeft, status: res.status };
  return { ok: true, spawned: true, reason: 'refreshed', minutesLeft: after.minutesLeft, status: res.status };
}
