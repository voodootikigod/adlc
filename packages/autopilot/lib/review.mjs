// Final review, attestation and the ticket lifecycle commands (spec §6.6
// retry-protocol reopen, §6.6a, §6.7 7a/7b/7c; AC 38, 44, 46).
//
// The invariant of §6.7: reviewed = attested = pushed. The size gate and the
// orchestrator's own `adversarial-review` run on a clean tree at HEAD; the
// attestation is recorded while HEAD is still that reviewed OID and the tree
// is still clean; the manifest commit may touch ONLY `.adlc/manifest.d/*.jsonl`
// (revision-ignored, so revision(HEAD) == revision(reviewedHead)). Any
// assertion failing is `oid-mismatch` and nothing is pushed.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { DEADLINES } from './spawn.mjs';
import { childEnv } from './keys.mjs';
import { validateOid, validateTicketId, validateIssueNumber } from './input.mjs';
import { manifestLineSha256 } from './diffcheck.mjs';
import { registerSeams, active } from './mutations.mjs';

registerSeams([
  'review.skipSizeGate',           // the size gate admits every diff
  'review.allowSummaryReview',     // --allow-summary-review is passed to the reviewer
  'review.attestWithoutHeadCheck', // 7b/7c run without the HEAD/clean/manifest-only assertions
  'review.reopenWithoutAuthorize', // the reopen update omits --authorize,
  'review.approveOnExitZero',
]);

export const MANIFEST_PATH_RE = /^\.adlc\/manifest\.d\/[^/]+\.jsonl$/;
export const COMMIT_IDENTITY = Object.freeze(['-c', 'user.name=adlc-autopilot', '-c', 'user.email=autopilot@adlc.invalid', '-c', 'commit.gpgsign=false']);
const LARGEST_PATHS = 5;

