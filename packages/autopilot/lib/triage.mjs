// Triage / P0 shaping (spec §5; AC 4, 26, 32, 35, 96, 101, 102; ticket AC5).
//
// For the selected issue the ORCHESTRATOR produces the ticket: a trusted
// `adlc:begin` block (§5.1, only when the issue is authorized) is assembled
// with no model call; otherwise ONE shaping call of the pinned `claude` with
// the fixed argv, the prompt on stdin, the 5-minute deadline and the 64 KiB
// stdout cap, bracketed by the durable attempt ledger. Only the issue TITLE
// and BODY are ever model-bound — never comments — and every model-bound byte
// passes the fail-closed redactor first. The gate chain then runs for every
// ticket regardless of how it was obtained; findings → CLARIFY.

import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fence } from '@adlc/core';
import { DEADLINES } from './spawn.mjs';
import { childEnv } from './keys.mjs';
import { validateIssueNumber, validateModel } from './input.mjs';
import { WITHHELD_BODY } from './redact.mjs';
import { LABEL_FOR_STATE } from './records.mjs';
import { viewIssue } from './github.mjs';
import { parseBlock, stripBlock, blockSkeleton } from './block.mjs';
import { SHAPING_PROMPT, shapingArgv, parseShapingResponse, criteriaFromShapedBody, ISSUE_BODY_FENCE_CAP, SHAPING_STDOUT_CAP } from './shaping-prompt.mjs';
import { createAttemptStore } from './attempts.mjs';
import { checkScope, schemaGate, specLintGate, extractCriteriaSection } from './triage-gates.mjs';
import { applyTerminalEffects } from './effects.mjs';
import { active, registerSeams } from './mutations.mjs';

registerSeams([
  'triage.skipRedaction',     // the issue text is model-bound unredacted
  'triage.promptInArgv',      // the prompt travels as a positional argv element, not stdin
  'triage.fetchComments',     // `gh issue view` also requests comments and they join the model input
  'triage.shapeTrustedBlock', // a trusted block WITH criteria still triggers the shaping call
  'triage.noStdoutCap',       // the shaping spawn has no 64 KiB stdout cap,
  'triage.trustShapedText',
  'triage.dryRunChargesAttempts',
]);

export const CLARIFY_LABEL = LABEL_FOR_STATE.clarify;
export const ISSUE_FIELDS = Object.freeze(['number', 'title', 'body', 'url']);
const BODY_ONLY_CONSTRAINTS = Object.freeze([
  'This issue already carries a trusted adlc block that fixes scope, rails, edges, duration and category. Produce ONLY the "body" field (the other fields are ignored) — never propose different scope or rails.',
]);

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
export const clarifySentinel = (findings) => `<!-- adlc-autopilot:clarify ${sha256(JSON.stringify(findings))} -->`;
export const issueUrlFor = (ctx, n) => `https://${ctx.gh.host}/${ctx.gh.repo}/issues/${validateIssueNumber(n)}`;

/** The ONLY issue read at triage: title + body (+ number/url); never comments (§5, AC 101). */
export async function loadIssue({ ctx, number }) {
  // Mutation seam `triage.fetchComments`.
  const fields = active('triage.fetchComments') ? [...ISSUE_FIELDS, 'comments'] : [...ISSUE_FIELDS];
  const doc = await viewIssue(ctx.gh, number, fields);
  return { number: validateIssueNumber(number), title: String(doc.title ?? ''), body: String(doc.body ?? ''), url: typeof doc.url === 'string' ? doc.url : null, comments: doc.comments };
}

/** The CLARIFY comment: every failed gate's findings verbatim, then the fix template (§5.4). */
export function renderClarifyComment({ findings, template, issueUrl }) {
  const blocks = findings.map((f) => `### ${f.gate}\n\n\`\`\`\n${String(f.detail).replace(/```/g, "'''")}\n\`\`\``).join('\n\n');
  return `The autopilot could not turn ${issueUrl} into an executable ticket. Failed gates:\n\n${blocks}\n\n`
    + 'To make the issue eligible, fix the findings above; a maintainer may also pin the ticket fields by adding this block to the issue body, followed by an `## Acceptance criteria` list:\n\n'
    + `${template}\n`;
}

const operational = (reason, extra = {}) => ({ verdict: 'OPERATIONAL', reason, lastError: reason, ...extra });

/** The CLARIFY document (sentinel + body) for findings raised OUTSIDE triage (the coldstart gaps of §6.3). */
export function clarifyDocument({ findings, issueUrl }) { return clarify({ findings, issueUrl }); }

