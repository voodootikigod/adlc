// prosecute-tool.test.mjs — T33: the adlc_prosecute tool definition + execute()
// wiring (diff capture, no-session fallback, structured verdict), plus rails
// recognition of the tool. The loop itself is covered by prosecute-runner.test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildProsecuteTool, captureDiff, makeAgentPromptReader } from '../lib/prosecute-tool.mjs';
import { checkToolCall } from '../rails-checker.mjs';
import { lensPermissions } from '../lib/prosecute-runner.mjs';
import { VERIFIER } from '../lib/prosecutor.mjs';

const PKG = dirname(dirname(fileURLToPath(import.meta.url)));
const fenced = (obj) => '```json\n' + JSON.stringify(obj) + '\n```';
const TOOL_CTX = { sessionID: 'ses_parent', agent: 'build', messageID: 'msg_1', id: 'call_1' };
const VERIFIER_PROMPT = makeAgentPromptReader(PKG)(VERIFIER.agent);

// a v2 `ctx.session` whose child replies are scripted from the prompt text
function mockSession(reply) {
  const calls = { creates: [], prompts: [] };
  const pending = new Map();
  let n = 0;
  return {
    calls,
    create: async (req) => { calls.creates.push(req); return { id: `ses_child_${++n}` }; },
    prompt: async (req) => { calls.prompts.push(req); pending.set(req.sessionID, reply(req.text)); return { id: 'inb' }; },
    wait: async () => {},
    context: async ({ sessionID }) => [{ type: 'assistant', content: [{ type: 'text', text: pending.get(sessionID) }] }],
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

test('makeAgentPromptReader reads the packaged agent prompt; "" for an unknown agent', () => {
  const read = makeAgentPromptReader(PKG);
  assert.ok(read('prosecutor-correctness').length > 0, 'real lens prompt loads');
  assert.equal(read('nope-not-an-agent'), '');
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
