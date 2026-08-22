// handoff-deny.test.mjs — pi context-rot handoff deny (slice 5).
// Drives the REAL extension's tool_call handler through the same fake pi
// harness extension.test.mjs uses, never a re-implementation of it.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  readdirSync,
  existsSync,
  realpathSync,
  renameSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

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
  createAdlcRootState,
  createStickyDenyState,
  handoffAppliesTo,
  isShellTool,
  isStructuredMutator,
  editTargetOf,
  formatRecoveryCommand,
  handoffRecoveryDiagnostic,
  foreignDenierOf,
  resolveAdlcRoot,
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

/**
 * A directory that never installed ADLC — no `.adlc/`, nothing else either.
 * The gate is contained to ADLC repos, so this is the shape that must stay
 * inert at every fill percent.
 */
function makeBareDir() {
  return realpathSync(mkdtempSync(join(tmpdir(), 'adlc-pi-bare-')));
}

/**
 * A root for the pure-plumbing tests that inject `evaluate`: containment runs
 * before evaluation, so those tests need a root that is actually an ADLC repo
 * or their injected evaluator is never reached.
 */
const PLUMBING_ROOT = (() => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'adlc-pi-plumbing-')));
  mkdirSync(join(root, '.adlc'), { recursive: true });
  return root;
})();
after(() => rmSync(PLUMBING_ROOT, { recursive: true, force: true }));

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
    root: PLUMBING_ROOT,
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
    checkHandoff({ toolName: 'edit', sessionId, root: PLUMBING_ROOT, evaluate });
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
  checkHandoff({ toolName: 'edit', sessionId: 'sess-a', root: PLUMBING_ROOT, manifestKey: 'k'.repeat(64), evaluate });
  checkHandoff({ toolName: 'edit', sessionId: 'sess-a', root: PLUMBING_ROOT, manifestKey: '', evaluate });
  checkHandoff({ toolName: 'edit', sessionId: 'sess-a', root: PLUMBING_ROOT, evaluate });
  assert.deepEqual(seen, ['k'.repeat(64), null, null]);
});

