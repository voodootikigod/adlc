// Token building and publish planning (plan §5.1). Every value passes
// sanitizeToken before it can reach a terminal surface; publishes are
// change-driven (diffed) so the watcher never spams; report-agent is never
// emitted — agent state belongs to herdr's built-in integrations.
import { sanitizeToken } from './sanitize.mjs';

/** Tokens for one pane from its repo's active-ticket state + latest phase. */
export function paneTokens(active, phase) {
  if (!active || typeof active !== 'object') return {};
  if (active.state === 'unreadable') return { ticket: 'unreadable' };
  if (active.state !== 'active') return {};
  const tokens = { ticket: sanitizeToken(active.id) };
  if (typeof phase === 'string' && phase.length > 0) tokens.phase = sanitizeToken(phase);
  return tokens;
}

/** Workspace-level backlog-count tokens. */
export function workspaceTokens(counts) {
  return {
    adlc_ready: sanitizeToken(String(counts?.ready ?? 0)),
    adlc_active: sanitizeToken(String(counts?.inFlight ?? 0)),
    adlc_blocked: sanitizeToken(String(counts?.blocked ?? 0)),
  };
}

/** One batched `pane report-metadata` argv for a pane's token set. */
export function buildReportArgs(paneId, tokens, ttlMs) {
  const args = ['pane', 'report-metadata', paneId, '--source', 'adlc'];
  for (const [key, value] of Object.entries(tokens)) {
    args.push('--token', `${sanitizeToken(key, 32)}=${sanitizeToken(String(value))}`);
  }
  args.push('--ttl-ms', String(ttlMs));
  return args;
}

/** Same shape for workspace report-metadata. */
export function buildWorkspaceReportArgs(workspaceId, tokens, ttlMs) {
  const args = ['workspace', 'report-metadata', workspaceId, '--source', 'adlc'];
  for (const [key, value] of Object.entries(tokens)) {
    args.push('--token', `${sanitizeToken(key, 32)}=${sanitizeToken(String(value))}`);
  }
  args.push('--ttl-ms', String(ttlMs));
  return args;
}

/** Only the entries of `next` that are new or changed vs `prev`. */
export function diffPublishes(prev, next) {
  const changed = new Map();
  for (const [paneId, tokens] of next) {
    const before = prev.get(paneId);
    if (!before || JSON.stringify(before) !== JSON.stringify(tokens)) changed.set(paneId, tokens);
  }
  return changed;
}

/** Keys present in `prev` but gone from `next` — the entries whose tokens must
 *  be actively CLEARED, or they linger in herdr until the 90s TTL expires
 *  (e.g. a pane whose ticket became absent, or a closed repo). */
export function droppedKeys(prev, next) {
  const gone = [];
  for (const key of prev.keys()) if (!next.has(key)) gone.push(key);
  return gone;
}

/** All token names this plugin ever publishes for a pane / a workspace — the
 *  set to `--clear-token` when the target drops out. */
export const PANE_TOKEN_KEYS = ['ticket', 'phase'];
export const WORKSPACE_TOKEN_KEYS = ['adlc_ready', 'adlc_active', 'adlc_blocked'];

/** `pane report-metadata` argv that clears this plugin's pane tokens. */
export function buildPaneClearArgs(paneId) {
  const args = ['pane', 'report-metadata', paneId, '--source', 'adlc'];
  for (const key of PANE_TOKEN_KEYS) args.push('--clear-token', key);
  return args;
}

/** `workspace report-metadata` argv that clears this plugin's workspace tokens. */
export function buildWorkspaceClearArgs(workspaceId) {
  const args = ['workspace', 'report-metadata', workspaceId, '--source', 'adlc'];
  for (const key of WORKSPACE_TOKEN_KEYS) args.push('--clear-token', key);
  return args;
}

/**
 * Version gate (plan §6.5): supported at or below the tested ceiling;
 * anything newer — or unparseable — degrades to a single warning token.
 */
export function versionGate(versionOutput, ceiling) {
  const match = typeof versionOutput === 'string' ? versionOutput.match(/(\d+)\.(\d+)\.(\d+)/) : null;
  if (!match) return { supported: false, token: 'untested herdr version (unparseable)' };
  const ceilMatch = typeof ceiling === 'string' ? ceiling.match(/(\d+)\.(\d+)\.(\d+)/) : null;
  if (!ceilMatch) throw new TypeError(`versionGate ceiling must be an x.y.z string, got ${ceiling}`);
  const version = match.slice(1, 4).map(Number);
  const ceil = ceilMatch.slice(1, 4).map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (version[i] > ceil[i]) {
      return { supported: false, token: `untested herdr version ${match[0]} (tested <= ${ceiling})` };
    }
    if (version[i] < ceil[i]) return { supported: true };
  }
  return { supported: true };
}
