// AC 2 / 23 / 27 / 47 / 65 / 87 — the quota gate's pure core: the matrix, the
// strict endpoint schema, the fallback grammar, family normalization, the
// reserve ordinal and overshoot bookkeeping. The loop-level re-check points
// (AC 18/39/50/158) live with the loop suites.

import { test } from './helpers/node-test.mjs';
import assert from 'node:assert/strict';
import {
  familyOf, validateUsageBody, noScopedLimit, evaluate, parseUsageText, readUsage, createSampler, thresholdFor, reconcile,
  QUOTA_UNKNOWN, BETA_HEADER, USAGE_URL, SAMPLE_TTL_MS,
} from '../lib/quota.mjs';
import { withMutation } from '../lib/mutations.mjs';

const body = ({ five = 10, seven = 10, limits, extra = {} } = {}) => ({
  five_hour: { utilization: five, resets_at: '2026-08-28T20:00:00Z' },
  seven_day: { utilization: seven, resets_at: '2026-09-01T00:00:00Z' },
  ...(limits !== undefined ? { limits } : {}),
  ...extra,
});
const scopedEntry = (name, percent) => ({ kind: 'weekly', percent, scope: { model: { display_name: name } } });
const gate = (b, family = 'opus', threshold = 50) => evaluate(validateUsageBody(b), { family, threshold });

export function ac2_quotaMatrix() {
  assert.equal(gate(body({ five: 49, seven: 49 })).ok, true, '49/49 → ok');
  assert.equal(gate(body({ five: 50, seven: 10 })).reason, 'five_hour', '5h 50 → refused');
  assert.equal(gate(body({ five: 10, seven: 50 })).reason, 'seven_day', '7d 50 → refused');
  assert.equal(gate(body({ limits: [scopedEntry('Opus', 50)] })).reason, 'seven_day_opus', 'scoped worker-model window 50 → refused');
  assert.equal(gate(body({ limits: [scopedEntry('Sonnet', 90)] }), 'opus').ok, true, 'another family at 90 does not gate opus');
  const unknown = evaluate({ ok: false, reason: QUOTA_UNKNOWN }, { family: 'opus' });
  assert.equal(unknown.ok, false); assert.equal(unknown.reason, QUOTA_UNKNOWN);
}
test('AC2: 49/49 ok; 5h 50, 7d 50 and a scoped worker-model window at 50 each refuse; unknown → quota-unknown', ac2_quotaMatrix);

export async function ac2_endpointHeadersAndFallback() {
  const calls = [];
  const fetchOk = async (url, init) => { calls.push({ url, headers: init.headers }); return { status: 200, json: async () => body({ five: 20, seven: 30 }) }; };
  const r = await readUsage({ fetchImpl: fetchOk, accessToken: 'tok-secret-1234567890', fallback: async () => { throw new Error('not consulted'); } });
  assert.equal(r.ok, true); assert.equal(r.source, 'endpoint');
  assert.equal(calls[0].url, USAGE_URL);
  assert.deepEqual(Object.keys(calls[0].headers).sort(), ['Authorization', 'anthropic-beta'], 'exactly the two headers');
  assert.equal(calls[0].headers['anthropic-beta'], BETA_HEADER);
  assert.deepEqual(r.headersUsed, ['Authorization', 'anthropic-beta'], 'the result names header NAMES only');
  assert.ok(!JSON.stringify({ ...r, body: undefined }).includes('tok-secret'), 'the token value appears nowhere in the result');
  // 401 → fallback text decides.
  const fetch401 = async () => ({ status: 401, json: async () => ({}) });
  const okText = 'Your subscription\nCurrent session: 12% used\nCurrent week (all models): 33% used\n';
  const f1 = await readUsage({ fetchImpl: fetch401, accessToken: 't', fallback: async () => okText });
  assert.equal(f1.source, 'fallback'); assert.equal(evaluate(f1, { family: 'opus' }).ok, true);
  const f2 = await readUsage({ fetchImpl: fetch401, accessToken: 't', fallback: async () => okText.replace('33%', '77%') });
  assert.equal(evaluate(f2, { family: 'opus' }).reason, 'seven_day');
  // Both sources failing → quota-unknown.
  const dead = async () => { throw new Error('ECONNREFUSED'); };
  const f3 = await readUsage({ fetchImpl: dead, accessToken: 't', fallback: async () => { throw new Error('no claude'); }, retries: 0 });
  assert.equal(f3.ok, false); assert.equal(f3.reason, QUOTA_UNKNOWN);
}
test('AC2: the endpoint is called with exactly the two headers, the token never appears in the result, 401 → fallback, both failing → quota-unknown', ac2_endpointHeadersAndFallback);

