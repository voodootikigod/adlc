// Terminal label + comment effects with independent reconciliation (spec
// §5.4, §6.10, §10; ticket AC6; AC 4).
//
// Every terminal outcome (clarify, blocked, stale, ci-red, oid-mismatch,
// pr-closed) has two GitHub effects: ONE comment keyed by a sentinel and ONE
// label. The durable intent `{ commentSentinel, commentPosted, labelApplied }`
// is written to the run record BEFORE either effect is attempted; each effect
// is then reconciled INDEPENDENTLY against GitHub (the comment is searched by
// sentinel, the label is read from the target — never the record alone) and the
// record is updated after each. A crash or `gh` failure between the two leaves
// a record the next iteration completes through `reconcilePendingEffects`.
// Comment bodies pass through the fail-closed redactor with the BODY sentinel
// on failure; the label is applied regardless, so a quarantine is never silent.

import { ensureComment, ensureLabel, GhError, hasComment } from './github.mjs';
import { WITHHELD_BODY } from './redact.mjs';
import { validateIssueNumber } from './input.mjs';
import { active, registerSeams } from './mutations.mjs';

registerSeams([
  'effects.skipIntent',   // no record write before / between the effects
  'effects.trustRecord',  // a missing flag mutates GitHub without reading it first
]);

export const TERMINAL_OUTCOMES = Object.freeze(['clarify', 'blocked', 'stale', 'ci-red', 'oid-mismatch', 'pr-closed']);
export const TARGET_KINDS = Object.freeze(['issue', 'pr']);
export const SENTINEL_PREFIX = '<!-- adlc-autopilot:';

export class EffectsError extends Error {
  constructor(code, detail) { super(detail ? `${code}: ${detail}` : code); this.code = code; this.exitCode = 1; }
}

const failed = (args, res) => new GhError('gh-failed', `${args.join(' ')} exited ${res.status}: ${String(res.stderr ?? '').trim().slice(0, 300)}`, res);

/** Post the comment unless one carrying `sentinel` already exists on the target. */
async function commentOn(gh, target, sentinel, body, { skipRead = false } = {}) {
  const n = validateIssueNumber(target.number, target.kind);
  if (target.kind === 'issue' && !skipRead) return ensureComment(gh, n, sentinel, body);
  if (!skipRead) {
    // PR conversation comments ARE issue comments in the API: the same bounded, every-page search.
    if (await hasComment(gh, n, sentinel)) return { posted: false };
  }
  const args = [target.kind, 'comment', String(n), '--body-file', '-'];
  const res = await gh.run(args, { stdinBytes: `${sentinel}\n${body}` });
  if (res.status !== 0) throw failed(args, res);
  return { posted: true };
}

/** Add the label unless the target already shows it. */
async function labelOn(gh, target, label, { skipRead = false } = {}) {
  const n = validateIssueNumber(target.number, target.kind);
  if (target.kind === 'issue' && !skipRead) return ensureLabel(gh, n, label, { present: true });
  if (!skipRead) {
    const cur = await gh.json([target.kind, 'view', String(n), '--json', 'labels']);
    if ((cur.labels ?? []).some((l) => l.name === label)) return { mutated: false };
  }
  const args = [target.kind, 'edit', String(n), '--add-label', label];
  const res = await gh.run(args);
  if (res.status !== 0) throw failed(args, res);
  return { mutated: true };
}

function validate({ outcome, target, sentinel, label }) {
  if (!TERMINAL_OUTCOMES.includes(outcome)) throw new EffectsError('bad-input:outcome', String(outcome));
  if (!target || !TARGET_KINDS.includes(target.kind)) throw new EffectsError('bad-input:target', 'kind must be issue|pr');
  if (typeof sentinel !== 'string' || !sentinel.startsWith(SENTINEL_PREFIX) || !sentinel.endsWith('-->')) throw new EffectsError('bad-input:sentinel', 'expected <!-- adlc-autopilot:… -->');
  if (typeof label !== 'string' || !/^[A-Za-z0-9:._-]+$/.test(label)) throw new EffectsError('bad-input:label', String(label));
  return { kind: target.kind, number: validateIssueNumber(target.number, target.kind) };
}

