// prosecute-runner.test.mjs — T33 AC1/AC2/AC4: the deterministic P5 loop drives
// fan-out → dedupe → verify → loop-until-dry with hard bounds; lens sessions are
// write-disabled; an unparseable verdict fails closed (finding kept).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  runProsecution, lensToolsMap, WRITE_TOOLS, makeLensAsk,
  parseFindings, parseVerdict, parseFenced,
} from '../lib/prosecute-runner.mjs';
import { LENSES, VERIFIER } from '../lib/prosecutor.mjs';

const fenced = (obj) => '```json\n' + JSON.stringify(obj) + '\n```';
const finding = (title, severity = 'high') => ({ title, severity, file: 'x.mjs', detail: 'd' });

// A scripted ask: lens agents return findings from `byAgent`, the verifier
// returns a vote from `verdict`. Records every call for assertions.
function scriptedAsk({ byAgent = {}, verdict = { real: true }, calls = [] } = {}) {
  return async ({ agent, prompt }) => {
    calls.push({ agent, prompt });
    if (agent === VERIFIER.agent) return typeof verdict === 'function' ? verdict(prompt) : fenced(verdict);
    const fs = byAgent[agent] ?? [];
    return fenced(fs);
  };
}

// ---- parsing ----
test('parseFenced/parseFindings/parseVerdict extract fenced JSON; fail closed on garbage', () => {
  assert.deepEqual(parseFenced('```json\n{"a":1}\n```'), { a: 1 });
  assert.equal(parseFenced('not json at all'), null);
  assert.deepEqual(parseFindings(fenced([finding('a')])), [finding('a')]);
  assert.deepEqual(parseFindings(fenced({ findings: [finding('a')] })), [finding('a')]);
  assert.deepEqual(parseFindings('garble'), []);
  assert.deepEqual(parseVerdict(fenced({ real: false, reason: 'refuted' })), { real: false, reason: 'refuted' });
  assert.equal(parseVerdict('no verdict here'), null);      // unparseable → null (fail-closed upstream)
  assert.equal(parseVerdict(fenced({ nope: 1 })), null);    // missing real → null
});

// ---- AC2: lens sessions provably cannot write ----
test('AC2: lensToolsMap disables EVERY mutating + shell tool (false map, not allowlist)', () => {
  const map = lensToolsMap();
  for (const t of WRITE_TOOLS) assert.equal(map[t], false, `${t} disabled`);
  for (const t of ['edit', 'write', 'patch', 'multiedit', 'apply_patch', 'bash', 'shell']) {
    assert.equal(map[t], false, `${t} explicitly disabled`);
  }
});

test('AC2: makeLensAsk passes the disable-map AND the system override to session.prompt', async () => {
  const promptCalls = [];
  const client = {
    session: {
      create: async () => ({ data: { id: 'child' } }),
      prompt: async (req) => { promptCalls.push(req); return { data: { parts: [{ type: 'text', text: 'ok' }] } }; },
      delete: async () => ({ data: true }),
    },
  };
  const ask = makeLensAsk(client, { parentID: 'parent' });
  await ask({ system: 'LENS SYSTEM PROMPT', prompt: 'find bugs' });
  const body = promptCalls[0].body;
  assert.equal(body.system, 'LENS SYSTEM PROMPT');
  for (const t of WRITE_TOOLS) assert.equal(body.tools[t], false, `${t} disabled in the real call`);
  assert.deepEqual(body.parts, [{ type: 'text', text: 'find bugs' }]);
});

test('AC2: makeLensAsk returns null when the client lacks the session API (caller falls back)', () => {
  assert.equal(makeLensAsk({}), null);
  assert.equal(makeLensAsk({ session: { create: () => {} } }), null); // no prompt
});

// ---- AC1: the loop ----
test('AC1: fan-out over all lenses, dedupe identical findings across lenses, confirm via verifier', async () => {
  const calls = [];
  // two different lenses surface the SAME finding → must dedupe to one confirmed
  const ask = scriptedAsk({
    byAgent: {
      [LENSES[0].agent]: [finding('shared-bug')],
      [LENSES[1].agent]: [finding('shared-bug')],
      [LENSES[2].agent]: [finding('unique-bug')],
    },
    verdict: { real: true },
    calls,
  });
  const r = await runProsecution({ ask, diff: 'DIFF' });
  const titles = r.confirmed.map((f) => f.title).sort();
  assert.deepEqual(titles, ['shared-bug', 'unique-bug']);
  // every lens was asked in round 1
  const lensAgents = new Set(calls.filter((c) => c.agent !== VERIFIER.agent).map((c) => c.agent));
  for (const l of LENSES) assert.ok(lensAgents.has(l.agent), `${l.agent} fanned out`);
  assert.equal(r.hitBound, null, 'converged, not bounded');
});