test('a failed marker write stays sticky for the session across calls', () => {
  const sticky = createStickyDenyState();
  const calls = [];
  const evaluate = (o) => {
    calls.push(o.denyEverWritten);
    return { deny: false, reasons: [], denyEverWritten: true };
  };
  checkHandoff({ toolName: 'edit', sessionId: 'sess-a', root: PLUMBING_ROOT, sticky, evaluate });
  checkHandoff({ toolName: 'edit', sessionId: 'sess-a', root: PLUMBING_ROOT, sticky, evaluate });
  checkHandoff({ toolName: 'edit', sessionId: 'sess-b', root: PLUMBING_ROOT, sticky, evaluate });
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

// ---- containment: the gate only runs where ADLC was installed --------------

test('a directory that never installed ADLC is inert at every fill percent', async () => {
  // The release blocker this closes: the band alone denied write/edit/bash in
  // any directory the agent happened to open, wrote .adlc state into it, and —
  // the deny store being durable — followed that directory into every later
  // session. Installing ADLC is the opt-in.
  for (const percent of [WARN_PCT, HANDOFF_PCT, HARD_PCT, 95, 100]) {
    const root = makeBareDir();
    try {
      const { pi, ctx } = await boot(root, { percent });
      for (const [tool, input] of [
        ['edit', { path: join(root, 'a.txt') }],
        ['write', { path: join(root, 'a.txt') }],
        ['bash', { command: 'rm -rf a.txt' }],
        ['some_custom_tool', { target: join(root, 'a.txt') }],
      ]) {
        const verdict = await call(pi, ctx, tool, input);
        assert.notEqual(verdict?.block, true, `${tool} must be allowed at ${percent}%`);
      }
      assert.equal(
        existsSync(join(root, '.adlc')),
        false,
        `the gate must not create .adlc state at ${percent}% in a repo that never opted in`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('containment short-circuits before the band is ever evaluated', () => {
  const root = makeBareDir();
  try {
    let evaluated = false;
    const evaluate = () => {
      evaluated = true;
      return { deny: true, reasons: ['D1:band'] };
    };
    const verdict = checkHandoff({
      toolName: 'edit',
      input: { path: 'a.txt' },
      sessionId: 'sess-a',
      usage: { percent: HARD_PCT },
      root,
      evaluate,
    });
    assert.deepEqual(verdict, { decision: 'allow' });
    assert.equal(evaluated, false, 'evaluation must not run outside an ADLC repo');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('installing ADLC is what arms the gate', () => {
  // The same directory, the same fill: the only difference is `.adlc/`.
  const root = makeBareDir();
  try {
    const args = {
      toolName: 'edit',
      input: { path: 'a.txt' },
      sessionId: 'sess-a',
      usage: { percent: HANDOFF_PCT },
      root,
    };
    assert.equal(checkHandoff(args).decision, 'allow');
    mkdirSync(join(root, '.adlc'), { recursive: true });
    assert.equal(checkHandoff(args).decision, 'deny');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- deny text: honest, and keyless where no key is configured -------------

test('the deny text drops the false fresh-session claim', async () => {
  // The deny is recorded in the repo and reaches a NEW session (proved by the
  // foreign-denier tests above), so "continue in a fresh session" was advice
  // that could not work.
  const root = makeRepo();
  try {
    seedForeignDeny(root, 'denier-text');
    const { pi, ctx } = await boot(root, { percent: 5 });
    const verdict = await call(pi, ctx, 'edit', { path: join(root, 'src', 'a.mjs') });
    assert.equal(verdict.block, true);
    assert.doesNotMatch(verdict.reason, /fresh session/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the deny text carries a session-bound recovery command', async () => {
  const root = makeRepo();
  try {
    seedForeignDeny(root, 'denier-cmd');
    const { pi, ctx } = await boot(root, { percent: 5, sessionId: 'my-session' });
    const verdict = await call(pi, ctx, 'edit', { path: join(root, 'src', 'a.mjs') });
    assert.equal(verdict.block, true);
    assert.match(verdict.reason, /handoff\.mjs/, 'names the recovery CLI by resolved path');
    assert.match(verdict.reason, /bypass --session my-session /, 'bound to this session');
    assert.match(verdict.reason, / --write(\s|$)/, 'copy-pasteable and persisting');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('with no manifest key the deny text names the keyless path', async () => {
  // Every mutating verb but one is key-gated, and the exception (`unlock`)
  // reclaims a session LOCK, not a deny — so with no key the only recovery is
  // removing the deny state by hand.
  const root = makeRepo();
  try {
    seedForeignDeny(root, 'denier-keyless');
    const { pi, ctx } = await boot(root, { percent: 5, sessionId: 'my-session' });
    const verdict = await call(pi, ctx, 'edit', { path: join(root, 'src', 'a.mjs') });
    assert.equal(verdict.block, true);
    assert.match(verdict.reason, /ADLC_MANIFEST_KEY/);
    assert.match(verdict.reason, /\.adlc\/handoffs\/denies\//, 'names the marker directory');
    assert.match(verdict.reason, /\.adlc\/\.deny-store/, 'names the sentinel');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the keyless block is omitted once a manifest key is configured', () => {
  const root = makeRepo();
  try {
    seedForeignDeny(root, 'denier-keyed');
    const keyed = checkHandoff({
      toolName: 'edit',
      input: { path: 'src/a.mjs' },
      sessionId: 'my-session',
      root,
      manifestKey: 'k'.repeat(64),
    });
    assert.equal(keyed.decision, 'deny');
    assert.match(keyed.reason, /bypass --session my-session /);
    assert.doesNotMatch(keyed.reason, /\.deny-store/, 'a keyed operator has the CLI path');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test('the recovery command degrades rather than emitting a broken one', () => {
  const base = {
    interpreterPath: '/usr/bin/node',
    scriptPath: '/opt/adlc/bin/handoff.mjs',
    adlcDir: '/srv/repo/.adlc',
    sessionId: 'sess-a',
  };
  assert.equal(
    formatRecoveryCommand(base),
    '/usr/bin/node /opt/adlc/bin/handoff.mjs bypass --session sess-a --dir /srv/repo/.adlc --write',
  );
  assert.match(
    formatRecoveryCommand({ ...base, unbound: true }),
    /bypass --session sess-a --unbound-reason \S+ --dir /,
  );

  // A path needing quoting is quoted; one that cannot be quoted at all degrades
  // to prose rather than a command that would break out of its own quoting.
  assert.match(
    formatRecoveryCommand({ ...base, scriptPath: '/opt/my adlc/bin/handoff.mjs' }),
    /'\/opt\/my adlc\/bin\/handoff\.mjs'/,
  );
  for (const broken of [
    { scriptPath: "/opt/it's/handoff.mjs" },
    { adlcDir: "/srv/it's/.adlc" },
    { interpreterPath: '/usr/bin/no\nde' },
  ]) {
    const degraded = formatRecoveryCommand({ ...base, ...broken });
    assert.doesNotMatch(degraded, /^\/usr\/bin\/node /);
    assert.match(degraded, /cannot be printed as a safe/);
  }

  // No usable session id means no --session command exists for any grammar.
  for (const sessionId of [null, '', '../escape', 'has space']) {
    assert.doesNotMatch(formatRecoveryCommand({ ...base, sessionId }), /bypass --session/);
  }
});

test('the diagnostic still names the keyless path when the CLI cannot be resolved', () => {
  const diagnostic = handoffRecoveryDiagnostic({
    sessionId: 'sess-a',
    hasManifestKey: false,
    cliPath: null,
  });
  assert.match(diagnostic, /could not be resolved/);
  assert.match(diagnostic, /\.adlc\/\.deny-store/, 'the keyless path needs no CLI at all');
});

test('a foreign deny gets an unbound grant, this session\'s own gets a bound one', () => {
  const of = (reasons, sessionId) =>
    handoffRecoveryDiagnostic({ sessionId, root: '/srv/repo', reasons, hasManifestKey: true });

  assert.match(of(['D3:unauthorized_open:sess-A'], 'sess-B'), /--unbound-reason/);
  assert.doesNotMatch(of(['D3:unauthorized_open:sess-B', 'D2:denier_session'], 'sess-B'), /--unbound-reason/);
  assert.equal(foreignDenierOf(['D3:unauthorized_open:sess-A'], 'sess-B'), 'sess-A');
  assert.equal(foreignDenierOf(['D3:unauthorized_open:sess-B'], 'sess-B'), null);
  assert.equal(foreignDenierOf(['D2:denier_session'], 'sess-B'), null);
  assert.equal(foreignDenierOf(undefined, 'sess-B'), null);
});

test('the command names the denied repo, so cwd cannot redirect it', () => {
  const root = makeRepo();
  try {
    seedForeignDeny(root, 'denier-dir');
    const { reason } = checkHandoff({
      toolName: 'edit',
      input: { path: 'src/a.mjs' },
      sessionId: 'sess-B',
      root,
      manifestKey: 'k'.repeat(64),
    });
    // Without --dir the CLI resolves .adlc from process.cwd(), writes the grant
    // into whatever directory the operator's shell happens to be in, and exits
    // 0 — reporting success while the denied repo stays denied.
    assert.match(reason, new RegExp(`--dir '?${realpathSync(root)}/\\.adlc'?`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the printed command actually clears a real band-generated foreign deny', async () => {
  // The end-to-end contract: band-generate a deny the way a real session does,
  // take the command the deny text shows a DIFFERENT session, run that exact
  // string in a shell whose cwd is somewhere else entirely, and check what it
  // bought. A band marker is unbound (ticket_id and content_hash both null), so
  // a bound grant would be consumed here and leave the session denied.
  const key = 'k'.repeat(64);
  const root = makeRepo();
  const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'adlc-pi-elsewhere-')));
  try {
    // Session A crosses the handoff band and leaves its own marker behind.
    checkHandoff({
      toolName: 'edit',
      input: { path: 'src/a.mjs' },
      sessionId: 'sess-A',
      usage: { percent: HANDOFF_PCT },
      root,
    });
    const marker = JSON.parse(
      readFileSync(join(root, '.adlc', 'handoffs', 'denies', 'sess-A.json'), 'utf8'),
    );
    assert.equal(marker.ticket_id, null, 'a band marker is unbound');
    assert.equal(marker.content_hash, null, 'a band marker is unbound');

    const askB = () =>
      checkHandoff({
        toolName: 'edit',
        input: { path: 'src/a.mjs' },
        sessionId: 'sess-B',
        root,
        manifestKey: key,
      });

    const denied = askB();
    assert.equal(denied.decision, 'deny');
    assert.match(denied.reason, /D3:unauthorized_open:sess-A/);

    // Pull the command out of the message exactly as an operator would.
    const command = denied.reason
      .split('\n')
      .find((line) => line.includes('bypass --session'))
      ?.replace(/^[^:]*: /, '');
    assert.ok(command, `no command line in:\n${denied.reason}`);

    const run = spawnSync(command, {
      shell: true,
      cwd: elsewhere,
      env: { ...process.env, ADLC_MANIFEST_KEY: key },
      encoding: 'utf8',
    });
    assert.equal(run.status, 0, `printed command failed: ${run.stderr}`);

    assert.equal(askB().decision, 'allow', 'the printed command must actually unblock the caller');
    assert.equal(askB().decision, 'deny', 'and be consumed by that one mutation, as the text says');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

test('the operator-facing deny text is pinned phrase by phrase', () => {
  // What an operator reads and pastes IS the contract, and prose is the one
  // part of this module a mutation gate cannot reach — string literals have no
  // comparison to invert. Every load-bearing claim is asserted verbatim here,
  // and every one of them is a fact this branch established by execution
  // rather than by reading the CLI's help.
  const root = makeRepo();
  try {
    seedForeignDeny(root, 'sess-A');
    const ask = (manifestKey) =>
      checkHandoff({
        toolName: 'edit',
        input: { path: 'src/a.mjs' },
        sessionId: 'sess-B',
        root,
        manifestKey,
      }).reason;

    const keyless = ask(null);
    // The correction this ticket exists for: a new session walks back into the
    // deny, so the old "continue in a fresh session" was unrunnable advice.
    assert.doesNotMatch(keyless, /fresh session/i);
    assert.ok(
      keyless.includes('it holds for new sessions here until an operator clears it'),
      'must say the deny outlives the session',
    );
    // Measured: the grant is consumed by the mutation it authorizes.
    assert.ok(
      keyless.includes('authorizes the NEXT mutation only'),
      'must not present a one-shot grant as a clear',
    );
    // Measured: unlock is keyless but reclaims a lock, not a deny.
    assert.ok(
      keyless.includes('`adlc handoff unlock` needs no key but reclaims a session lock, not a deny'),
      'must say why the one keyless verb is not the answer',
    );
    // Measured: removing the marker without the sentinel still denies.
    assert.ok(
      keyless.includes('.adlc/handoffs/denies/') && keyless.includes('.adlc/.deny-store'),
      'both removal paths, or the recipe does not work',
    );
    assert.ok(
      keyless.includes('Deleting a marker on its own is not enough'),
      'the half-recipe is the one an operator would otherwise try first',
    );
    // The exact reason token, not a wildcard: an empty one is rejected by the
    // CLI, and a changed one changes what lands in the audit record.
    assert.ok(
      keyless.includes('--unbound-reason pi-handoff-operator-recovery'),
      'the grant carries a stable, non-empty operator reason',
    );

    // A keyed operator gets the durable flows named instead of the file path.
    const keyed = ask('k'.repeat(64));
    assert.ok(
      keyed.includes('`adlc handoff resume` / `continue` are the durable handoff flows'),
      'a keyed operator needs the durable path, not just the one-shot grant',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('opt-in is monotonic — deleting .adlc cannot disarm an armed repo', async () => {
  // Containment must not become an off switch. A custom tool whose target the
  // extractor cannot see is not rail-checked while the store is cold, so an
  // agent below the band could remove `.adlc` and, with a naive presence
  // check, walk past every later handoff deny. Before this branch the band
  // alone denied here; that must stay true for a repo that DID opt in.
  const root = makeRepo();
  try {
    const { pi, ctx } = await boot(root, { percent: 5, sessionId: 'sess-1' });
    assert.equal(
      (await call(pi, ctx, 'edit', { path: join(root, 'src', 'a.mjs') }))?.block,
      undefined,
      'below the band, an opted-in repo is editable',
    );

    // The agent removes the opt-in marker, taking the deny store with it.
    rmSync(join(root, '.adlc'), { recursive: true, force: true });

    ctx.getContextUsage = () => ({ percent: HARD_PCT, tokens: 1 });
    const verdict = await call(pi, ctx, 'edit', { path: join(root, 'src', 'a.mjs') });
    assert.equal(verdict?.block, true, 'a repo that opted in stays enforced for the session');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a repo that never opted in stays inert even after the memory is used', () => {
  // The monotonic memory must be per-root: remembering repo A must not arm
  // repo B, or containment is undone by the fix for it.
  const adlcRoots = createAdlcRootState();
  const armed = makeRepo();
  const never = makeBareDir();
  try {
    const ask = (root) =>
      checkHandoff({
        toolName: 'edit',
        input: { path: 'a.txt' },
        sessionId: 'sess-1',
        usage: { percent: HARD_PCT },
        root,
        adlcRoots,
      }).decision;

    assert.equal(ask(armed), 'deny', 'the opted-in repo arms the memory');
    assert.equal(ask(never), 'allow', 'a different, never-opted-in repo stays inert');
    assert.equal(existsSync(join(never, '.adlc')), false, 'and gains no state');

    rmSync(join(armed, '.adlc'), { recursive: true, force: true });
    assert.equal(ask(armed), 'deny', 'the remembered root stays enforced');
    assert.equal(ask(never), 'allow', 'the never-opted-in one still does not');
  } finally {
    rmSync(armed, { recursive: true, force: true });
    rmSync(never, { recursive: true, force: true });
  }
});

test('the opt-in memory is keyed by canonical path, not by spelling', () => {
  // Same checkout, three spellings. If the memory keys on the raw string, an
  // agent that removes `.adlc` and then reaches the repo through a symlink or
  // an un-normalized cwd walks past the monotonic guard.
  const adlcRoots = createAdlcRootState();
  const real = realpathSync(mkdtempSync(join(tmpdir(), 'adlc-pi-canon-')));
  const linkDir = realpathSync(mkdtempSync(join(tmpdir(), 'adlc-pi-canonlink-')));
  const link = join(linkDir, 'repo');
  try {
    mkdirSync(join(real, '.adlc'), { recursive: true });
    symlinkSync(real, link);
    const ask = (root) =>
      checkHandoff({
        toolName: 'edit',
        input: { path: 'a.txt' },
        sessionId: 'sess-1',
        usage: { percent: HARD_PCT },
        root,
        adlcRoots,
        // A stub evaluator keeps this about containment only, and stops a real
        // deny from re-creating `.adlc` and re-arming the root behind the test.
        evaluate: () => ({ deny: true, reasons: ['D1:band'] }),
      }).decision;

    assert.equal(ask(real), 'deny', 'arm through the canonical path');
    rmSync(join(real, '.adlc'), { recursive: true, force: true });

    assert.equal(ask(real), 'deny', 'canonical path stays enforced');
    assert.equal(ask(join(real, '.')), 'deny', 'an un-normalized spelling too');
    assert.equal(ask(link), 'deny', 'and a symlink to the same checkout');
  } finally {
    rmSync(real, { recursive: true, force: true });
    rmSync(linkDir, { recursive: true, force: true });
  }
});

test('the opt-in memory outlives an extension reload within the process', async () => {
  // A fresh extension instance must not be a way to forget that this repo
  // opted in — otherwise "delete .adlc, then reload" is the bypass.
  const root = makeRepo();
  try {
    const first = await boot(root, { percent: 5, sessionId: 'sess-1' });
    await call(first.pi, first.ctx, 'edit', { path: join(root, 'src', 'a.mjs') });

    rmSync(join(root, '.adlc'), { recursive: true, force: true });

    const reloaded = await boot(root, { percent: HARD_PCT, sessionId: 'sess-2' });
    const verdict = await call(reloaded.pi, reloaded.ctx, 'edit', { path: join(root, 'src', 'a.mjs') });
    assert.equal(verdict?.block, true, 'a reload must not forget the opt-in');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a missing or empty root arms nothing — it must not resolve to cwd', () => {
  // `resolve('')` is `process.cwd()`, so a memory that accepted an empty root
  // would record the CURRENT directory as opted in and arm a repo that never
  // was. A non-string root must not throw its way out of the gate either.
  const adlcRoots = createAdlcRootState();
  for (const bogus of ['', null, undefined, 0, {}]) {
    assert.doesNotThrow(() => adlcRoots.record(bogus), `record(${String(bogus)})`);
    assert.equal(adlcRoots.has(bogus), false, `has(${String(bogus)})`);
  }
  assert.equal(adlcRoots.has(process.cwd()), false, 'cwd must not have been armed');

  // And the gate itself stays inert rather than throwing on a rootless call.
  assert.doesNotThrow(() =>
    checkHandoff({
      toolName: 'edit',
      input: { path: 'a.txt' },
      sessionId: 'sess-1',
      usage: { percent: HARD_PCT },
      root: '',
      adlcRoots,
    }),
  );
});

test('the self-deny label is pinned too — it is the path most operators hit', () => {
  // A session whose own window crossed the band is the commonest way to meet
  // this deny, and it takes the BOUND branch of the label. The phrase-by-phrase
  // test above asks as a different session, so it only ever sees the unbound
  // branch; without this, the one-shot honesty could be deleted from the
  // likeliest message and every test would still pass.
  const root = makeRepo();
  try {
    const own = checkHandoff({
      toolName: 'edit',
      input: { path: 'src/a.mjs' },
      sessionId: 'sess-A',
      usage: { percent: HANDOFF_PCT },
      root,
      manifestKey: 'k'.repeat(64),
    });
    assert.equal(own.decision, 'deny');
    assert.match(own.reason, /D2:denier_session/, 'this is the self-deny path');
    assert.ok(
      own.reason.includes('authorizes the NEXT mutation only'),
      'the one-shot claim must survive on the bound branch',
    );
    assert.doesNotMatch(own.reason, /--unbound-reason/, 'a session clearing its own record stays bound');
    assert.doesNotMatch(own.reason, /fresh session/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a deny with no usable session id still refuses the fresh-session lie', () => {
  // D0:invalid_session_id is a live path — an unresolvable or unsafe id reaches
  // the gate as null and denies — and it renders formatNoSessionIdMessage,
  // which no other test reaches. The canonical package's wording for this case
  // tells the operator to start a new session; that is exactly the claim this
  // branch deletes, so the local twin must not drift back into it.
  const root = makeRepo();
  try {
    for (const sessionId of [null, '../escape']) {
      const verdict = checkHandoff({
        toolName: 'edit',
        input: { path: 'src/a.mjs' },
        sessionId,
        usage: { percent: HANDOFF_PCT },
        root,
      });
      assert.equal(verdict.decision, 'deny', `${sessionId} must fail closed`);
      assert.match(verdict.reason, /D0:invalid_session_id/);
      assert.doesNotMatch(verdict.reason, /fresh session/i, 'the deleted lie must not return here');
      assert.ok(
        verdict.reason.includes('reaches a new session as well'),
        'must still say a new session does not clear it',
      );
      assert.doesNotMatch(verdict.reason, /bypass --session/, 'no --session command exists without an id');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('shell metacharacters in a repo path are quoted, never emitted bare', () => {
  // The printed command is copy-pasted into a shell. A path carrying `;`, `$`,
  // `&` or a space must come back single-quoted, or the diagnostic hands the
  // operator a second command. Mirrors the canonical fixture in
  // packages/context-handoff/adapter-test/recovery-exception.test.mjs.
  const base = {
    interpreterPath: '/usr/bin/node',
    scriptPath: '/opt/adlc/bin/handoff.mjs',
    sessionId: 'sess-a',
  };
  for (const adlcDir of [
    '/srv/a;rm -rf ~/x/.adlc',
    '/srv/$(id)/.adlc',
    '/srv/a&&touch pwned/.adlc',
    '/srv/my repo/.adlc',
    '/srv/a|b/.adlc',
  ]) {
    const command = formatRecoveryCommand({ ...base, adlcDir });
    assert.ok(command.includes(`--dir '${adlcDir}'`), `must single-quote ${adlcDir}: ${command}`);
  }
  // A path with nothing special stays unquoted, so the quoting is real and not
  // an unconditional wrap that would prove nothing.
  assert.ok(formatRecoveryCommand({ ...base, adlcDir: '/srv/plain/.adlc' }).includes('--dir /srv/plain/.adlc '));
});

test('a diagnostic that cannot be a command is never labelled as one', () => {
  // The label and the command come from one representability test; if they
  // disagree, prose gets announced as something to paste.
  const unquotable = handoffRecoveryDiagnostic({
    sessionId: 'sess-a',
    root: "/srv/it's",
    hasManifestKey: true,
    cliPath: '/opt/adlc/bin/handoff.mjs',
  });
  assert.match(unquotable, /cannot be printed as a safe/);
  assert.doesNotMatch(unquotable, /One-shot host-side grant.*: /, 'prose must not wear a command label');
  // And the unsafe-path prose keeps the manual recipe, not just an apology.
  assert.match(unquotable, /bypass --session sess-a/, 'names the subcommand to run by hand');
  assert.match(unquotable, /interpreter at .*script at /, 'names both binaries');
});

test('the keyless recipe names the legacy sentinel, so it terminates', () => {
  // A repo carrying the pre-migration .adlc/handoffs/.deny-store re-creates the
  // canonical sentinel from it on the next read, so a recipe naming only
  // .adlc/.deny-store loops forever on D0:deny_store_unavailable. Measured.
  const root = makeRepo();
  try {
    checkHandoff({
      toolName: 'edit',
      input: { path: 'src/a.mjs' },
      sessionId: 'sess-A',
      usage: { percent: HANDOFF_PCT },
      root,
    });
    writeFileSync(join(root, '.adlc', 'handoffs', '.deny-store'), '1\n');

    const text = checkHandoff({
      toolName: 'edit',
      input: { path: 'src/a.mjs' },
      sessionId: 'sess-B',
      root,
    }).reason;
    assert.ok(text.includes('.adlc/handoffs/.deny-store'), 'the legacy sentinel must be named');

    // Follow the printed recipe literally, then confirm it actually cleared.
    for (const f of readdirSync(join(root, '.adlc', 'handoffs', 'denies'))) {
      if (f.endsWith('.json')) rmSync(join(root, '.adlc', 'handoffs', 'denies', f));
    }
    rmSync(join(root, '.adlc', '.deny-store'), { force: true });
    rmSync(join(root, '.adlc', 'handoffs', '.deny-store'), { force: true });
    assert.equal(
      checkHandoff({ toolName: 'edit', input: { path: 'src/a.mjs' }, sessionId: 'sess-B', root }).decision,
      'allow',
      'the recipe as printed must terminate',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a session started in a subdirectory is still inside the repo', () => {
  // Containment asks whether this path is INSIDE an ADLC repo, not whether it
  // is one. pi hands the gate its cwd, which is routinely a subdirectory, and
  // an exact-match check let a session in <repo>/src walk past an open
  // repo-wide deny — and, before that, wrote band markers into a stray
  // <repo>/src/.adlc that no operator would think to clear.
  const root = makeRepo();
  try {
    const sub = join(root, 'src', 'deep');
    mkdirSync(sub, { recursive: true });

    // Session A trips the band at the repo root and leaves an open marker.
    checkHandoff({
      toolName: 'edit',
      input: { path: 'a.txt' },
      sessionId: 'sess-A',
      usage: { percent: HANDOFF_PCT },
      root,
    });

    const fromSub = checkHandoff({
      toolName: 'edit',
      input: { path: 'a.txt' },
      sessionId: 'sess-B',
      usage: { percent: 5 },
      root: sub,
    });
    assert.equal(fromSub.decision, 'deny', 'the open deny reaches a session started in a subdirectory');
    assert.match(fromSub.reason, /D3:unauthorized_open:sess-A/);
    assert.equal(
      existsSync(join(sub, '.adlc')),
      false,
      'and no stray .adlc is created beside the subdirectory',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the walk stops at a nested checkout — it is its own project', () => {
  // A repo vendored inside an ADLC repo must not be captured by it, or the
  // blocker this branch fixes comes back for anyone whose scratch checkout
  // happens to live under one.
  const root = makeRepo();
  try {
    const nested = join(root, 'vendor', 'other-project');
    mkdirSync(join(nested, '.git'), { recursive: true });
    // The memory MUST be threaded here, exactly as the extension threads it:
    // without it this test passes against a boundary check that only exists on
    // the live lookup, while the remembered-root lookup captures the nested
    // checkout anyway.
    const adlcRoots = createAdlcRootState();
    const ask = (r) =>
      checkHandoff({
        toolName: 'edit',
        input: { path: 'a.txt' },
        sessionId: 'sess-1',
        usage: { percent: HARD_PCT },
        root: r,
        adlcRoots,
      }).decision;

    assert.equal(ask(root), 'deny', 'the outer repo arms the memory');
    assert.equal(ask(nested), 'allow', 'a nested checkout is not the outer ADLC repo');
    assert.equal(existsSync(join(nested, '.adlc')), false);

    // And still not, once the outer opt-in is only a memory.
    rmSync(join(root, '.adlc'), { recursive: true, force: true });
    assert.equal(ask(root), 'deny', 'the outer repo stays remembered');
    assert.equal(ask(nested), 'allow', 'the boundary holds for the remembered root too');
    assert.equal(existsSync(join(nested, '.adlc')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveAdlcRoot finds the repo, the nested boundary, or nothing', () => {
  const root = makeRepo();
  try {
    const sub = join(root, 'a', 'b', 'c');
    mkdirSync(sub, { recursive: true });
    assert.equal(resolveAdlcRoot(root), realpathSync(root));
    assert.equal(resolveAdlcRoot(sub), realpathSync(root), 'walks up to the ADLC root');

    const bare = makeBareDir();
    assert.equal(resolveAdlcRoot(bare), null, 'a directory outside any ADLC repo');
    for (const bogus of ['', null, undefined, 0, {}]) {
      assert.equal(resolveAdlcRoot(bogus), null, `resolveAdlcRoot(${String(bogus)})`);
    }
    rmSync(bare, { recursive: true, force: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the README's keyless command clears a repo with several markers and a legacy sentinel", () => {
  // Runs the documented recipe VERBATIM against the worst realistic state —
  // two open markers owned by other sessions, plus the pre-migration sentinel.
  // The earlier singular form ("rm .../<session-id>.json .adlc/.deny-store")
  // left both of those behind and the operator permanently locked out.
  const root = makeRepo();
  try {
    for (const sessionId of ['sess-A', 'sess-B']) {
      checkHandoff({
        toolName: 'edit',
        input: { path: 'src/a.mjs' },
        sessionId,
        usage: { percent: HANDOFF_PCT },
        root,
      });
    }
    writeFileSync(join(root, '.adlc', 'handoffs', '.deny-store'), '1\n');

    const ask = () =>
      checkHandoff({ toolName: 'edit', input: { path: 'src/a.mjs' }, sessionId: 'sess-C', root })
        .decision;
    assert.equal(ask(), 'deny', 'a third session is denied by the others');

    // The exact command the README prints, run from the repo root.
    const command = readFileSync(join(REPO_ROOT, 'plugins', 'adlc-pi', 'README.md'), 'utf8')
      .split('\n')
      .find((line) => line.startsWith('rm -f .adlc/handoffs/denies/'));
    assert.ok(command, 'the README must still document a concrete keyless command');
    const run = spawnSync(command, { shell: true, cwd: root, encoding: 'utf8' });
    assert.equal(run.status, 0, `documented command failed: ${run.stderr}`);

    assert.equal(ask(), 'allow', 'the documented recipe must actually clear the repo');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a different checkout moved to a remembered path is not the remembered repo', () => {
  // The memory has to tell two things apart that look identical from the path
  // alone: `.adlc` deleted out from under an opted-in repo (must keep
  // enforcing — that is the off switch) and the whole checkout replaced by
  // another project (must NOT enforce, or the blocker comes back as stray
  // .adlc state in a repo that never opted in). Filesystem identity separates
  // them.
  //
  // The replacement is built elsewhere and renamed into place, so its inode is
  // allocated while the original still exists and is therefore guaranteed
  // distinct — a delete-then-recreate could reuse the freed inode and flake.
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'adlc-pi-swap-')));
  const path = join(parent, 'workspace');
  const replacement = join(parent, 'other-project');
  try {
    mkdirSync(join(path, '.adlc'), { recursive: true });
    mkdirSync(join(replacement, '.git'), { recursive: true });

    const adlcRoots = createAdlcRootState();
    const ask = () =>
      checkHandoff({
        toolName: 'edit',
        input: { path: 'a.txt' },
        sessionId: 'sess-1',
        usage: { percent: HARD_PCT },
        root: path,
        adlcRoots,
      }).decision;

    assert.equal(ask(), 'deny', 'the opted-in checkout arms the memory');

    // Same path, different checkout.
    rmSync(path, { recursive: true, force: true });
    renameSync(replacement, path);

    assert.equal(ask(), 'allow', 'a replacement checkout is not the repo that opted in');
    assert.equal(existsSync(join(path, '.adlc')), false, 'and gains no ADLC state');
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('deleting only .adlc still keeps the SAME checkout enforced', () => {
  // The other half of the pair above: identical from the path, opposite
  // answer, because the directory itself is unchanged.
  const root = makeRepo();
  try {
    const adlcRoots = createAdlcRootState();
    const ask = () =>
      checkHandoff({
        toolName: 'edit',
        input: { path: 'a.txt' },
        sessionId: 'sess-1',
        usage: { percent: HARD_PCT },
        root,
        adlcRoots,
      }).decision;
    assert.equal(ask(), 'deny');
    rmSync(join(root, '.adlc'), { recursive: true, force: true });
    assert.equal(ask(), 'deny', 'removing .adlc is not a way to be forgotten');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
