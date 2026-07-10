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

const PKG = dirname(dirname(fileURLToPath(import.meta.url)));
const fakeSchema = {
  string: () => ({ _t: 'string', optional() { return this; }, describe() { return this; } }),
};
const fenced = (obj) => '```json\n' + JSON.stringify(obj) + '\n```';

// a session client whose child prompt replies are scripted by agent title
function mockClient(reply) {
  const calls = { prompts: [] };
  return {
    calls,
    session: {
      create: async () => ({ data: { id: 'child' } }),
      prompt: async (req) => { calls.prompts.push(req); return { data: { parts: [{ type: 'text', text: reply(req) }] } }; },
      delete: async () => ({ data: true }),
    },
  };
}

test('buildProsecuteTool shapes an adlc_prosecute ToolDefinition with an optional base arg', () => {
  const def = buildProsecuteTool(fakeSchema, { root: '/p', pkgRoot: PKG });
  assert.ok(def.adlc_prosecute);
  assert.match(def.adlc_prosecute.description, /P5 prosecution|WRITE-DISABLED/);
  assert.ok(def.adlc_prosecute.args.base);
  assert.equal(typeof def.adlc_prosecute.execute, 'function');
});

test('execute: no session client → structured "use the prose protocol" fallback (not silent)', async () => {
  const def = buildProsecuteTool(fakeSchema, { root: '/p', pkgRoot: PKG }); // no client
  const r = await def.adlc_prosecute.execute({}, {});
  assert.equal(r.metadata.error, 'no-session-api');
  assert.equal(r.metadata.deterministic, false);
  assert.match(r.output, /\/adlc-prosecute/);
});

test('execute: empty diff → reports nothing to prosecute (does not spawn lenses)', async () => {
  const client = mockClient(() => fenced([]));
  const def = buildProsecuteTool(fakeSchema, { root: '/p', pkgRoot: PKG, client, diffImpl: () => '' });
  const r = await def.adlc_prosecute.execute({ base: 'main' }, { sessionID: 's' });
  assert.equal(r.metadata.confirmed, 0);
  assert.match(r.output, /no changes to prosecute/);
  assert.equal(client.calls.prompts.length, 0, 'no lens sessions spawned');
});

test('execute: a real diff drives the deterministic loop and returns a structured verdict', async () => {
  // lenses find a bug; verifier confirms it
  const client = mockClient((req) => {
    const sys = req.body.system ?? '';
    if (sys.includes('verifier')) return fenced({ real: true, reason: 'reproduced' });
    return fenced([{ title: 'planted-bug', severity: 'high', file: 'x.mjs' }]);
  });
  const def = buildProsecuteTool(fakeSchema, { root: '/p', pkgRoot: PKG, client, diffImpl: () => 'diff --git a/x b/x' });
  const r = await def.adlc_prosecute.execute({ base: 'main' }, { sessionID: 's' });
  assert.equal(r.metadata.deterministic, true);
  assert.equal(r.metadata.confirmed, 1);
  assert.match(r.metadata.verdict, /NO-SHIP/);
  assert.match(r.output, /planted-bug/);
  // the child sessions were fail-CLOSED (AC2, end-to-end through the tool):
  // "*": false floor, and no write/sub-agent tool re-enabled.
  for (const p of client.calls.prompts) {
    assert.equal(Object.keys(p.body.tools)[0], '*');
    assert.equal(p.body.tools['*'], false);
    for (const t of ['edit', 'write', 'bash', 'apply_patch', 'task']) assert.notEqual(p.body.tools[t], true);
  }
});

test('captureDiff distinguishes a git FAILURE from a clean empty tree', () => {
  assert.deepEqual(captureDiff({ spawnImpl: () => { throw new Error('not a git repo'); } }), { diff: '', error: 'not a git repo' });
  assert.deepEqual(captureDiff({ spawnImpl: () => '' }), { diff: '', error: null }); // clean tree
  assert.deepEqual(captureDiff({ spawnImpl: () => 'diff...' }), { diff: 'diff...', error: null });
});

test('execute: a git-capture FAILURE fails CLOSED (NO-SHIP), not a false empty-diff SHIP', async () => {
  const client = mockClient(() => fenced([]));
  const def = buildProsecuteTool(fakeSchema, {
    root: '/p', pkgRoot: PKG, client,
    diffImpl: () => ({ diff: '', error: 'fatal: bad revision main...HEAD' }),
  });
  const r = await def.adlc_prosecute.execute({ base: 'main' }, { sessionID: 's' });
  assert.equal(r.metadata.error, 'diff-capture-failed');
  assert.match(r.metadata.verdict, /NO-SHIP/);
  assert.equal(client.calls.prompts.length, 0, 'did not run lenses on a broken diff');
});

test('execute: a bounded/incomplete run with zero findings is NO-SHIP (INCOMPLETE), never a false SHIP', async () => {
  // never converges → hits maxRounds; still zero confirmed → must NOT SHIP
  let n = 0;
  const client = mockClient((req) => {
    const sys = req.body.system ?? '';
    if (sys.includes('verifier')) return fenced({ real: false }); // everything refuted → zero confirmed
    n += 1;
    return fenced([{ title: `ephemeral-${n}`, severity: 'low', file: 'x' }]); // new finding every round → never dry
  });
  const def = buildProsecuteTool(fakeSchema, { root: '/p', pkgRoot: PKG, client, diffImpl: () => 'diff x' });
  const r = await def.adlc_prosecute.execute({ base: 'main' }, { sessionID: 's' });
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