/**
 * Apply (or resume) the two effects of a terminal outcome.
 * @returns {{ ok, outcome, commentPosted, labelApplied, comment, label, error, record }}
 */
export async function applyTerminalEffects({ ctx, record, outcome, target, sentinel, body, label }) {
  const t = validate({ outcome, target, sentinel, label });
  if (!record || record.issue == null) throw new EffectsError('bad-input:record', 'record with an issue number required');
  const r = ctx.redactor.redact(String(body ?? ''), { withheld: WITHHELD_BODY });
  const existing = record.effects?.[outcome];
  // A new sentinel for the same outcome is a new intent (new findings → new comment).
  let intent = existing && existing.commentSentinel === sentinel
    ? { ...existing }
    : { commentSentinel: sentinel, commentPosted: false, labelApplied: false, target: t, label, body: r.text, redactionFailed: !r.ok };
  let current = record;
  const persist = (patch) => {
    intent = { ...intent, ...patch };
    // Mutation seam `effects.skipIntent`: nothing durable is written around the effects.
    if (active('effects.skipIntent')) return current;
    current = ctx.records.save({ ...current, effects: { ...(current.effects ?? {}), [outcome]: intent } });
    return current;
  };
  persist({}); // the durable intent, BEFORE either effect
  // Mutation seam `effects.trustRecord`: a missing flag mutates without consulting GitHub.
  const skipRead = active('effects.trustRecord');
  const out = { ok: false, outcome, commentPosted: intent.commentPosted, labelApplied: intent.labelApplied, comment: null, label: null, error: null, record: current };
  const fail = (which, e) => { out.error = { ...(out.error ?? {}), [which]: { code: e?.code ?? 'gh-failed', message: String(e?.message ?? e) } }; ctx.log?.(`effects ${outcome} #${t.number}: ${which} ${e?.code ?? 'gh-failed'}`); };
  // Each effect is reconciled and persisted on its own: a failing comment never blocks the label.
  if (!intent.commentPosted) {
    try { out.comment = await commentOn(ctx.gh, intent.target, intent.commentSentinel, intent.body, { skipRead }); persist({ commentPosted: true }); out.commentPosted = true; }
    catch (e) { fail('comment', e); }
  }
  if (!intent.labelApplied) {
    try { out.label = await labelOn(ctx.gh, intent.target, intent.label, { skipRead }); persist({ labelApplied: true }); out.labelApplied = true; }
    catch (e) { fail('label', e); }
  }
  out.ok = out.commentPosted && out.labelApplied;
  out.record = current;
  return out;
}

/** The effects of `record` still missing on GitHub (a flag not yet confirmed). */
export function pendingEffects(record) {
  return Object.entries(record?.effects ?? {})
    .filter(([, i]) => i && typeof i === 'object' && (!i.commentPosted || !i.labelApplied))
    .map(([outcome, intent]) => ({ outcome, intent }));
}

/**
 * Replay every missing effect (next iteration, BEFORE the run is treated as
 * quarantined). Idempotent: each effect is re-checked on GitHub first.
 */
export async function reconcilePendingEffects(ctx, record) {
  const replayed = [];
  let current = record;
  for (const { outcome, intent } of pendingEffects(record)) {
    const r = await applyTerminalEffects({ ctx, record: current, outcome, target: intent.target, sentinel: intent.commentSentinel, body: intent.body, label: intent.label });
    current = r.record ?? current;
    replayed.push({ outcome, ok: r.ok, commentPosted: r.commentPosted, labelApplied: r.labelApplied, error: r.error });
  }
  return { replayed, complete: replayed.every((r) => r.ok), record: current };
}
