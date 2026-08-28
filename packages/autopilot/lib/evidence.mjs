// P0/P1 evidence bound to the ticket (spec §6.3; AC 72, 98).
//
// coldstart: prompt via `adlc coldstart <id> --tickets <ISSUE_WT>/.adlc/tickets
// --prompt-only` (cwd ISSUE_WT, no --dir), answered by the GATED `claude -p`
// call whose prompt travels on stdin, validated as {gaps:[{what,why_blocking}]}
// and RE-SERIALIZED (never forwarded verbatim), then recorded with
// `--prompt-only --record-verdict -` carrying the CURRENT ticketHash on stdin
// (key-bearing). A non-empty `gaps` is a CLARIFY — zero record calls.
// spec-lint: the criteria document `<ISSUE_WT>/.adlc/specs/<ULID>-ac.md`
// (tracked, committed with the ticket) recorded with the in-repo bin.

import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import { validateIssueNumber, validateTicketId, validateModel } from './input.mjs';
import { childEnv } from './keys.mjs';
import { DEADLINES } from './spawn.mjs';
import { registerSeams, active } from './mutations.mjs';
import { RunError, runGit } from './retire.mjs';
import { manifestLineSha256, criteriaDocPath } from './diffcheck.mjs';

registerSeams([
  'create.recordDespiteGaps',   // a non-empty gaps answer is still recorded as a coldstart pass
  'create.untrackedCriteria',   // the criteria document is left out of the ticket commit
  'create.cwdRepoRoot',         // the ticket/coldstart/spec-lint children run with cwd REPO_ROOT instead of ISSUE_WT
]);

export const CLAUDE_STDOUT_CAP = 64 * 1024;
export const CRITERIA_HEADING = '=== ACCEPTANCE CRITERIA ===';
export const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/** cwd for every command from step 1 on (§6 path contract). */
export function issueCwd(ctx, issue) {
  return active('create.cwdRepoRoot') ? ctx.repoRoot : ctx.paths.issueWorktree(issue);
}

/** `manifestLineSha256` (diffcheck.mjs convention) of every line under `<adlc>/manifest.d/*.jsonl` (+ legacy manifest.jsonl). */
export function manifestLineHashes(adlcDir) {
  const out = new Set();
  const files = [];
  const seg = join(adlcDir, 'manifest.d');
  if (existsSync(seg)) for (const n of readdirSync(seg)) if (n.endsWith('.jsonl')) files.push(join(seg, n));
  if (existsSync(join(adlcDir, 'manifest.jsonl'))) files.push(join(adlcDir, 'manifest.jsonl'));
  for (const f of files) for (const line of readFileSync(f, 'utf8').split('\n')) if (line.trim()) out.add(manifestLineSha256(line));
  return out;
}

/** Validate a coldstart answer as EXACTLY {gaps:[{what,why_blocking}]} and re-serialize it. */
export function validateGaps(doc) {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) throw new RunError('coldstart-malformed', 'answer is not an object');
  const keys = Object.keys(doc);
  if (keys.length !== 1 || keys[0] !== 'gaps' || !Array.isArray(doc.gaps)) throw new RunError('coldstart-malformed', 'expected exactly {gaps:[…]}');
  const gaps = doc.gaps.map((g, i) => {
    if (g === null || typeof g !== 'object' || Array.isArray(g)) throw new RunError('coldstart-malformed', `gaps[${i}] is not an object`);
    const gk = Object.keys(g).sort();
    if (gk.join(',') !== 'what,why_blocking' || typeof g.what !== 'string' || typeof g.why_blocking !== 'string') throw new RunError('coldstart-malformed', `gaps[${i}] must be {what,why_blocking} strings`);
    return { what: g.what, why_blocking: g.why_blocking };
  });
  return { gaps };
}

/** `claude -p --output-format json` prints an envelope whose `result` is the answer text; extract the JSON object inside. */
export function parseClaudeAnswer(stdout) {
  let text = String(stdout ?? '');
  try {
    const env = JSON.parse(text);
    if (env && typeof env === 'object' && !Array.isArray(env)) {
      if (typeof env.result === 'string') text = env.result;
      else if (Array.isArray(env.gaps)) return validateGaps(env);
    }
  } catch { /* not an envelope: the text itself carries the answer */ }
  const start = text.indexOf('{'); const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) throw new RunError('coldstart-malformed', 'no JSON object in the answer');
  let doc;
  try { doc = JSON.parse(text.slice(start, end + 1)); } catch (e) { throw new RunError('coldstart-malformed', e.message); }
  return validateGaps(doc);
}

