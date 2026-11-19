import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmp } from '@adlc/core/test-kit';
import { checkHandoff, resolveAdlcRoot, createAdlcRootState } from '../lib/handoff-gate.mjs';
import { checkShellCommand, checkStructuredWrite } from '../lib/rails-checker.mjs';
import { createExtension } from '../lib/extension.mjs';

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });
}

test('resolveAdlcRoot resolves nested linked git worktrees ahead of outer repo even when outer repo is armed', (t) => {
  const primary = tmp(t, 'pi-wt-primary-');
  git(primary, 'init', '-b', 'main');
  mkdirSync(join(primary, '.adlc'), { recursive: true });
  writeFileSync(
    join(primary, '.adlc', 'tickets.json'),
    JSON.stringify({ tickets: [{ id: 'T1', title: 'Primary', rails: ['src/frozen.js'] }] })
  );
  mkdirSync(join(primary, 'src'), { recursive: true });
  writeFileSync(join(primary, 'src', 'frozen.js'), 'export const x = 1;\n');
  git(primary, 'add', '-A');
  git(primary, 'commit', '-m', 'init');

  const lane = join(primary, '.worktrees', 'lane-a');
  git(primary, 'worktree', 'add', '-b', 'lane-a', lane);
  mkdirSync(join(lane, 'packages', 'sub'), { recursive: true });

  const roots = createAdlcRootState();
  roots.record(realpathSync(primary));

  assert.equal(resolveAdlcRoot(lane, null, roots), realpathSync(lane));
  assert.equal(resolveAdlcRoot(join(lane, 'packages', 'sub'), null, roots), realpathSync(lane));
});

test('checkShellCommand denies mutating commands that move workdir and allows root workdir or read-only commands', (t) => {
  const root = tmp(t, 'pi-shell-wd-');
  const ticket = { id: 'T1', title: 'Test', rails: ['src/frozen.js'] };

  const moved = checkShellCommand('rm frozen.js', ticket, root, { workdir: 'src' });
  assert.equal(moved.decision, 'deny');
  assert.match(moved.reason, /changes cwd/);

  const sameRoot = checkShellCommand('rm src/free.js', ticket, root, { workdir: root });
  assert.equal(sameRoot.decision, 'allow');

  const readOnlyInSub = checkShellCommand('ls -la', ticket, root, { workdir: 'src' });
  assert.equal(readOnlyInSub.decision, 'allow');
});