function clarify({ findings, issueUrl, ticket = null }) {
  const template = blockSkeleton();
  return { verdict: 'CLARIFY', findings, sentinel: clarifySentinel(findings), template, body: renderClarifyComment({ findings, template, issueUrl }), ticket };
}

/** ONE shaping call (§5.2) around the attempt ledger. Returns { ok, ticket } | { ok:false, reason }. */
async function shapingCall({ ctx, n, url, title, body, bodyOnly, store, preModelCall }) {
  if (store.shapingExcluded(n)) return { ok: false, reason: 'shaping-failed' };
  if (preModelCall) { const g = await preModelCall('shaping'); if (g && g.ok === false) return { ok: false, reason: g.reason ?? 'model-call-refused' }; }
  const fenced = fence('github-issue', `Title: ${title}\n\n${body}`, ISSUE_BODY_FENCE_CAP);
  const prompt = SHAPING_PROMPT({ issueUrl: url, fencedBody: fenced, constraints: bodyOnly ? [...BODY_ONLY_CONSTRAINTS] : [] });
  const attempt = store.beginAttempt(n, 'shaping'); // durable `started` BEFORE the spawn
  const cwd = join(ctx.paths.runDir(n), 'shaping');
  mkdirSync(cwd, { recursive: true });
  const argv = [ctx.pinned.claude, ...shapingArgv(validateModel(ctx.local.model))];
  // Mutation seams `triage.promptInArgv` / `triage.noStdoutCap`.
  const inArgv = active('triage.promptInArgv');
  const req = { argv: inArgv ? [...argv, prompt] : argv, cwd, env: childEnv(ctx.env.base), deadlineMs: DEADLINES.claude, label: 'claude shaping' };
  if (!inArgv) req.stdinBytes = prompt;
  if (!active('triage.noStdoutCap')) req.stdoutCap = SHAPING_STDOUT_CAP;
  const res = await ctx.spawn(req);
  if (res.error || res.timedOut || res.truncated || res.status !== 0) {
    store.finishAttempt(n, attempt.id, 'failed');
    return { ok: false, reason: res.reason ?? (res.error ? `spawn-failed:claude` : `shaping-failed:exit-${res.status}`), attemptId: attempt.id };
  }
  const parsed = parseShapingResponse(res.stdout, { issueUrl: url, bodyOnly });
  if (!parsed.ok) { store.finishAttempt(n, attempt.id, 'failed'); return { ok: false, reason: parsed.reason, attemptId: attempt.id }; }
  store.finishAttempt(n, attempt.id, 'ok');
  return { ok: true, ticket: parsed.ticket, attemptId: attempt.id };
}

/**
 * @param p.issue          { number, title?, body?, url? } — title/body fetched via gh when absent
 * @param p.revision       { titleSha256, bodySha256, lastEditedAt } bound at selection; a mismatch is operational
 * @param p.authorization  eligibleAuthor() result; only `ok:true` lets a block be trusted
 * @param p.preModelCall   optional async gate (quota sample) run before the shaping spawn
 * @returns PROCEED { ticket, evidence } | CLARIFY { findings, sentinel, template, body } | OPERATIONAL { reason }
 */
