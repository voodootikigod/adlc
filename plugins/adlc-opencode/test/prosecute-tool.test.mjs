// prosecute-tool.test.mjs — T33: the adlc_prosecute tool definition + execute()
// wiring (diff capture, no-session fallback, structured verdict), plus rails
// recognition of the tool. The loop itself is covered by prosecute-runner.test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildProsecuteTool, captureDiff, makeAgentPromptReader, makeModelLedger } from '../lib/prosecute-tool.mjs';
import { ALL_AGENTS } from '../lib/prosecutor.mjs';
import { checkToolCall } from '../rails-checker.mjs';
import { lensPermissions } from '../lib/prosecute-runner.mjs';
import { VERIFIER } from '../lib/prosecutor.mjs';

const PKG = dirname(dirname(fileURLToPath(import.meta.url)));
const fenced = (obj) => '```json\n' + JSON.stringify(obj) + '\n```';
const TOOL_CTX = { sessionID: 'ses_parent', agent: 'build', messageID: 'msg_1', id: 'call_1' };
const VERIFIER_PROMPT = makeAgentPromptReader(PKG)(VERIFIER.agent);

// a v2 `ctx.session` whose child replies are scripted from the prompt text.
// Like OpenCode 2.x, a child answers on the model it was CREATED with
// (`create.model`), else on the session model `model(create)` (v2
// `SessionMessageAssistant.model`) — naming an agent alone does not pick its model.
function mockSession(reply, model) {
  const calls = { creates: [], prompts: [] };
  const created = new Map();
  const pending = new Map();
  let n = 0;
  return {
    calls,
    create: async (req) => { calls.creates.push(req); const id = `ses_child_${++n}`; created.set(id, req); return { id }; },
    prompt: async (req) => { calls.prompts.push(req); pending.set(req.sessionID, reply(req.text)); return { id: 'inb' }; },
    wait: async () => {},
    context: async ({ sessionID }) => {
      const req = created.get(sessionID);
      const m = req?.model ?? model?.(req);
      return [{ type: 'assistant', agent: 'x', ...(m ? { model: m } : {}), content: [{ type: 'text', text: pending.get(sessionID) }] }];
    },
  };
}
const isVerifier = (text) => VERIFIER_PROMPT.length > 0 && text.startsWith(VERIFIER_PROMPT);

test('buildProsecuteTool shapes an adlc_prosecute v2 Tool.Info with an optional base input', () => {
  const def = buildProsecuteTool({ root: '/p', pkgRoot: PKG });
  assert.equal(def.name, 'adlc_prosecute');
  assert.match(def.description, /P5 prosecution|WRITE-DISABLED/);
  assert.deepEqual(def.input, {
    type: 'object',
    properties: { base: { type: 'string', description: def.input.properties.base.description } },
    additionalProperties: false,
  });
  assert.equal(typeof def.execute, 'function');
});

test('execute: no session API → structured "use the prose protocol" fallback (not silent)', async () => {
  const def = buildProsecuteTool({ root: '/p', pkgRoot: PKG }); // no session
  const r = await def.execute({}, TOOL_CTX);
  assert.equal(r.metadata.error, 'no-session-api');
  assert.equal(r.metadata.deterministic, false);
  assert.match(r.content, /\/adlc-prosecute/);
});

test('execute: empty diff → reports nothing to prosecute (does not spawn lenses)', async () => {
  const session = mockSession(() => fenced([]));
  const diffCalls = [];
  const def = buildProsecuteTool({ root: '/p', pkgRoot: PKG, session, diffImpl: (o) => { diffCalls.push(o); return ''; } });
  const r = await def.execute({ base: 'main' }, TOOL_CTX);
  assert.equal(r.metadata.confirmed, 0);
  assert.match(r.content, /no changes to prosecute/);
  assert.equal(session.calls.prompts.length, 0, 'no lens sessions spawned');
  assert.deepEqual(diffCalls, [{ base: 'main', cwd: '/p' }], 'the diff is taken in the plugin root');
});