export function ac23_fallbackGrammar() {
  const base = 'Plan: subscription\nCurrent session: 12% used\nCurrent week (all models): 33% used\nCurrent week (Opus): 40% used\n';
  const cur = parseUsageText(base);
  assert.equal(cur.ok, true); assert.equal(cur.fiveHour, 12); assert.equal(cur.sevenDay, 33); assert.equal(cur.scoped.get('opus'), 40);
  const noScoped = parseUsageText('subscription\nCurrent session: 1% used\nCurrent week (all models): 2% used\n');
  assert.equal(noScoped.ok, true); assert.equal(noScoped.scoped.size, 0, 'ok (no scoped)');
  assert.equal(parseUsageText('subscription\nCurrent session: 1% used\n').reason, QUOTA_UNKNOWN, 'missing weekly line');
  assert.equal(parseUsageText(base.replace('33%', '101%')).reason, QUOTA_UNKNOWN, 'value 101');
  assert.equal(parseUsageText(base.replace('subscription', 'plan')).reason, QUOTA_UNKNOWN, 'no literal "subscription"');
  assert.equal(parseUsageText(base + 'Current session: 13% used\n').reason, QUOTA_UNKNOWN, 'duplicate mandatory line with a different value');
}
test('AC23: current text → ok; scoped absent → ok(no scoped); missing weekly, 101, no "subscription" → quota-unknown', ac23_fallbackGrammar);

export function ac47_strictSchemaAndNoScopedLimit() {
  const cases = [
    ['HTTP body not an object', 'nope'],
    ['five_hour null', body({ extra: { five_hour: null } })],
    ['utilization "70"', body({ extra: { five_hour: { utilization: '70', resets_at: '2026-01-01T00:00:00Z' } } })],
    ['utilization 101', body({ extra: { seven_day: { utilization: 101, resets_at: '2026-01-01T00:00:00Z' } } })],
    ['limits {}', body({ limits: {} })],
    ['matching entry lacking percent', body({ limits: [{ kind: 'weekly', scope: { model: { display_name: 'Opus' } } }] })],
    ['non-matching scope null', body({ limits: [{ kind: 'weekly', percent: 1, scope: null }] })],
    ['non-matching scope string', body({ limits: [{ kind: 'weekly', percent: 1, scope: 'sonnet' }] })],
    ['non-matching scope []', body({ limits: [{ kind: 'weekly', percent: 1, scope: [] }] })],
    ['non-matching scope {}', body({ limits: [{ kind: 'weekly', percent: 1, scope: {} }] })],
    ['non-matching scope {model:{}}', body({ limits: [{ kind: 'weekly', percent: 1, scope: { model: {} } }] })],
    ['non-matching display_name ""', body({ limits: [{ kind: 'weekly', percent: 1, scope: { model: { display_name: '' } } }] })],
    ['duplicate scoped entries disagree', body({ limits: [scopedEntry('Opus', 10), scopedEntry('opus', 20)] })],
  ];
  for (const [name, b] of cases) {
    const v = validateUsageBody(b);
    assert.equal(v.ok, false, name); assert.equal(v.reason, QUOTA_UNKNOWN, name);
  }
  // The canonical predicate over the RAW body.
  const noLimit = body({ limits: [scopedEntry('Sonnet', 5)], extra: { seven_day_opus: null } });
  assert.equal(noScopedLimit(noLimit, 'opus'), true);
  for (const bad of [null, undefined, 7, 'x']) assert.equal(typeof noScopedLimit(bad, 'opus'), 'boolean', `a ${bad} body never throws`);
  assert.equal(gate(noLimit).windows.scoped, null, 'no scoped limit → the gate reads no scoped window');
  const malformedOpus = body({ limits: [{ kind: 'weekly', scope: { model: { display_name: 'Opus' } } }] });
  assert.equal(validateUsageBody(malformedOpus).reason, QUOTA_UNKNOWN, 'a present-but-malformed Opus entry is quota-unknown, never "no limit"');
  const siblingObject = body({ limits: [scopedEntry('Sonnet', 5)], extra: { seven_day_opus: { utilization: 60, resets_at: 'x' } } });
  assert.equal(gate(siblingObject).reason, 'seven_day_opus', 'seven_day_opus as an object is read when limits has no Opus entry');
  const disagree = body({ limits: [scopedEntry('Opus', 10)], extra: { seven_day_opus: { utilization: 60 } } });
  assert.equal(validateUsageBody(disagree).reason, QUOTA_UNKNOWN, 'disagreement between the two shapes → quota-unknown');
  assert.equal(gate(body({ five: 10, seven: 10 })).ok, true, 'a body with no limits key is valid');
}
test('AC47: every malformed shape (incl. a NON-matching scope) is quota-unknown; noScopedLimit is the canonical predicate', ac47_strictSchemaAndNoScopedLimit);

