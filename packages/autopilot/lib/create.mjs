// Staged, journaled worktree creation (spec §6.1; AC 24, 93, 104, 107), the
// §2.1 `creating` repair row, and the ticket write of §6.2.
//
// Ownership is established on TOKEN-NAMED staging artifacts before the final
// names ever exist: the record is persisted FIRST (`state: creating`,
// `creationPhase: recorded`), then every phase value is written to the record
// immediately BEFORE its git command — `staged` (worktree add at
// `<ISSUE_WT>.creating-<token>` on `adlc/autopilot/staging-<token>`), `marked`
// (the ownership marker in the LOCAL git config), `renamed` (`git branch -m`;
// git carries the marker's config section with the branch), `moved`
// (`git worktree move` to ISSUE_WT) — so recovery always knows which step may
// have half-happened and only ever touches artifacts whose ownership is
// provable (a token-embedded name, or the marker with the record's token).

import { existsSync, readdirSync, readFileSync, rmdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { validateIssueNumber, validateOid, branchFor, stagingBranchFor } from './input.mjs';
import { newRecord } from './records.mjs';
import { childEnv } from './keys.mjs';
import { DEADLINES } from './spawn.mjs';
import { registerSeams, active } from './mutations.mjs';
import { RunError, MARKER_KEY, runGit, readMarker, localBranchTip, markOrphan } from './retire.mjs';
import { issueCwd, manifestLineHashes } from './evidence.mjs';
import { canonicalTicketSha256 } from './diffcheck.mjs';

export { recordEvidence, commitTicket } from './evidence.mjs';

registerSeams([
  'create.skipStaging',          // the worktree/branch are created directly under their final names
  'create.phaseAfterGit',        // the next creationPhase is written AFTER its git command, not before
  'create.repairIgnoresTipMove', // repair continues when the staging tip no longer equals baseOid
]);

/** Rewrite the record with the next phase BEFORE the git command it names (§6.1). */
async function phase(ctx, issue, next, run) {
  if (!active('create.phaseAfterGit')) ctx.records.update(issue, { creationPhase: next });
  const r = await run();
  if (active('create.phaseAfterGit')) ctx.records.update(issue, { creationPhase: next });
  return r;
}

const gitRoot = (ctx, args) => runGit(ctx, ctx.repoRoot, args);

/** Retire STAGING artifacts (provably ours: the token is in their names) after a refused rename. */
async function retireStaging(ctx, record) {
  const { stagingBranch, stagingPath, baseOid } = record;
  if (existsSync(stagingPath)) await gitRoot(ctx, ['worktree', 'remove', stagingPath]);
  await gitRoot(ctx, ['update-ref', '-d', `refs/heads/${stagingBranch}`, baseOid]);
  await gitRoot(ctx, ['config', '--unset', MARKER_KEY(stagingBranch)]);
}

/**
 * §6.1 step 1: record first, then staged → marked → renamed → moved, then
 * `npm ci --ignore-scripts` in ISSUE_WT. Throws RunError('orphan-dir' |
 * 'orphan-branch' | 'create-<phase>-failed' | 'init-failed').
 */
export async function createIssueWorktree({ ctx, issue, baseOid, issueRevision = null }) {
  issue = validateIssueNumber(issue);
  baseOid = validateOid(baseOid);
  const paths = ctx.paths;
  const finalPath = paths.issueWorktree(issue);
  const finalBranch = branchFor(issue);
  if (existsSync(finalPath)) throw new RunError('orphan-dir', finalPath);           // zero git calls
  if (await localBranchTip(ctx, finalBranch) != null) throw new RunError('orphan-branch', finalBranch);
  const token = randomBytes(32).toString('hex');
  const direct = active('create.skipStaging');
  const stagingBranch = direct ? finalBranch : stagingBranchFor(token);
  const stagingPath = direct ? finalPath : paths.stagingWorktree(issue, token);
  ctx.records.save(newRecord({ issue, token, baseOid, branch: finalBranch, stagingBranch, stagingPath, finalPath, issueRevision }));
  const fail = (step, r) => new RunError(`create-${step}-failed`, r.err.slice(0, 200));
  const add = await phase(ctx, issue, 'staged', () => gitRoot(ctx, ['worktree', 'add', stagingPath, '-b', stagingBranch, baseOid]));
  if (!add.ok) throw fail('staged', add);
  const mark = await phase(ctx, issue, 'marked', () => gitRoot(ctx, ['config', MARKER_KEY(stagingBranch), token]));
  if (!mark.ok) throw fail('marked', mark);
  if (!direct) {
    const ren = await phase(ctx, issue, 'renamed', () => gitRoot(ctx, ['branch', '-m', stagingBranch, finalBranch]));
    if (!ren.ok) {
      await retireStaging(ctx, ctx.records.load(issue));
      await markOrphan(ctx, { issue }, 'orphan-branch');
      throw new RunError('orphan-branch', finalBranch);
    }
    const mv = await phase(ctx, issue, 'moved', () => gitRoot(ctx, ['worktree', 'move', stagingPath, finalPath]));
    if (!mv.ok) throw fail('moved', mv);
  } else {
    ctx.records.update(issue, { creationPhase: 'moved' });
  }
  const record = ctx.records.update(issue, { state: 'shaped', creationPhase: 'moved', localHead: baseOid });
  const npm = await ctx.spawn({ argv: [ctx.pinned.npm, 'ci', '--ignore-scripts'], cwd: finalPath, env: childEnv(ctx.env.base), deadlineMs: DEADLINES.npmCi, label: 'npm ci' });
  if (npm.status !== 0 || npm.timedOut) {
    ctx.records.update(issue, { lastError: `init-failed: ${String(npm.stderr ?? '').slice(0, 200)}` });
    throw new RunError('init-failed', npm.timedOut ? 'timeout' : `npm ci exited ${npm.status}`);
  }
  return { record, token, finalPath, finalBranch };
}

function removeIfEmptyDir(path) {
  try { if (existsSync(path) && readdirSync(path).length === 0) rmdirSync(path); } catch { /* leave it */ }
}

/** Finish rename → move → shaped from a record whose staging branch carries the marker. */
async function finishFromStaging(ctx, record, { needRename }) {
  const issue = record.issue;
  if (needRename) {
    const ren = await phase(ctx, issue, 'renamed', () => gitRoot(ctx, ['branch', '-m', record.stagingBranch, record.finalBranch]));
    if (!ren.ok) return markOrphan(ctx, record, 'orphan-branch');
  }
  if (existsSync(record.stagingPath)) {
    if (existsSync(record.finalPath)) return markOrphan(ctx, record, 'final-path-exists');
    const mv = await phase(ctx, issue, 'moved', () => gitRoot(ctx, ['worktree', 'move', record.stagingPath, record.finalPath]));
    if (!mv.ok) return markOrphan(ctx, record, 'move-failed');
  } else if (!existsSync(record.finalPath)) {
    return markOrphan(ctx, record, 'worktree-missing');
  }
  ctx.records.update(issue, { state: 'shaped', creationPhase: 'moved', localHead: record.localHead ?? record.baseOid });
  return { outcome: 'repaired', issue, state: 'shaped' };
}

/**
 * The §2.1 `creating` row, keyed on `creationPhase`. Touches ONLY artifacts
 * the record names whose ownership is provable; the record is never deleted
 * while any token-owned artifact exists; a final branch WITHOUT the marker is
 * never claimed and never deleted.
 */
export async function repairCreation({ ctx, record }) {
  const issue = record.issue;
  const { token, baseOid, stagingBranch, stagingPath, finalBranch, finalPath } = record;
  const orphan = (reason, extra) => markOrphan(ctx, record, reason, extra);
  // The record's names must be the ones its OWN token derives — a staging path of a different token is never touched.
  const expectedStaging = stagingBranchFor(token);
  if (stagingBranch !== finalBranch && (stagingBranch !== expectedStaging || stagingPath !== ctx.paths.stagingWorktree(issue, token))) return orphan('staging-token-mismatch');
  const stagingTip = await localBranchTip(ctx, stagingBranch);
  const finalTip = stagingBranch === finalBranch ? stagingTip : await localBranchTip(ctx, finalBranch);
  const finalMarker = finalTip == null ? null : await readMarker(ctx, finalBranch);
  const finalOwned = finalTip != null && finalMarker === token;
  switch (record.creationPhase) {
    case 'recorded': case 'staged': case 'marked': {
      if (stagingTip == null) {
        if (finalOwned) return finishFromStaging(ctx, record, { needRename: false });
        if (finalTip != null) return orphan('final-branch-unowned');
        // nothing present → delete the record and any EMPTY directories it named
        removeIfEmptyDir(stagingPath); removeIfEmptyDir(finalPath);
        ctx.records.remove(issue);
        return { outcome: 'deleted', issue };
      }
      if (stagingTip !== baseOid && !active('create.repairIgnoresTipMove')) return orphan('staging-tip-moved', { expected: baseOid, observed: stagingTip });
      const marker = await readMarker(ctx, stagingBranch);
      if (marker == null) {
        const mark = await phase(ctx, issue, 'marked', () => gitRoot(ctx, ['config', MARKER_KEY(stagingBranch), token]));
        if (!mark.ok) return orphan('mark-failed');
      } else if (marker !== token) return orphan('marker-mismatch');
      if (stagingBranch === finalBranch) return finishFromStaging(ctx, record, { needRename: false });
      if (finalTip != null) return orphan('final-branch-exists');
      return finishFromStaging(ctx, record, { needRename: true });
    }
    case 'renamed': {
      if (finalOwned) return finishFromStaging(ctx, record, { needRename: false });
      if (finalTip != null) return orphan('final-branch-unowned');
      if (stagingTip == null) return orphan('branch-missing');
      if ((await readMarker(ctx, stagingBranch)) !== token) return orphan('marker-mismatch');
      return finishFromStaging(ctx, record, { needRename: true });
    }
    case 'moved': {
      if (!finalOwned) return orphan(finalTip == null ? 'branch-missing' : 'final-branch-unowned');
      return finishFromStaging(ctx, record, { needRename: false });
    }
    default:
      return orphan('unknown-phase');
  }
}

/** `ticketSnapshotSha256` = diffcheck's `canonicalTicketSha256` (completed removed, deep key-sorted) over the shard the store wrote. */
export function ticketSnapshotSha256(shardJson) {
  return canonicalTicketSha256(typeof shardJson === 'string' ? JSON.parse(shardJson) : shardJson);
}

function parseJsonDocs(text) {
  const docs = []; let depth = 0; let start = -1; let inStr = false; let esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') { if (depth === 0) start = i; depth++; }
    else if (c === '}') { depth--; if (depth === 0 && start !== -1) { try { docs.push(JSON.parse(text.slice(start, i + 1))); } catch { /* skip */ } start = -1; } }
  }
  return docs;
}