test('execute: a real diff drives the deterministic loop and returns a structured verdict', async () => {
  // lenses find a bug; verifier confirms it
  const session = mockSession((text) => {
    if (isVerifier(text)) return fenced({ real: true, reason: 'reproduced' });
    return fenced([{ title: 'planted-bug', severity: 'high', file: 'x.mjs' }]);
  });
  const def = buildProsecuteTool({ root: '/p', pkgRoot: PKG, session, diffImpl: () => 'diff --git a/x b/x' });
  const r = await def.execute({ base: 'main' }, TOOL_CTX);
  assert.equal(r.metadata.deterministic, true);
  assert.equal(r.metadata.confirmed, 1);
  assert.match(r.metadata.verdict, /NO-SHIP/);
  assert.match(r.content, /planted-bug/);
  // the child sessions were fail-CLOSED (AC2, end-to-end through the tool):
  // every one was created with the read-only lens permissions.
  assert.ok(session.calls.creates.length > 1, 'lenses and verifier ran');
  for (const c of session.calls.creates) assert.deepEqual(c.permissions, lensPermissions());
});

test('captureDiff distinguishes a git FAILURE from a clean empty tree', () => {
  assert.deepEqual(captureDiff({ spawnImpl: () => { throw new Error('not a git repo'); } }), { diff: '', error: 'not a git repo' });
  assert.deepEqual(captureDiff({ spawnImpl: () => '' }), { diff: '', error: null }); // clean tree
  assert.deepEqual(captureDiff({ spawnImpl: () => 'diff...' }), { diff: 'diff...', error: null });
});

test('execute: a git-capture FAILURE fails CLOSED (NO-SHIP), not a false empty-diff SHIP', async () => {
  const session = mockSession(() => fenced([]));
  const def = buildProsecuteTool({
    root: '/p', pkgRoot: PKG, session,
    diffImpl: () => ({ diff: '', error: 'fatal: bad revision main...HEAD' }),
  });
  const r = await def.execute({ base: 'main' }, TOOL_CTX);
  assert.equal(r.metadata.error, 'diff-capture-failed');
  assert.match(r.metadata.verdict, /NO-SHIP/);
  assert.equal(session.calls.prompts.length, 0, 'did not run lenses on a broken diff');
});

test('execute: a bounded/incomplete run with zero findings is NO-SHIP (INCOMPLETE), never a false SHIP', async () => {
  // never converges → hits maxRounds; still zero confirmed → must NOT SHIP
  let n = 0;
  const session = mockSession((text) => {
    if (isVerifier(text)) return fenced({ real: false }); // everything refuted → zero confirmed
    n += 1;
    return fenced([{ title: `ephemeral-${n}`, severity: 'low', file: 'x' }]); // new finding every round → never dry
  });
  const def = buildProsecuteTool({ root: '/p', pkgRoot: PKG, session, diffImpl: () => 'diff x' });
  const r = await def.execute({ base: 'main' }, TOOL_CTX);
  assert.equal(r.metadata.confirmed, 0);
  assert.ok(r.metadata.hitBound, 'the run hit a bound');
  assert.match(r.metadata.verdict, /NO-SHIP.*INCOMPLETE/);
});

// ---- per-lens models ----
// `ctx.agent` as v2 exposes it: list() → AgentListOutput { location, data: AgentInfo[] }.
// Each listed agent configures its own model, `vercel/vmc/adlc-<id>`.
const agentDomain = (ids = ALL_AGENTS) => ({
  list: async () => ({ location: { directory: '/p' }, data: ids.map((id) => ({ id, name: id, mode: 'subagent', hidden: false, permissions: [], model: { providerID: 'vercel', id: `vmc/adlc-${id}` } })) }),
});
// The session model a child falls back to when created without one.
const lensModel = () => ({ providerID: 'vercel', id: 'vmc/adlc-session' });
const bugOrConfirm = (text) => (isVerifier(text) ? fenced({ real: true }) : fenced([{ title: 'bug', severity: 'high', file: 'x' }]));