export async function ac47_lenientSchemaSeamBites() {
  const malformedNonMatching = body({ limits: [{ kind: 'weekly', percent: 1, scope: null }] });
  assert.equal(validateUsageBody(malformedNonMatching).ok, false);
  await withMutation('quota.lenientSchema', () => { assert.equal(validateUsageBody(malformedNonMatching).ok, true, 'the seam skips the malformed entry'); });
}
test('AC47: the quota.lenientSchema seam makes the gate skip a malformed entry (what the coverage gate injects)', ac47_lenientSchemaSeamBites);

export function ac65_familyNormalization() {
  assert.equal(familyOf('Fable'), 'fable');
  assert.equal(familyOf('claude-opus-5'), 'opus');
  assert.equal(familyOf('Claude Sonnet 5'), 'sonnet');
  assert.equal(familyOf('opus'), 'opus');
  assert.equal(familyOf('gpt-5'), 'unknown');
  assert.equal(familyOf(null), 'unknown');
  const text = 'subscription\nCurrent session: 1% used\nCurrent week (all models): 2% used\nCurrent week (Opus): 70% used\n';
  assert.equal(evaluate(parseUsageText(text), { family: familyOf('claude-opus-5') }).reason, 'seven_day_opus', 'an Opus line at 70 with --model claude-opus-5 → refused');
  assert.equal(parseUsageText(text + 'Current week (Opus): 71% used\n').reason, QUOTA_UNKNOWN, 'two (Opus) lines with different values → quota-unknown');
  assert.equal(parseUsageText(text + 'Current week (Opus): 70% used\n').ok, true, 'a repeated identical line is fine');
}
test('AC65: familyOf maps Fable/claude-opus-5/Claude Sonnet 5/opus and gpt-5→unknown; an Opus 70% line refuses claude-opus-5; two disagreeing Opus lines → quota-unknown', ac65_familyNormalization);

export function ac27_overshootAndReserve() {
  const before = { fiveHour: 40, sevenDay: 30, scoped: null };
  const after = { fiveHour: 52, sevenDay: 31, scoped: null };
  const rec = reconcile({ step: 'shaping', before, after, threshold: 50 });
  assert.equal(rec.overshoot, true); assert.equal(rec.delta, 12); assert.equal(rec.step, 'shaping');
  assert.equal(evaluate({ ok: true, fiveHour: 52, sevenDay: 31, scoped: new Map() }, { family: 'opus', threshold: 50 }).ok, false, 'the next start is refused by the ordinary gate');
  assert.equal(thresholdFor(1, { threshold: 50, reserve: 5 }), 50, 'the first start is gated at the threshold');
  assert.equal(thresholdFor(2, { threshold: 50, reserve: 5 }), 45, 'every later start at threshold − reserve');
  assert.equal(evaluate({ ok: true, fiveHour: 46, sevenDay: 10, scoped: new Map() }, { family: 'opus', threshold: thresholdFor(2) }).ok, false, 'a strike at 46% is refused with threshold 50 / reserve 5');
  assert.equal(evaluate({ ok: true, fiveHour: 44, sevenDay: 10, scoped: new Map() }, { family: 'opus', threshold: thresholdFor(2) }).ok, true);
}
test('AC27: a post-step reading ≥ threshold records overshoot and refuses the next start; the reserve refuses a strike at 46% (50/5)', ac27_overshootAndReserve);

