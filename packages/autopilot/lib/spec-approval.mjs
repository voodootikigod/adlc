// The spec-approval binding (spec §14, §11.1; AC 80, 83, 89, 154).
//
// Before the BUILD ticket is dispatched, the newest `spec-approval` manifest
// entry bound to it — read from the segments at the pinned baseline, never
// the working tree — must (1) carry `spec_hash` equal to the sha256 of the
// CONTENT of the spec blob (never the git object id), (2) pass the runner's
// own `adlc run p1` gate, (3) be bound to a merge identity GitHub attests
// (the PR that introduced the spec blob was merged by an admin/maintain
// login the record's `approver` names), and (4) carry `approved_assumptions`
// and `assumptions_hash` equal to the §11.1 items extracted from that blob.
// The manifest is data the preflight checks, never a claim it trusts.

import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { DEADLINES } from './spawn.mjs';
import { childEnv } from './keys.mjs';
import { permissionOf, isMaintainer } from './github.mjs';
import { validateOid, validateTicketId } from './input.mjs';
import { PreflightError, SPEC_PATH, MANIFEST_DIR, ROOT_MANIFEST, showAtBaseline, listTreeAtBaseline } from './preflight-common.mjs';
import { registerSeams, active } from './mutations.mjs';

registerSeams([
  'specApproval.oldestWins',            // the OLDEST spec-approval record is compared instead of the newest
  'specApproval.skipRunnerGate',        // `adlc run p1` is not spawned / its exit is ignored
  'specApproval.skipMergeIdentity',     // the GitHub merge-identity binding is skipped
  'specApproval.skipAssumptions',       // the §11.1 assumptions binding is skipped
  'preflight.acceptBlobOidAsSpecHash',  // the git blob OID of the spec is accepted as spec_hash
  'specApproval.skipSignedVerify',
]);

export const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/**
 * The §11.1 extractor: the ordered `N. ` items under the `### 11.1` heading,
 * up to the next `## `/`### ` heading; each item's text runs from after
 * `N. ` to the next item or blank line, whitespace runs collapsed to one space.
 */
export function extractResiduals(specText) {
  const lines = String(specText ?? '').split(/\r?\n/);
  const start = lines.findIndex((l) => /^### 11\.1\b/.test(l));
  if (start === -1) return [];
  const items = [];
  let cur = null;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^##(#)?\s/.test(l)) break;
    const m = /^(\d+)\.\s+(.*)$/.exec(l);
    if (m) { if (cur !== null) items.push(cur); cur = m[2]; continue; }
    if (l.trim() === '') { if (cur !== null) items.push(cur); cur = null; continue; }
    if (cur !== null) cur += ' ' + l;
  }
  if (cur !== null) items.push(cur);
  return items.map((s) => s.replace(/\s+/g, ' ').trim());
}

export const assumptionsHash = (items) => sha256(JSON.stringify(items));

/** Parse one segment's JSON lines; a malformed line is an error, never skipped silently. */
export function parseSegmentEntries(text, segment) {
  const out = [];
  const lines = String(text ?? '').split('\n');
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    let e;
    try { e = JSON.parse(line); } catch { throw new PreflightError('spec-approval-stale', `manifest ${segment}:${i + 1} is not JSON`); }
    if (e && typeof e === 'object') out.push({ ...e, segment });
  });
  return out;
}

/** The newest `spec-approval` entry for the ticket: by `ts`, ties by segment order then seq. */
export function newestSpecApproval(entries, ticketId) {
  const mine = entries.filter((e) => e.gate === 'spec-approval' && e.ticket === ticketId);
  if (mine.length === 0) return null;
  const key = (e) => [Date.parse(e.ts ?? '') || 0, e.__order ?? 0, Number.isInteger(e.seq) ? e.seq : 0];
  const cmp = (a, b) => { const ka = key(a); const kb = key(b); for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i]; return 0; };
  const sorted = [...mine].sort(cmp);
  return active('specApproval.oldestWins') ? sorted[0] : sorted[sorted.length - 1];
}