/** The criteria section of a ticket body: from the ACCEPTANCE CRITERIA heading to the next `=== … ===` heading or the end. */
export function criteriaSection(body) {
  const lines = String(body ?? '').split('\n');
  const start = lines.findIndex((l) => l.trim() === CRITERIA_HEADING);
  if (start === -1) throw new RunError('criteria-missing', `ticket body has no ${CRITERIA_HEADING} section`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) if (/^=== .* ===$/.test(lines[i].trim())) { end = i; break; }
  const section = lines.slice(start + 1, end).join('\n').trim();
  if (!section) throw new RunError('criteria-missing', 'criteria section is empty');
  return section;
}

/** Write the criteria document `<ISSUE_WT>/.adlc/specs/<ULID>-ac.md` (diffcheck's `criteriaDocPath`) atomically with the heading spec-lint's extractor needs. */
export function writeCriteriaDocument(wt, ticketId, body) {
  const text = `## Acceptance criteria\n\n${criteriaSection(body)}\n`;
  const path = join(wt, criteriaDocPath(ticketId));
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
  return { path, sha256: sha256(text) };
}

/** The gated `claude -p` call (§3.2, §5.3): fresh quota sample + start ordinal before, reconcile after; prompt on stdin. */
export async function gatedClaude(ctx, { prompt, cwd, model, label }) {
  const m = validateModel(model);
  let sample = null;
  if (ctx.quota?.sample) {
    const ordinal = ctx.status?.incrementStarts ? ctx.status.incrementStarts() : null;
    sample = await ctx.quota.sample({ ordinal, fresh: true });
    if (!sample?.ok) throw new RunError('quota-gated', sample?.reason ?? 'quota refused');
  }
  const env = { ...childEnv(ctx.env.base), HOME: ctx.env.home ?? ctx.env.base.HOME };
  const res = await ctx.spawn({
    argv: [ctx.pinned.claude, '-p', '--model', m, '--output-format', 'json', '--permission-mode', 'plan', '--max-turns', '1'],
    cwd, env, stdinBytes: prompt, deadlineMs: DEADLINES.claude, stdoutCap: CLAUDE_STDOUT_CAP, label,
  });
  if (sample && ctx.quota.reconcile) await ctx.quota.reconcile(label, sample);
  if (res.timedOut) throw new RunError(`timeout:${label}`);
  if (res.status !== 0 || res.error) throw new RunError('claude-failed', String(res.stderr ?? '').slice(0, 200));
  return res.stdout;
}

async function adlc(ctx, { issue, args, keyBearing = false, stdinBytes, label }) {
  const env = childEnv(ctx.env.base, keyBearing ? { key: ctx.key, keyBearing: true } : {});
  return ctx.spawn({ argv: [ctx.pinned.adlc, ...args], cwd: issueCwd(ctx, issue), env, stdinBytes, deadlineMs: DEADLINES.adlcRecorder, label });
}

/** `adlc ticket show <id> --json --root <ISSUE_WT>` (the ticket CLI takes --root, not --dir) → the CURRENT ticketHash. */
export async function currentTicketHash(ctx, issue, ticketId) {
  const res = await adlc(ctx, { issue, args: ['ticket', 'show', ticketId, '--json', '--root', ctx.paths.issueWorktree(issue)], label: 'adlc ticket show' });
  if (res.status !== 0) throw new RunError('ticket-show-failed', String(res.stderr ?? '').slice(0, 200));
  let doc;
  try { doc = JSON.parse(res.stdout); } catch (e) { throw new RunError('ticket-show-failed', `bad json: ${e.message}`); }
  if (typeof doc?.ticketHash !== 'string' || !doc.ticketHash) throw new RunError('ticket-show-failed', 'no ticketHash');
  return doc.ticketHash;
}

/**
 * Record P0/P1 evidence and make the ONE ticket commit (§6.2/§6.3: the
 * records and the criteria document are committed WITH the ticket shard).
 * Returns { verdict:'PROCEED', … } or { verdict:'CLARIFY', gaps } (the caller
 * applies the CLARIFY effects and retires the run — nothing recorded, nothing
 * committed).
 */