export async function ac87_sampleNeverReusedPastTtl() {
  let t = 0; let reads = 0;
  const s = createSampler({ read: async () => ({ n: ++reads }), now: () => t, ttlMs: SAMPLE_TTL_MS });
  assert.deepEqual(await s.sample(), { n: 1 });
  t = 59_000; assert.deepEqual(await s.sample(), { n: 1 }, 'a 59-second-old sample is reused');
  t = 61_000; assert.deepEqual(await s.sample(), { n: 2 }, 'a 61-second-old sample is never reused');
  assert.deepEqual(await s.sample({ fresh: true }), { n: 3 }, 'fresh forces a re-read');
  await withMutation('quota.reuseStale', async () => { t = 10_000_000; assert.deepEqual(await s.sample(), { n: 3 }, 'seam: the stale sample is reused'); });
}
test('AC87: a quota sample is valid for 60 s and a 61-second-old one is never reused', ac87_sampleNeverReusedPastTtl);

export async function ac2_forceOkSeamBites() {
  assert.equal(gate(body({ five: 90, seven: 90 })).ok, false);
  await withMutation('quota.forceOk', () => { assert.equal(gate(body({ five: 90, seven: 90 })).ok, true); });
}
test('AC2: the quota.forceOk seam admits a 90/90 reading (the fixture the coverage gate applies)', ac2_forceOkSeamBites);

// ---- the re-check points over the REAL loop / run (AC 18, 39, 50) ----
import { createSequenceFixture } from './helpers/sequence-fixture.mjs';
import { iterate, quotaCommand } from '../lib/loop.mjs';
import { runIssue } from '../lib/run.mjs';
import { FAKE } from './helpers/recover-fixture.mjs';

const OK_USAGE = (scoped = {}) => ({ ok: true, fiveHour: 10, sevenDay: 10, scoped: new Map(Object.entries({ opus: 10, sonnet: 10, ...scoped })), resetsAt: { fiveHour: null } });
const REFUSED_USAGE = () => ({ ok: true, fiveHour: 80, sevenDay: 10, scoped: new Map([['opus', 10], ['sonnet', 10]]), resetsAt: { fiveHour: null } });
const fleetSpawns = (fx) => fx.recorder.filter((r) => r.argv[0] === FAKE.adlc && r.argv[1] === 'fleet');
const coldstartClaude = (fx) => (fx.state.claudeCalls ?? []).filter((c) => c.stdin.includes('COLDSTART PROMPT'));

export async function ac18_quotaRecheckPoints() {
  // (a) refused right AFTER the shaping call → zero fleet dispatches, a run record in state `shaped`.
  let reads = 0;
  const fx = await createSequenceFixture({ quotaRead: async () => (++reads <= 2 ? OK_USAGE() : REFUSED_USAGE()) });
  try {
    const it = await iterate({ ctx: fx.ctx, deps: fx.loopDeps(), pinnedIssue: fx.issue });
    assert.match(it.outcome, /^sleep:quota:five_hour/, JSON.stringify(it.document?.verdict));
    assert.equal(it.document.verdict, 'PROCEED', 'the shaping call ran (its sample was the 2nd read)');
    assert.equal(fleetSpawns(fx).length, 0, 'zero fleet dispatches');
    assert.equal(fx.ctx.records.load(fx.issue)?.state, 'shaped', 'the shaped ticket is cached');
    assert.ok(fx.ctx.records.load(fx.issue).ticketCache?.title, 'with the ticket');
  } finally { fx.cleanup(); }
  // (b) a 61-second-old result is never reused: the sampler re-reads past its 60 s TTL even without `fresh`.
  let n = 0; let t = 1_000_000;
  const sampler = createSampler({ read: async () => { n++; return OK_USAGE(); }, now: () => t });
  await sampler.sample({ fresh: false }); await sampler.sample({ fresh: false });
  assert.equal(n, 1, 'within the TTL the result is reused');
  t += 61_000;
  await sampler.sample({ fresh: false });
  assert.equal(n, 2, 'a 61-second-old result is re-read');
}
test('AC18: a quota fake that flips to refused after the shaping call → zero fleet dispatches and a `shaped` run record; a 61-second-old sample is never reused', { timeout: 120_000 }, ac18_quotaRecheckPoints);