/** Every manifest entry at the baseline: the root ledger plus every `manifest.d/*.jsonl` segment. */
export async function readManifestAtBaseline(ctx, oid) {
  const entries = [];
  let order = 0;
  const root = await showAtBaseline(ctx, oid, ROOT_MANIFEST);
  if (root !== null) for (const e of parseSegmentEntries(root, 'root')) entries.push({ ...e, __order: order });
  const names = (await listTreeAtBaseline(ctx, oid, MANIFEST_DIR)).filter((n) => n.endsWith('.jsonl')).sort();
  for (const name of names) {
    order += 1;
    const text = await showAtBaseline(ctx, oid, `${MANIFEST_DIR}/${name}`);
    if (text === null) continue;
    for (const e of parseSegmentEntries(text, name)) entries.push({ ...e, __order: order });
  }
  return entries;
}

/** `adlc run p1 --ticket <id> --json --dir <adlcDir>` with cwd = the pinned checkout; exit 0 is the gate. */
export async function runnerGate({ ctx, ticketId, cwd, adlcDir = join(cwd, '.adlc') }) {
  if (active('specApproval.skipRunnerGate')) return { ok: true, detail: 'skipped' };
  const res = await ctx.spawn({
    argv: [ctx.pinned.adlc, 'run', 'p1', '--ticket', validateTicketId(ticketId), '--json', '--dir', adlcDir],
    cwd, env: childEnv(ctx.env.base), deadlineMs: DEADLINES.adlcRecorder, label: 'adlc run p1',
  });
  if (res.status === 0) return { ok: true, detail: null };
  let detail = String(res.stderr ?? '').trim().slice(0, 300);
  try { const doc = JSON.parse(res.stdout); detail = [...(doc.errors ?? []), ...(doc.missing ?? []).map((m) => `missing: ${m}`)].join('; ') || detail; } catch { /* keep stderr */ }
  return { ok: false, detail: `adlc run p1 exited ${res.status ?? res.reason}: ${detail}` };
}

/**
 * The human-identity binding (§14): the commit that introduced the spec blob
 * on main → its pull request → merged by an admin/maintain login whom the
 * record's `approver` names (login or the e-mail GitHub reports for it).
 */
export async function mergeIdentity({ ctx, oid, approver }) {
  if (active('specApproval.skipMergeIdentity')) return { ok: true, login: null };
  let sha;
  try { sha = validateOid(await ctx.git.localOut(ctx.repoRoot, ['rev-list', '-1', oid, '--', SPEC_PATH]), { field: 'spec-commit' }); }
  catch (e) { return { ok: false, detail: `cannot resolve the commit that introduced the spec blob: ${e.message}` }; }
  let pulls;
  try { pulls = await ctx.gh.json(['api', `repos/${ctx.gh.repo}/commits/${sha}/pulls`]); } catch (e) { return { ok: false, detail: `commits/${sha}/pulls: ${e.message}` }; }
  if (!Array.isArray(pulls) || pulls.length === 0) return { ok: false, detail: `no pull request introduced ${sha}` };
  const merged = pulls.filter((p) => p && typeof p.merged_at === 'string' && p.merged_at && p.merged_by && typeof p.merged_by.login === 'string');
  if (merged.length === 0) return { ok: false, detail: `no MERGED pull request introduced ${sha}` };
  for (const pr of merged) {
    const login = pr.merged_by.login;
    const perm = await permissionOf(ctx.gh, login);
    if (!isMaintainer(perm)) continue;
    let email = null;
    try { const u = await ctx.gh.json(['api', `users/${encodeURIComponent(login)}`]); email = typeof u?.email === 'string' ? u.email : null; } catch { /* e-mail is optional */ }
    const a = String(approver ?? '').trim();
    if (a && (a === login || (email && a.toLowerCase() === email.toLowerCase()))) return { ok: true, login, pr: pr.number, sha };
    return { ok: false, detail: `PR #${pr.number} was merged by ${login} (${perm}); the record's approver "${a}" names neither that login nor its e-mail` };
  }
  return { ok: false, detail: `no merged pull request for ${sha} was merged by an admin/maintain login` };
}