test('extension resolves subdirectory ctx.cwd to enclosing ADLC root and enforces rails on relative write and bash cwd', async (t) => {
  const root = tmp(t, 'pi-ext-sub-');
  git(root, 'init', '-b', 'main');
  mkdirSync(join(root, '.adlc'), { recursive: true });
  writeFileSync(
    join(root, '.adlc', 'tickets.json'),
    JSON.stringify({ tickets: [{ id: 'T1', title: 'Subdir test', rails: ['src/frozen.js'] }] })
  );
  writeFileSync(join(root, '.adlc', 'current-ticket.json'), JSON.stringify({ id: 'T1' }));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'frozen.js'), 'frozen\n');
  writeFileSync(join(root, 'src', 'free.js'), 'free\n');

  const handlers = new Map();
  const pi = {
    on(event, fn) {
      handlers.set(event, fn);
    },
    registerTool() {},
    registerCommand() {},
    sendMessage() {},
    async exec() {
      return { stdout: '', stderr: '', code: 0 };
    },
  };

  const ext = createExtension({ env: {} });
  ext(pi);

  const subCwd = join(root, 'src');
  const ctx = {
    cwd: subCwd,
    ui: { notify() {}, setWidget() {}, setStatus() {} },
    getContextUsage: () => ({ percent: 10 }),
    sessionManager: { getSessionId: () => 'sess-sub-1', getEntries: () => [] },
  };

  await handlers.get('session_start')({}, ctx);

  // Relative write 'frozen.js' from ctx.cwd = root/src hits rail 'src/frozen.js'
  const writeBlocked = await handlers.get('tool_call')(
    { toolName: 'write', toolCallId: 'c1', input: { path: 'frozen.js', content: 'tamper' } },
    ctx
  );
  assert.equal(writeBlocked?.block, true);

  // Relative write 'free.js' from ctx.cwd = root/src is allowed
  const writeAllowed = await handlers.get('tool_call')(
    { toolName: 'write', toolCallId: 'c2', input: { path: 'free.js', content: 'ok' } },
    ctx
  );
  assert.equal(writeAllowed, undefined);

  // Mutating bash with explicit cwd !== activeCwd is blocked
  const bashBlocked = await handlers.get('tool_call')(
    { toolName: 'bash', toolCallId: 'c3', input: { command: 'rm free.js', cwd: subCwd } },
    { ...ctx, cwd: root }
  );
  assert.equal(bashBlocked?.block, true);
  assert.match(bashBlocked?.reason ?? '', /changes cwd/);

  // Cross-key spoofing: ctx.cwd = subCwd while input.Cwd = root MUST STILL block mutating bash
  const spoofBlocked = await handlers.get('tool_call')(
    { toolName: 'bash', toolCallId: 'c4', input: { command: 'rm frozen.js', Cwd: root } },
    ctx
  );
  assert.equal(spoofBlocked?.block, true);
  assert.match(spoofBlocked?.reason ?? '', /changes cwd/);

  // Conflicting workdir keys on bash fail closed
  const conflictBlocked = await handlers.get('tool_call')(
    { toolName: 'bash', toolCallId: 'c5', input: { command: 'rm src/free.js', Cwd: '.', workdir: 'src' } },
    { ...ctx, cwd: root }
  );
  assert.equal(conflictBlocked?.block, true);
  assert.match(conflictBlocked?.reason ?? '', /conflicting working directories/);

  // Custom third-party tool with relative path from subdirectory ctx.cwd resolves against ctx.cwd and blocks rail
  const customBlocked = await handlers.get('tool_call')(
    { toolName: 'custom_writer', toolCallId: 'c6', input: { path: 'frozen.js' } },
    ctx
  );
  assert.equal(customBlocked?.block, true);
  assert.match(customBlocked?.reason ?? '', /frozen rail/);

  // With ADLC_CONTEXT_ROT_HANDOFF_ENABLED=1 and ctx.cwd = root/.adlc, relative write '.deny-store' hits D0 protected path
  const handlersHandoff = new Map();
  const piHandoff = {
    on(event, fn) {
      handlersHandoff.set(event, fn);
    },
    registerTool() {},
    registerCommand() {},
    sendMessage() {},
    async exec() {
      return { stdout: '', stderr: '', code: 0 };
    },
  };
  createExtension({ env: { ADLC_CONTEXT_ROT_HANDOFF_ENABLED: '1' } })(piHandoff);
  const adlcSubCtx = {
    ...ctx,
    cwd: join(root, '.adlc'),
  };
  await handlersHandoff.get('session_start')({}, adlcSubCtx);
  const denyStoreBlocked = await handlersHandoff.get('tool_call')(
    { toolName: 'write', toolCallId: 'c7', input: { path: '.deny-store', content: 'tamper' } },
    adlcSubCtx
  );
  assert.equal(denyStoreBlocked?.block, true);
});

