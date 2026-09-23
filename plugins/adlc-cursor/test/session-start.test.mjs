// session-start.test.mjs — T64 AC3/AC4/AC17/AC19: sessionStart wiring semantics,
// consumer-root resolution, env pin, depth isolation, always-apply rule scaffold.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync, writeFileSync, readFileSync, existsSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmp } from '@adlc/core/test-kit';
import { writeDirectory } from '../../../packages/tickets/test/helpers.mjs';

import { handleSessionStart } from '../hooks/adlc-session-start.mjs';
import { bumpDepthCounter, readDepth, writeP5Marker, readP5Marker } from '../lib/session-state.mjs';
import { resolveSessionIdentity, sessionSafeId, SESSION_ENV_KEY } from '../lib/session-identity.mjs';
import { readSessionResolution, upsertSessionResolution } from '../lib/workspace-resolve.mjs';
import { ensureTicketContextRule, mergeHooks, PLUGIN_ROOT } from '../lib/scaffold.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, '..', 'hooks', 'adlc-session-start.mjs');

function legacyRepo(t, { tickets, pointer } = {}) {
  const root = tmp(t, 'adlc-ss-');
  mkdirSync(join(root, '.adlc'), { recursive: true });
  writeFileSync(join(root, '.adlc', 'tickets.json'), JSON.stringify({ tickets: tickets ?? [{ id: 'T1', title: 't', rails: [], scope: [], edges: [] }] }));
  if (pointer !== undefined) {
    writeFileSync(join(root, '.adlc', 'current-ticket.json'),
      typeof pointer === 'string' ? pointer : JSON.stringify(pointer));
  }
  return root;
}

test('AC4: active ticket context + env pin; does not set ADLC_P4_ENFORCEMENT', (t) => {
  const root = legacyRepo(t, { pointer: { id: 'T1' } });
  const state = tmp(t, 'adlc-state-');
  const env = { ADLC_CURSOR_STATE_DIR: state };
  const r = handleSessionStart({
    session_id: 'S1',
    workspace_roots: [root],
  }, { env });
  assert.match(r.additional_context, /T1/);
  assert.equal(r.env?.[SESSION_ENV_KEY], 'S1');
  assert.equal(r.env?.ADLC_P4_ENFORCEMENT, undefined);
  assert.ok(!('ADLC_P4_ENFORCEMENT' in (r.env ?? {})));
  const rec = readSessionResolution('S1', { env });
  assert.equal(rec.outcome, 'active');
  assert.equal(rec.root, root);
});

test('AC4: inactive ADLC root reports exact phrase no active ticket', (t) => {
  const root = legacyRepo(t); // no pointer
  const state = tmp(t, 'adlc-state-');
  const r = handleSessionStart({
    session_id: 'S-idle',
    workspace_roots: [root],
  }, { env: { ADLC_CURSOR_STATE_DIR: state } });
  assert.match(r.additional_context, /no active ticket/);
  assert.equal(r.workspace.outcome, 'inactive');
});

test('AC4: zero roots with ADLC-bearing plugin cwd → unresolved (never selects cwd)', (t) => {
  const pluginish = legacyRepo(t, { pointer: { id: 'T1' } });
  const state = tmp(t, 'adlc-state-');
  const prev = process.cwd();
  t.after(() => process.chdir(prev));
  process.chdir(pluginish);
  const r = handleSessionStart({ session_id: 'S0' }, {
    env: { ADLC_CURSOR_STATE_DIR: state },
  });
  assert.equal(r.workspace.outcome, 'unresolved');
  assert.match(r.additional_context, /unresolved|no host-supplied/i);
  assert.ok(!r.additional_context.includes('**T1**'));
});

test('AC4: multi-active ambiguity does not invent a winner', (t) => {
  const a = legacyRepo(t, { pointer: { id: 'T1' } });
  const b = legacyRepo(t, {
    tickets: [{ id: 'T2', title: 't2', rails: [], scope: [], edges: [] }],
    pointer: { id: 'T2' },
  });
  const state = tmp(t, 'adlc-state-');
  const r = handleSessionStart({
    session_id: 'Samb',
    workspace_roots: [a, b],
  }, { env: { ADLC_CURSOR_STATE_DIR: state } });
  assert.equal(r.workspace.outcome, 'ambiguous');
  assert.match(r.additional_context, /ambiguity/i);
  assert.ok(!r.additional_context.includes('no active ticket'));
});

test('AC4: directory-only store is ADLC-bearing and can be active', (t) => {
  const root = tmp(t, 'adlc-dir-');
  const state = tmp(t, 'adlc-state-');
  writeDirectory(root, [{ id: 'T9', title: 'd', rails: [], scope: [], edges: [] }]);
  writeFileSync(join(root, '.adlc', 'current-ticket.json'), JSON.stringify({ id: 'T9' }));
  const r = handleSessionStart({
    session_id: 'Sdir',
    workspace_roots: [root],
  }, { env: { ADLC_CURSOR_STATE_DIR: state } });
  assert.equal(r.workspace.outcome, 'active');
  assert.match(r.additional_context, /T9/);
});