export async function triage({ ctx, issue, revision = null, authorization = null, preModelCall = null, attempts = null, dryRun = false }) {
  const n = validateIssueNumber(issue?.number);
  const full = typeof issue.body === 'string' && typeof issue.title === 'string' ? { comments: undefined, ...issue } : await loadIssue({ ctx, number: n });
  const url = full.url ?? issueUrlFor(ctx, n);
  if (revision && (revision.titleSha256 !== sha256(full.title) || revision.bodySha256 !== sha256(full.body ?? ''))) return operational('issue-revision-changed');
  let title = String(full.title); let body = String(full.body ?? '');
  // Mutation seam `triage.skipRedaction`: no model-bound byte skips the redactor otherwise (§5.2, §10).
  if (!active('triage.skipRedaction')) {
    const rb = ctx.redactor.redact(body, { withheld: WITHHELD_BODY });
    const rt = ctx.redactor.redact(title, { withheld: WITHHELD_BODY });
    if (!rb.ok || !rt.ok) return clarify({ findings: [{ gate: 'redaction', detail: 'the issue text could not be redacted and was withheld from every model-bound path' }], issueUrl: url });
    body = rb.text; title = rt.text;
  }
  if (active('triage.fetchComments') && Array.isArray(full.comments)) body += `\n${full.comments.map((c) => String(c?.body ?? '')).join('\n')}`;
  let block = null; let strippedBody = body;
  if (authorization?.ok === true) {
    const parsed = parseBlock(body);
    if (!parsed.ok) return clarify({ findings: [{ gate: 'block', detail: parsed.errors.join('\n') }], issueUrl: url });
    if (parsed.block) { block = parsed.block; strippedBody = stripBlock(parsed); }
  }
  const criteria = block ? extractCriteriaSection(strippedBody) : { found: false, text: null };
  const blockFields = block ? { scope: block.scope ?? [], rails: block.rails ?? [], edges: block.edges ?? [], duration: block.duration, category: block.category } : null;
  let ticket; let mode; let attemptId = null;
  // Mutation seam `triage.shapeTrustedBlock`.
  if (block && criteria.found && !active('triage.shapeTrustedBlock')) {
    ticket = { title: `#${n}: ${title}`, body: `GitHub issue: ${url}\n${strippedBody}`, ...blockFields };
    mode = 'trusted-block';
  } else {
    const real = attempts ?? createAttemptStore({ paths: ctx.paths, now: ctx.now, lockToken: ctx.lock?.token ?? null });
    // A dry run READS the ledger (the cap still applies) but never writes it (codex r3 B6).
    // Mutation seam `triage.dryRunChargesAttempts`: a dry run books an attempt.
    const store = dryRun && !active('triage.dryRunChargesAttempts')
      ? { shapingExcluded: (m) => real.shapingExcluded(m), beginAttempt: () => ({ id: null }), finishAttempt: () => {} }
      : real;
    const bodyOnly = block !== null;
    const r = await shapingCall({ ctx, n, url, title, body: strippedBody, bodyOnly, store, preModelCall });
    if (!r.ok) return operational(r.reason, { attemptId: r.attemptId ?? null });
    attemptId = r.attemptId;
    ticket = bodyOnly
      ? { title: `#${n}: ${title}`, body: r.ticket.body, ...blockFields }
      : { title: r.ticket.title, body: r.ticket.body, scope: r.ticket.scope, rails: r.ticket.rails ?? [], edges: [], category: r.ticket.category, duration: r.ticket.duration };
    mode = bodyOnly ? 'trusted-block+shaped-body' : 'shaping-call';
    // The MODEL-produced text is untrusted output (codex r3 A4): it passes the same redactor as the
    // issue text and any secret-shaped content in it is a CLARIFY — never a ticket write or a comment.
    // Mutation seam `triage.trustShapedText`: the shaped text is written unredacted.
    if (!active('triage.trustShapedText')) {
      const scans = [ticket.title, ticket.body].map((t) => ctx.redactor.redact(String(t ?? ''), { withheld: WITHHELD_BODY }));
      if (scans.some((x) => !x.ok || (x.hits ?? []).length > 0)) {
        return clarify({ findings: [{ gate: 'redaction', detail: 'the shaped ticket text contained secret-shaped content and was withheld from every write' }], issueUrl: url, ticket: null });
      }
    }
  }
  // Gate chain (§5.3): every gate, findings verbatim.
  const findings = [...await schemaGate({ ctx, ticket })];
  const tree = String(await ctx.git.localOut(ctx.repoRoot, ['ls-tree', '-r', '--name-only', ctx.baseOid])).split('\n').filter(Boolean);
  findings.push(...checkScope({ scope: ticket.scope, category: ticket.category, denylist: ctx.denylist, treePaths: tree }));
  findings.push(...await specLintGate({ ctx, issue: n, criteriaText: mode === 'trusted-block' ? criteria.text : criteriaFromShapedBody(ticket.body) }));
  if (findings.length) return clarify({ findings, issueUrl: url, ticket });
  return { verdict: 'PROCEED', ticket, evidence: { mode, attemptId, issueUrl: url, gates: ['ticket-schema', 'scope', 'protected-path', 'spec-lint'] } };
}

/** The CLARIFY effects (§5.4): record `{state:'clarify', sentinel, …}` first, then comment + label via lib/effects.mjs. */
export async function clarifyEffects({ ctx, issue, sentinel, body, revision = null }) {
  const n = validateIssueNumber(typeof issue === 'object' ? issue?.number : issue);
  const existing = ctx.records.load(n);
  const record = {
    ...(existing ?? { issue: n, effects: {} }),
    issue: n, state: 'clarify', sentinel,
    issueUpdatedAt: revision?.lastEditedAt ?? existing?.issueUpdatedAt ?? null,
    issueRevision: revision ?? existing?.issueRevision ?? null,
  };
  return applyTerminalEffects({ ctx, record, outcome: 'clarify', target: { kind: 'issue', number: n }, sentinel, body, label: CLARIFY_LABEL });
}
