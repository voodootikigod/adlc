// Selection for the loop (spec §4): the candidate set from GitHub, the
// denylist parsed at BASE_OID, the cheap §4.2 rules over every candidate, and
// the expensive ones (authorization timeline/edits, the selection-time
// ls-remote) evaluated in score order until one candidate is eligible — so a
// repository with hundreds of open issues costs a handful of gh calls, not
// three per issue. Pure pieces live in select.mjs / authorize.mjs / denylist.mjs.

import { listOpenIssues, issueTimeline, issueBodyEdits, permissionOf, listOpenPrs } from './github.mjs';
import { eligibleAuthor } from './authorize.mjs';
import { hardExclusions, selectIssue, scoreIssue } from './select.mjs';
import { buildDenylist } from './denylist.mjs';
import { parseBlock } from './block.mjs';
import { createAttemptStore } from './attempts.mjs';
import { registerSeams, active } from './mutations.mjs';

registerSeams(['selection.failOpenAttempts']);
import { showAtBaseline, PreflightError } from './preflight-common.mjs';
import { branchFor, validateIssueNumber } from './input.mjs';

export const TRUST_ROOTS_PATH = 'packages/rails-guard/lib/ci/trust-roots.mjs';
export const RAILS_GUARD_CI_PATH = 'scripts/rails-guard-ci.mjs';

/** A REST issue (`gh api repos/../issues`) in the shape select/authorize read (`gh issue view --json`). */
export function normalizeIssue(raw) {
  const labels = Array.isArray(raw?.labels) ? raw.labels.map((l) => (typeof l === 'string' ? { name: l } : { name: l?.name })).filter((l) => l.name) : [];
  return {
    number: validateIssueNumber(raw?.number, 'issue'),
    title: String(raw?.title ?? ''), body: String(raw?.body ?? ''), url: typeof raw?.html_url === 'string' ? raw.html_url : (raw?.url ?? null),
    state: String(raw?.state ?? 'open').toUpperCase(), labels,
    milestone: raw?.milestone ? { title: raw.milestone.title ?? null } : null,
    createdAt: raw?.created_at ?? raw?.createdAt ?? null, updatedAt: raw?.updated_at ?? raw?.updatedAt ?? null,
    author: { login: raw?.user?.login ?? raw?.author?.login ?? null },
    authorAssociation: raw?.author_association ?? raw?.authorAssociation ?? null,
  };
}

/** The denylist of §4.2 from the two trust-root lists AT BASE_OID (never the working tree) plus config extras. */
export async function loadDenylist({ ctx }) {
  const [trustRootsModuleText, railsGuardCiText] = await Promise.all([showAtBaseline(ctx, ctx.baseOid, TRUST_ROOTS_PATH), showAtBaseline(ctx, ctx.baseOid, RAILS_GUARD_CI_PATH)]);
  if (trustRootsModuleText == null || railsGuardCiText == null) throw new PreflightError('trust-root-list-missing', `${TRUST_ROOTS_PATH} / ${RAILS_GUARD_CI_PATH} absent at ${ctx.baseOid}`);
  return buildDenylist({ trustRootsModuleText, railsGuardCiText, extras: ctx.config?.autopilot?.protectedPathsExtra ?? [] });
}

/** The scope globs of a body's `<!-- adlc:begin -->` block, or null (a malformed block is triage's finding, not an exclusion). */
export function scopeBlockOf(body) {
  const parsed = parseBlock(body);
  return parsed.ok && Array.isArray(parsed.fields?.scope) ? parsed.fields.scope : null;
}

/**
 * @returns {{ picked, issue, authorization, revision, excludedRule, ranked, reason }}
 *   `picked` is the issue NUMBER (null when nothing is eligible); `revision`
 *   carries the authorization's issueRevision plus `updatedAt` for §6.0a.
 */