test('execute: every lens and the verifier run AS their agent and report the model that answered', async () => {
  const session = mockSession(bugOrConfirm, lensModel);
  const def = buildProsecuteTool({ root: '/p', pkgRoot: PKG, session, agent: agentDomain(), diffImpl: () => 'diff x' });
  const r = await def.execute({ base: 'main' }, TOOL_CTX);
  const named = new Set(session.calls.creates.map((c) => c.agent));
  for (const a of ALL_AGENTS) assert.ok(named.has(a), `${a} created as its own agent`);
  for (const c of session.calls.creates) assert.deepEqual(c.permissions, lensPermissions(), 'every child still write-disabled');
  for (const p of session.calls.prompts) assert.ok(p.text.indexOf('\n\n---\n\n') > 0, 'authoritative charter always leads the prompt');
  for (const a of ALL_AGENTS) assert.deepEqual(r.metadata.models[a], [`vercel/vmc/adlc-${a}`]);
  assert.deepEqual(r.metadata.unregisteredAgents, []);
  assert.equal(r.metadata.agentListUnavailable, false);
  assert.equal(r.metadata.singleModel, false);
  assert.match(r.content, /Reviewer models:/);
  assert.match(r.content, /prosecutor-security: vercel\/vmc\/adlc-prosecutor-security/);
  assert.doesNotMatch(r.content, /single-model review/);
});

test('execute: reviewers that all answer on one model are labelled single-model, not cross-model', async () => {
  const session = mockSession(() => fenced([]), () => ({ providerID: 'anthropic', id: 'claude-opus-5' }));
  const def = buildProsecuteTool({ root: '/p', pkgRoot: PKG, session, agent: { list: async () => ({ data: ALL_AGENTS.map((id) => ({ id, name: id })) }) }, diffImpl: () => 'diff x' });
  const r = await def.execute({ base: 'main' }, TOOL_CTX);
  assert.equal(r.metadata.singleModel, true);
  assert.match(r.content, /fresh-context, single-model review \(not cross-model\)/);
});

test('execute: an unregistered lens agent runs on the session model and is surfaced, not hidden', async () => {
  const session = mockSession(() => fenced([]), lensModel);
  const agent = agentDomain(ALL_AGENTS.filter((a) => a !== 'prosecutor-tests'));
  const def = buildProsecuteTool({ root: '/p', pkgRoot: PKG, session, agent, diffImpl: () => 'diff x' });
  const r = await def.execute({ base: 'main' }, TOOL_CTX);
  assert.deepEqual(r.metadata.unregisteredAgents, ['prosecutor-tests']);
  assert.equal(r.metadata.agentListUnavailable, false);
  assert.deepEqual(r.metadata.models['prosecutor-tests'], ['vercel/vmc/adlc-session']);
  assert.match(r.content, /prosecutor-tests: vercel\/vmc\/adlc-session \(session model: agent not registered\)/);
  assert.doesNotMatch(r.content, /prosecutor-security: .*agent not registered/, 'only the missing agent is flagged');
  assert.doesNotMatch(r.content, /Could not list OpenCode agents/);
});

test('execute: a host that cannot list agents is reported as such — not blamed on missing agents', async () => {
  const session = mockSession(() => fenced([]), lensModel);
  const agent = { list: async () => { throw new Error('GET /agent 500'); } };
  const def = buildProsecuteTool({ root: '/p', pkgRoot: PKG, session, agent, diffImpl: () => 'diff x' });
  const r = await def.execute({ base: 'main' }, TOOL_CTX);
  assert.equal(r.metadata.agentListUnavailable, true);
  assert.deepEqual(r.metadata.unregisteredAgents, []);
  assert.match(r.content, /Could not list OpenCode agents, so every reviewer ran on the session model/);
  assert.doesNotMatch(r.content, /agent not registered/);
  for (const c of session.calls.creates) assert.equal('agent' in c, false, 'no agent named without a listing');
});