export async function ac39_coldstartIsGated() {
  // refused between shaping and coldstart (the coldstart gate is the first sample the RUN takes)
  let reads = 0;
  const fx = await createSequenceFixture({ quotaRead: async () => (++reads <= 1 ? OK_USAGE() : REFUSED_USAGE()) });
  try {
    await fx.ctx.quota.sample({ ordinal: 1, fresh: true }); // the loop-head sample (ok)
    const result = await runIssue({ ctx: fx.ctx, deps: fx.ctx.deps, issue: fx.issue, ticket: fx.ticket, revision: { updatedAt: fx.state.issue.updatedAt }, authorization: { ok: true } });
    assert.equal(result.state, 'shaped', JSON.stringify(result));
    assert.equal(coldstartClaude(fx).length, 0, 'zero coldstart claude calls');
    assert.equal(fx.ctx.records.load(fx.issue).state, 'shaped');
    assert.equal(fleetSpawns(fx).length, 0);
  } finally { fx.cleanup(); }
  // a coldstart fake that stalls is killed at 5 minutes; the run record does not change
  const timers = []; let id = 1;
  const spawner = { setTimeoutFn: (fn, ms) => { timers.push({ id: id++, fn, ms }); return timers.at(-1).id; }, clearTimeoutFn: (i) => { const k = timers.findIndex((x) => x.id === i); if (k !== -1) timers.splice(k, 1); } };
  const fx2 = await createSequenceFixture({ spawner, claudeAnswer: null });
  let snapshot = null;
  fx2.table[FAKE.claude] = (args, { stdin }) => { snapshot = JSON.stringify(fx2.ctx.records.load(fx2.issue)); return String(stdin).includes('COLDSTART PROMPT') ? { hang: true } : { stdout: '{}' }; };
  try {
    const p = runIssue({ ctx: fx2.ctx, deps: fx2.ctx.deps, issue: fx2.issue, ticket: fx2.ticket, revision: { updatedAt: fx2.state.issue.updatedAt }, authorization: { ok: true } });
    let spins = 0; while (snapshot === null && spins++ < 50_000) await new Promise((r) => setImmediate(r));
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    const deadline = timers.find((x) => x.ms === 5 * 60_000);
    assert.ok(deadline, `the coldstart deadline is 5 minutes (armed: ${timers.map((x) => x.ms).join(',')})`);
    deadline.fn();
    const result = await p;
    assert.equal(result.state, 'failed', JSON.stringify(result));
    assert.match(String(result.reason), /^timeout:claude coldstart$/, 'the deadline names the command');
    assert.equal(JSON.stringify(fx2.ctx.records.load(fx2.issue)), snapshot, 'no run record change');
  } finally { fx2.cleanup(); }
}
test('AC39: a quota refusal between shaping and coldstart → zero coldstart claude calls and a cached `shaped` ticket; a stalling coldstart fake is killed at 5 minutes with no run record change', { timeout: 120_000 }, ac39_coldstartIsGated);

export async function ac50_effectiveModelPropagates() {
  for (const [model, scoped, expectRefused] of [['sonnet', { sonnet: 60 }, 'seven_day_sonnet'], ['sonnet', {}, null], ['opus', {}, null]]) {
    const fx = await createSequenceFixture({ local: { model }, quotaRead: async () => OK_USAGE(scoped) });
    try {
      const it = await iterate({ ctx: fx.ctx, deps: fx.loopDeps(), pinnedIssue: fx.issue });
      if (expectRefused) { assert.equal(it.outcome, `sleep:quota:${expectRefused}`, 'the gate reads the SCOPED window of the effective model'); continue; }
      assert.equal(it.outcome, 'done', JSON.stringify(it.document?.run ?? it.outcome));
      const claude = (fx.state.claudeCalls ?? []).map((c) => c.args);
      assert.equal(claude.length, 2, 'the shaping and the coldstart-answer calls');
      for (const a of claude) assert.deepEqual(a.slice(0, 3), ['-p', '--model', model]);
      const fleet = fleetSpawns(fx)[0].argv;
      assert.equal(fleet[fleet.indexOf('--model') + 1], model, 'the fleet argv carries the effective model');
    } finally { fx.cleanup(); }
  }
}
test('AC50: with --model sonnet the shaping argv, the coldstart-answer argv and the fleet argv all carry --model sonnet and the gate reads the Sonnet scoped window; with no override all three carry --model opus', { timeout: 240_000 }, ac50_effectiveModelPropagates);

