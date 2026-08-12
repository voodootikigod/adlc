// handoff-deny.test.mjs — pi context-rot handoff deny (slice 5).
// Drives the REAL extension's tool_call handler through the same fake pi
// harness extension.test.mjs uses, never a re-implementation of it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ensureDenyMarker,
  writeDenyRecord,
  HANDOFF_PCT,
  HARD_PCT,
  WARN_PCT,
} from '@adlc/context-handoff';

import { createExtension } from '../lib/extension.mjs';
import {
  checkHandoff,
  createStickyDenyState,
  handoffAppliesTo,
  isShellTool,
  isStructuredMutator,
  editTargetOf,
  observeHandoffSignals,
  resolvePiSessionId,
} from '../lib/handoff-gate.mjs';

const TICKET = {
  id: 'T1',
  title: 'Test Ticket',
  body: 'Do the thing',
  scope: ['src/**'],
  rails: ['test/contracts/**'],
};

function makeRepo({ current = 'T1' } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'adlc-pi-handoff-')));
  mkdirSync(join(root, '.adlc'), { recursive: true });
  writeFileSync(join(root, '.adlc', 'tickets.json'), JSON.stringify({ tickets: [TICKET] }, null, 2));
  if (current !== null) {
    writeFileSync(join(root, '.adlc', 'current-ticket.json'), JSON.stringify({ id: current }));
  }
  return root;
}

function fakePi() {
  const handlers = {};
  return {
    on(name, fn) {
      handlers[name] = fn;
    },
    registerCommand() {},
    async exec() {
      return { stdout: '', stderr: '', code: 0 };
    },
    handlers,
  };
}

function fakeCtx(cwd, { percent } = {}) {
  const notices = [];
  return {
    cwd,
    ui: {
      setStatus() {},
      notify(msg, level) {
        notices.push({ msg, level });
      },
    },
    ...(percent === undefined ? {} : { getContextUsage: () => ({ percent, tokens: 1 }) }),
    notices,
  };
}

async function boot(root, { percent, sessionEvent, sessionId } = {}) {
  const pi = fakePi();
  createExtension({ env: {} })(pi);
  const ctx = fakeCtx(root, { percent });
  if (sessionId) ctx.sessionManager = { getSessionId: () => sessionId };
  await pi.handlers.session_start(
    sessionEvent ?? { type: 'session_start', reason: 'startup' },
    ctx,
  );
  return { pi, ctx };
}

/** Seed an open deny record owned by another session. */
function seedForeignDeny(root, name = 'denier-1') {
  assert.equal(
    ensureDenyMarker(root, {
      sessionId: name,
      ticketId: 'T1',
      contentHash: 'abc',
      host: 'test',
    }).ok,
    true,
  );
}

function call(pi, ctx, toolName, input) {
  return pi.handlers.tool_call({ toolName, input, toolCallId: 'tc-1' }, ctx);
}

// ---- pure glue -------------------------------------------------------------

test('the deny-set applies to mutators, the shell and custom tools, not to reads', () => {
  for (const t of ['write', 'edit', 'bash', 'some_custom_tool']) {
    assert.equal(handoffAppliesTo(t), true, `${t} must be gated`);
  }
  for (const t of ['read', 'grep', 'glob', 'list', 'ls', '']) {
    assert.equal(handoffAppliesTo(t), false, `${t} must not be gated`);
  }
  assert.equal(isStructuredMutator('edit'), true);
  assert.equal(isStructuredMutator('bash'), false);
  assert.equal(isShellTool('bash'), true);
});

test('the structured edit target is read from pi tool input', () => {
  assert.equal(editTargetOf({ path: 'src/a.mjs' }), 'src/a.mjs');
  assert.equal(editTargetOf({ filePath: 'src/a.mjs' }), 'src/a.mjs');
  assert.equal(editTargetOf({ path: '   ' }), null);
  assert.equal(editTargetOf(null), null);
});

test('a live context-usage percent becomes the pct band signal', () => {
  assert.deepEqual(observeHandoffSignals({ percent: HANDOFF_PCT }), { pct: HANDOFF_PCT });
  assert.deepEqual(observeHandoffSignals({ percent: 0 }), { pct: 0 });
  assert.deepEqual(observeHandoffSignals({ percent: '55' }), { pct: 55 });
});

test('an absent usage reading contributes no signal; a garbage one fails closed', () => {
  // pi degrades getContextUsage() to null where the host does not provide it —
  // a dead telemetry source must not hard-lock the repo.
  assert.deepEqual(observeHandoffSignals(null), {});
  assert.deepEqual(observeHandoffSignals(undefined), {});
  assert.deepEqual(observeHandoffSignals({}), {});
  // Present but unreadable is the opposite case: it must not read as healthy.
  assert.ok(Number.isNaN(observeHandoffSignals({ percent: 'not-a-number' }).pct));
});

