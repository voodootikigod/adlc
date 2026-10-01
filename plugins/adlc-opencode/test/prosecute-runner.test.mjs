// prosecute-runner.test.mjs — T33 AC1/AC2/AC4: the deterministic P5 loop drives
// fan-out → dedupe → verify → loop-until-dry with hard bounds; lens sessions are
// write-disabled; an unparseable verdict fails closed (finding kept).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  runProsecution, lensPermissions, LENS_READ_TOOLS, makeLensAsk,
  parseFindings, parseVerdict, parseFenced,
} from '../lib/prosecute-runner.mjs';
import { LENSES, VERIFIER } from '../lib/prosecutor.mjs';
import { READONLY_TOOLS } from '../rails-checker.mjs';

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
  assert.deepEqual(parseFindings(fenced([finding('a')])), { findings: [finding('a')], parsed: true });
  assert.deepEqual(parseFindings(fenced({ findings: [finding('a')] })), { findings: [finding('a')], parsed: true });
  assert.deepEqual(parseFindings(fenced([])), { findings: [], parsed: true }); // explicit empty array → clean
  assert.deepEqual(parseFindings(''), { findings: [], parsed: false });        // empty reply → fail closed (anomalous)
  assert.deepEqual(parseFindings('garble'), { findings: [], parsed: false });  // garbage → parse FAILURE
  assert.deepEqual(parseVerdict(fenced({ real: false, reason: 'refuted' })), { real: false, reason: 'refuted' });
  assert.equal(parseVerdict('no verdict here'), null);      // unparseable → null (fail-closed upstream)
  assert.equal(parseVerdict(fenced({ nope: 1 })), null);    // missing real → null
});

// ---- AC2: lens sessions provably cannot write (fail-CLOSED allowlist) ----
// OpenCode v2 evaluates permission rules last-match-wins over the agent's rules
// followed by the session's (core `Permission.evaluate`: `findLast`, `*` glob).
const globMatch = (pattern, value) =>
  new RegExp(`^${pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(value);
const effectOf = (action, rules) =>
  rules.findLast((r) => globMatch(r.action, action) && globMatch(r.resource, 'x.mjs'))?.effect ?? 'ask';
// The default `build` agent allows everything — the case the session rules must override.
const ALLOW_ALL_AGENT = [{ action: '*', resource: '*', effect: 'allow' }];

test('AC2: lensPermissions is a wildcard-deny-first ALLOWLIST — unlisted actions fail closed', () => {
  const rules = lensPermissions();
  assert.deepEqual(rules[0], { action: '*', resource: '*', effect: 'deny' }, 'the deny floor comes first');
  assert.deepEqual(new Set(LENS_READ_TOOLS), new Set(READONLY_TOOLS), 'allowlist derives from rails-checker READONLY_TOOLS');
  const effective = [...ALLOW_ALL_AGENT, ...rules];
  for (const t of READONLY_TOOLS) assert.equal(effectOf(t, effective), 'allow', `read-only ${t} allowed`);
  // write (edit/write/patch all request `edit`), shell, sub-agent, MCP, unknown → deny
  for (const t of ['edit', 'shell', 'bash', 'subagent', 'task', 'question', 'skill', 'some_mcp_write_tool', 'a-tool-that-does-not-exist-yet']) {
    assert.equal(effectOf(t, effective), 'deny', `${t} must be denied (fails closed via "*")`);
  }
});

test('AC2: makeLensAsk creates the child with lensPermissions and leads the prompt with the system text', async () => {
  const calls = { create: [], prompt: [] };
  const session = {
    create: async (req) => { calls.create.push(req); return { id: 'ses_lens' }; },
    prompt: async (req) => { calls.prompt.push(req); return { id: 'inb_1' }; },
    wait: async () => {},
    context: async () => [{ type: 'assistant', content: [{ type: 'text', text: 'ok' }] }],
  };
  const ask = makeLensAsk(session, { directory: '/repo' });
  assert.equal(await ask({ system: 'LENS SYSTEM PROMPT', prompt: 'find bugs' }), 'ok');
  assert.deepEqual(calls.create, [{ title: 'adlc-prosecute', permissions: lensPermissions(), location: { directory: '/repo' } }]);
  assert.deepEqual(calls.prompt, [{ sessionID: 'ses_lens', text: 'LENS SYSTEM PROMPT\n\n---\n\nfind bugs' }]);
  await ask({ prompt: 'no system' });
  assert.equal(calls.prompt[1].text, 'no system');
});

test('AC2: makeLensAsk returns null when the session API is incomplete (caller falls back)', () => {
  assert.equal(makeLensAsk({}), null);
  assert.equal(makeLensAsk(undefined), null);
  assert.equal(makeLensAsk({ create: () => {}, prompt: () => {} }), null); // no wait/context
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

// ---- codex round-1 fail-open fixes ----
test('FAIL-CLOSED: an ALL-GARBAGE round does NOT masquerade as dry/SHIP', async () => {
  // every lens returns unparseable prose; verifier confirms nothing real exists
  const ask = async ({ agent }) => (agent === VERIFIER.agent ? 'no json' : 'the model rambled, no JSON here');
  const r = await runProsecution({ ask, diff: 'DIFF', bounds: { maxRounds: 2 } });
  // each unparseable lens surfaces a synthetic blocker → confirmed is non-empty
  assert.ok(r.confirmed.length > 0, 'unparseable lenses surfaced blockers, not a false clear');
  assert.ok(r.confirmed.every((f) => f._unparsed) , 'the blockers are parse-failure markers');
  assert.ok(r.unverified.length > 0, 'kept as unverified');
});

test('a clean empty lens reply is NOT a parse failure (real dry round SHIPs)', async () => {
  const ask = async ({ agent }) => (agent === VERIFIER.agent ? fenced({ real: true }) : fenced([]));
  const r = await runProsecution({ ask, diff: 'DIFF', bounds: { maxRounds: 3 } });
  assert.deepEqual(r.confirmed, [], 'genuinely no findings → clean');
  assert.equal(r.hitBound, null, 'converged');
});