export class ReviewError extends Error {
  constructor(code, detail, extra = {}) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'ReviewError'; this.code = code; this.exitCode = 2; Object.assign(this, extra);
  }
}

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/** Parse the LAST top-level JSON document in a stdout capture (the ticket CLI prints plan + result). */
export function parseLastJson(stdout) {
  const text = String(stdout ?? '');
  try { return JSON.parse(text); } catch { /* fall through */ }
  const starts = [];
  const re = /^[{[]/gm; let m;
  while ((m = re.exec(text)) !== null) starts.push(m.index);
  for (let i = starts.length - 1; i >= 0; i--) {
    try { return JSON.parse(text.slice(starts[i])); } catch { /* try an earlier start */ }
  }
  throw new ReviewError('bad-json', 'no JSON document in output');
}

// ---- git helpers shared by review / push / maintain ----
export async function headOf(ctx, cwd) { return validateOid(await ctx.git.localOut(cwd, ['rev-parse', 'HEAD']), { field: 'head' }); }
export async function isClean(ctx, cwd) {
  const r = await ctx.git.local(cwd, ['status', '--porcelain']);
  if (r.status !== 0) throw new ReviewError('git-failed', `status --porcelain exited ${r.status}`);
  return r.stdout.trim() === '';
}
/** `git add -A -- <paths>` + commit with a fixed identity; returns the new HEAD. */
export async function commitPaths(ctx, cwd, { paths, message }) {
  // A pathspec that matches nothing makes `git add` fail; only existing paths are staged.
  const present = paths.filter((p) => existsSync(join(cwd, p)));
  if (present.length === 0) throw new ReviewError('git-failed', `nothing to commit under ${paths.join(', ')}`);
  const add = await ctx.git.local(cwd, ['add', '-A', '--', ...present]);
  if (add.status !== 0) throw new ReviewError('git-failed', `add exited ${add.status}: ${add.stderr.trim()}`);
  const commit = await ctx.git.local(cwd, [...COMMIT_IDENTITY, 'commit', '-q', '-m', message]);
  if (commit.status !== 0) throw new ReviewError('git-failed', `commit exited ${commit.status}: ${commit.stderr.trim()}`);
  return headOf(ctx, cwd);
}
/** Paths of the last commit; must all be manifest segments. Returns { ok, paths }. */
export async function lastCommitIsManifestOnly(ctx, cwd) {
  const out = await ctx.git.localOut(cwd, ['diff', '--name-only', 'HEAD~1', 'HEAD']);
  const paths = out.split('\n').map((s) => s.trim()).filter(Boolean);
  return { ok: paths.length > 0 && paths.every((p) => MANIFEST_PATH_RE.test(p)), paths };
}
// ---- manifest-line bookkeeping (S5 convention): every key-bearing command that
// appends to `.adlc/manifest.d/*.jsonl` records manifestLineSha256(line) of each
// NEW line in `record.manifestLinesWritten` BEFORE the next actual-diff check,
// else that check reports `foreign-manifest-line`. New lines are found by
// snapshotting the segment files before and after the command.
export function readSegments(cwd) {
  const dir = join(cwd, '.adlc', 'manifest.d');
  const out = new Map();
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.jsonl')).sort()) out.set(f, readFileSync(join(dir, f), 'utf8').split('\n').filter((l) => l.length > 0));
  return out;
}
/** Lines present in `after` but not in `before` (multiset difference per segment). */
export function newManifestLines(before, after) {
  const lines = [];
  for (const [file, arr] of after) {
    const seen = new Map();
    for (const l of before.get(file) ?? []) seen.set(l, (seen.get(l) ?? 0) + 1);
    for (const l of arr) { const c = seen.get(l) ?? 0; if (c > 0) seen.set(l, c - 1); else lines.push(l); }
  }
  return lines;
}
/** The issue number of an ISSUE_WT path (`…/.worktrees/autopilot-issue-<n>`), or null. */
export function issueFromWorktree(cwd) {
  const m = /^autopilot-issue-(\d+)$/.exec(basename(cwd));
  return m ? validateIssueNumber(m[1]) : null;
}
/** Run `fn` (one key-bearing command) and record the hashes of the manifest lines it appended. */
export async function trackManifestLines({ ctx, cwd, issue = null }, fn) {
  const before = readSegments(cwd);
  const result = await fn();
  const hashes = newManifestLines(before, readSegments(cwd)).map(manifestLineSha256);
  const n = issue ?? issueFromWorktree(cwd);
  if (hashes.length && n != null && ctx.records?.load(n)) {
    const cur = ctx.records.load(n);
    ctx.records.update(n, { manifestLinesWritten: [...new Set([...(cur.manifestLinesWritten ?? []), ...hashes])] });
  }
  return { result, hashes };
}

const adlcArgv = (ctx, ...args) => [ctx.pinned.adlc, ...args];
const keyEnv = (ctx) => childEnv(ctx.env.base, { key: ctx.key, keyBearing: true });

// ---- 7a: size gate + final review ----
export async function sizeGate({ ctx, cwd, baseOid }) {
  const max = ctx.config.autopilot.reviewMaxBytes;
  const base = validateOid(baseOid, { field: 'baseOid' });
  const r = await ctx.git.local(cwd, ['diff', `${base}...HEAD`]);
  if (r.status !== 0) throw new ReviewError('git-failed', `diff exited ${r.status}`);
  const bytes = r.truncated ? Number.POSITIVE_INFINITY : Buffer.byteLength(r.stdout, 'utf8');
  if (active('review.skipSizeGate') || bytes <= max) return { ok: true, bytes, max, code: null, largest: [] };
  const numstat = await ctx.git.local(cwd, ['diff', '--numstat', `${base}...HEAD`]);
  const largest = numstat.stdout.split('\n').filter(Boolean).map((l) => {
    const [a, d, ...p] = l.split('\t'); return { path: p.join('\t'), lines: (Number(a) || 0) + (Number(d) || 0) };
  }).sort((x, y) => y.lines - x.lines).slice(0, LARGEST_PATHS);
  return { ok: false, bytes, max, code: 'diff-too-large', largest };
}

export async function finalReview({ ctx, issue, cwd, baseOid }) {
  const base = validateOid(baseOid, { field: 'baseOid' });
  if (!(await isClean(ctx, cwd))) throw new ReviewError('oid-mismatch', 'tree not clean before the final review');
  const head = await headOf(ctx, cwd);
  const argv = [ctx.pinned['adversarial-review'], '--base', base, '--provider', 'codex', '--json', '--fail-on', 'medium',
    '--max-bytes', String(ctx.config.autopilot.reviewMaxBytes), '--findings-ledger', ctx.paths.findingsLedger(issue)];
  if (active('review.allowSummaryReview')) argv.push('--allow-summary-review');
  const r = await ctx.spawn({ argv, cwd, env: childEnv(ctx.env.base), deadlineMs: DEADLINES.finalReview, label: 'adversarial-review' });
  let doc = null;
  try { doc = JSON.parse(r.stdout); } catch { doc = null; }
  let verdict;
  // The verdict is the DOCUMENT's, corroborated by the exit code (codex r3 B1): a status 0 whose
  // output is not a review document (or names no verdict) is UNAVAILABLE — fail closed.
  // Mutation seam `review.approveOnExitZero`: exit 0 alone approves.
  const documented = typeof doc?.verdict === 'string' ? doc.verdict : null;
  if (r.timedOut || r.error) verdict = 'unavailable';
  else if (r.status === 0) verdict = active('review.approveOnExitZero') ? 'approve' : (documented === 'approve' ? 'approve' : documented ? 'needs-attention' : 'unavailable');
  else if (r.status === 2) verdict = 'needs-attention';
  else verdict = 'unavailable';
  if (verdict !== 'unavailable' && documented && documented !== verdict) verdict = documented === 'approve' ? 'approve' : 'needs-attention';
  const after = await headOf(ctx, cwd);
  if (after !== head || !(await isClean(ctx, cwd))) throw new ReviewError('oid-mismatch', 'tree moved during the final review');
  return { verdict, findings: Array.isArray(doc?.findings) ? doc.findings : [], reviewedHead: head, reason: r.reason ?? null, raw: doc };
}

/**
 * 7a as one round step: size gate → final review. Two consecutive
 * `diff-too-large` failures on one run → `blocked`. Returns { ok, code, ... }.
 */
export async function reviewRound({ ctx, issue, cwd, baseOid, record }) {
  const size = await sizeGate({ ctx, cwd, baseOid });
  if (!size.ok) {
    const streak = (record?.diffTooLargeStreak ?? 0) + 1;
    if (record) ctx.records.update(issue, { diffTooLargeStreak: streak });
    const deadEnd = `diff-too-large: ${size.bytes} bytes > ${size.max}\nlargest paths:\n${size.largest.map((l) => `  ${l.lines}\t${l.path}`).join('\n')}`;
    return { ok: false, code: streak >= 2 ? 'blocked' : 'diff-too-large', reason: 'diff-too-large', streak, deadEnd, size };
  }
  if (record && (record.diffTooLargeStreak ?? 0) !== 0) ctx.records.update(issue, { diffTooLargeStreak: 0 });
  const review = await finalReview({ ctx, issue, cwd, baseOid });
  if (review.verdict === 'approve') return { ok: true, code: null, ...review };
  const code = review.verdict === 'unavailable' ? 'review-unavailable' : 'needs-attention';
  return { ok: false, code, reason: code, ...review, deadEnd: JSON.stringify({ verdict: review.verdict, findings: review.findings }, null, 2) };
}

// ---- 7b/7c: attestation and the manifest commit ----
async function commitManifest(ctx, cwd, message) {
  const attestedHead = await commitPaths(ctx, cwd, { paths: ['.adlc/manifest.d'], message });
  if (!active('review.attestWithoutHeadCheck')) {
    if (!(await isClean(ctx, cwd))) throw new ReviewError('oid-mismatch', 'tree not clean after the manifest commit');
    const only = await lastCommitIsManifestOnly(ctx, cwd);
    if (!only.ok) throw new ReviewError('oid-mismatch', `manifest commit touches ${only.paths.join(', ') || 'nothing'}`);
  }
  return attestedHead;
}

export async function attest({ ctx, cwd, ticketId, baseOid, reviewedHead, issue = null }) {
  const id = validateTicketId(ticketId); const base = validateOid(baseOid, { field: 'baseOid' });
  const reviewed = validateOid(reviewedHead, { field: 'reviewedHead' });
  if (!active('review.attestWithoutHeadCheck')) {
    if ((await headOf(ctx, cwd)) !== reviewed) throw new ReviewError('oid-mismatch', 'HEAD moved since the final review');
    if (!(await isClean(ctx, cwd))) throw new ReviewError('oid-mismatch', 'tree not clean at attestation');
  }
  const argv = adlcArgv(ctx, 'prosecute', 'record-cross-model', '--ticket', id, '--provider', 'codex', '--author-provider', 'anthropic',
    '--verdict', 'approve', '--base', base, '--dir', join(cwd, '.adlc'), '--json');
  const { result: r, hashes } = await trackManifestLines({ ctx, cwd, issue }, () => ctx.spawn({ argv, cwd, env: keyEnv(ctx), deadlineMs: DEADLINES.adlcRecorder, label: 'adlc prosecute record-cross-model' }));
  if (r.status !== 0) throw new ReviewError('oid-mismatch', `record-cross-model exited ${r.status}: ${r.stderr.trim().slice(0, 300)}`);
  let revision = null; try { revision = parseLastJson(r.stdout)?.data?.revision ?? null; } catch { revision = null; }
  const attestedHead = await commitManifest(ctx, cwd, `chore(attest): cross-model approve ${id}`);
  return { attestedHead, reviewedHead: reviewed, revision, manifestLineHashes: hashes };
}

export async function carryForward({ ctx, cwd, ticketId, priorRevision, baseOid, issue = null }) {
  const id = validateTicketId(ticketId); const base = validateOid(baseOid, { field: 'baseOid' });
  if (typeof priorRevision !== 'string' || !priorRevision) throw new ReviewError('carry-forward-refused', 'no prior revision recorded');
  if (!(await isClean(ctx, cwd))) throw new ReviewError('oid-mismatch', 'tree not clean before carry-forward');
  const argv = adlcArgv(ctx, 'prosecute', 'record-cross-model', '--ticket', id, '--carry-forward', priorRevision, '--base', base, '--dir', join(cwd, '.adlc'), '--json');
  const { result: r, hashes } = await trackManifestLines({ ctx, cwd, issue }, () => ctx.spawn({ argv, cwd, env: keyEnv(ctx), deadlineMs: DEADLINES.adlcRecorder, label: 'adlc prosecute record-cross-model --carry-forward' }));
  if (r.status !== 0) throw new ReviewError('carry-forward-refused', r.stderr.trim().slice(0, 300) || `exit ${r.status}`);
  let revision = null; try { revision = parseLastJson(r.stdout)?.data?.revision ?? null; } catch { revision = null; }
  const attestedHead = await commitManifest(ctx, cwd, `chore(attest): carry forward cross-model approve ${id}`);
  return { attestedHead, revision, manifestLineHashes: hashes };
}

// ---- §6.6a completion and the §6.6 reopen ----
export async function completeTicket({ ctx, cwd, ticketId, issue = null }) {
  const id = validateTicketId(ticketId);
  const argv = adlcArgv(ctx, 'ticket', 'complete', id, '--write', '--root', cwd, '--json');
  const { result: r, hashes } = await trackManifestLines({ ctx, cwd, issue }, () => ctx.spawn({ argv, cwd, env: keyEnv(ctx), deadlineMs: DEADLINES.adlcRecorder, label: 'adlc ticket complete' }));
  if (r.status !== 0) throw new ReviewError('ticket-complete-failed', r.stdout.trim().slice(0, 300) || r.stderr.trim().slice(0, 300));
  const head = await commitPaths(ctx, cwd, { paths: ['.adlc/tickets', '.adlc/manifest.d'], message: `chore(ticket): complete ${id}` });
  let ticketHash = null; try { ticketHash = parseLastJson(r.stdout)?.ticketHash ?? null; } catch { ticketHash = null; }
  return { head, ticketHash, manifestLineHashes: hashes };
}

async function showTicket(ctx, cwd, id) {
  const r = await ctx.spawn({ argv: adlcArgv(ctx, 'ticket', 'show', id, '--json', '--root', cwd), cwd, env: childEnv(ctx.env.base), deadlineMs: DEADLINES.adlcRecorder, label: 'adlc ticket show' });
  if (r.status !== 0) throw new ReviewError('ticket-show-failed', r.stderr.trim().slice(0, 300));
  const env = parseLastJson(r.stdout);
  if (!env?.ticket || typeof env.ticketHash !== 'string') throw new ReviewError('ticket-show-failed', 'envelope lacks ticket/ticketHash');
  return env;
}

/** The §6.6 Step 0 reopen: show → full document with completed:false → authorized CAS update → commit. */
export async function reopenTicket({ ctx, cwd, ticketId, round, issue = null }) {
  const id = validateTicketId(ticketId);
  const env = await showTicket(ctx, cwd, id);
  if (env.ticket.completed !== true) return { reopened: false, ticketHash: env.ticketHash, head: await headOf(ctx, cwd) };
  const doc = { ...env.ticket, completed: false };
  const argv = adlcArgv(ctx, 'ticket', 'update', id, '--input', '-', '--expect', env.ticketHash, ...(active('review.reopenWithoutAuthorize') ? [] : ['--authorize']), '--write', '--root', cwd, '--json');
  const { result: r, hashes } = await trackManifestLines({ ctx, cwd, issue }, () => ctx.spawn({ argv, cwd, env: keyEnv(ctx), stdinBytes: JSON.stringify(doc), deadlineMs: DEADLINES.adlcRecorder, label: 'adlc ticket update' }));
  if (r.status !== 0) {
    // The ticket CLI prints its error envelope `{ok:false, code, message}` on stderr.
    let code = null;
    for (const stream of [r.stderr, r.stdout]) { try { code = parseLastJson(stream)?.code ?? null; } catch { code = null; } if (code) break; }
    throw new ReviewError('reopen-failed', `${code ?? `exit ${r.status}`}`, { cliCode: code });
  }
  const after = await showTicket(ctx, cwd, id);
  if (after.ticket.completed !== false) throw new ReviewError('reopen-failed', 'completed is not false after the update');
  const head = await commitPaths(ctx, cwd, { paths: ['.adlc/tickets', '.adlc/manifest.d'], message: `chore(ticket): reopen ${id} for retry round ${round}` });
  return { reopened: true, ticketHash: after.ticketHash, head, manifestLineHashes: hashes };
}
