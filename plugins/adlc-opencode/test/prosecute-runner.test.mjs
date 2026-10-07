// prosecute-runner.test.mjs — T33 AC1/AC2/AC4: the deterministic P5 loop drives
// fan-out → dedupe → verify → loop-until-dry with hard bounds; lens sessions are
// write-disabled; an unparseable verdict fails closed (finding kept).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  runProsecution, lensPermissions, LENS_READ_TOOLS, makeLensAsk,
  parseFindings, parseVerdict, parseFenced, listRegisteredAgents, replyModel, AGENT_LIST_TIMEOUT_MS,
} from '../lib/prosecute-runner.mjs';
import { LENSES, VERIFIER, ALL_AGENTS } from '../lib/prosecutor.mjs';
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

// ---- per-lens models: a registered lens runs AS its agent, ON its configured model ----
// `ctx.agent.list` resolves v2 `AgentListOutput` ({ location, data: AgentInfo[] });
// a child's reply is the v2 `SessionMessageAssistant` carrying `model`.
// `agentModel(id)` is the model each listed agent configures (null = none).
const agentModelOf = (id) => ({ providerID: 'vercel', id: `vmc/adlc-${id}` });
function lensHost(replyImpl, { agents = ALL_AGENTS, listing, agentModel = agentModelOf } = {}) {
  const calls = { creates: [], prompts: [], listings: 0 };
  const replies = new Map();
  const session = {
    create: async (req) => { calls.creates.push(req); return { id: `ses_child_${calls.creates.length}` }; },
    prompt: async (req) => { calls.prompts.push(req); replies.set(req.sessionID, await replyImpl(req)); return { id: `inb_${calls.prompts.length}` }; },
    wait: async () => {},
    context: async ({ sessionID }) => [replies.get(sessionID)],
  };
  const agentApi = {
    list: listing ?? (async () => {
      calls.listings += 1;
      return { location: { directory: '/repo' }, data: agents.map((id) => ({ id, name: id, mode: 'subagent', hidden: false, permissions: [], ...(agentModel(id) ? { model: agentModel(id) } : {}) })) };
    }),
  };
  return { calls, session, agentApi };
}
const reply = (text, model) => ({ id: 'msg_a', type: 'assistant', agent: 'x', ...(model ? { model } : {}), content: [{ type: 'text', text }] });

test('per-lens model: a registered agent creates the child AS that agent ON its model, charter still leads the prompt, still write-disabled', async () => {
  const host = lensHost(() => reply('ok'));
  const ask = makeLensAsk(host.session, { agentApi: host.agentApi, directory: '/repo' });
  const text = await ask({ agent: 'prosecutor-security', system: 'LENS SYSTEM PROMPT', prompt: 'find bugs' });
  assert.equal(text, 'ok');
  const created = host.calls.creates[0];
  assert.equal(created.agent, 'prosecutor-security');
  // OpenCode 2.x does not apply an agent's model to a plugin-created session
  // (live-verified), so the agent's configured model must be passed explicitly.
  assert.deepEqual(created.model, { providerID: 'vercel', id: 'vmc/adlc-prosecutor-security' }, "the agent's own model is passed");
  assert.deepEqual(created.permissions, lensPermissions(), 'the read-only allowlist still applies');
  assert.equal(host.calls.prompts[0].text, 'LENS SYSTEM PROMPT\n\n---\n\nfind bugs', 'the authoritative packaged charter is preserved');
});

test('per-lens model: an agent with no configured model is named but adds no model (session model applies)', async () => {
  const host = lensHost(() => reply('ok'), { agentModel: () => null });
  const ask = makeLensAsk(host.session, { agentApi: host.agentApi });
  await ask({ agent: 'prosecutor-security', system: 'S', prompt: 'x' });
  assert.equal(host.calls.creates[0].agent, 'prosecutor-security');
  assert.equal('model' in host.calls.creates[0], false);
});