test('the pct signal is what the bands actually see', () => {
  // Guards against a unit slip (0-1 vs 0-100) silently disabling the band.
  assert.ok(WARN_PCT < HANDOFF_PCT && HANDOFF_PCT < HARD_PCT);
  const seen = [];
  const evaluate = (o) => {
    seen.push(o.observed);
    return { deny: false, reasons: [] };
  };
  checkHandoff({
    toolName: 'edit',
    input: { path: 'src/a.mjs' },
    sessionId: 'sess-a',
    usage: { percent: HANDOFF_PCT },
    root: '/tmp',
    evaluate,
  });
  assert.deepEqual(seen, [{ pct: HANDOFF_PCT }]);
});

test('an unsafe session id reaches the gate as null, not as a filename', () => {
  const seen = [];
  const evaluate = (o) => {
    seen.push(o.sessionId);
    return { deny: false, reasons: [] };
  };
  for (const sessionId of [null, '', '../escape', 'has/slash']) {
    checkHandoff({ toolName: 'edit', sessionId, root: '/tmp', evaluate });
  }
  assert.deepEqual(seen, [null, null, null, null]);
});

test('pi\'s own session manager is the primary identity', () => {
  // ExtensionContext.sessionManager is a ReadonlySessionManager exposing
  // getSessionId(). Preferring anything else would bind D2 to the extension
  // instance instead of the session, so a reload would drop the deny.
  const ctx = { sessionManager: { getSessionId: () => 'pi-real-session' } };
  assert.equal(resolvePiSessionId(null, ctx), 'pi-real-session');
  assert.equal(
    resolvePiSessionId({ sessionId: 'event-sess' }, ctx),
    'pi-real-session',
    'the session manager outranks the event payload',
  );
});

test('a throwing or absent session manager falls through, never crashes', () => {
  const throwing = {
    sessionManager: {
      getSessionId() {
        throw new Error('no session yet');
      },
    },
  };
  assert.equal(resolvePiSessionId({ sessionId: 'event-sess' }, throwing), 'event-sess');
  const unsafe = { sessionManager: { getSessionId: () => '../escape' } };
  assert.equal(resolvePiSessionId({ sessionId: 'event-sess' }, unsafe), 'event-sess');
});

test('a host-supplied session id wins over the mint', () => {
  assert.equal(resolvePiSessionId({ sessionId: 'host-sess' }, null), 'host-sess');
  assert.equal(resolvePiSessionId({ session: { id: 'nested' } }, null), 'nested');
  assert.equal(resolvePiSessionId(null, { sessionId: 'ctx-sess' }), 'ctx-sess');
});

test('the minted session id is stable, unique and safe to name a file after', () => {
  const a = resolvePiSessionId(null, null);
  const b = resolvePiSessionId(null, null);
  assert.match(a, /^pi-\d+-/);
  assert.notEqual(a, b, 'a distinct process/instance must not reuse an id');
  assert.ok(!a.includes('/') && !a.includes('..'));
});

test('an unusable mint yields null so the caller fails closed', () => {
  assert.equal(resolvePiSessionId(null, null, { mint: () => '../escape' }), null);
  assert.equal(resolvePiSessionId(null, null, { mint: () => '' }), null);
});

// ---- the real extension ----------------------------------------------------

