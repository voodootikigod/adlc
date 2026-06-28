// providers/github.mjs — the GitHub implementation of the provider interface.
// The ONLY GitHub-specific code; it talks to `gh` through the injected runner, so
// it is fully offline-testable with canned --json fixtures. Every mutation is an
// execFile argv (never a shell string) — untrusted issue content is passed as a
// flag VALUE, never interpolated into a command (design C4).

import { ghJson } from '../gh.mjs';
import { selectorArgs } from '../config.mjs';
import { normalizeNewlines } from '../canonical.mjs';
import { STATUS_COMMENT_MARKER } from '../status-render.mjs';

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

/** Pull the numeric issue number out of a `gh issue create` URL (…/issues/<n>). */
export function parseIssueNumberFromUrl(url) {
  const m = String(url ?? '').match(/\/issues\/(\d+)\s*$/);
  return m ? Number(m[1]) : null;
}

/** Pull the numeric comment id out of a comment url (…#issuecomment-<id>). */
export function parseCommentId(url) {
  const m = String(url ?? '').match(/#issuecomment-(\d+)\s*$/);
  return m ? m[1] : null;
}

const refNum = (ref) => String(typeof ref === 'object' ? ref.number : ref);

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

    /** Resolve the authenticated login (for the status-comment author check). */
    async whoami({ runner }) {
      const r = await ghJson(runner, ['api', 'user']);
      if (!r.ok) return { ok: false, error: r.error };
      return { ok: true, login: r.data?.login ?? null };
    },

    /**
     * Fetch one issue by number (labels included) — the selector-independent read
     * used by crash recovery to adopt an orphan the label-scoped list can't see.
     * @returns {Promise<{ok, number?, nodeId?, url?, labels?, state?, error?}>}
     */
    async getIssue({ runner, repo }, number) {
      const r = await ghJson(runner, ['issue', 'view', String(number), '--repo', repo, '--json', 'id,number,url,labels,state']);
      if (!r.ok) {
        // Distinguish a CONFIRMED-missing issue (safe for the caller to recreate)
        // from a TRANSIENT failure (network/5xx/rate-limit) — the caller must not
        // recreate on a transient failure or it duplicates the existing issue.
        const notFound = /could not resolve|not found|no longer exists|404/i.test(r.error || '');
        return { ok: false, notFound, error: r.error };
      }
      const m = mapIssue(r.data);
      return { ok: true, number: m.number, nodeId: m.nodeId, url: m.url, labels: m.labels, state: m.state };
    },

    /**
     * Create an issue for a local-only ticket. Optionally attach labels ATOMICALLY
     * (create-if-missing first, then `issue create --label`) so the new issue is in
     * the configured selection immediately — no unlabeled-orphan window. Then
     * `issue view --json` recovers the durable nodeId + number.
     * @returns {Promise<{ok, number?, nodeId?, url?, error?}>}
     */
    async createIssue({ runner, repo, dryRun }, { title, body, labels = [] }) {
      if (dryRun) return { ok: true, dryRun: true };
      for (const label of labels) {
        // --force = create-if-missing (idempotent); `issue create --label X` errors if X doesn't exist.
        const c = await runner(['label', 'create', label, '--repo', repo, '--force']);
        if (!c.ok) return { ok: false, error: c.error || c.stderr || `gh label create ${label} failed` };
      }
      const args = ['issue', 'create', '--repo', repo, '--title', title, '--body', body];
      for (const label of labels) args.push('--label', label);
      const created = await runner(args);
      if (!created.ok) return { ok: false, error: created.error || created.stderr || 'gh issue create failed' };
      const url = (created.stdout || '').trim().split('\n').filter(Boolean).pop();
      const number = parseIssueNumberFromUrl(url);
      if (!number) return { ok: false, error: `could not parse the new issue number from: ${url}` };
      const view = await ghJson(runner, ['issue', 'view', String(number), '--repo', repo, '--json', 'id,number,url']);
      if (!view.ok) return { ok: false, error: view.error };
      return { ok: true, number, nodeId: view.data?.id ?? null, url: view.data?.url ?? url };
    },

    /** Replace the issue body (prose + re-serialized block). */
    async updateIssueBody({ runner, repo, dryRun }, ref, body) {
      if (dryRun) return { ok: true, dryRun: true };
      const r = await runner(['issue', 'edit', refNum(ref), '--repo', repo, '--body', body]);
      return r.ok ? { ok: true } : { ok: false, error: r.error || r.stderr || 'gh issue edit failed' };
    },

    /**
     * Ensure the given labels (create-if-missing), then add/remove them on the issue.
     * The caller passes only labels that actually need to change, so a converged
     * issue triggers NO call (push idempotency).
     */
    async ensureLabels({ runner, repo, dryRun }, ref, { add = [], remove = [] } = {}) {
      if (add.length === 0 && remove.length === 0) return { ok: true, noop: true };
      if (dryRun) return { ok: true, dryRun: true };
      for (const label of add) {
        // --force makes create idempotent (update-if-exists), so re-runs never error.
        const c = await runner(['label', 'create', label, '--repo', repo, '--force']);
        if (!c.ok) return { ok: false, error: c.error || c.stderr || `gh label create ${label} failed` };
      }
      const args = ['issue', 'edit', refNum(ref), '--repo', repo];
      for (const l of add) args.push('--add-label', l);
      for (const l of remove) args.push('--remove-label', l);
      const r = await runner(args);
      return r.ok ? { ok: true } : { ok: false, error: r.error || r.stderr || 'gh issue edit (labels) failed' };
    },

    /**
     * Upsert the marker-anchored status comment. Reads the issue's comments, finds
     * the one authored by `login` carrying the marker; edits it only if the body
     * differs, else creates it. A converged comment makes NO mutating call.
     */
    async upsertStatusComment({ runner, repo, dryRun, login }, ref, body) {
      const view = await ghJson(runner, ['issue', 'view', refNum(ref), '--repo', repo, '--json', 'comments']);
      if (!view.ok) return { ok: false, error: view.error };
      const comments = Array.isArray(view.data?.comments) ? view.data.comments : [];
      const mine = comments.find((c) => c?.author?.login === login && typeof c.body === 'string' && c.body.includes(STATUS_COMMENT_MARKER));
      const same = (a, b) => normalizeNewlines(a ?? '').trim() === normalizeNewlines(b ?? '').trim();

      if (mine && same(mine.body, body)) return { ok: true, changed: false };
      if (dryRun) return { ok: true, dryRun: true, changed: true };

      if (mine) {
        const id = parseCommentId(mine.url);
        if (!id) return { ok: false, error: `could not parse comment id from: ${mine.url}` };
        const r = await runner(['api', '--method', 'PATCH', `/repos/${repo}/issues/comments/${id}`, '-f', `body=${body}`]);
        return r.ok ? { ok: true, changed: true } : { ok: false, error: r.error || r.stderr || 'gh api PATCH comment failed' };
      }
      const r = await runner(['issue', 'comment', refNum(ref), '--repo', repo, '--body', body]);
      return r.ok ? { ok: true, changed: true } : { ok: false, error: r.error || r.stderr || 'gh issue comment failed' };
    },
  };
}