/** `adlc gate-manifest verify --dir <cwd>/.adlc --allow-legacy-unsigned`, KEY-BEARING (§9.3): the only spawn that may see the key here. */
export async function verifySignedManifest({ ctx, cwd, adlcDir = join(cwd, '.adlc') }) {
  if (active('specApproval.skipSignedVerify')) return { ok: true, detail: 'skipped' };
  const res = await ctx.spawn({
    argv: [ctx.pinned.adlc, 'gate-manifest', 'verify', '--dir', adlcDir, '--allow-legacy-unsigned'],
    cwd, env: childEnv(ctx.env.base, { key: ctx.key, keyBearing: true }), deadlineMs: DEADLINES.adlcRecorder, label: 'gate-manifest verify (spec approval)',
  });
  if (res.status === 0) return { ok: true, detail: null };
  return { ok: false, detail: `gate-manifest verify exited ${res.status ?? res.reason}: ${String(res.stderr ?? res.stdout ?? '').trim().slice(0, 300)}` };
}

/** The complete §14 binding for the build ticket. Throws PreflightError on any mismatch. */
export async function checkSpecApproval({ ctx, oid, ticketId, runnerCwd = null }) {
  const specText = await showAtBaseline(ctx, oid, SPEC_PATH);
  if (specText === null) throw new PreflightError('spec-approval-stale', `${SPEC_PATH} is absent at ${oid}`);
  const entries = await readManifestAtBaseline(ctx, oid);
  const record = newestSpecApproval(entries, ticketId);
  if (!record) throw new PreflightError('spec-approval-stale', `no spec-approval record for ${ticketId} at ${oid}`);
  const data = record.data ?? {};
  const contentHash = sha256(specText);
  let expected = contentHash;
  // Mutation seam: the blob OID is accepted as the spec hash (the identities are conflated).
  if (active('preflight.acceptBlobOidAsSpecHash') && data.spec_hash !== contentHash) {
    const blobOid = await ctx.git.localOut(ctx.repoRoot, ['rev-parse', `${oid}:${SPEC_PATH}`]);
    if (data.spec_hash === blobOid) expected = blobOid;
  }
  if (typeof data.spec_hash !== 'string' || data.spec_hash !== expected) throw new PreflightError('spec-approval-stale', `spec_hash ${data.spec_hash ?? 'absent'} != sha256(content) ${contentHash}`);
  const checks = { specHash: contentHash, record: { segment: record.segment, seq: record.seq ?? null, ts: record.ts ?? null } };
  if (runnerCwd) {
    // The approval record must sit on a manifest whose signatures VERIFY under the
    // operator's key — a hash-chain-only manifest could carry a forged approval.
    const verified = await verifySignedManifest({ ctx, cwd: runnerCwd });
    if (!verified.ok) throw new PreflightError('spec-approval-unverified', verified.detail);
    checks.signedVerify = 'ok';
    const gate = await runnerGate({ ctx, ticketId, cwd: runnerCwd });
    if (!gate.ok) throw new PreflightError('spec-approval-stale', gate.detail);
    checks.runnerGate = 'ok';
  } else { checks.runnerGate = 'skipped: needs-worktree'; checks.signedVerify = 'skipped: needs-worktree'; }
  const identity = await mergeIdentity({ ctx, oid, approver: data.approver });
  if (!identity.ok) throw new PreflightError('spec-approval-unbound', identity.detail);
  checks.mergedBy = identity.login;
  if (!active('specApproval.skipAssumptions')) {
    const items = extractResiduals(specText);
    const hash = assumptionsHash(items);
    const approved = Array.isArray(data.approved_assumptions) ? data.approved_assumptions : null;
    const same = approved !== null && approved.length === items.length && approved.every((s, i) => s === items[i]);
    if (typeof data.assumptions_hash !== 'string' || data.assumptions_hash !== hash || !same) {
      throw new PreflightError('spec-approval-assumptions-stale', `approved_assumptions/assumptions_hash do not describe the ${items.length} §11.1 items at ${oid}`);
    }
    checks.assumptionsHash = hash;
  }
  return { ok: true, checks };
}