test('AC4: dual-store is error-bearing, not no active ticket', (t) => {
  const root = legacyRepo(t, { pointer: { id: 'T1' } });
  const state = tmp(t, 'adlc-state-');
  writeDirectory(root, [{ id: 'T1', title: 'd', rails: [], scope: [], edges: [] }]);
  const r = handleSessionStart({
    session_id: 'Sdual',
    workspace_roots: [root],
  }, { env: { ADLC_CURSOR_STATE_DIR: state } });
  assert.equal(r.workspace.outcome, 'error');
  assert.match(r.additional_context, /AMBIGUOUS_STORE|error/i);
  assert.ok(!r.additional_context.includes('no active ticket'));
});

test('AC4: stale ticketHash is error-bearing', (t) => {
  const root = legacyRepo(t, { pointer: { id: 'T1', ticketHash: '0'.repeat(64) } });
  const state = tmp(t, 'adlc-state-');
  const r = handleSessionStart({
    session_id: 'Sstale',
    workspace_roots: [root],
  }, { env: { ADLC_CURSOR_STATE_DIR: state } });
  assert.equal(r.workspace.outcome, 'error');
  assert.ok(!r.additional_context.includes('no active ticket'));
});

test('identity: env≠payload conflict skips named-state mutation', (t) => {
  const root = legacyRepo(t, { pointer: { id: 'T1' } });
  const state = tmp(t, 'adlc-state-');
  const env = { ADLC_CURSOR_STATE_DIR: state, [SESSION_ENV_KEY]: 'A' };
  // seed A and B depth + marker + index
  bumpDepthCounter(null, { sessionId: 'A', env, toolUseId: 'x1' });
  bumpDepthCounter(null, { sessionId: 'B', env, toolUseId: 'x1' });
  writeP5Marker({ sessionId: 'A', ticketId: 'T1', runId: 'r1', env });
  writeP5Marker({ sessionId: 'B', ticketId: 'T1', runId: 'r2', env });
  upsertSessionResolution({ sessionId: 'A', outcome: 'active', root, ticketId: 'T1', env });
  upsertSessionResolution({ sessionId: 'B', outcome: 'inactive', root, env });
  const depthA = readDepth('A', { env });
  const depthB = readDepth('B', { env });
  const markA = readP5Marker('A', { env });
  const markB = readP5Marker('B', { env });
  const idxA = readSessionResolution('A', { env });
  const idxB = readSessionResolution('B', { env });

  const r = handleSessionStart({
    session_id: 'B',
    workspace_roots: [root],
  }, { env });
  assert.equal(r.identity.conflict, true);
  assert.equal(r.env, undefined);
  assert.equal(readDepth('A', { env }), depthA);
  assert.equal(readDepth('B', { env }), depthB);
  assert.deepEqual(readP5Marker('A', { env }), markA);
  assert.deepEqual(readP5Marker('B', { env }), markB);
  assert.equal(readSessionResolution('A', { env }).generation, idxA.generation);
  assert.equal(readSessionResolution('B', { env }).generation, idxB.generation);
});

test('identity: generation_id alone is anonymous; session_id≠conversation_id conflicts', () => {
  assert.equal(resolveSessionIdentity({ generation_id: 'g1' }).sessionId, null);
  assert.equal(resolveSessionIdentity({ generation_id: 'g1' }).source, 'anonymous');
  const c = resolveSessionIdentity({ session_id: 'A', conversation_id: 'B' });
  assert.equal(c.ok, false);
  assert.equal(c.conflict, true);
});

test('AC3: interleaved A/B depth + tool_use_id idempotency + safeId isolation', (t) => {
  const state = tmp(t, 'adlc-state-');
  const env = { ADLC_CURSOR_STATE_DIR: state };
  assert.equal(bumpDepthCounter(null, { sessionId: 'A', env, toolUseId: 'a1' }), 1);
  assert.equal(bumpDepthCounter(null, { sessionId: 'B', env, toolUseId: 'b1' }), 1);
  assert.equal(bumpDepthCounter(null, { sessionId: 'A', env, toolUseId: 'a2' }), 2);
  assert.equal(bumpDepthCounter(null, { sessionId: 'B', env, toolUseId: 'b2' }), 2);
  // duplicate tool_use_id → no bump
  assert.equal(bumpDepthCounter(null, { sessionId: 'A', env, toolUseId: 'a1' }), 2);
  // missing tool_use_id → per-delivery bump
  assert.equal(bumpDepthCounter(null, { sessionId: 'A', env }), 3);
  assert.equal(bumpDepthCounter(null, { sessionId: 'A', env }), 4);
  // traversal-shaped ids get independent safe files
  const evil = '../escape';
  assert.equal(bumpDepthCounter(null, { sessionId: evil, env, toolUseId: 'e1' }), 1);
  assert.notEqual(sessionSafeId(evil), sessionSafeId('A'));
  assert.ok(existsSync(join(state, `cursor-buildgate-depth-${sessionSafeId(evil)}.json`)));
});