test("per-lens model: the agent's model overrides a factory model, and a variant is kept", async () => {
  const host = lensHost(() => reply('ok'), { agentModel: (id) => ({ providerID: 'p', id: `m-${id}`, variant: 'high' }) });
  const ask = makeLensAsk(host.session, { agentApi: host.agentApi, model: { providerID: 'p', id: 'session-default' } });
  await ask({ agent: 'prosecutor-tests', system: 'S', prompt: 'x' });
  await ask({ agent: 'not-listed', system: 'S', prompt: 'x' });
  assert.deepEqual(host.calls.creates[0].model, { providerID: 'p', id: 'm-prosecutor-tests', variant: 'high' });
  assert.deepEqual(host.calls.creates[1].model, { providerID: 'p', id: 'session-default' }, 'an unlisted agent keeps the factory model');
});

test('per-lens model: onResolved reports the model that answered and that the agent config was used', async () => {
  const seen = [];
  const host = lensHost(() => reply('ok', { providerID: 'vercel', id: 'vmc/adlc-prosecutor-security' }));
  const ask = makeLensAsk(host.session, { agentApi: host.agentApi, onResolved: (r) => seen.push(r) });
  await ask({ agent: 'prosecutor-security', system: 'S', prompt: 'x' });
  assert.deepEqual(seen, [{ agent: 'prosecutor-security', model: 'vercel/vmc/adlc-prosecutor-security', agentModel: true, agentsListed: true }]);
});

test('per-lens model: an UNREGISTERED agent is never named; it runs once on the session model with the charter', async () => {
  const seen = [];
  const host = lensHost(() => reply('ok', { providerID: 'anthropic', id: 'claude-opus-5' }), { agents: ['build', 'plan'] });
  const ask = makeLensAsk(host.session, { agentApi: host.agentApi, onResolved: (r) => seen.push(r) });
  assert.equal(await ask({ agent: 'prosecutor-security', system: 'LENS SYSTEM PROMPT', prompt: 'x' }), 'ok');
  assert.equal(host.calls.creates.length, 1, 'one child session, no probe-and-retry');
  assert.equal('agent' in host.calls.creates[0], false, 'an unknown agent is not named');
  assert.match(host.calls.prompts[0].text, /^LENS SYSTEM PROMPT/);
  assert.deepEqual(host.calls.creates[0].permissions, lensPermissions(), 'still write-disabled');
  assert.deepEqual(seen, [{ agent: 'prosecutor-security', model: 'anthropic/claude-opus-5', agentModel: false, agentsListed: true }]);
});

test('per-lens model: a host that cannot list agents keeps the session-model behavior and says so (agentsListed:false)', async () => {
  for (const host of [
    lensHost(() => reply('ok'), { listing: async () => { throw new Error('404'); } }),
    lensHost(() => reply('ok'), { listing: async () => ({ error: { name: 'UnknownError' } }) }),
    { ...lensHost(() => reply('ok')), agentApi: undefined },
  ]) {
    const seen = [];
    const ask = makeLensAsk(host.session, { agentApi: host.agentApi, onResolved: (r) => seen.push(r) });
    await ask({ agent: 'prosecutor-security', system: 'S', prompt: 'x' });
    assert.equal('agent' in host.calls.creates[0], false);
    assert.match(host.calls.prompts[0].text, /^S\n/);
    assert.equal(seen[0].agentsListed, false, 'the fallback is attributed to the listing, not to a missing agent');
    assert.equal(seen[0].agentModel, false);
  }
});

