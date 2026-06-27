// config.mjs — read + validate .adlc/config.json, resolve the target repo, and
// build the `gh issue list` selector argv. Delegates field validation to the
// frozen T1 validateConfig (single schema source).

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { validateConfig } from './validate.mjs';

/** Load + schema-validate .adlc/config.json. Returns {ok, config, errors}. */
export function loadConfig(dir = '.') {
  const path = join(dir, '.adlc', 'config.json');
  if (!existsSync(path)) return { ok: false, config: null, errors: [`config not found: ${path} (run /adlc-init or create .adlc/config.json)`] };
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    return { ok: false, config: null, errors: [`invalid JSON in ${path}: ${e.message}`] };
  }
  const errors = validateConfig(raw);
  return { ok: errors.length === 0, config: errors.length ? null : raw, errors };
}

/**
 * Resolve the target `owner/repo`: explicit config wins; else derive from a git
 * remote URL (passed in so this stays pure/offline-testable).
 */
export function resolveRepo(ticketSync, { gitRemoteUrl } = {}) {
  if (ticketSync?.repo) return { ok: true, repo: ticketSync.repo };
  const m = (gitRemoteUrl || '').match(/github\.com[:/]([^/]+\/[^/.]+)(?:\.git)?\/?$/);
  if (m) return { ok: true, repo: m[1] };
  return { ok: false, error: 'repo not configured and not derivable from the git remote' };
}

/**
 * Build the argv for `gh issue list` from the selector. `limit` bounds the fetch;
 * the caller treats `returned === limit` as possible truncation (fail closed,
 * never delete). Default selector: open issues (the body-contains-sentinel filter
 * is applied client-side after fetch, since `gh` can't grep the body server-side).
 */
export function selectorArgs(ticketSync, { limit = 500 } = {}) {
  const sel = ticketSync?.select ?? {};
  const args = ['issue', 'list', '--json', 'number,title,body,labels,state,url', '--limit', String(limit)];
  args.push('--state', sel.state || 'open');
  for (const label of sel.labels ?? []) args.push('--label', label);
  if (sel.query) args.push('--search', sel.query);
  return args;
}