test('Pi checkStructuredWrite and extension enforce foreign checkout rails and block writes outside root', async (t) => {
  const primary = tmp(t, 'pi-foreign-primary-');
  const foreign = tmp(t, 'pi-foreign-sibling-');
  const outsidePlain = tmp(t, 'pi-foreign-plain-');

  git(primary, 'init', '-b', 'main');
  mkdirSync(join(primary, '.adlc'), { recursive: true });
  writeFileSync(
    join(primary, '.adlc', 'tickets.json'),
    JSON.stringify({ tickets: [{ id: 'T-PRIMARY', title: 'Primary', rails: ['outer/frozen.js'] }] })
  );

  git(foreign, 'init', '-b', 'main');
  mkdirSync(join(foreign, '.adlc'), { recursive: true });
  writeFileSync(
    join(foreign, '.adlc', 'tickets.json'),
    JSON.stringify({ tickets: [{ id: 'T-FOREIGN', title: 'Foreign', rails: ['src/frozen.js'] }] })
  );
  writeFileSync(join(foreign, '.adlc', 'current-ticket.json'), JSON.stringify({ id: 'T-FOREIGN' }));

  // 1. Direct checkStructuredWrite against existing foreign ADLC checkout hits T-FOREIGN's rail
  const foreignVerdict = checkStructuredWrite(
    join(foreign, 'src', 'frozen.js'),
    { id: 'T-PRIMARY', rails: ['outer/frozen.js'] },
    primary
  );
  assert.equal(foreignVerdict.decision, 'deny');
  assert.match(foreignVerdict.reason, /src\/frozen\.js/);

  // 2. Direct checkStructuredWrite against plain outside path (even with unrestricted/empty scope) denies escaping root
  const plainOutsideVerdict = checkStructuredWrite(
    join(outsidePlain, 'src', 'frozen.js'),
    { id: 'T-PRIMARY', rails: ['outer/frozen.js'] },
    primary
  );
  assert.equal(plainOutsideVerdict.decision, 'deny');
  assert.match(plainOutsideVerdict.reason, /out of the ticket's declared scope/);

  // 3. Extension started in primary with NO active ticket in primary still blocks write targeting foreign active checkout's rail
  const handlers = new Map();
  const pi = {
    on(event, fn) {
      handlers.set(event, fn);
    },
    registerTool() {},
    registerCommand() {},
    sendMessage() {},
    async exec() {
      return { stdout: '', stderr: '', code: 0 };
    },
  };
  createExtension({ env: {} })(pi);
  const ctx = {
    cwd: primary,
    ui: { notify() {}, setWidget() {}, setStatus() {} },
    getContextUsage: () => ({ percent: 10 }),
    sessionManager: { getSessionId: () => 'sess-foreign-1', getEntries: () => [] },
  };
  await handlers.get('session_start')({}, ctx);
  const extForeignBlocked = await handlers.get('tool_call')(
    { toolName: 'write', toolCallId: 'cf1', input: { path: join(foreign, 'src', 'frozen.js'), content: 'tamper' } },
    ctx
  );
  assert.equal(extForeignBlocked?.block, true);
  assert.match(extForeignBlocked?.reason ?? '', /frozen rail/);

  // 4. Nested worktree shell mutation from outer checkout (both via checkShellCommand with outerTicket and via extension with no outer ticket) hits nested rail
  git(primary, 'add', '-A');
  git(primary, 'commit', '-m', 'init primary');
  const lane = join(primary, '.worktrees', 'lane');
  git(primary, 'worktree', 'add', '-b', 'lane', lane);
  writeFileSync(
    join(lane, '.adlc', 'tickets.json'),
    JSON.stringify({ tickets: [{ id: 'T-LANE', title: 'Lane', rails: ['src/frozen.js'] }] })
  );
  writeFileSync(join(lane, '.adlc', 'current-ticket.json'), JSON.stringify({ id: 'T-LANE' }));

  const shellNestedDirect = checkShellCommand(
    'echo hacked > .worktrees/lane/src/frozen.js',
    { id: 'T-PRIMARY', rails: ['outer/frozen.js'] },
    primary
  );
  assert.equal(shellNestedDirect.decision, 'deny');
  assert.match(shellNestedDirect.reason, /src\/frozen\.js/);

  const extShellNestedBlocked = await handlers.get('tool_call')(
    { toolName: 'bash', toolCallId: 'cf2', input: { command: 'echo hacked > .worktrees/lane/src/frozen.js' } },
    ctx
  );
  assert.equal(extShellNestedBlocked?.block, true);
  assert.match(extShellNestedBlocked?.reason ?? '', /src\/frozen\.js/);

  // 5. Secondary build-gate in Pi extension ignores outer ADLC_TICKET_STORE=/tmp/outer.json when nested worktree owns high-risk local store
  const extLowStore = join(outsidePlain, 'outer-low.json');
  writeFileSync(extLowStore, JSON.stringify({ tickets: [{ id: 'T-SHARED', title: 'Low', rails: [] }] }));
  writeFileSync(
    join(lane, '.adlc', 'tickets.json'),
    JSON.stringify({ tickets: [{ id: 'T-SHARED', title: 'High', category: 'architecture', rails: [] }] })
  );
  writeFileSync(join(lane, '.adlc', 'current-ticket.json'), JSON.stringify({ id: 'T-SHARED' }));

  const bgHandlers = new Map();
  const bgPi = {
    on(event, fn) {
      bgHandlers.set(event, fn);
    },
    registerTool() {},
    registerCommand() {},
    sendMessage() {},
    async exec() {
      return { stdout: '', stderr: '', code: 0 };
    },
  };
  createExtension({ env: { ADLC_TICKET_STORE: extLowStore, ADLC_TICKET: 'T-SHARED' } })(bgPi);
  const degradedCtx = {
    cwd: primary,
    ui: { notify() {}, setWidget() {}, setStatus() {} },
    getContextUsage: () => ({ percent: 95 }),
    sessionManager: { getSessionId: () => 'sess-bg-pi', getEntries: () => [] },
  };
  await bgHandlers.get('session_start')({}, degradedCtx);
  await bgHandlers.get('session_compact')({ reason: 'threshold' }, degradedCtx);
  const bgNestedBlocked = await bgHandlers.get('tool_call')(
    { toolName: 'write', toolCallId: 'cf-bg', input: { path: join(lane, 'src', 'free.js'), content: 'x' } },
    degradedCtx
  );
  assert.equal(bgNestedBlocked?.block, true);
  assert.match(bgNestedBlocked?.reason ?? '', /build gate|high-risk/i);

  // 6. Direct launch FROM nested worktree with ADLC_TICKET_STORE=../../.adlc/tickets.json or outer store path enforces lane's own frozen rails
  writeFileSync(
    join(primary, '.adlc', 'tickets.json'),
    JSON.stringify({ tickets: [{ id: 'T-SHARED', title: 'Outer', rails: [] }] })
  );
  writeFileSync(
    join(lane, '.adlc', 'tickets.json'),
    JSON.stringify({ tickets: [{ id: 'T-SHARED', title: 'Lane', rails: ['src/frozen.js'] }] })
  );
  writeFileSync(join(lane, '.adlc', 'current-ticket.json'), JSON.stringify({ id: 'T-SHARED' }));
  for (const badOverride of ['../../.adlc/tickets.json', join(primary, '.adlc', 'tickets.json')]) {
    const directHandlers = new Map();
    const directPi = {
      on(event, fn) {
        directHandlers.set(event, fn);
      },
      registerTool() {},
      registerCommand() {},
      sendMessage() {},
      async exec() {
        return { stdout: '', stderr: '', code: 0 };
      },
    };
    createExtension({ env: { ADLC_TICKET_STORE: badOverride, ADLC_TICKET: 'T-SHARED' } })(directPi);
    const directLaneCtx = {
      cwd: lane,
      ui: { notify() {}, setWidget() {}, setStatus() {} },
      getContextUsage: () => ({ percent: 10 }),
      sessionManager: { getSessionId: () => 'sess-direct-lane', getEntries: () => [] },
    };
    await directHandlers.get('session_start')({}, directLaneCtx);
    const directLaneBlocked = await directHandlers.get('tool_call')(
      { toolName: 'write', toolCallId: 'cf-direct', input: { path: 'src/frozen.js', content: 'x' } },
      directLaneCtx
    );
    assert.equal(directLaneBlocked?.block, true, `expected block for ${badOverride}`);
    assert.match(directLaneBlocked?.reason ?? '', /src\/frozen\.js/);
  }

  // 7. Mid-session modification of tickets.json updates stampTicketFiles(cwd) and reloads newly added rails
  const stampRepo = tmp(t, 'pi-stamp-reload-');
  git(stampRepo, 'init', '-b', 'main');
  mkdirSync(join(stampRepo, '.adlc'), { recursive: true });
  const stampTicketsPath = join(stampRepo, '.adlc', 'tickets.json');
  writeFileSync(stampTicketsPath, JSON.stringify({ tickets: [{ id: 'T-STAMP', title: 'Stamp', rails: [] }] }));
  writeFileSync(join(stampRepo, '.adlc', 'current-ticket.json'), JSON.stringify({ id: 'T-STAMP' }));
  const stampHandlers = new Map();
  createExtension({ env: { ADLC_TICKET: 'T-STAMP' } })({
    on(ev, fn) { stampHandlers.set(ev, fn); },
    registerTool() {},
    registerCommand() {},
    sendMessage() {},
    async exec() { return { stdout: '', stderr: '', code: 0 }; },
  });
  const stampCtx = {
    cwd: stampRepo,
    ui: { notify() {}, setWidget() {}, setStatus() {} },
    getContextUsage: () => ({ percent: 10 }),
    sessionManager: { getSessionId: () => 'sess-stamp', getEntries: () => [] },
  };
  await stampHandlers.get('session_start')({}, stampCtx);
  const beforeRailAdd = await stampHandlers.get('tool_call')(
    { toolName: 'write', toolCallId: 'st1', input: { path: 'src/late.js', content: 'ok' } },
    stampCtx
  );
  assert.notEqual(beforeRailAdd?.block, true);
  writeFileSync(
    stampTicketsPath,
    JSON.stringify({ tickets: [{ id: 'T-STAMP', title: 'Stamp', rails: ['src/late.js'] }] })
  );
  const future = new Date(Date.now() + 5000);
  utimesSync(stampTicketsPath, future, future);
  await stampHandlers.get('turn_start')({}, stampCtx);
  const afterRailAdd = await stampHandlers.get('tool_call')(
    { toolName: 'write', toolCallId: 'st2', input: { path: 'src/late.js', content: 'blocked' } },
    stampCtx
  );
  assert.equal(afterRailAdd?.block, true);
  assert.match(afterRailAdd?.reason ?? '', /src\/late\.js/);

  // 8. checkHandoff records adlcRoots when armed via external storeOverride so deleting external store does not disarm
  const extLatchRepo = tmp(t, 'pi-ext-latch-repo-');
  git(extLatchRepo, 'init', '-b', 'main');
  mkdirSync(join(extLatchRepo, 'src'), { recursive: true });
  writeFileSync(join(extLatchRepo, 'src', 'a.js'), 'export const a = 1;\n');
  git(extLatchRepo, 'add', '-A');
  git(extLatchRepo, 'commit', '-m', 'init');
  const extLatchStore = join(outsidePlain, 'latch-ext-tickets.json');
  writeFileSync(extLatchStore, JSON.stringify({ tickets: [{ id: 'T-LATCH', title: 'Latch', rails: [] }] }));
  const latchRoots = createAdlcRootState();
  const initialHandoff = checkHandoff({
    toolName: 'edit',
    input: { path: 'src/a.js' },
    sessionId: 'sess-latch',
    usage: { percent: 10 },
    root: extLatchRepo,
    adlcRoots: latchRoots,
    storeOverride: extLatchStore,
    evaluate: () => ({ deny: false, reasons: [] }),
  });
  assert.equal(initialHandoff.decision, 'allow');
  unlinkSync(extLatchStore);
  const postDeleteHandoff = checkHandoff({
    toolName: 'edit',
    input: { path: 'src/a.js' },
    sessionId: 'sess-latch',
    usage: { percent: 95 },
    root: extLatchRepo,
    adlcRoots: latchRoots,
    storeOverride: extLatchStore,
    evaluate: () => ({ deny: true, reasons: ['D1:band'] }),
  });
  assert.equal(postDeleteHandoff.decision, 'deny');
});