test('makeModelLedger: single-model needs every reviewer on one KNOWN, identical model; one reviewer is never "single-model"', () => {
  const unknownOnly = makeModelLedger();
  unknownOnly.record({ agent: 'a', model: null, agentModel: true });
  unknownOnly.record({ agent: 'b', model: null, agentModel: true });
  assert.equal(unknownOnly.summary().singleModel, false);
  assert.deepEqual(unknownOnly.summary().models, { a: ['unknown'], b: ['unknown'] });
  const mixed = makeModelLedger();
  for (const agent of ['a', 'b', 'c']) mixed.record({ agent, model: 'anthropic/claude-opus-5', agentModel: true });
  for (const agent of ['d', 'e', 'f']) mixed.record({ agent, model: null, agentModel: true });
  assert.equal(mixed.summary().singleModel, false, 'unknown reviewers are not proof of one model');
  const drifted = makeModelLedger();
  drifted.record({ agent: 'a', model: 'x/y', agentModel: true });
  drifted.record({ agent: 'a', model: 'x/z', agentModel: true });
  drifted.record({ agent: 'b', model: 'x/y', agentModel: true });
  assert.equal(drifted.summary().singleModel, false, 'a reviewer that answered on two models is not single-model');
  const same = makeModelLedger();
  same.record({ agent: 'a', model: 'x/y', agentModel: true });
  same.record({ agent: 'b', model: 'x/y', agentModel: true });
  assert.equal(same.summary().singleModel, true);
  assert.equal(same.summary().agentListUnavailable, false, 'a record without agentsListed means the listing worked');
  const unlisted = makeModelLedger();
  unlisted.record({ agent: 'a', model: 'x/y', agentModel: false, agentsListed: false });
  assert.equal(unlisted.summary().agentListUnavailable, true);
  assert.deepEqual(unlisted.summary().unregisteredAgents, [], 'a listing failure is not blamed on the agent');
  const one = makeModelLedger();
  one.record({ agent: 'a', model: 'x/y', agentModel: true });
  assert.equal(one.summary().singleModel, false);
});

test('makeAgentPromptReader reads the packaged agent prompt; "" for an unknown agent', () => {
  const read = makeAgentPromptReader(PKG);
  assert.ok(read('prosecutor-correctness').length > 0, 'real lens prompt loads');
  assert.equal(read('nope-not-an-agent'), '');
});

test('execute: a failing lens model fails CLOSED (NO-SHIP), not an uncaught throw', async () => {
  const session = mockSession(() => { throw new Error('503 model unavailable'); });
  const def = buildProsecuteTool({ root: '/p', pkgRoot: PKG, session, agent: agentDomain(), diffImpl: () => 'diff x' });
  const r = await def.execute({ base: 'main' }, TOOL_CTX);
  assert.equal(r.metadata.verdict, 'NO-SHIP (prosecution-failed)');
  assert.equal(r.metadata.error, 'prosecution-failed');
  assert.match(r.content, /Prosecution stopped with an error.*503/);
});

// ---- rails: the plugin's own adlc_prosecute tool must not be denied ----
test('adlc_prosecute is NOT denied by the rail guard under active enforcement', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-pros-'));
  mkdirSync(join(dir, '.adlc'), { recursive: true });
  writeFileSync(join(dir, '.adlc', 'tickets.json'), JSON.stringify({ tickets: [{ id: 'T1', rails: ['test/**'] }] }));
  try {
    const r = checkToolCall({ tool: 'adlc_prosecute', args: { base: 'main' }, root: dir, env: { ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: 'T1' } });
    assert.equal(r.decision, 'allow');
    // and an edit to the frozen rail IS still denied (guard is live)
    const denied = checkToolCall({ tool: 'edit', args: { filePath: 'test/x.mjs' }, root: dir, env: { ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: 'T1' } });
    assert.equal(denied.decision, 'deny');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
