// providers/github.mjs — the GitHub implementation of the provider interface.
// The ONLY GitHub-specific code; it talks to `gh` through the injected runner, so
// it is fully offline-testable with canned --json fixtures.

import { ghJson } from '../gh.mjs';
import { selectorArgs } from '../config.mjs';

/** Map one raw `gh issue list --json` entry to the provider's neutral shape. */
export function mapIssue(raw) {
  return {
    number: raw.number,
    nodeId: raw.id ?? null,
    url: raw.url ?? null,
    title: raw.title ?? '',
    body: raw.body ?? '',
    labels: Array.isArray(raw.labels) ? raw.labels.map((l) => (typeof l === 'string' ? l : l.name)).filter(Boolean) : [],
    state: (raw.state ?? '').toLowerCase(),
  };
}

export function githubProvider() {
  return {
    /** @returns {Promise<{ok, issues?, error?, truncated?}>} */
    async listIssues({ runner, repo, ticketSync, limit = 500 }) {
      const r = await ghJson(runner, selectorArgs(ticketSync, { limit, repo }));
      if (!r.ok) return { ok: false, error: r.error };
      if (!Array.isArray(r.data)) return { ok: false, error: 'gh issue list did not return an array' };
      // A full page means we cannot be sure we got everything — fail closed rather
      // than risk a truncated set driving deletions/incomplete sync.
      if (r.data.length >= limit) {
        return { ok: false, truncated: true, error: `fetched ${r.data.length} issues (hit the limit of ${limit}); narrow the selector or raise --limit` };
      }
      return { ok: true, issues: r.data.map(mapIssue) };
    },
  };
}
