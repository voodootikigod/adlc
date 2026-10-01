// v2-registration.test.mjs — the OpenCode v2 wiring of `setup(ctx)`: what is
// registered, in what order, with which failure direction, and how the event
// loop behaves. Everything goes through the real plugin and a fake v2 ctx.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureDenyMarker } from '@adlc/context-handoff';

import plugin from '../index.mjs';
import {
  loadPlugin, createFakeCtx, captureStderr,
  compactionEnded, filesystemChanged, sessionCreated, sessionIdle,
} from './helpers/fake-ctx.mjs';

const RAIL_CONTENT = 'FROZEN RAIL\n';

function repo(t, tickets = [{ id: 'T1', title: 'T1 fixture', rails: ['test/**'] }]) {
  const dir = mkdtempSync(join(tmpdir(), 'oc-v2reg-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, '.adlc'), { recursive: true });
  writeFileSync(join(dir, '.adlc', 'tickets.json'), JSON.stringify({ tickets }));
  return dir;
}

/** A git repo with a committed rail file, so the watcher can restore it. */
function gitRepo(t) {
  const dir = repo(t);
  mkdirSync(join(dir, 'test'), { recursive: true });
  writeFileSync(join(dir, 'test', 'x.mjs'), RAIL_CONTENT);
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  git('init', '-q');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  return dir;
}

function withEnv(t, patch) {
  const saved = { ...process.env };
  t.after(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  });
  for (const [k, v] of Object.entries(patch)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
}

const ENFORCING = { ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: 'T1', ADLC_ALLOW_ADVISORY_HOOKS: undefined, ADLC_BUILD_GATE_BYPASS: undefined };

/** An object whose every property read throws — an injected internal error. */
const exploding = () => new Proxy({}, { get() { throw new Error('injected'); }, has() { throw new Error('injected'); } });

test('AC9: a rails hit in execute.before rejects by default', async (t) => {
  const dir = repo(t);
  withEnv(t, ENFORCING);
  const p = await loadPlugin({ root: dir });
  await assert.rejects(() => captureStderr(() => p.before('write', { path: 'test/x.mjs', content: 'x' })), /ADLC rails-guard: blocked write/);
});

test('AC10: advisoryHooks option downgrades the same hit to a stderr advisory', async (t) => {
  const dir = repo(t);
  withEnv(t, ENFORCING);
  const { result: p, lines: loadLines } = await captureStderr(() => loadPlugin({ root: dir, options: { advisoryHooks: true } }));
  assert.ok(loadLines.some((l) => /^\[adlc\] warning: ADLC: opencode\.json plugin options weaken enforcement/.test(l)), 'downgrade announced at load');
  const { lines } = await captureStderr(() => p.before('write', { path: 'test/x.mjs', content: 'x' }));
  assert.ok(lines.some((l) => l.includes('[ADVISORY')), lines.join('\n'));
});

test('AC11: the handoff deny ignores the advisory downgrade', async (t) => {
  const dir = repo(t, [{ id: 'T1', title: 'fixture', rails: [] }]);
  withEnv(t, { ...ENFORCING, ADLC_CONTEXT_ROT_HANDOFF_ENABLED: '1' });
  assert.equal(ensureDenyMarker(dir, { sessionId: 'denier-1', ticketId: 'T1', contentHash: 'abc', host: 'test' }).ok, true);
  const p = await captureStderr(() => loadPlugin({ root: dir, options: { advisoryHooks: true } })).then((r) => r.result);
  await assert.rejects(() => captureStderr(() => p.before('edit', { path: 'src/ok.mjs' }, { sessionID: 's1' })), /ADLC context-handoff/);
});

test('AC12: advisory hooks and every event branch survive an injected internal error', async (t) => {
  const dir = repo(t);
  withEnv(t, ENFORCING);
  const p = await loadPlugin({ root: dir });
  const { tool, session } = p.registrations;
  await tool.get('execute.after')(exploding());
  await tool.get('execute.after')({ tool: 'edit', sessionID: 's', input: exploding() });
  await session.get('context')(exploding());
  await session.get('compaction')(exploding());
  await session.get('prompt')(exploding());
  await session.get('prompt')({ sessionID: 's', prompt: exploding() });
  const broken = (type) => ({ type, get data() { throw new Error('injected'); } });
  for (const type of ['session.compaction.ended', 'filesystem.changed', 'session.created', 'session.idle', 'something.else']) {
    await p.emit(broken(type));
  }
  await p.emit(exploding());
  // The loop is still on its first subscription and still handling events.
  await p.emit(sessionIdle('s'));
  assert.equal(p.events.subscriptions.length, 1, 'no event ended the loop');
  p.cleanup();
});

test('AC13: a native-tool builder failure keeps the enforcing hook and says so on stderr', async (t) => {
  const dir = repo(t);
  withEnv(t, ENFORCING);
  const fake = createFakeCtx({ root: dir });
  Object.defineProperty(fake.ctx, 'generate', { get() { throw new Error('builder exploded'); } });
  const { result: cleanup, lines } = await captureStderr(() => plugin.setup(fake.ctx));
  cleanup();
  assert.ok(lines.some((l) => l.startsWith('[adlc] native tools NOT registered: builder exploded')), lines.join('\n'));
  assert.equal(typeof fake.registrations.tool.get('execute.before'), 'function');
  await assert.rejects(
    () => captureStderr(() => fake.registrations.tool.get('execute.before')({ tool: 'edit', sessionID: 's', input: { path: 'test/x.mjs' } })),
    /ADLC rails-guard: blocked/,
  );
});

test('AC14: after compaction, a high-risk session\'s next edit is blocked by the build gate (autocontinue fallback)', async (t) => {
  const dir = repo(t, [{ id: 'T1', title: 'high', risk: 'high', rails: ['frozen/**'] }]);
  withEnv(t, ENFORCING);
  const p = await loadPlugin({ root: dir });
  await p.before('edit', { path: 'src/ok.mjs' }, { sessionID: 'ses_hi' });
  await p.emit(compactionEnded('ses_hi'));
  await assert.rejects(() => captureStderr(() => p.before('edit', { path: 'src/ok.mjs' }, { sessionID: 'ses_hi' })), /ADLC build-gate: blocked/);
  p.cleanup();
});

test('AC15: with late registration acknowledgements, setup resolves only after execute.before is registered', async (t) => {
  const dir = repo(t);
  // The enforcing hook acknowledges LAST, long after every other registration.
  const fake = createFakeCtx({ root: dir, ackDelayMs: (kind, name) => (`${kind}:${name}` === 'tool:execute.before' ? 120 : 5) });
  const cleanup = await plugin.setup(fake.ctx);
  cleanup();
  assert.ok(fake.log.includes('tool:execute.before'), `acknowledged before resolve: ${fake.log.join(', ')}`);
  assert.ok(fake.registrations.tool.has('execute.before'), 'the enforcing hook was registered');
  for (const expected of ['tool:execute.after', 'permission:evaluate', 'session:context', 'session:compaction', 'session:prompt']) {
    assert.ok(fake.log.includes(expected), `${expected} acknowledged before setup resolved`);
  }
  assert.equal(fake.log.filter((l) => l === 'tool:transform').length, 2, 'rail notice + native tools');
});

test('AC15: a failed enforcing registration fails setup (closed), a failed advisory one does not', async (t) => {
  const dir = repo(t);
  const failing = (name) => createFakeCtx({ root: dir, onRegister: (kind, n) => { if (`${kind}:${n}` === name) throw new Error(`no ${name}`); } });
  await assert.rejects(() => plugin.setup(failing('tool:execute.before').ctx), /no tool:execute\.before/);
  await assert.rejects(() => plugin.setup(failing('permission:evaluate').ctx), /no permission:evaluate/);
  const advisory = failing('session:context');
  const { result: cleanup, lines } = await captureStderr(() => plugin.setup(advisory.ctx));
  cleanup();
  assert.ok(lines.some((l) => /^\[adlc\] warning: context hook NOT registered: no session:context/.test(l)), lines.join('\n'));
});

test('AC16: an ended event stream is resubscribed, and cleanup stops the loop', async (t) => {
  const dir = repo(t);
  const p = await loadPlugin({ root: dir });
  const first = await p.events.waitForSubscription(1);
  p.events.end();
  await p.events.waitForSubscription(2);
  await p.emit(sessionIdle('s')); // the new subscription is consumed
  p.cleanup();
  assert.equal(first.signal.aborted, true, 'cleanup aborts the subscription signal');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(p.events.subscriptions.length, 2, 'no resubscribe after cleanup');
});

test('AC16: a throwing event stream is resubscribed too', async (t) => {
  const dir = repo(t);
  const fake = createFakeCtx({ root: dir });
  let subscribes = 0;
  const real = fake.ctx.event.subscribe;
  fake.ctx.event.subscribe = (o) => {
    subscribes += 1;
    if (subscribes === 1) return { [Symbol.asyncIterator]() { return { next: async () => { throw new Error('reconnect'); } }; } };
    return real(o);
  };
  const cleanup = await plugin.setup(fake.ctx);
  await fake.events.waitForSubscription(1);
  cleanup();
  assert.equal(subscribes, 2);
});

test('AC17: a filesystem.changed event from another location produces no watcher action', async (t) => {
  const dir = gitRepo(t);
  withEnv(t, ENFORCING);
  const p = await loadPlugin({ root: dir });
  writeFileSync(join(dir, 'test', 'x.mjs'), 'SPOOFED\n');
  const { lines } = await captureStderr(() => p.emit(filesystemChanged(join(dir, 'test', 'x.mjs'), { directory: join(tmpdir(), 'another-project') })));
  assert.equal(readFileSync(join(dir, 'test', 'x.mjs'), 'utf8'), 'SPOOFED\n', 'foreign event did not restore');
  assert.deepEqual(lines, []);
  // control: the same event for THIS location is acted on
  await captureStderr(() => p.emit(filesystemChanged(join(dir, 'test', 'x.mjs'), { directory: dir })));
  assert.equal(readFileSync(join(dir, 'test', 'x.mjs'), 'utf8'), RAIL_CONTENT, 'own-location event restores the rail');
  p.cleanup();
});

test('session.created reports the statusline on stderr; foreign sessions are ignored', async (t) => {
  const dir = repo(t);
  withEnv(t, ENFORCING);
  const p = await loadPlugin({ root: dir });
  const { lines: foreign } = await captureStderr(() => p.emit(sessionCreated('ses_x', { directory: join(tmpdir(), 'elsewhere') })));
  assert.deepEqual(foreign, []);
  const { lines } = await captureStderr(() => p.emit(sessionCreated('ses_1', { directory: dir })));
  assert.ok(lines.some((l) => /^\[adlc\] info: .*T1/.test(l)), lines.join('\n'));
  p.cleanup();
});