test('AC3 concurrency: multi-process bumps lose no increments', (t) => {
  const state = tmp(t, 'adlc-state-');
  const env = { ...process.env, ADLC_CURSOR_STATE_DIR: state };
  const mod = join(HERE, '../lib/session-state.mjs');
  const script = join(state, 'worker.mjs');
  writeFileSync(script, [
    `import { bumpDepthCounter } from ${JSON.stringify(mod)};`,
    'const n = Number(process.argv[2]);',
    'for (let i = 0; i < n; i++) {',
    "  bumpDepthCounter(null, { sessionId: 'conc', env: process.env, toolUseId: `p${process.pid}-${i}` });",
    '}',
  ].join('\n'));
  for (const n of [8, 8, 8]) {
    execFileSync(process.execPath, [script, String(n)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  }
  assert.equal(readDepth('conc', { env }), 24);
});

test('wire: real sessionStart script emits env + context', (t) => {
  const root = legacyRepo(t, { pointer: { id: 'T1' } });
  const state = tmp(t, 'adlc-state-');
  const out = execFileSync(process.execPath, [SCRIPT], {
    cwd: join(HERE, '..'), // plugin cwd — must not win
    env: { ...process.env, ADLC_CURSOR_STATE_DIR: state, ADLC_P4_ENFORCEMENT: '' },
    input: JSON.stringify({ session_id: 'Swire', workspace_roots: [root] }),
  }).toString();
  const j = JSON.parse(out);
  assert.equal(j.env.ADLC_CURSOR_SESSION_ID, 'Swire');
  assert.match(j.additional_context, /T1/);
  assert.ok(!('ADLC_P4_ENFORCEMENT' in (j.env ?? {})));
});

test('fixture payload drives sessionStart (patched root)', (t) => {
  const root = legacyRepo(t, { pointer: { id: 'T1' } });
  const state = tmp(t, 'adlc-state-');
  const payload = JSON.parse(readFileSync(join(HERE, 'fixtures', 'session-start.active.json'), 'utf8'));
  payload.workspace_roots = [root];
  const r = handleSessionStart(payload, { env: { ADLC_CURSOR_STATE_DIR: state } });
  assert.equal(r.workspace.outcome, 'active');
});

test('AC17: alwaysApply rule + scaffold preserve user-modified sentinel file', (t) => {
  const project = tmp(t, 'adlc-scaf-');
  mkdirSync(join(project, '.cursor', 'rules'), { recursive: true });
  const dest = join(project, '.cursor', 'rules', 'adlc-ticket-context.mdc');
  writeFileSync(dest, `---\nalwaysApply: true\n---\n\n<!-- BEGIN ADLC_TICKET_CONTEXT_V1 -->\nUSER EDIT\n<!-- END ADLC_TICKET_CONTEXT_V1 -->\n`);
  const res = ensureTicketContextRule(project, { pluginRoot: PLUGIN_ROOT });
  assert.equal(res.preserved, true);
  assert.match(readFileSync(dest, 'utf8'), /USER EDIT/);
  assert.ok(existsSync(`${dest}.adlc-proposed`));

  const fresh = tmp(t, 'adlc-scaf2-');
  const created = ensureTicketContextRule(fresh, { pluginRoot: PLUGIN_ROOT });
  assert.equal(created.created, true);
  const body = readFileSync(join(fresh, '.cursor', 'rules', 'adlc-ticket-context.mdc'), 'utf8');
  assert.match(body, /alwaysApply:\s*true/);
});

test('scaffold mergeHooks wires sessionStart', () => {
  const merged = mergeHooks({});
  assert.ok(merged.hooks.sessionStart?.some((e) => /adlc-session-start\.mjs/.test(e.command)));
  assert.equal(merged.hooks.sessionStart[0].failClosed, false);
  assert.equal(merged.hooks.sessionStart[0].timeout, 10);
});

test('phase hint / enforcement boolean mapping', (t) => {
  const root = legacyRepo(t, { pointer: { id: 'T1' } });
  const state = tmp(t, 'adlc-state-');
  for (const [flag, enforcing] of [['', false], ['0', false], ['false', false], ['1', true]]) {
    const r = handleSessionStart({ session_id: 'Sph', workspace_roots: [root] }, {
      env: { ADLC_CURSOR_STATE_DIR: state, ADLC_P4_ENFORCEMENT: flag },
    });
    if (enforcing) assert.match(r.additional_context, /enforcing|active \(ADLC_P4_ENFORCEMENT=1\)/);
    else assert.match(r.additional_context, /inactive/);
  }
});