export async function ac2_productionReaderHasATransport() {
  // The DEFAULT context reader: the endpoint over the runtime fetch with the credential's token; a 401 falls back to the pinned `claude -p "/usage"`.
  let endpointCalls = 0;
  const fx = await createSequenceFixture({ quotaRead: null, fetchImpl: async (url, opts) => { endpointCalls++; assert.match(url, /api\.anthropic\.com\/api\/oauth\/usage/); assert.equal(opts.headers.Authorization, 'Bearer fake-access-token'); return { status: 200, json: async () => ({ five_hour: { utilization: 12, resets_at: '2026-08-28T13:00:00Z' }, seven_day: { utilization: 20, resets_at: '2026-09-03T00:00:00Z' } }) }; } });
  try {
    const q = await fx.ctx.quota.sample({ ordinal: 1, fresh: true });
    assert.equal(endpointCalls, 1, 'the endpoint was called with the credential token');
    assert.ok(!fx.logs.join('\n').includes('fake-access-token'), 'the bearer value never reaches the log');
    assert.ok(!JSON.stringify(q).includes('fake-access-token'), 'nor the sample');
    assert.equal(q.ok, true, JSON.stringify(q));
  } finally { fx.cleanup(); }
  const fallbackText = 'Your subscription\nCurrent session: 7% used\nCurrent week (all models): 9% used\n';
  assert.equal(parseUsageText(fallbackText).ok, true, 'the fallback text is valid under the usage-text grammar');
  const fx2 = await createSequenceFixture({ quotaRead: null, fetchImpl: async () => ({ status: 401 }), claudeAnswer: (args) => (args.includes('/usage') ? { type: 'result', result: fallbackText } : { type: 'result', result: JSON.stringify({ gaps: [] }) }) });
  try {
    const q = await fx2.ctx.quota.sample({ ordinal: 1, fresh: true });
    assert.equal(q.ok, true, JSON.stringify(q));
    const call = (fx2.state.claudeCalls ?? []).find((c) => c.args.includes('/usage'));
    assert.ok(call, 'the fallback spawned the pinned claude with /usage');
    assert.deepEqual(call.args, ['-p', '/usage', '--output-format', 'json']);
  } finally { fx2.cleanup(); }
}
test('AC2: the production quota reader has a transport — the endpoint over fetch with the credential token, then the pinned claude -p /usage fallback on 401', { timeout: 120_000 }, ac2_productionReaderHasATransport);

export async function ac65_familyMappersAgree() {
  const { modelFamily } = await import('../lib/preflight-a.mjs');
  for (const m of ['opus', 'claude-opus-5', 'Claude Sonnet 5', 'fable', 'claude-3-haiku', 'gpt-5', 'opusish', 'sonnetx', 'haiku-lite', '', null]) {
    const q = familyOf(m); const p = modelFamily(m);
    assert.equal(p, q === 'unknown' ? null : q, `phase A and the quota gate map ${JSON.stringify(m)} the same way (${p} vs ${q})`);
  }
  assert.equal(modelFamily('opusish'), null, 'a substring is not a family (the quota gate would call it unknown)');
}
test('AC65: phase A validates the model with the SAME family mapper the quota gate enforces with — no model is admitted that the gate calls unknown', ac65_familyMappersAgree);