test('AC1: a finding surfaced by multiple lenses is VERIFIED ONCE (round dedupe saves the session budget)', async () => {
  // Every lens surfaces the SAME finding. Round-level dedupe must collapse them
  // BEFORE verification, so the verifier runs once — not once per lens. Without
  // the round dedupe, the verifier would be called LENSES.length times, wasting
  // the maxSessions budget on the same finding (the round-dedupe's real job).
  const calls = [];
  const ask = scriptedAsk({
    byAgent: Object.fromEntries(LENSES.map((l) => [l.agent, [finding('one-shared-bug')]])),
    verdict: { real: true },
    calls,
  });
  const r = await runProsecution({ ask, diff: 'DIFF' });
  const verifierCalls = calls.filter((c) => c.agent === VERIFIER.agent).length;
  assert.equal(verifierCalls, 1, `verifier ran ${verifierCalls}x for one deduped finding (should be 1)`);
  assert.equal(r.confirmed.length, 1);
});

test('AC1: a refuted finding (verifier real:false, majority) is DROPPED', async () => {
  const ask = scriptedAsk({
    byAgent: { [LENSES[0].agent]: [finding('doomed')] },
    verdict: { real: false },
  });
  const r = await runProsecution({ ask, diff: 'DIFF' });
  assert.deepEqual(r.confirmed, [], 'refuted finding dropped');
});

test('AC1: loop-until-dry — terminates after 2 consecutive dry rounds, not maxRounds', async () => {
  let round = 0;
  // round 1 surfaces a finding; rounds 2+ surface nothing → 2 dry rounds → stop
  const ask = async ({ agent }) => {
    if (agent === VERIFIER.agent) return fenced({ real: true });
    // only the first lens, only the first time it's asked, yields a finding
    round += 1;
    return fenced(round <= 1 ? [finding('once')] : []);
  };
  const r = await runProsecution({ ask, diff: 'DIFF', bounds: { maxRounds: 10, maxDry: 2 } });
  assert.equal(r.hitBound, null, 'stopped by convergence, not the round bound');
  assert.ok(r.rounds >= 2 && r.rounds < 10, `stopped early at round ${r.rounds}`);
  assert.equal(r.confirmed.length, 1);
});

test('AC1: hard bound — maxSessions stops the loop and is reported', async () => {
  const ask = scriptedAsk({ byAgent: Object.fromEntries(LENSES.map((l) => [l.agent, [finding(`f-${l.key}`)]])), verdict: { real: true } });
  const r = await runProsecution({ ask, diff: 'DIFF', bounds: { maxSessions: 2, maxRounds: 10 } });
  assert.equal(r.hitBound, 'maxSessions');
  assert.ok(r.sessionsUsed <= 2 + 1, 'stopped near the session cap');
});

test('AC1: hard bound — maxRounds stops a never-converging loop', async () => {
  // every round keeps producing a NEW finding → never dry
  let n = 0;
  const ask = async ({ agent }) => {
    if (agent === VERIFIER.agent) return fenced({ real: true });
    n += 1;
    return fenced([finding(`ever-new-${n}`)]);
  };
  const r = await runProsecution({ ask, diff: 'DIFF', bounds: { maxRounds: 3, maxSessions: 999 } });
  assert.equal(r.hitBound, 'maxRounds');
  assert.equal(r.rounds, 3);
});

// ---- AC4: unparseable verdict fails closed ----
test('AC4: an unparseable verdict → finding KEPT (fail-closed) and marked unverified, never dropped', async () => {
  const ask = scriptedAsk({
    byAgent: { [LENSES[0].agent]: [finding('unsure')] },
    verdict: 'the model rambled and produced no json verdict',
  });
  const r = await runProsecution({ ask, diff: 'DIFF' });
  assert.equal(r.confirmed.length, 1, 'kept as a blocker');
  assert.equal(r.unverified.length, 1, 'flagged unverified');
  assert.equal(r.unverified[0].title, 'unsure');
});

test('runProsecution requires an ask function', async () => {
  await assert.rejects(() => runProsecution({ diff: 'x' }), /ask\(\) function is required/);
});