export async function selectForLoop({ ctx, pinned = null, force = false, top = null }) {
  const gh = ctx.gh;
  const cfg = ctx.config?.autopilot ?? {};
  const listed = await listOpenIssues(gh);
  if (!listed.ok) return { picked: null, issue: null, authorization: null, revision: null, excludedRule: listed.reason, ranked: [], reason: listed.reason, detail: listed.detail };
  const candidates = listed.issues.map(normalizeIssue);
  const denylist = ctx.denylist ?? (ctx.denylist = await loadDenylist({ ctx }));
  const listedPrs = await listOpenPrs(gh);
  if (!listedPrs.ok) return { picked: null, issue: null, authorization: null, revision: null, excludedRule: listedPrs.reason, ranked: [], reason: listedPrs.reason, detail: listedPrs.detail };
  const openPrs = listedPrs.prs;
  const localBranches = (await ctx.git.localOut(ctx.repoRoot, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/adlc/autopilot/'])).split('\n').map((s) => s.trim()).filter(Boolean);
  const attempts = createAttemptStore({ paths: ctx.paths, now: ctx.now, lockToken: ctx.lock?.token ?? null });
  const facts = new Map();

  // Stage 1: the cheap rules over every candidate (no per-issue I/O).
  const cheap = (issue) => hardExclusions({
    issue, authorization: { ok: true }, openPrs: Array.isArray(openPrs) ? openPrs : [], localBranches, remoteRefExists: false,
    records: ctx.records, scopeBlock: scopeBlockOf(issue.body), denylist, attempts: safeFailed(attempts, issue.number, ctx.log),
  });
  const stage1 = await selectIssue({ candidates, evaluate: (issue) => ({ exclusions: cheap(issue), ...scoreIssue(issue, ctx.now()) }), pinned, force, now: ctx.now });
  if (stage1.reason === 'issue-not-found') return { picked: null, issue: null, authorization: null, revision: null, excludedRule: 'issue-not-found', ranked: [], reason: stage1.reason };

  // Stage 2: the expensive rules, in rank order, until one candidate survives.
  const ranked = [];
  let choice = null;
  for (const r of stage1.ranked) {
    if (choice || r.excluded.length > 0) { ranked.push(r); continue; }
    const issue = candidates.find((c) => c.number === r.number);
    const full = await evaluateFully({ ctx, gh, cfg, issue, openPrs, localBranches, denylist, attempts });
    facts.set(r.number, full);
    const lifted = force ? full.exclusions.filter((x) => stage1.ranked.find((s) => s.number === r.number)?.lifted?.some((l) => l.rule === x.rule)) : [];
    const excluded = full.exclusions.filter((x) => !lifted.includes(x));
    const row = { ...r, excluded, lifted: [...r.lifted, ...lifted] };
    ranked.push(row);
    if (excluded.length === 0) choice = { issue, ...full };
  }
  const limited = top ? ranked.slice(0, top) : ranked;
  if (!choice) {
    const first = pinned != null ? ranked[0] : null;
    const excludedRule = first?.excluded?.[0]?.rule ?? (pinned != null ? 'excluded' : 'no-eligible-candidate');
    return { picked: null, issue: null, authorization: null, revision: null, excludedRule, ranked: limited, reason: pinned != null ? 'excluded' : 'no-eligible-candidate' };
  }
  return {
    picked: choice.issue.number, issue: choice.issue, authorization: choice.authorization,
    revision: { ...(choice.authorization?.issueRevision ?? {}), updatedAt: choice.issue.updatedAt ?? null },
    excludedRule: null, ranked: limited, reason: null,
  };
}

function safeFailed(attempts, n, log = null) {
  try { return attempts.failedWithin24h(n); }
  catch (e) {
    // Mutation seam `selection.failOpenAttempts`: a corrupt ledger counts as zero attempts (the cap is bypassed).
    if (active('selection.failOpenAttempts')) return 0;
    // Fail CLOSED (codex r2 A7): an unreadable ledger is treated as the cap reached — the
    // issue is excluded (`shaping-failed`) until the operator repairs or resets the ledger.
    log?.(`issue ${n}: attempts ledger unreadable (${e.code ?? 'error'}: ${e.message}); treated as the shaping cap reached`);
    return Number.POSITIVE_INFINITY;
  }
}

async function evaluateFully({ ctx, gh, cfg, issue, openPrs, localBranches, denylist, attempts }) {
  const n = issue.number;
  const [timeline, edits] = await Promise.all([issueTimeline(gh, n), issueBodyEdits(gh, n)]);
  const authorization = await eligibleAuthor({ issue, timeline, edits, mode: cfg.dispatchApproval, permissionOf: (login) => permissionOf(gh, login) });
  let remoteRefExists;
  try { remoteRefExists = (await ctx.git.lsRemoteOid(ctx.remote.remotePushUrl, `refs/heads/${branchFor(n)}`)) != null; } catch { remoteRefExists = undefined; }
  const exclusions = hardExclusions({
    issue, authorization, openPrs: Array.isArray(openPrs) ? openPrs : [], localBranches, remoteRefExists,
    records: ctx.records, scopeBlock: scopeBlockOf(issue.body), denylist, attempts: safeFailed(attempts, n, ctx.log),
  });
  return { authorization, exclusions };
}

/** The dry-run ticket when shaping is not requested (§2): the issue's title, no scope. */
export function placeholderTicket({ issue }) {
  return { title: String(issue?.title ?? `issue ${issue?.number ?? ''}`), category: 'feature', scope: [], rails: [], edges: [], duration: 1, placeholder: true };
}