export async function ac60_helperBumpsTheOrdinalUnderTheOrchestratorLock() {
  // The helper process never owns the lock: its ADLC_AUTOPILOT_LOCK_TOKEN is verified against the on-disk owner.
  const fx = await createSequenceFixture();
  try {
    const token = fx.ctx.lock.token;
    fx.ctx.status.resetStarts('it-h');
    const env = { PATH: process.env.PATH, HOME: fx.ctx.env.home, ADLC_AUTOPILOT_LOCK_TOKEN: token };
    const deps = { quota: { read: async () => OK_USAGE({}) } };
    const r1 = await quotaCommand({ flags: { startOrdinal: 'auto', iteration: 'it-h' }, env, cwd: fx.ctx.repoRoot, deps });
    assert.equal(r1.exitCode, 0, JSON.stringify(r1.document));
    assert.equal(r1.document.ordinal, 1, 'the helper bumped the ordinal although it holds no lock of its own');
    const r2 = await quotaCommand({ flags: { startOrdinal: 'auto', iteration: 'it-h' }, env, cwd: fx.ctx.repoRoot, deps });
    assert.equal(r2.document.ordinal, 2);
    const wrong = await quotaCommand({ flags: { startOrdinal: 'auto', iteration: 'it-h' }, env: { ...env, ADLC_AUTOPILOT_LOCK_TOKEN: 'f'.repeat(64) }, cwd: fx.ctx.repoRoot, deps });
    assert.equal(wrong.exitCode, 1); assert.equal(wrong.document.code, 'lock-not-held', 'a token that is not the on-disk owner is refused');
  } finally { fx.cleanup(); }
}
test('AC60: the pre-strike quota helper bumps the start ordinal under the ORCHESTRATOR\'s lock (its env token verified against the on-disk owner) and is refused with any other token', { timeout: 120_000 }, ac60_helperBumpsTheOrdinalUnderTheOrchestratorLock);

export async function ac60_helperRunsFromTheIssueWorktree() {
  // fleet spawns the helper from INSIDE the issue worktree (a linked worktree): the helper resolves the MAIN worktree as its root.
  const { spawnSync } = await import('node:child_process');
  const { join } = await import('node:path');
  const fx = await createSequenceFixture();
  try {
    const linked = join(fx.ctx.repoRoot, '.worktrees', 'helper-wt');
    const r = spawnSync('git', ['worktree', 'add', '-q', '-b', 'helper-branch', linked], { cwd: fx.ctx.repoRoot, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    fx.ctx.status.resetStarts('it-w');
    const env = { PATH: process.env.PATH, HOME: fx.ctx.env.home, ADLC_AUTOPILOT_LOCK_TOKEN: fx.ctx.lock.token };
    const out = await quotaCommand({ flags: { startOrdinal: 'auto', iteration: 'it-w' }, env, cwd: linked, deps: { quota: { read: async () => OK_USAGE({}) } } });
    assert.equal(out.exitCode, 0, JSON.stringify(out.document));
    assert.equal(out.document.ordinal, 1, 'the helper bumped the MAIN worktree\'s status file from inside the linked worktree');
    assert.equal(fx.ctx.status.read().startsThisIteration, 1);
  } finally { fx.cleanup(); }
}
test('AC60: the pre-strike quota helper works when spawned from INSIDE the issue worktree (a linked worktree): it resolves the main worktree as its root and bumps its ordinal', { timeout: 120_000 }, ac60_helperRunsFromTheIssueWorktree);

export async function ac60_helperUsesTheUsageFallback() {
  // The quota helper never runs phase A: with the endpoint failing, its /usage fallback must still find the pinned claude.
  const fx = await createSequenceFixture({ quotaRead: null, fetchImpl: async () => ({ status: 401 }), claudeAnswer: (args) => (args.includes('/usage') ? { type: 'result', result: 'Your subscription\nCurrent session: 3% used\nCurrent week (all models): 4% used\n' } : { type: 'result', result: '{}' }) });
  try {
    fx.ctx.status.pinTools(fx.ctx.pinned);                                   // what phase A persists
    fx.ctx.status.resetStarts('it-f');
    const env = { PATH: process.env.PATH, HOME: fx.ctx.env.home, ADLC_AUTOPILOT_LOCK_TOKEN: fx.ctx.lock.token };
    const r = await quotaCommand({ flags: { startOrdinal: 'auto', iteration: 'it-f' }, env, cwd: fx.ctx.repoRoot, deps: { fetchImpl: async () => ({ status: 401 }), spawn: fx.ctx.spawn } });
    assert.equal(r.exitCode, 0, JSON.stringify(r.document));
    assert.ok((fx.state.claudeCalls ?? []).some((c) => c.args.includes('/usage')), 'the fallback spawned the pinned claude from the persisted pins');
  } finally { fx.cleanup(); }
}
test('AC60: the quota-only helper carries the pins phase A persisted, so its `/usage` fallback runs when the endpoint is unavailable', { timeout: 120_000 }, ac60_helperUsesTheUsageFallback);
