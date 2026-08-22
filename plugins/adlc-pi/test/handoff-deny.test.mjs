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

import { READONLY_TOOLS } from '../lib/rails-checker.mjs';
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
  hasProtectedPathFault,
  hasStoreIntegrityFault,
  resolveRecoveryCliPath,
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
 * Install ADLC in a directory the way the predicate actually tests for it: a
 * ticket store, not a bare `.adlc/`. A directory holding only `.adlc/` is what
 * the pre-fix bug left behind, and it must NOT read as an installed repo.
 * @param {string} dir
 * @returns {string} dir
 */
function makeCheckout(dir) {
  mkdirSync(join(dir, '.git'), { recursive: true });
  // A bare `mkdir .git` is what an AGENT can produce; a real checkout has HEAD.
  writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  return dir;
}

function installAdlc(dir) {
  mkdirSync(join(dir, '.adlc'), { recursive: true });
  writeFileSync(join(dir, '.adlc', 'tickets.json'), JSON.stringify({ tickets: [TICKET] }));
  return dir;
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
const PLUMBING_ROOT = installAdlc(realpathSync(mkdtempSync(join(tmpdir(), 'adlc-pi-plumbing-'))));
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
    // A bare `.adlc/` is what the old bug left lying around; it must not arm.
    mkdirSync(join(root, '.adlc'), { recursive: true });
    assert.equal(checkHandoff(args).decision, 'allow', 'a bare .adlc/ is not an install');
    installAdlc(root);
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
    assert.match(verdict.reason, /rm -rf \S*\/\.adlc\/handoffs \S*\/\.adlc\/\.deny-store/, 'one safe command, absolute');
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
  assert.match(diagnostic, /resolve `\.adlc` first/, 'the keyless path needs no CLI at all');
  // The global install route is @adlc/cli, whose bin is `adlc`; context-handoff's
  // own `handoff` bin is a transitive dependency's and is not on PATH after it.
  assert.match(diagnostic, /`adlc handoff bypass\|repair\|resume`/, 'names the bin that exists');
  assert.doesNotMatch(diagnostic, /bin: handoff /, 'not the unlinked transitive bin');
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
      keyless.includes('authorizes the NEXT gated tool call only'),
      'must not present a one-shot grant as a clear, nor overstate what spends it',
    );
    // Measured: unlock is keyless but reclaims a lock, not a deny.
    assert.ok(
      keyless.includes('`adlc handoff unlock` needs no key but reclaims a session lock, not a deny'),
      'must say why the one keyless verb is not the answer',
    );
    // Measured: removing the marker without the sentinel still denies.
    assert.match(
      keyless,
      /rm -rf \S*\/\.adlc\/handoffs \S*\/\.adlc\/\.deny-store/,
      'the whole tree and the sentinel, by resolved absolute path',
    );
    assert.ok(
      keyless.includes('Do not pick off one marker or glob inside'),
      'the half-recipe and the glob are both what an operator would otherwise try',
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
    installAdlc(real);
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
      own.reason.includes('authorizes the NEXT gated tool call only'),
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
    assert.match(text, /rm -rf \S+\/handoffs \S+\/\.deny-store/, 'the whole tree, in one command');
    assert.doesNotMatch(text, /denies\/\*/, 'never a glob: it expands through a symlink');

    // Run the command the MESSAGE prints, parsed out of it, in a shell whose
    // cwd is the repo — the same standard the foreign-deny e2e uses. Hardcoding
    // the paths here would let the printed recipe drift away from the one that
    // works without any test noticing.
    const recipe = /`(rm -rf [^`]+)`/.exec(text)?.[1];
    assert.ok(recipe, `no removal command in the message:\n${text}`);
    const run = spawnSync(recipe, { shell: true, cwd: root, encoding: 'utf8' });
    assert.equal(run.status, 0, `printed recipe failed: ${run.stderr}`);
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

test('a .git boundary picks which store applies — it does not release enforcement', () => {
  // The boundary exists so a genuinely vendored checkout keeps its OWN deny
  // store. It must not become a way to switch enforcement off, because `.git`
  // is a directory an agent can create: measured before this, `mkdir src/.git`
  // under an armed repo turned deny into allow.
  //
  // So a remembered root outranks the boundary. The cost is that a vendored
  // checkout inside a repo this process has already armed answers to the outer
  // store — over-enforcing, which is the safe side of a distinction the
  // filesystem cannot make, and correct anyway: the deny is about THIS
  // session's context rot, not about which project owns the file.
  const root = makeRepo();
  try {
    const nested = join(root, 'vendor', 'other-project');
    makeCheckout(nested);
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
    assert.equal(ask(nested), 'deny', 'a hand-made .git under an armed repo is not an escape');

    // The same holds once the outer opt-in survives only as a memory.
    rmSync(join(root, '.adlc'), { recursive: true, force: true });
    assert.equal(ask(nested), 'deny', 'and still not, once the opt-in is only remembered');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an unarmed outer repo leaves a vendored checkout its own store', () => {
  // The other side of the same rule: with nothing remembered, the boundary does
  // its intended job — a nested checkout carrying its own ticket store answers
  // to that store, not to the enclosing repo's.
  const root = makeRepo();
  try {
    const nested = join(root, 'vendor', 'other-project');
    makeCheckout(nested);
    installAdlc(nested);

    assert.equal(resolveAdlcRoot(nested), realpathSync(nested), 'its own store, not the outer one');
    assert.equal(resolveAdlcRoot(join(root, 'src')), realpathSync(root), 'an ordinary subdir is the repo');

    // And a nested checkout with NO store of its own is simply not an ADLC repo
    // when nothing above it has been armed.
    const bare = join(root, 'vendor', 'plain');
    makeCheckout(bare);
    assert.equal(resolveAdlcRoot(bare), null);
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

    // Run the command the MESSAGE prints — it carries resolved absolute paths,
    // so it is the authoritative one an operator copies. The README documents
    // the same shape with a `<repo>` placeholder, asserted separately.
    const printed = checkHandoff({
      toolName: 'edit',
      input: { path: 'src/a.mjs' },
      sessionId: 'sess-C',
      root,
    }).reason;
    const command = /`(rm -rf [^`]+)`/.exec(printed)?.[1];
    assert.ok(command, `no removal command in the message:\n${printed}`);
    const run = spawnSync(command, { shell: true, cwd: root, encoding: 'utf8' });
    assert.equal(run.status, 0, `printed command failed: ${run.stderr}`);

    const readme = readFileSync(join(REPO_ROOT, 'plugins', 'adlc-pi', 'README.md'), 'utf8');
    assert.ok(
      readme.includes('rm -rf <repo>/.adlc/handoffs <repo>/.adlc/.deny-store'),
      'the README must document the same two targets',
    );

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
    installAdlc(path);
    makeCheckout(replacement);

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

test('a non-mutating gated call spends the grant, and the text says so', () => {
  // "authorizes the NEXT mutation" was wrong: pi gates every tool but a read,
  // and the shared adapter consumes a verified grant on any gated call whose
  // other reasons are clear. A `bash pwd` therefore spends it without touching
  // anything, and an operator told otherwise loses their one shot to a
  // diagnostic command.
  const key = 'k'.repeat(64);
  const root = makeRepo();
  try {
    checkHandoff({
      toolName: 'edit',
      input: { path: 'src/a.mjs' },
      sessionId: 'sess-A',
      usage: { percent: HANDOFF_PCT },
      root,
    });
    const ask = (toolName, input) =>
      checkHandoff({ toolName, input, sessionId: 'sess-B', root, manifestKey: key }).decision;

    assert.equal(ask('edit', { path: 'src/a.mjs' }), 'deny');
    const cli = resolveRecoveryCliPath();
    const grant = spawnSync(
      process.execPath,
      [cli, 'bypass', '--session', 'sess-B', '--unbound-reason', 'pi-handoff-operator-recovery',
        '--dir', join(root, '.adlc'), '--write'],
      { env: { ...process.env, ADLC_MANIFEST_KEY: key }, encoding: 'utf8' },
    );
    assert.equal(grant.status, 0, grant.stderr);

    assert.equal(ask('bash', { command: 'pwd' }), 'allow', 'a read-only shell call is still gated');
    assert.equal(ask('edit', { path: 'src/a.mjs' }), 'deny', 'and it spent the grant');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a store-integrity deny does not advertise a grant that cannot clear it', () => {
  // Measured: against D0:deny_store_unavailable BOTH grant forms exit 0, are
  // consumed, and leave the session denied. Printing one as the recovery is
  // the same false instruction this gate exists to stop giving.
  const root = makeRepo();
  try {
    checkHandoff({
      toolName: 'edit',
      input: { path: 'src/a.mjs' },
      sessionId: 'sess-A',
      usage: { percent: HANDOFF_PCT },
      root,
    });
    // Emptied denies/ while the sentinel remains == the store is unavailable.
    rmSync(join(root, '.adlc', 'handoffs', 'denies', 'sess-A.json'));

    const verdict = checkHandoff({
      toolName: 'edit',
      input: { path: 'src/a.mjs' },
      sessionId: 'sess-A',
      root,
      manifestKey: 'k'.repeat(64),
    });
    assert.equal(verdict.decision, 'deny');
    assert.ok(hasStoreIntegrityFault(verdict.reasons), `expected a store fault: ${verdict.reasons}`);
    assert.ok(
      verdict.reason.includes('Only the unbound form above lifts it'),
      'the text must name the grant form that actually works',
    );
    assert.match(verdict.reason, /--unbound-reason/, 'and offer it');
    assert.match(
      verdict.reason,
      /rm -rf \S+\/handoffs \S+\/\.deny-store/,
      'and must point at the store repair that does',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('hasStoreIntegrityFault names store faults and nothing else', () => {
  for (const reason of ['D0:deny_store_unavailable', 'D0:invalid_deny_records', 'D3:invalid_record']) {
    assert.equal(hasStoreIntegrityFault([reason]), true, reason);
  }
  for (const reason of ['D3:unauthorized_open:sess-A', 'D2:denier_session', 'D1:process_sticky']) {
    assert.equal(hasStoreIntegrityFault([reason]), false, reason);
  }
  assert.equal(hasStoreIntegrityFault(undefined), false);
});

test('a relative custom-tool target is reported against the session cwd', () => {
  // Containment resolves the REPO root, but a tool's relative path is relative
  // to the SESSION's cwd. Conflating the two misreports which file was touched
  // — `a.txt` from <repo>/src is `src/a.txt`, not `a.txt`. No bypass rides on
  // it (every spelling of a protected path denies either way, asserted below),
  // but the deny-set is told the wrong filename.
  const root = makeRepo();
  try {
    const sub = join(root, 'src');
    mkdirSync(sub, { recursive: true });

    const seen = [];
    checkHandoff({
      toolName: 'some_custom_tool',
      input: { target: 'a.txt' },
      sessionId: 'sess-1',
      usage: { percent: 5 },
      root: sub,
      evaluate: (o) => {
        seen.push(...o.editRelPaths);
        return { deny: false, reasons: [] };
      },
    });
    assert.deepEqual(seen, ['src/a.txt'], 'relative to the session, expressed against the repo');

    // And the protected store is denied however it is spelled from there.
    for (const target of [join('..', '.adlc', '.deny-store'), join(root, '.adlc', '.deny-store')]) {
      const verdict = checkHandoff({
        toolName: 'some_custom_tool',
        input: { target },
        sessionId: 'sess-1',
        usage: { percent: 5 },
        root: sub,
      });
      assert.equal(verdict.decision, 'deny', `must deny ${target}`);
      assert.match(verdict.reason, /path_protected/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a suffixed invalid-record reason is still a store fault', () => {
  // The shared gate emits `D3:invalid_record:<label>`, never the bare code —
  // an exact-string classifier silently missed every real one, exactly as
  // `D3:unauthorized_open:<id>` would have.
  assert.equal(hasStoreIntegrityFault(['D3:invalid_record:sess-A.json']), true);
  assert.equal(hasStoreIntegrityFault(['D3:invalid_record:?']), true);
  assert.equal(hasStoreIntegrityFault(['D3:invalid_record']), true);
  // And the neighbouring D3 must not be swept in with it: an unauthorized open
  // record IS clearable by an unbound grant, so it must keep offering one.
  assert.equal(hasStoreIntegrityFault(['D3:unauthorized_open:sess-A']), false);
});

test('a store-integrity deny gets the UNBOUND grant, which is what lifts it', () => {
  // The shared gate lifts D0/D3:invalid_record only for an unbound operator
  // override — measured: unbound clears a clean store fault, bound does not.
  // Withholding the command here (an earlier mistake of mine) sent keyed
  // operators to delete files when a non-destructive repair existed.
  const diagnostic = handoffRecoveryDiagnostic({
    sessionId: 'sess-a',
    root: '/srv/repo',
    reasons: ['D0:deny_store_unavailable'],
    hasManifestKey: true,
    cliPath: '/opt/adlc/bin/handoff.mjs',
  });
  assert.match(diagnostic, /bypass --session sess-a --unbound-reason/, 'a store fault needs the unbound form');
  assert.match(diagnostic, /unbound because the deny reports the store itself/, 'and says why');
  assert.doesNotMatch(diagnostic, /belongs to another session/, 'not the foreign-record reason');
  assert.match(diagnostic, /Only the unbound form above lifts it/);
  assert.match(diagnostic, /rm -rf \S+\/handoffs \S+\/\.deny-store/, 'and names the durable repair');

  // A normal deny still gets its command.
  assert.match(
    handoffRecoveryDiagnostic({
      sessionId: 'sess-a',
      root: '/srv/repo',
      reasons: ['D3:unauthorized_open:sess-b'],
      hasManifestKey: true,
      cliPath: '/opt/adlc/bin/handoff.mjs',
    }),
    /bypass --session sess-a --unbound-reason/,
  );
});

test('the command printed for a store fault actually lifts it', () => {
  // The end-to-end check that would have caught my own false claim: run the
  // exact string the store-fault message prints and see whether the next call
  // is allowed. It is — the unbound form lifts D0 where a bound one does not.
  const key = 'k'.repeat(64);
  const root = makeRepo();
  try {
    checkHandoff({
      toolName: 'edit',
      input: { path: 'src/a.mjs' },
      sessionId: 'sess-A',
      usage: { percent: HANDOFF_PCT },
      root,
    });
    // Emptied denies/ with the sentinel still present == store unavailable.
    rmSync(join(root, '.adlc', 'handoffs', 'denies', 'sess-A.json'));

    const ask = () =>
      checkHandoff({ toolName: 'edit', input: { path: 'src/a.mjs' }, sessionId: 'sess-B', root, manifestKey: key });
    const denied = ask();
    assert.deepEqual(denied.reasons, ['D0:deny_store_unavailable'], 'a clean store fault, nothing else');

    const command = denied.reason
      .split('\n')
      .find((line) => line.includes('bypass --session'))
      ?.replace(/^[^:]*: /, '');
    assert.ok(command, `no command printed for a store fault:\n${denied.reason}`);

    const run = spawnSync(command, {
      shell: true,
      cwd: realpathSync(tmpdir()),
      env: { ...process.env, ADLC_MANIFEST_KEY: key },
      encoding: 'utf8',
    });
    assert.equal(run.status, 0, `printed command failed: ${run.stderr}`);
    assert.equal(ask().decision, 'allow', 'the printed command must lift the store fault');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a protected-path deny offers no grant, because none lifts it', () => {
  // Measured: with a verified unbound grant in place, a tool naming
  // `.adlc/.deny-store` is still denied and the grant is not consumed. Offering
  // one spends the operator's single shot on a deny it cannot touch.
  const root = makeRepo();
  try {
    const verdict = checkHandoff({
      toolName: 'some_custom_tool',
      input: { target: join(root, '.adlc', '.deny-store') },
      sessionId: 'sess-B',
      root,
      manifestKey: 'k'.repeat(64),
    });
    assert.equal(verdict.decision, 'deny');
    assert.ok(hasProtectedPathFault(verdict.reasons), `expected a protected-path reason: ${verdict.reasons}`);
    assert.doesNotMatch(verdict.reason, /bypass --session/, 'no grant is offered');
    assert.match(verdict.reason, /targets an ADLC artifact the deny-set protects/);
    assert.match(verdict.reason, /target something outside/);
    // Measured asymmetry, and the operator has to be warned about it: a SHELL
    // call naming a protected path is refused but still spends a grant, while
    // a structured tool call does not. The shared adapter claims the grant
    // before its shell scan appends the reasons.
    assert.match(verdict.reason, /SPENDS the grant anyway/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('hasProtectedPathFault covers both protected-path spellings', () => {
  for (const reason of ['path_protected:.adlc/x', 'path_protected_symlink:.adlc/x', 'path_protected_shell:rm']) {
    assert.equal(hasProtectedPathFault([reason]), true, reason);
  }
  for (const reason of ['D3:unauthorized_open:s', 'D0:deny_store_unavailable', 'D1:process_sticky']) {
    assert.equal(hasProtectedPathFault([reason]), false, reason);
  }
  assert.equal(hasProtectedPathFault(undefined), false);
});

test('a nested .adlc cannot outrank the repo it sits in', () => {
  // The escape this closes: an agent below the band creates <repo>/src/.adlc,
  // and a nearest-match walk would then resolve every later call to that empty
  // store, stepping around the outer repo's open deny. Measured before the
  // fix: deny became allow.
  //
  // The trade is deliberate — a nested .adlc with no .git of its own no longer
  // keeps a separate deny store, it answers to the enclosing repo. One
  // checkout, one ADLC root. An independent nested checkout still keeps its
  // own, because the walk stops at its .git (asserted separately below).
  const root = makeRepo();
  try {
    makeCheckout(root);
    const sub = join(root, 'src');
    mkdirSync(sub, { recursive: true });

    const adlcRoots = createAdlcRootState();
    const ask = (r) =>
      checkHandoff({
        toolName: 'edit',
        input: { path: 'a.txt' },
        sessionId: 'sess-B',
        root: r,
        adlcRoots,
      }).decision;

    // Session A leaves an open, repo-wide deny.
    checkHandoff({
      toolName: 'edit',
      input: { path: 'a.txt' },
      sessionId: 'sess-A',
      usage: { percent: HANDOFF_PCT },
      root,
      adlcRoots,
    });
    assert.equal(ask(sub), 'deny', 'the subdirectory answers to the repo');

    // The strongest form of the escape: the agent plants a complete, valid
    // ticket store, not just a directory.
    installAdlc(sub);
    assert.equal(ask(sub), 'deny', 'and a store planted underneath does not change that');

    assert.equal(resolveAdlcRoot(sub), realpathSync(root), 'the repo root is still the root');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a .adlc above the checkout cannot capture it either', () => {
  // The same boundary in the other direction: the walk stops at .git, so an
  // ADLC directory in some parent of the checkout is not this repo's root.
  const outer = realpathSync(mkdtempSync(join(tmpdir(), 'adlc-pi-above-')));
  try {
    installAdlc(outer);
    const checkout = join(outer, 'project');
    makeCheckout(checkout);

    assert.equal(resolveAdlcRoot(checkout), null, 'the checkout did not opt in');
    assert.equal(
      checkHandoff({
        toolName: 'edit',
        input: { path: 'a.txt' },
        sessionId: 'sess-1',
        usage: { percent: HARD_PCT },
        root: checkout,
      }).decision,
      'allow',
    );
    assert.equal(existsSync(join(checkout, '.adlc')), false);
  } finally {
    rmSync(outer, { recursive: true, force: true });
  }
});

test('every tool the rail checker calls read-only stays usable under a deny', () => {
  // Two hand-kept lists had drifted: `find` is a real pi read-only tool the
  // rail checker classifies as one, and the handoff gate's private list
  // omitted it — so an open deny confiscated the tool an operator needs to
  // work out what is wrong, contradicting the documented "reads stay open".
  for (const tool of READONLY_TOOLS) {
    assert.equal(handoffAppliesTo(tool), false, `${tool} is read-only per the rail checker`);
  }
  for (const tool of ['glob', 'list']) {
    assert.equal(handoffAppliesTo(tool), false, `${tool} must stay ungated too`);
  }
  for (const tool of ['write', 'edit', 'bash', 'some_custom_tool']) {
    assert.equal(handoffAppliesTo(tool), true, `${tool} must stay gated`);
  }
});

test('a deny with no usable session id promises no grant behaviour', () => {
  // formatRecoveryCommand degrades to prose when no --session command can be
  // built; appending "that grant is consumed by…" then describes a grant that
  // was never offered.
  const diagnostic = handoffRecoveryDiagnostic({
    sessionId: null,
    root: '/srv/repo',
    reasons: ['D3:unauthorized_open:sess-a'],
    hasManifestKey: true,
    cliPath: '/opt/adlc/bin/handoff.mjs',
  });
  assert.doesNotMatch(diagnostic, /bypass --session/, 'no command can be built');
  assert.doesNotMatch(diagnostic, /That grant is consumed/, 'so promise nothing about one');
  assert.match(diagnostic, /reaches a new session as well/);

  // With a usable id the follow-up is present again.
  assert.match(
    handoffRecoveryDiagnostic({
      sessionId: 'sess-b',
      root: '/srv/repo',
      reasons: ['D3:unauthorized_open:sess-a'],
      hasManifestKey: true,
      cliPath: '/opt/adlc/bin/handoff.mjs',
    }),
    /That grant is consumed/,
  );
});

test('the unresolved-CLI fallback names the unbound form for a store fault', () => {
  const storeFault = handoffRecoveryDiagnostic({
    sessionId: 'sess-a',
    root: '/srv/repo',
    reasons: ['D0:deny_store_unavailable'],
    hasManifestKey: true,
    cliPath: null,
  });
  assert.match(storeFault, /--unbound-reason/, 'a bound grant does not lift a store fault');

  const ordinary = handoffRecoveryDiagnostic({
    sessionId: 'sess-a',
    root: '/srv/repo',
    reasons: ['D2:denier_session'],
    hasManifestKey: true,
    cliPath: null,
  });
  assert.match(ordinary, /bypass\|repair\|resume/);
});

test('a directory contaminated by the old bug is not an ADLC repo', () => {
  // The blocker left `.adlc/.deny-store` and markers in ordinary directories.
  // Gating containment on the mere presence of `.adlc` lets those artifacts
  // vouch for the gate that created them, so a repo already hit by the bug
  // stays bricked by the very fix meant to unbrick it. The ticket store — the
  // plugin's own "ADLC is installed here" test — is what decides.
  const root = makeBareDir();
  try {
    // Exactly what the pre-fix gate left behind: deny state, no ticket store.
    mkdirSync(join(root, '.adlc', 'handoffs', 'denies'), { recursive: true });
    writeFileSync(join(root, '.adlc', '.deny-store'), JSON.stringify({ schema: 1, sessions: ['old'] }));
    writeFileSync(
      join(root, '.adlc', 'handoffs', 'denies', 'old.json'),
      JSON.stringify({ session_id: 'old', ticket_id: null, content_hash: null, status: 'open' }),
    );

    for (const percent of [5, HANDOFF_PCT, HARD_PCT, 95]) {
      for (const [tool, input] of [
        ['edit', { path: 'a.txt' }],
        ['bash', { command: 'npm test' }],
      ]) {
        assert.notEqual(
          checkHandoff({ toolName: tool, input, sessionId: 'sess-1', usage: { percent }, root }).decision,
          'deny',
          `${tool} at ${percent}% must not be denied by the old bug's own leftovers`,
        );
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an external ticket store arms the gate with no local .adlc', () => {
  // The other half, and the fail-open u4 hit: ADLC_TICKET_STORE may be an
  // absolute path to a store outside the worktree, which the rail guard
  // accepts with no local `.adlc`. ANDing a local directory onto the predicate
  // would leave rails enforcing while the deny-set silently stood down.
  const root = makeBareDir();
  const storeHome = makeBareDir();
  try {
    const store = join(storeHome, 'tickets.json');
    writeFileSync(store, JSON.stringify({ tickets: [TICKET] }));
    let evaluatedRoot = null;
    const verdict = checkHandoff({
      toolName: 'edit',
      input: { path: 'a.txt' },
      sessionId: 'sess-1',
      usage: { percent: HARD_PCT },
      root,
      storeOverride: store,
      evaluate: (o) => {
        evaluatedRoot = o.root;
        return { deny: true, reasons: ['D1:band'] };
      },
    });
    assert.equal(verdict.decision, 'deny', 'an external store still means ADLC is in force');
    // And enforcement must land on the WORKING directory. An absolute override
    // is true of every ancestor equally, so letting it drive the walk marched
    // the root up to `/` — where durable deny state would have been written.
    assert.equal(evaluatedRoot, realpathSync(root), 'the repo, not an ancestor');
    assert.equal(resolveAdlcRoot(root, store), realpathSync(root));
    assert.notEqual(resolveAdlcRoot(root, store), '/');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(storeHome, { recursive: true, force: true });
  }
});

test('a bare mkdir .git is not a checkout, even on the first gated call', () => {
  // The remembered-root rule only helps once something has been remembered. A
  // session whose FIRST gated call happens below a freshly created `.git` had
  // no memory to fall back on, so an empty directory was a one-command opt-out
  // of the enclosing repo's deny. A real checkout has HEAD.
  const root = makeRepo();
  try {
    makeCheckout(root);
    const sub = join(root, 'src');
    mkdirSync(join(sub, '.git'), { recursive: true }); // the agent's version: no HEAD

    // Fresh memory: nothing has been armed yet, exactly as on a first call.
    const verdict = checkHandoff({
      toolName: 'edit',
      input: { path: 'a.txt' },
      sessionId: 'sess-1',
      usage: { percent: HARD_PCT },
      root: sub,
      adlcRoots: createAdlcRootState(),
    });
    assert.equal(verdict.decision, 'deny', 'an empty .git does not release the enclosing repo');
    assert.equal(resolveAdlcRoot(sub), realpathSync(root));

    // And giving it a convincing HEAD does not either, because the enclosing
    // repo is a real ADLC repo (git + ticket store). That is the tiebreaker: no
    // filesystem test separates a forged checkout from a real one, so inside a
    // real ADLC repo the boundary does not release enforcement at all — cold,
    // with no remembered root to fall back on.
    writeFileSync(join(sub, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    assert.equal(resolveAdlcRoot(sub), realpathSync(root), 'still the enclosing repo');

    const linked = join(root, 'linked');
    mkdirSync(linked, { recursive: true });
    writeFileSync(join(linked, '.git'), 'gitdir: ../.git/worktrees/linked\n');
    assert.equal(resolveAdlcRoot(linked), realpathSync(root), 'a worktree pointer does not either');

    const forged = join(root, 'forged');
    mkdirSync(forged, { recursive: true });
    for (const content of ['x', '', 'not a gitdir pointer', 'GITDIR: ../elsewhere']) {
      writeFileSync(join(forged, '.git'), content);
      assert.equal(
        resolveAdlcRoot(forged),
        realpathSync(root),
        `a .git file containing ${JSON.stringify(content)} is not a checkout`,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an external store gives one root per checkout, not one per directory', () => {
  // Falling back to the cwd meant each subdirectory became its own handoff
  // root, so deny markers scattered per-directory and an open deny stopped
  // being repo-wide — the durable, cross-session property the whole deny-set
  // rests on.
  const root = makeCheckout(makeBareDir());
  const storeHome = makeBareDir();
  try {
    const store = join(storeHome, 'tickets.json');
    writeFileSync(store, JSON.stringify({ tickets: [TICKET] }));
    const deep = join(root, 'packages', 'a', 'src');
    mkdirSync(deep, { recursive: true });

    assert.equal(resolveAdlcRoot(root, store), realpathSync(root));
    assert.equal(resolveAdlcRoot(deep, store), realpathSync(root), 'the checkout, not the cwd');
    assert.equal(
      resolveAdlcRoot(join(root, 'packages'), store),
      realpathSync(root),
      'and the same root from every depth',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(storeHome, { recursive: true, force: true });
  }
});

test('the enclosing repo is remembered from session start, before any tool call', () => {
  // The residual escape after the boundary was hardened: a `.git` forged
  // BEFORE the session leaves no remembered root to outrank it on the first
  // gated call. Arming at session_start closes that window — the memory is the
  // one signal an agent cannot construct from inside the session.
  const root = makeRepo();
  try {
    makeCheckout(root);
    const sub = join(root, 'src');
    // A convincing forgery, planted before the session ever starts.
    mkdirSync(join(sub, '.git'), { recursive: true });
    writeFileSync(join(sub, '.git', 'HEAD'), 'ref: refs/heads/main\n');

    // The forgery does not win even unarmed: inside a real ADLC repo (git +
    // ticket store) the boundary never releases enforcement. Arming at
    // session_start is the second, independent guarantee this test pins.
    assert.equal(resolveAdlcRoot(sub), realpathSync(root), 'the enclosing repo still answers');

    // session_start resolves from the SESSION's root and records it, so the
    // same call from the subdirectory is outranked by the remembered repo.
    const adlcRoots = createAdlcRootState();
    adlcRoots.record(resolveAdlcRoot(root));
    assert.equal(
      checkHandoff({
        toolName: 'edit',
        input: { path: 'a.txt' },
        sessionId: 'sess-1',
        usage: { percent: HARD_PCT },
        root: sub,
        adlcRoots,
      }).decision,
      'deny',
      'a repo armed at session start is not released by a forged boundary',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('session_start itself arms the memory, through the real extension', async () => {
  // The repo here deliberately has a ticket store but NO `.git`, which is the
  // shape the enclosing-ADLC-repo tiebreaker cannot help with: with no git+store
  // ancestor, a forged `<sub>/.git` IS honoured as a boundary, so the memory
  // armed at session_start is the only thing standing between the agent and an
  // escape. (Inside a real git+store repo the boundary never releases at all —
  // covered separately — which is why this test must not use that shape, or it
  // would pass without the wiring it exists to pin.)
  const root = makeRepo();
  try {
    const sub = join(root, 'src');
    mkdirSync(join(sub, '.git'), { recursive: true });
    writeFileSync(join(sub, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(join(sub, 'a.txt'), 'x\n');

    // Structurally, the forgery DOES win here: no git+store ancestor exists, so
    // the tiebreaker cannot fire and the boundary is honoured. That is what
    // makes this the shape where session_start arming is load-bearing.
    assert.equal(resolveAdlcRoot(sub), null, 'unarmed, the forged boundary is honoured');

    // A session opens in the repo — session_start must record it.
    await boot(root, { percent: 5, sessionId: 'sess-A' });

    // A later session opens inside the forged directory.
    const second = await boot(sub, { percent: HARD_PCT, sessionId: 'sess-B' });
    const verdict = await call(second.pi, second.ctx, 'edit', { path: join(sub, 'a.txt') });
    assert.equal(verdict?.block, true, 'the repo armed at session start outranks the forgery');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the keyless recipe never globs, because a glob leaves the repo', () => {
  // Measured: with `denies` repointed at another directory,
  // `rm .adlc/handoffs/denies/*.json` deletes the files it finds THERE. The
  // printed recipe must stay a directory removal, which takes the symlink
  // rather than following it.
  const text = handoffRecoveryDiagnostic({
    sessionId: 'sess-a',
    root: '/srv/repo',
    reasons: ['D3:unauthorized_open:sess-b'],
    hasManifestKey: false,
    cliPath: '/opt/adlc/bin/handoff.mjs',
  });
  assert.match(text, /rm -rf \S+\/handoffs \S+\/\.deny-store/);
  assert.doesNotMatch(text, /\*/, 'no wildcard anywhere in the recovery text');
  assert.doesNotMatch(text, /rm -rf \.adlc/, 'and never the relative form that follows a symlink');

  // And the same command is what the README documents.
  const readme = readFileSync(join(REPO_ROOT, 'plugins', 'adlc-pi', 'README.md'), 'utf8');
  assert.ok(
    readme.includes('rm -rf <repo>/.adlc/handoffs <repo>/.adlc/.deny-store'),
    'README and runtime text must not drift apart',
  );
  const commandBlock = readme.slice(readme.indexOf('```bash', readme.indexOf('If you do not have the key')));
  assert.ok(
    !commandBlock.slice(0, commandBlock.indexOf('```', 7)).includes('*'),
    'the documented COMMAND must not glob (the prose may still explain why)',
  );
});

test('the printed --dir is the real path, not a symlink to it', () => {
  // `--dir` is pasted into a shell and the CLI insists its last segment is
  // `.adlc`; a symlinked root that resolves elsewhere would hand the operator a
  // path the CLI rejects, or worse, the wrong repo's store. Dropping the
  // realpath survived every other test.
  const real = realpathSync(mkdtempSync(join(tmpdir(), 'adlc-pi-realdir-')));
  const linkHome = realpathSync(mkdtempSync(join(tmpdir(), 'adlc-pi-realdir-link-')));
  const link = join(linkHome, 'repo');
  try {
    installAdlc(real);
    symlinkSync(real, link);
    const viaLink = handoffRecoveryDiagnostic({
      sessionId: 'sess-a',
      root: link,
      reasons: ['D3:unauthorized_open:sess-b'],
      hasManifestKey: true,
      cliPath: '/opt/adlc/bin/handoff.mjs',
    });
    assert.ok(viaLink.includes(`--dir ${join(real, '.adlc')} `), `expected the real path: ${viaLink}`);
    assert.ok(!viaLink.includes(link), 'the symlink must not appear in a pasted command');
  } finally {
    rmSync(real, { recursive: true, force: true });
    rmSync(linkHome, { recursive: true, force: true });
  }
});

test('a deny with no resolved root prints no command rather than the wrong one', () => {
  // `resolve('')` is process.cwd(), so a missing root used to print a --dir
  // naming whatever directory this process sits in — confidently wrong.
  for (const root of [null, undefined, '']) {
    const text = handoffRecoveryDiagnostic({
      sessionId: 'sess-a',
      root,
      reasons: ['D3:unauthorized_open:sess-b'],
      hasManifestKey: true,
      cliPath: '/opt/adlc/bin/handoff.mjs',
    });
    assert.doesNotMatch(text, /--dir ['/]/, `no --dir PATH for root=${String(root)}`);
    assert.doesNotMatch(text, /bypass --session/, 'and no command at all');
    assert.match(text, /No repository root was resolved/);
  }
});

test('an unreadable filesystem identity keeps enforcing, on either side', () => {
  // The fail-closed branch of the checkout-identity check had no test at all:
  // planting `return false` there — turning "cannot tell" into "forget it" —
  // passed the entire suite. Both halves matter, because both mean the same
  // thing operationally: identity could not be established, and a memory that
  // forgets under uncertainty is the off switch it exists to remove.
  const adlcRoots = createAdlcRootState();

  // `now === null`: recorded while the directory existed, unreadable after.
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'adlc-pi-gone-')));
  const root = join(parent, 'repo');
  try {
    installAdlc(root);
    adlcRoots.record(root);
    assert.equal(adlcRoots.has(root), true, 'armed while present');

    renameSync(root, join(parent, 'moved-away'));
    assert.equal(adlcRoots.has(root), true, 'and still armed once it cannot be read');

    // Through the gate: containment must reach evaluation rather than
    // short-circuiting to allow. The evaluator is stubbed so this is a
    // statement about containment only.
    assert.equal(
      checkHandoff({
        toolName: 'edit',
        input: { path: 'a.txt' },
        sessionId: 'sess-1',
        usage: { percent: 5 },
        root,
        adlcRoots,
        evaluate: () => ({ deny: true, reasons: ['D1:band'] }),
      }).decision,
      'deny',
      'a remembered root with no readable identity stays enforced',
    );

    // `recorded === null`: identity was never establishable — a platform
    // without stable inodes, or a path that vanished before the stat.
    const neverThere = join(parent, 'never-existed');
    adlcRoots.record(neverThere);
    assert.equal(adlcRoots.has(neverThere), true, 'unknown at record time also fails closed');
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('a symlinked .adlc shows its real target in the removal command', () => {
  // An external ticket store reached through `.adlc -> /elsewhere` is a
  // supported layout, and `rm -rf .adlc/handoffs` follows the link — measured,
  // it deleted through it. Printing the relative form hid that: the command
  // looked local and reached outside the checkout. The resolved path makes the
  // reach visible BEFORE the operator runs it, which is the honest fix; for a
  // genuine external store deleting there is exactly right, and for a repointed
  // one the operator can see the path is not their repo.
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'adlc-pi-extstore-')));
  try {
    const repo = join(parent, 'repo');
    const store = join(parent, 'external-store');
    mkdirSync(repo, { recursive: true });
    mkdirSync(store, { recursive: true });
    symlinkSync(store, join(repo, '.adlc'));

    const text = handoffRecoveryDiagnostic({
      sessionId: 'sess-a',
      root: repo,
      reasons: ['D3:unauthorized_open:sess-b'],
      hasManifestKey: false,
      cliPath: '/opt/adlc/bin/handoff.mjs',
    });
    assert.ok(
      text.includes(`rm -rf ${store}/handoffs ${store}/.deny-store`),
      `the removal must name the real store:\n${text}`,
    );
    assert.doesNotMatch(text, /rm -rf \.adlc/, 'never the relative form that hides the hop');

    // `--dir` keeps the unresolved spelling on purpose: the CLI requires that
    // argument's last segment to be `.adlc`, which the target is not.
    assert.ok(text.includes(`--dir ${join(repo, '.adlc')} `), 'the CLI argument stays .adlc-suffixed');
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('a forged checkout inside a real ADLC repo cannot release it, even cold', () => {
  // The tiebreaker between two requirements that otherwise conflict, given
  // that no filesystem test separates a forged checkout from a real one:
  //   - a `.git` an agent can create must not release an enclosing ADLC repo;
  //   - a store above an unrelated checkout (a stray ~/.adlc/tickets.json)
  //     must not enforce over every repo beneath it.
  // An enclosing git+store ancestor tells them apart — a home directory is not
  // a checkout. Both halves are asserted here so neither can be traded away.
  const enclosing = makeCheckout(makeRepo()); // a real project: git AND a store
  const home = makeBareDir();
  try {
    const forged = join(enclosing, 'src');
    mkdirSync(forged, { recursive: true });
    makeCheckout(forged);

    // Cold — no memory at all, the case session_start arming cannot help with.
    assert.equal(resolveAdlcRoot(forged), realpathSync(enclosing), 'no escape from a real ADLC repo');
    assert.equal(
      checkHandoff({
        toolName: 'edit',
        input: { path: 'a.txt' },
        sessionId: 'sess-1',
        usage: { percent: HARD_PCT },
        root: forged,
        adlcRoots: createAdlcRootState(),
      }).decision,
      'deny',
    );

    // The other half: a ticket store above a directory that is NOT a checkout
    // must not swallow an unrelated repo beneath it.
    installAdlc(home);
    const unrelated = join(home, 'someones-project');
    mkdirSync(unrelated, { recursive: true });
    makeCheckout(unrelated);
    assert.equal(resolveAdlcRoot(unrelated), null, 'a stray store above must not capture a checkout');
    assert.equal(existsSync(join(unrelated, '.adlc')), false);
  } finally {
    rmSync(enclosing, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('the walk stops at the outermost enclosing ADLC repo, not above it', () => {
  // A regression the tiebreaker introduced and this pins: disabling the
  // boundary whenever ANY ancestor was a real ADLC repo let the walk sail past
  // the outer repo too, so a stray parent `.adlc/tickets.json` outranked the
  // repository itself — the exact shadowing the boundary exists to prevent.
  // The test is per-directory: climb past a boundary only while another real
  // ADLC repo remains ABOVE it.
  const stray = makeBareDir();
  try {
    installAdlc(stray); // a stray store above everything, e.g. a home directory
    const outer = makeCheckout(installAdlc(join(stray, 'outer')));
    const inner = makeCheckout(installAdlc(join(outer, 'inner')));

    assert.equal(resolveAdlcRoot(inner), realpathSync(outer), 'the outer repo, never the stray parent');
    assert.equal(resolveAdlcRoot(outer), realpathSync(outer), 'and the outer repo answers for itself');
    assert.notEqual(resolveAdlcRoot(inner), realpathSync(stray));
  } finally {
    rmSync(stray, { recursive: true, force: true });
  }
});

test('a protected SHELL call spends the grant; a structured one does not', () => {
  // The measured asymmetry the deny text now warns about. The shared adapter
  // claims a verified grant while the reason list is still empty, and bash's
  // protected-path reasons are appended after that — so a shell call naming
  // `.adlc` is refused AND costs the operator their one shot, where the same
  // target through a structured tool costs nothing. Pinning it here means the
  // warning cannot quietly become false if that ordering is ever fixed
  // upstream (the fix belongs in @adlc/context-handoff, not pi).
  const key = 'k'.repeat(64);
  const cli = resolveRecoveryCliPath();
  for (const [label, toolName, makeInput, expected] of [
    ['structured', 'some_custom_tool', (r) => ({ target: join(r, '.adlc', '.deny-store') }), 'allow'],
    ['shell', 'bash', () => ({ command: 'rm .adlc/.deny-store' }), 'deny'],
  ]) {
    const root = makeRepo();
    try {
      checkHandoff({
        toolName: 'edit',
        input: { path: 'src/a.mjs' },
        sessionId: 'sess-A',
        usage: { percent: HANDOFF_PCT },
        root,
      });
      const ask = (tool, input) =>
        checkHandoff({ toolName: tool, input, sessionId: 'sess-B', root, manifestKey: key }).decision;

      const granted = spawnSync(
        process.execPath,
        [cli, 'bypass', '--session', 'sess-B', '--unbound-reason', 'pi-handoff-operator-recovery',
          '--dir', join(root, '.adlc'), '--write'],
        { env: { ...process.env, ADLC_MANIFEST_KEY: key }, encoding: 'utf8' },
      );
      assert.equal(granted.status, 0, granted.stderr);

      assert.equal(ask(toolName, makeInput(root)), 'deny', `${label}: a protected target is refused`);
      assert.equal(
        ask('edit', { path: 'src/a.mjs' }),
        expected,
        `${label}: grant ${expected === 'allow' ? 'must survive' : 'is spent (documented)'}`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('deleting the ticket store does not disarm an armed repo, in either layout', () => {
  // u4's round-8 shape, checked against pi. The containment signal is a FILE an
  // agent can delete: measured here, structured tool calls naming the ticket
  // store through every shape pi's extractor admits (path/target/filePath/file)
  // are ALLOWED — unlike `.adlc/.deny-store`, the store is not a protected
  // path — so `rm` of it below the band is a real route, and without a latch
  // the repo would read as never-ADLC and the gate would be off for good.
  //
  // The latch is the monotonic memory armed at session_start: deleting a file
  // inside the root leaves the DIRECTORY's identity untouched, so the root
  // stays remembered. Both store layouts are covered because
  // `ticketStoreExists` accepts either.
  //
  // Residual, deliberately not closed here: a full PROCESS restart starts a
  // fresh latch, so a repo whose store was deleted reads as never-ADLC to the
  // next process. Protecting the ticket store as a handoff path belongs in
  // @adlc/context-handoff, not in this adapter.
  for (const [layout, install] of [
    ['tickets.json', (r) => {
      mkdirSync(join(r, '.adlc'), { recursive: true });
      const f = join(r, '.adlc', 'tickets.json');
      writeFileSync(f, JSON.stringify({ tickets: [TICKET] }));
      return f;
    }],
    ['tickets/.store.json', (r) => {
      mkdirSync(join(r, '.adlc', 'tickets'), { recursive: true });
      const f = join(r, '.adlc', 'tickets', '.store.json');
      writeFileSync(f, JSON.stringify({ tickets: [TICKET] }));
      return f;
    }],
  ]) {
    const root = makeBareDir();
    try {
      const storeFile = install(root);
      const adlcRoots = createAdlcRootState();

      // Arm exactly as session_start does.
      const armed = resolveAdlcRoot(root);
      assert.equal(armed, realpathSync(root), `${layout}: the repo arms`);
      adlcRoots.record(armed);

      // The deletion route is open — assert it, so this test notices if the
      // store ever becomes a protected path and the note above goes stale.
      for (const key of ['path', 'target', 'filePath', 'file']) {
        assert.equal(
          checkHandoff({
            toolName: 'some_custom_tool',
            input: { [key]: storeFile },
            sessionId: 'sess-1',
            usage: { percent: 5 },
            root,
            adlcRoots,
          }).decision,
          'allow',
          `${layout}: a structured {${key}} naming the store is not a protected path today`,
        );
      }

      rmSync(storeFile, { force: true });
      assert.equal(resolveAdlcRoot(root), null, `${layout}: structurally it now reads as never-ADLC`);

      // The latch: below the band, a later mutation must still be evaluated.
      assert.equal(
        checkHandoff({
          toolName: 'edit',
          input: { path: 'a.txt' },
          sessionId: 'sess-2',
          usage: { percent: 5 },
          root,
          adlcRoots,
          evaluate: () => ({ deny: true, reasons: ['D1:band'] }),
        }).decision,
        'deny',
        `${layout}: deleting the store must not be an off switch`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