/**
 * §6.2: `adlc ticket create --input - --write --root <ISSUE_WT> --json` (the
 * ticket CLI resolves its store from `--root`, not `--dir`; key-bearing, JSON
 * on stdin, id omitted → ULID). Records `ticketId`, `ticketSnapshotSha256`
 * and the manifest lines it wrote. The commit is made by `recordEvidence`
 * (§6.3 commits the records WITH the shard).
 */
export async function writeTicket({ ctx, issue, ticket }) {
  issue = validateIssueNumber(issue);
  const adlcDir = ctx.paths.issueAdlc(issue);
  const ticketsDir = ctx.paths.issueTickets(issue);
  const listShards = () => (existsSync(ticketsDir) ? readdirSync(ticketsDir).filter((n) => n.endsWith('.json')) : []);
  const shardsBefore = new Set(listShards());
  const linesBefore = manifestLineHashes(adlcDir);
  const { id: _omit, completed: _c, ...input } = ticket ?? {};
  const res = await ctx.spawn({
    argv: [ctx.pinned.adlc, 'ticket', 'create', '--input', '-', '--write', '--root', ctx.paths.issueWorktree(issue), '--json'],
    cwd: issueCwd(ctx, issue), env: childEnv(ctx.env.base, { key: ctx.key, keyBearing: true }),
    stdinBytes: JSON.stringify(input), deadlineMs: DEADLINES.adlcRecorder, label: 'adlc ticket create',
  });
  if (res.status !== 0 || res.timedOut) throw new RunError('ticket-create-failed', String(res.stderr ?? '').slice(0, 300));
  const docs = parseJsonDocs(res.stdout);
  const newShards = listShards().filter((n) => !shardsBefore.has(n));
  let ticketId = docs.map((d) => d?.ticketId ?? d?.ticket?.id ?? d?.id).find((v) => typeof v === 'string' && /^T-[0-9A-HJKMNP-TV-Z]{26}$/.test(v)) ?? null;
  let shardPath = null;
  for (const n of newShards) {
    const doc = JSON.parse(readFileSync(join(ticketsDir, n), 'utf8'));
    if (ticketId == null || doc.id === ticketId) { ticketId = doc.id; shardPath = join(ticketsDir, n); break; }
  }
  if (!ticketId || !shardPath) throw new RunError('ticket-create-failed', 'no new ticket shard found');
  const snapshot = ticketSnapshotSha256(readFileSync(shardPath, 'utf8'));
  const last = docs.at(-1); // `--write --json` prints the plan, then `{applied, storeHash, ticketHash}` — the LAST document carries the hash
  const ticketHash = typeof last?.ticketHash === 'string' ? last.ticketHash : null;
  const manifestLinesWritten = [...manifestLineHashes(adlcDir)].filter((h) => !linesBefore.has(h));
  const prior = ctx.records.load(issue);
  if (prior) ctx.records.update(issue, { ticketId, ticketSnapshotSha256: snapshot, manifestLinesWritten: [...(prior.manifestLinesWritten ?? []), ...manifestLinesWritten] });
  return { ticketId, shardPath, ticketSnapshotSha256: snapshot, ticketHash, manifestLinesWritten };
}