test('clean repo without deny/handoff → the edit runs', async () => {
  const root = makeRepo();
  try {
    const { pi, ctx } = await boot(root, { percent: 5 });
    const verdict = await call(pi, ctx, 'edit', { path: join(root, 'src', 'a.mjs') });
    assert.equal(verdict?.block, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an open deny for another session blocks the edit', async () => {
  const root = makeRepo();
  try {
    seedForeignDeny(root);
    const { pi, ctx } = await boot(root, { percent: 5 });
    const verdict = await call(pi, ctx, 'edit', { path: join(root, 'src', 'a.mjs') });
    assert.equal(verdict.block, true);
    assert.match(verdict.reason, /D3:unauthorized_open:denier-1/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the shell is fail-closed-all under the deny-set', async () => {
  const root = makeRepo();
  try {
    seedForeignDeny(root, 'denier-2');
    const { pi, ctx } = await boot(root, { percent: 5 });
    const verdict = await call(pi, ctx, 'bash', { command: 'ls' });
    assert.equal(verdict.block, true);
    assert.match(verdict.reason, /bash_fail_closed_under_deny/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an agent shell `adlc handoff repair` is tagged mutating-cli', async () => {
  const root = makeRepo();
  try {
    seedForeignDeny(root, 'denier-3');
    const { pi, ctx } = await boot(root, { percent: 5 });
    const verdict = await call(pi, ctx, 'bash', { command: 'adlc handoff repair --write' });
    assert.equal(verdict.block, true);
    assert.match(verdict.reason, /bash_handoff_mutating_cli/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a custom third-party tool is blocked under the deny-set too', async () => {
  const root = makeRepo();
  try {
    seedForeignDeny(root, 'denier-4');
    const { pi, ctx } = await boot(root, { percent: 5 });
    const verdict = await call(pi, ctx, 'some_custom_tool', { anything: 1 });
    assert.equal(verdict.block, true);
    assert.match(verdict.reason, /context-rot handoff deny/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('read-only tools still run under the deny-set', async () => {
  const root = makeRepo();
  try {
    seedForeignDeny(root, 'denier-5');
    const { pi, ctx } = await boot(root, { percent: 5 });
    const verdict = await call(pi, ctx, 'read', { path: join(root, 'src', 'a.mjs') });
    assert.equal(verdict?.block, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the deny-set holds with NO active ticket — it is not ticket-scoped', async () => {
  const root = makeRepo({ current: null });
  try {
    seedForeignDeny(root, 'denier-6');
    const { pi, ctx } = await boot(root, { percent: 5 });
    const verdict = await call(pi, ctx, 'edit', { path: join(root, 'src', 'a.mjs') });
    assert.equal(verdict.block, true, 'every other pi gate returns early without a ticket');
    assert.match(verdict.reason, /D3:unauthorized_open:denier-6/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the denier stays denied after its record is consumed (D2)', async () => {
  const root = makeRepo();
  try {
    const { pi, ctx } = await boot(root, { percent: HANDOFF_PCT, sessionEvent: {
      type: 'session_start',
      reason: 'startup',
      sessionId: 'denier-sticky',
    } });
    // The band fires, the marker is written, and the denier is sticky after a
    // consume — the deny record survives the session cooling off.
    await call(pi, ctx, 'edit', { path: join(root, 'src', 'a.mjs') });
    writeDenyRecord(root, {
      session_id: 'denier-sticky',
      ticket_id: 'T1',
      content_hash: 'abc',
      status: 'consumed',
      since: new Date().toISOString(),
      host: 'test',
      schema: 1,
    });
    const { pi: pi2, ctx: ctx2 } = await boot(root, { percent: 5, sessionEvent: {
      type: 'session_start',
      reason: 'startup',
      sessionId: 'denier-sticky',
    } });
    const verdict = await call(pi2, ctx2, 'edit', { path: join(root, 'src', 'a.mjs') });
    assert.equal(verdict.block, true);
    assert.match(verdict.reason, /D2:denier_session/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the live context percent drives the band and writes a deny marker', async () => {
  const root = makeRepo();
  try {
    const { pi, ctx } = await boot(root, {
      percent: HANDOFF_PCT,
      sessionEvent: { type: 'session_start', reason: 'startup', sessionId: 'deep-sess' },
    });
    const verdict = await call(pi, ctx, 'edit', { path: join(root, 'src', 'a.mjs') });
    assert.equal(verdict.block, true);
    const marker = join(root, '.adlc', 'handoffs', 'denies', 'deep-sess.json');
    assert.equal(existsSync(marker), true, 'the handoff band must write denies/<session>.json');
    assert.match(readFileSync(marker, 'utf8'), /"host": "pi"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a percent below the handoff band does not deny', async () => {
  const root = makeRepo();
  try {
    const { pi, ctx } = await boot(root, {
      percent: HANDOFF_PCT - 1,
      sessionEvent: { type: 'session_start', reason: 'startup', sessionId: 'shallow-sess' },
    });
    const verdict = await call(pi, ctx, 'edit', { path: join(root, 'src', 'a.mjs') });
    assert.equal(verdict?.block, undefined);
    assert.equal(
      existsSync(join(root, '.adlc', 'handoffs', 'denies', 'shallow-sess.json')),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a host without getContextUsage stays editable on a clean repo', async () => {
  const root = makeRepo();
  try {
    const { pi, ctx } = await boot(root); // no getContextUsage on ctx
    const verdict = await call(pi, ctx, 'edit', { path: join(root, 'src', 'a.mjs') });
    assert.equal(verdict?.block, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('writing a handoff trust-root artifact is denied even with a cold store', async () => {
  const root = makeRepo();
  try {
    const { pi, ctx } = await boot(root, { percent: 5 });
    const verdict = await call(pi, ctx, 'write', {
      path: join(root, '.adlc', 'handoffs', 'denies', 'x.json'),
    });
    assert.equal(verdict.block, true);
    assert.match(verdict.reason, /path_protected/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the deny is surfaced to the operator and recorded as evidence', async () => {
  const root = makeRepo();
  try {
    seedForeignDeny(root, 'denier-7');
    const { pi, ctx } = await boot(root, { percent: 5 });
    await call(pi, ctx, 'edit', { path: join(root, 'src', 'a.mjs') });
    assert.ok(
      ctx.notices.some((n) => n.level === 'error' && /handoff deny/.test(n.msg)),
      'the operator must see why the tool was blocked',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the manifest key is threaded so a signed resume-auth can be verified', () => {
  const seen = [];
  const evaluate = (o) => {
    seen.push(o.manifestKey);
    return { deny: false, reasons: [], denyEverWritten: false };
  };
  checkHandoff({ toolName: 'edit', sessionId: 'sess-a', root: '/tmp', manifestKey: 'k'.repeat(64), evaluate });
  checkHandoff({ toolName: 'edit', sessionId: 'sess-a', root: '/tmp', manifestKey: '', evaluate });
  checkHandoff({ toolName: 'edit', sessionId: 'sess-a', root: '/tmp', evaluate });
  assert.deepEqual(seen, ['k'.repeat(64), null, null]);
});

test('a failed marker write stays sticky for the session across calls', () => {
  const sticky = createStickyDenyState();
  const calls = [];
  const evaluate = (o) => {
    calls.push(o.denyEverWritten);
    return { deny: false, reasons: [], denyEverWritten: true };
  };
  checkHandoff({ toolName: 'edit', sessionId: 'sess-a', root: '/tmp', sticky, evaluate });
  checkHandoff({ toolName: 'edit', sessionId: 'sess-a', root: '/tmp', sticky, evaluate });
  checkHandoff({ toolName: 'edit', sessionId: 'sess-b', root: '/tmp', sticky, evaluate });
  assert.deepEqual(calls, [false, true, false]);
});

test('a THROWING getContextUsage fails closed, an absent one does not', async () => {
  const root = makeRepo();
  try {
    // Absent API: a host that does not provide it must not hard-lock the repo.
    const absent = await boot(root);
    assert.equal(
      (await call(absent.pi, absent.ctx, 'edit', { path: join(root, 'src', 'a.mjs') }))?.block,
      undefined,
    );

    // Present but throwing: that is a FAILED read of a real signal, not the
    // absence of one. Collapsing the two would let a 95%-full session through
    // on a transient error.
    const pi = fakePi();
    createExtension({ env: {} })(pi);
    const ctx = fakeCtx(root);
    ctx.getContextUsage = () => {
      throw new Error('transient');
    };
    await pi.handlers.session_start({ type: 'session_start', reason: 'startup' }, ctx);
    const verdict = await call(pi, ctx, 'edit', { path: join(root, 'src', 'a.mjs') });
    assert.equal(verdict?.block, true, 'an unreadable context signal must fail closed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the plugin declares the package it enforces with', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(pkg.dependencies['@adlc/context-handoff'], 'must depend on @adlc/context-handoff');
  assert.ok(pkg.files.includes('lib/'), 'files must ship lib/');
});

test('a custom tool reaching the deny store by any extractable key is denied', async () => {
  // The rail gate vets custom tools with extractToolPaths, which reads `target`
  // and `file` as well as `path`. The handoff gate read only the three `path`
  // spellings, so these reached the store while the rail checker saw them.
  const root = makeRepo();
  try {
    const { pi, ctx } = await boot(root, { percent: 5 });
    for (const input of [
      { target: join(root, '.adlc', '.deny-store') },
      { file: join(root, '.adlc', 'handoffs', 'denies', 'x.json') },
    ]) {
      const verdict = await call(pi, ctx, 'custom_writer', input);
      assert.equal(verdict.block, true, `must block: ${JSON.stringify(input)}`);
      assert.match(verdict.reason, /path_protected/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a custom tool targeting ordinary files is still allowed with a cold store', async () => {
  const root = makeRepo();
  try {
    const { pi, ctx } = await boot(root, { percent: 5 });
    for (const input of [{ target: 'src/app.mjs' }, { path: 'src/app.mjs' }, {}]) {
      const verdict = await call(pi, ctx, 'custom_writer', input);
      assert.notEqual(verdict?.block, true, `must allow: ${JSON.stringify(input)}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a custom tool naming a protected directory is denied', async () => {
  const root = makeRepo();
  try {
    const { pi, ctx } = await boot(root, { percent: 5 });
    for (const input of [{ target: join(root, '.adlc', 'handoffs') }, { path: join(root, '.adlc') }]) {
      const verdict = await call(pi, ctx, 'custom_deleter', input);
      assert.equal(verdict.block, true, `must block: ${JSON.stringify(input)}`);
      assert.match(verdict.reason, /path_protected/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