export async function recordEvidence({ ctx, issue, ticketId, ticket, model = ctx.local?.model }) {
  issue = validateIssueNumber(issue);
  ticketId = validateTicketId(ticketId);
  const wt = ctx.paths.issueWorktree(issue);
  const adlcDir = ctx.paths.issueAdlc(issue);
  const ticketsDir = ctx.paths.issueTickets(issue);
  const before = manifestLineHashes(adlcDir);
  // coldstart prompt (never --dir; cwd = ISSUE_WT; --tickets names the store)
  const p = await adlc(ctx, { issue, args: ['coldstart', ticketId, '--tickets', ticketsDir, '--prompt-only'], label: 'adlc coldstart prompt' });
  if (p.status !== 0) throw new RunError('coldstart-prompt-failed', String(p.stderr ?? '').slice(0, 200));
  const red = ctx.redactor.redact(p.stdout);
  const prompt = red.ok ? red.text : red.text; // ok:false → already the withheld sentinel (lands in CLARIFY downstream)
  const answer = parseClaudeAnswer(await gatedClaude(ctx, { prompt, cwd: issueCwd(ctx, issue), model, label: 'claude coldstart' }));
  if (answer.gaps.length > 0 && !active('create.recordDespiteGaps')) return { verdict: 'CLARIFY', gaps: answer.gaps, ticketId };
  const ticketHash = await currentTicketHash(ctx, issue, ticketId);
  const rec = await adlc(ctx, {
    issue, keyBearing: true, label: 'adlc coldstart record',
    args: ['coldstart', ticketId, '--tickets', ticketsDir, '--prompt-only', '--record-verdict', '-'],
    stdinBytes: JSON.stringify({ gaps: answer.gaps, ticketHash }),
  });
  if (rec.status !== 0) throw new RunError('coldstart-record-failed', String(rec.stderr ?? '').slice(0, 200));
  // spec-lint over the tracked criteria document, recorded with the in-repo bin
  const criteria = writeCriteriaDocument(wt, ticketId, ticket?.body);
  const lint = await ctx.spawn({
    argv: [ctx.pinned.node, ctx.pinned.specLintBin, criteria.path, '--record', '--ticket', ticketId, '--dir', adlcDir],
    cwd: issueCwd(ctx, issue), env: childEnv(ctx.env.base, { key: ctx.key, keyBearing: true }), deadlineMs: DEADLINES.adlcRecorder, label: 'spec-lint record',
  });
  if (lint.status !== 0) throw new RunError('spec-lint-failed', String(lint.stderr ?? lint.stdout ?? '').slice(0, 300), 2);
  const manifestLinesWritten = [...manifestLineHashes(adlcDir)].filter((h) => !before.has(h));
  const commitOid = await commitTicket({ ctx, issue, ticketId, title: ticket?.title ?? '', criteriaPath: criteria.path });
  const prior = ctx.records.load(issue);
  if (prior) ctx.records.update(issue, { ticketId, ticketHash, localHead: commitOid, criteriaDocSha256: criteria.sha256, manifestLinesWritten: [...(prior.manifestLinesWritten ?? []), ...manifestLinesWritten] });
  return { verdict: 'PROCEED', ticketId, ticketHash, criteriaPath: criteria.path, criteriaDocSha256: criteria.sha256, manifestLinesWritten, commitOid };
}

/** The ticket commit `chore(ticket): <ULID> <title> (#<n>)` over `.adlc/` in ISSUE_WT; returns its OID. */
export async function commitTicket({ ctx, issue, ticketId, title, criteriaPath = null }) {
  const wt = ctx.paths.issueWorktree(issue);
  const add = await runGit(ctx, wt, ['add', '-A', '--', '.adlc']);
  if (!add.ok) throw new RunError('ticket-commit-failed', add.err.slice(0, 200));
  if (active('create.untrackedCriteria') && criteriaPath) await runGit(ctx, wt, ['rm', '--cached', '-q', '--', criteriaPath]);
  const msg = `chore(ticket): ${ticketId} ${String(title).trim()} (#${issue})`;
  const commit = await runGit(ctx, wt, ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', msg]);
  if (!commit.ok) throw new RunError('ticket-commit-failed', commit.err.slice(0, 200));
  const head = await runGit(ctx, wt, ['rev-parse', 'HEAD']);
  if (!head.ok) throw new RunError('ticket-commit-failed', 'rev-parse HEAD');
  return head.out;
}
