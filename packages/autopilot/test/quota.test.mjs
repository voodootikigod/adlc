// AC 2 / 23 / 27 / 47 / 65 / 87 — the quota gate's pure core: the matrix, the
// strict endpoint schema, the fallback grammar, family normalization, the
// reserve ordinal and overshoot bookkeeping. The loop-level re-check points
// (AC 18/39/50/158) live with the loop suites.

import { test } from 'node:test';
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