test('per-lens model: a HUNG agent listing is bounded — the lens still runs, on the session model', async () => {
  const seen = [];
  const host = lensHost(() => reply('ok'), { listing: () => new Promise(() => {}) });
  const ask = makeLensAsk(host.session, { agentApi: host.agentApi, agentListTimeoutMs: 20, onResolved: (r) => seen.push(r) });
  const started = Date.now();
  assert.equal(await ask({ agent: 'prosecutor-security', system: 'S', prompt: 'x' }), 'ok');
  assert.ok(Date.now() - started < 2_000, 'did not wait on the hung listing');
  assert.equal('agent' in host.calls.creates[0], false);
  assert.equal(seen[0].agentsListed, false);
});

test('per-lens model: the registered set is listed ONCE per ask, even across concurrent lenses', async () => {
  const host = lensHost(() => reply('ok'));
  const ask = makeLensAsk(host.session, { agentApi: host.agentApi });
  await Promise.all(ALL_AGENTS.map((agent) => ask({ agent, system: 'S', prompt: 'x' })));
  assert.equal(host.calls.listings, 1);
  assert.deepEqual(host.calls.creates.map((c) => c.agent).sort(), [...ALL_AGENTS].sort());
});

test('per-lens model: a failing lens model is NOT retried on the session model (no silent family switch)', async () => {
  const host = lensHost(() => { throw new Error('provider vercel: 503 model unavailable'); });
  const ask = makeLensAsk(host.session, { agentApi: host.agentApi });
  await assert.rejects(() => ask({ agent: 'prosecutor-security', system: 'S', prompt: 'x' }), /503/);
  assert.equal(host.calls.creates.length, 1, 'no retry');
  assert.equal(host.calls.prompts.length, 1, 'no retry');
});

test('listRegisteredAgents / replyModel read the opencode v2 shapes', async () => {
  const list = (data) => ({ list: async () => ({ location: { directory: '/r' }, data }) });
  assert.deepEqual(
    await listRegisteredAgents(list([{ id: 'a', name: 'A', model: { providerID: 'p', id: 'm' } }, { id: 'b', name: 'B' }, { id: 'c', model: { providerID: 'p' } }, {}])),
    new Map([['a', { providerID: 'p', id: 'm' }], ['b', null], ['c', null]]),
    'keyed by id (not display name), each with its configured model; a half-known model is none');
  assert.equal(await listRegisteredAgents({}), null);
  assert.equal(await listRegisteredAgents(undefined), null);
  assert.equal(await listRegisteredAgents(list('nope')), null);
  assert.equal(await listRegisteredAgents({ list: () => new Promise(() => {}) }, { timeoutMs: 10 }), null, 'hung listing → null');
  const asked = [];
  await listRegisteredAgents({ list: async (input) => { asked.push(input); return { data: [] }; } }, { directory: '/repo' });
  assert.deepEqual(asked, [{ location: { directory: '/repo' } }], 'listed for the project directory');
  assert.equal(AGENT_LIST_TIMEOUT_MS, 5_000);
  assert.equal(replyModel([reply('x', { providerID: 'vercel', id: 'vmc/a' })]), 'vercel/vmc/a');
  assert.equal(replyModel([reply('old', { providerID: 'p', id: 'old' }), { type: 'user' }, reply('new', { providerID: 'p', id: 'new' })]), 'p/new', 'the last assistant answered');
  assert.equal(replyModel([reply('x')]), null);
  assert.equal(replyModel([]), null);
  assert.equal(replyModel(undefined), null);
  assert.equal(replyModel([reply('x', { providerID: 'vercel' })]), null, 'a half-known model is not reported');
  assert.equal(replyModel([reply('x', { id: 'vmc/a' })]), null);
});

test('runProsecution names every lens and the verifier as its own agent (so each gets its own model)', async () => {
  const calls = [];
  const ask = scriptedAsk({ byAgent: { [LENSES[0].agent]: [finding('b')] }, calls });
  await runProsecution({ ask, diff: 'DIFF' });
  const agents = new Set(calls.map((c) => c.agent));
  for (const a of [...LENSES.map((l) => l.agent), VERIFIER.agent]) assert.ok(agents.has(a), `${a} asked by name`);
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
