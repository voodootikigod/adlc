// prosecute-tool.test.mjs — T33: the adlc_prosecute tool definition + execute()
// wiring (diff capture, no-session fallback, structured verdict), plus rails
// recognition of the tool. The loop itself is covered by prosecute-runner.test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
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
  assert.match(def.description, /P5 prosecution/);
  assert.match(def.description, /WRITE-DISABLED/);
  assert.match(def.description, /return findings, they cannot edit\. Returns the confirmed findings for the human gate\./);
  assert.doesNotMatch(def.description, /Prefer this over/i);
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

test('captureDiff refuses an option-like base without running git (no --output= write)', () => {
  for (const base of ['--output=/tmp/x', '-p', ' --stat', '--no-index']) {
    let ran = false;
    const res = captureDiff({ base, spawnImpl: () => { ran = true; return 'diff'; } });
    assert.equal(ran, false, `git must not run for base=${JSON.stringify(base)}`);
    assert.equal(res.diff, '');
    assert.match(res.error, /invalid base ref/);
  }
});

test('captureDiff against the real git binary: an --output= base creates no file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-capdiff-'));
  try {
    const run = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
    run('init', '-q', '-b', 'main');
    run('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
    const target = join(dir, 'leak.txt');
    const res = captureDiff({ base: `--output=${target}`, cwd: dir });
    assert.ok(res.error, 'refused');
    assert.equal(existsSync(target), false, 'git never wrote the output file');
    assert.deepEqual(captureDiff({ base: 'main', cwd: dir }), { diff: '', error: null }, 'a normal ref still works');
  } finally { rmSync(dir, { recursive: true, force: true }); }
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

test('execute: every lens and the verifier run on their agent\'s MODEL (never created as the agent) and report the model that answered', async () => {
  const session = mockSession(bugOrConfirm, lensModel);
  const def = buildProsecuteTool({ root: '/p', pkgRoot: PKG, session, agent: agentDomain(), diffImpl: () => 'diff x' });
  const r = await def.execute({ base: 'main' }, TOOL_CTX);
  for (const c of session.calls.creates) assert.equal('agent' in c, false, 'a child is never created as a repo-controlled agent');
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

test('execute: a lens with no registered agent runs on the CALLING session\'s model, not the host default', async () => {
  const gets = [];
  const session = mockSession(() => fenced([]));
  session.get = async (req) => { gets.push(req); return { id: req.sessionID, model: { providerID: 'anthropic', id: 'claude-b' } }; };
  const def = buildProsecuteTool({ root: '/p', pkgRoot: PKG, session, agent: agentDomain([]), diffImpl: () => 'diff x' });
  await def.execute({ base: 'main' }, { ...TOOL_CTX, sessionID: 'ses_caller' });
  assert.deepEqual(gets, [{ sessionID: 'ses_caller' }]);
  assert.ok(session.calls.creates.length > 0);
  for (const c of session.calls.creates) assert.deepEqual(c.model, { providerID: 'anthropic', id: 'claude-b' });
});

test('execute: an unresolvable calling-session model leaves children on the host default (no crash)', async () => {
  for (const get of [async () => { throw new Error('boom'); }, async () => ({ id: 's' }), () => new Promise(() => {}), undefined]) {
    const session = mockSession(() => fenced([]));
    if (get) session.get = get;
    const def = buildProsecuteTool({ root: '/p', pkgRoot: PKG, session, agent: agentDomain([]), diffImpl: () => 'diff x', sessionLookupTimeoutMs: 20 });
    await def.execute({ base: 'main' }, { ...TOOL_CTX, sessionID: 'ses_caller' });
    for (const c of session.calls.creates) assert.equal('model' in c, false);
  }
});

test('execute: when one lens fails, its in-flight siblings are interrupted, not left running', async () => {
  const session = mockSession(() => fenced([]));
  const interrupted = [];
  session.interrupt = async (req) => { interrupted.push(req.sessionID); };
  let waits = 0;
  session.wait = ({ sessionID }) => {
    waits += 1;
    // the first lens fails fast; every other child would run until its timeout
    return waits === 1 ? Promise.reject(new Error('provider 503')) : new Promise(() => {});
  };
  const def = buildProsecuteTool({ root: '/p', pkgRoot: PKG, session, agent: agentDomain(), diffImpl: () => 'diff x' });
  const r = await def.execute({ base: 'main' }, TOOL_CTX);
  assert.equal(r.metadata.error, 'prosecution-failed');
  assert.ok(waits > 1, 'several lenses were in flight');
  await new Promise((done) => setTimeout(done, 20)); // siblings clean up on their own rejection, just after execute returns
  assert.equal(new Set(interrupted).size, waits, 'every child that was started was interrupted');
});

test('execute: cancelling the tool call stops the prosecution and interrupts the running children', async () => {
  const session = mockSession(() => fenced([]));
  const interrupted = [];
  session.interrupt = async (req) => { interrupted.push(req.sessionID); };
  session.wait = () => new Promise(() => {});
  const parent = new AbortController();
  const def = buildProsecuteTool({ root: '/p', pkgRoot: PKG, session, agent: agentDomain(), diffImpl: () => 'diff x' });
  const running = def.execute({ base: 'main' }, { ...TOOL_CTX, signal: parent.signal });
  await new Promise((r) => setTimeout(r, 30));
  const started = session.calls.creates.length;
  assert.ok(started > 0);
  parent.abort();
  const r = await running;
  assert.equal(r.metadata.error, 'prosecution-failed');
  await new Promise((done) => setTimeout(done, 20));
  assert.equal(interrupted.length, started, 'every running child was interrupted');
  assert.equal(session.calls.creates.length, started, 'no new child was launched after the cancel');
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
