import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmp } from '@adlc/core/test-kit';
import plugin from '../index.mjs';
import { checkToolCall } from '../rails-checker.mjs';

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

test('OpenCode setup resolves nested linked worktree launch directory over outer project.directory', async (t) => {
  const primary = tmp(t, 'oc-wt-primary-');
  git(primary, 'init', '-b', 'main');
  mkdirSync(join(primary, '.adlc'), { recursive: true });
  writeFileSync(
    join(primary, '.adlc', 'tickets.json'),
    JSON.stringify({ tickets: [{ id: 'T-WT', title: 'Worktree Ticket', rails: ['src/frozen.mjs'] }] })
  );
  mkdirSync(join(primary, 'src'), { recursive: true });
  writeFileSync(join(primary, 'src', 'frozen.mjs'), 'export const x = 1;\n');
  git(primary, 'add', '-A');
  git(primary, 'commit', '-m', 'init');

  const lane = join(primary, '.worktrees', 'lane-a');
  git(primary, 'worktree', 'add', '-b', 'lane-a', lane);
  // Activate ticket ONLY in the nested worktree, not in primary
  writeFileSync(join(lane, '.adlc', 'current-ticket.json'), JSON.stringify({ id: 'T-WT' }));

  const prevEnf = process.env.ADLC_P4_ENFORCEMENT;
  process.env.ADLC_P4_ENFORCEMENT = '1';
  t.after(() => {
    if (prevEnf === undefined) delete process.env.ADLC_P4_ENFORCEMENT;
    else process.env.ADLC_P4_ENFORCEMENT = prevEnf;
  });

  let beforeHook = null;
  const ac = new AbortController();
  t.after(() => ac.abort());

  await plugin.setup({
    location: {
      directory: lane,
      project: { directory: primary },
    },
    signal: ac.signal,
    tool: {
      hook(stage, fn) {
        if (stage === 'execute.before') beforeHook = fn;
      },
      register() {},
    },
    permission: {
      hook() {},
    },
    event: {
      async *subscribe({ signal }) {
        await new Promise((res) => signal.addEventListener('abort', res, { once: true }));
      },
    },
  });

  assert.equal(typeof beforeHook, 'function');
  await assert.rejects(
    () =>
      beforeHook({
        tool: 'write',
        sessionID: 'sess-wt',
        input: { path: join(lane, 'src', 'frozen.mjs'), content: 'tamper' },
      }),
    /frozen rail/
  );
  ac.abort();
});

test('checkToolCall extracts alternative shell workdir keys (Cwd, dir_path, working_directory)', (t) => {
  const root = tmp(t, 'oc-wd-keys-');
  mkdirSync(join(root, '.adlc'), { recursive: true });
  writeFileSync(
    join(root, '.adlc', 'tickets.json'),
    JSON.stringify({ tickets: [{ id: 'T1', title: 'Test', rails: ['src/frozen.mjs'] }] })
  );
  const env = { ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: 'T1' };

  for (const key of ['Cwd', 'dir_path', 'working_directory']) {
    const denied = checkToolCall({
      tool: 'bash',
      args: { command: 'rm frozen.mjs', [key]: 'src' },
      root,
      env,
    });
    assert.equal(denied.decision, 'deny', key);
    assert.match(denied.reason, /changes cwd/);

    const allowed = checkToolCall({
      tool: 'bash',
      args: { command: 'rm src/free.mjs', [key]: root },
      root,
      env,
    });
    assert.equal(allowed.decision, 'allow', key);
  }

  // Conflicting workdir keys fail closed
  const conflicted = checkToolCall({
    tool: 'bash',
    args: { command: 'rm src/free.mjs', Cwd: '.', workdir: 'src' },
    root,
    env,
  });
  assert.equal(conflicted.decision, 'deny');
  assert.match(conflicted.reason, /conflicting working directories/);

  // Subdirectory launch cwd denies relative shell mutation without workdir and catches relative structured write
  mkdirSync(join(root, 'src'), { recursive: true });
  const subShellDenied = checkToolCall({
    tool: 'bash',
    args: { command: 'rm frozen.mjs' },
    root,
    cwd: join(root, 'src'),
    env,
  });
  assert.equal(subShellDenied.decision, 'deny');
  assert.match(subShellDenied.reason, /changes cwd/);

  const subWriteDenied = checkToolCall({
    tool: 'write',
    args: { path: 'frozen.mjs', content: 'tamper' },
    root,
    cwd: join(root, 'src'),
    env,
  });
  assert.equal(subWriteDenied.decision, 'deny');
  assert.match(subWriteDenied.reason, /frozen rail/);
});

test('OpenCode setup resolves enclosing git root from subdirectory launch under external ADLC_TICKET_STORE', async (t) => {
  const repo = tmp(t, 'oc-ext-store-repo-');
  const extDir = tmp(t, 'oc-ext-store-dir-');
  const extStore = join(extDir, 'tickets.json');
  git(repo, 'init', '-b', 'main');
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'frozen.mjs'), 'export const x = 1;\n');
  writeFileSync(
    extStore,
    JSON.stringify({ tickets: [{ id: 'T-EXT', title: 'External', rails: ['src/frozen.mjs'] }] })
  );

  const prevEnf = process.env.ADLC_P4_ENFORCEMENT;
  const prevStore = process.env.ADLC_TICKET_STORE;
  const prevTicket = process.env.ADLC_TICKET;
  process.env.ADLC_P4_ENFORCEMENT = '1';
  process.env.ADLC_TICKET_STORE = extStore;
  process.env.ADLC_TICKET = 'T-EXT';
  t.after(() => {
    if (prevEnf === undefined) delete process.env.ADLC_P4_ENFORCEMENT;
    else process.env.ADLC_P4_ENFORCEMENT = prevEnf;
    if (prevStore === undefined) delete process.env.ADLC_TICKET_STORE;
    else process.env.ADLC_TICKET_STORE = prevStore;
    if (prevTicket === undefined) delete process.env.ADLC_TICKET;
    else process.env.ADLC_TICKET = prevTicket;
  });

  let beforeHook = null;
  const ac = new AbortController();
  t.after(() => ac.abort());

  await plugin.setup({
    location: { directory: join(repo, 'src') },
    signal: ac.signal,
    tool: {
      hook(stage, fn) {
        if (stage === 'execute.before') beforeHook = fn;
      },
      register() {},
    },
    permission: { hook() {} },
    event: {
      async *subscribe({ signal }) {
        await new Promise((res) => signal.addEventListener('abort', res, { once: true }));
      },
    },
  });

  await assert.rejects(
    () =>
      beforeHook({
        tool: 'write',
        sessionID: 'sess-ext',
        input: { path: join(repo, 'src', 'frozen.mjs'), content: 'tamper' },
      }),
    /frozen rail/
  );
  ac.abort();
});

test('OpenCode checkToolCall enforces foreign checkout rails and rejects unverified out-of-root targets', (t) => {
  const primary = tmp(t, 'oc-foreign-primary-');
  const foreign = tmp(t, 'oc-foreign-sibling-');
  const outsidePlain = tmp(t, 'oc-foreign-plain-');

  git(primary, 'init', '-b', 'main');
  mkdirSync(join(primary, '.adlc'), { recursive: true });
  writeFileSync(
    join(primary, '.adlc', 'tickets.json'),
    JSON.stringify({ tickets: [{ id: 'T-PRIMARY', title: 'Primary', rails: ['outer/frozen.mjs'] }] })
  );

  git(foreign, 'init', '-b', 'main');
  mkdirSync(join(foreign, '.adlc'), { recursive: true });
  writeFileSync(
    join(foreign, '.adlc', 'tickets.json'),
    JSON.stringify({ tickets: [{ id: 'T-FOREIGN', title: 'Foreign', rails: ['src/frozen.mjs'] }] })
  );
  writeFileSync(join(foreign, '.adlc', 'current-ticket.json'), JSON.stringify({ id: 'T-FOREIGN' }));

  const env = {
    ADLC_P4_ENFORCEMENT: '1',
    ADLC_TICKET: 'T-PRIMARY',
    ADLC_TICKET_STORE: join(primary, '.adlc', 'tickets.json'),
  };

  // Absolute target in foreign ADLC checkout hits T-FOREIGN's rail
  const foreignRailHit = checkToolCall({
    tool: 'write',
    args: { filePath: join(foreign, 'src', 'frozen.mjs') },
    root: primary,
    cwd: primary,
    env,
  });
  assert.equal(foreignRailHit.decision, 'deny');
  assert.match(foreignRailHit.reason, /T-FOREIGN/);

  // Structured tool with explicit cwd = foreign + relative path hits T-FOREIGN's rail
  const foreignRelativeHit = checkToolCall({
    tool: 'apply_patch',
    args: { cwd: foreign, patchText: '*** Update File: src/frozen.mjs\n@@\n' },
    root: primary,
    cwd: primary,
    env,
  });
  assert.equal(foreignRelativeHit.decision, 'deny');
  assert.match(foreignRelativeHit.reason, /T-FOREIGN/);

  // Non-ADLC outside path is rejected as escaping root while T-PRIMARY rails are active
  const plainOutsideDeny = checkToolCall({
    tool: 'write',
    args: { filePath: join(outsidePlain, 'src', 'frozen.mjs') },
    root: primary,
    cwd: primary,
    env,
  });
  assert.equal(plainOutsideDeny.decision, 'deny');
  assert.match(plainOutsideDeny.reason, /outside the repository root/);

  // Conflicting workdirs on structured tool fail closed
  const conflictStructured = checkToolCall({
    tool: 'write',
    args: { filePath: 'src/ok.mjs', cwd: primary, workdir: foreign },
    root: primary,
    cwd: primary,
    env,
  });
  assert.equal(conflictStructured.decision, 'deny');
  assert.match(conflictStructured.reason, /conflicting working directories/);

  // Nested worktree shell mutation from outer checkout (both with active outer ticket and without active outer ticket) hits nested worktree's rail
  git(primary, 'add', '-A');
  git(primary, 'commit', '-m', 'init primary');
  const lane = join(primary, '.worktrees', 'lane');
  git(primary, 'worktree', 'add', '-b', 'lane', lane);
  writeFileSync(
    join(lane, '.adlc', 'tickets.json'),
    JSON.stringify({ tickets: [{ id: 'T-LANE', title: 'Lane', rails: ['src/frozen.mjs'] }] })
  );
  writeFileSync(join(lane, '.adlc', 'current-ticket.json'), JSON.stringify({ id: 'T-LANE' }));

  const shellNestedWithOuter = checkToolCall({
    tool: 'bash',
    args: { command: 'echo hacked > .worktrees/lane/src/frozen.mjs' },
    root: primary,
    cwd: primary,
    env,
  });
  assert.equal(shellNestedWithOuter.decision, 'deny');
  assert.match(shellNestedWithOuter.reason, /T-LANE/);

  const shellNestedNoOuter = checkToolCall({
    tool: 'bash',
    args: { command: 'echo hacked > .worktrees/lane/src/frozen.mjs' },
    root: primary,
    cwd: primary,
    env: { ADLC_P4_ENFORCEMENT: '1' },
  });
  assert.equal(shellNestedNoOuter.decision, 'deny');
  assert.match(shellNestedNoOuter.reason, /T-LANE/);

  // Relative traversal ADLC_TICKET_STORE=../../.adlc/tickets.json must not let nested worktree load outer store
  const relTraversalDenied = checkToolCall({
    tool: 'write',
    args: { filePath: '.worktrees/lane/src/frozen.mjs' },
    root: primary,
    cwd: primary,
    env: {
      ADLC_P4_ENFORCEMENT: '1',
      ADLC_TICKET: 'T-PRIMARY',
      ADLC_TICKET_STORE: '../../.adlc/tickets.json',
    },
  });
  assert.equal(relTraversalDenied.decision, 'deny');
  assert.match(relTraversalDenied.reason, /T-LANE/);

  // Direct nested launch (root === lane, both T-SHARED) with ADLC_TICKET_STORE=../../.adlc/tickets.json or outer store path must enforce lane's own frozen rails
  writeFileSync(
    join(primary, '.adlc', 'tickets.json'),
    JSON.stringify({ tickets: [{ id: 'T-SHARED', title: 'Outer', rails: [] }] })
  );
  writeFileSync(
    join(lane, '.adlc', 'tickets.json'),
    JSON.stringify({ tickets: [{ id: 'T-SHARED', title: 'Lane', rails: ['src/frozen.mjs'] }] })
  );
  writeFileSync(join(lane, '.adlc', 'current-ticket.json'), JSON.stringify({ id: 'T-SHARED' }));
  for (const badOverride of ['../../.adlc/tickets.json', join(primary, '.adlc', 'tickets.json')]) {
    const directLaneDenied = checkToolCall({
      tool: 'write',
      args: { filePath: 'src/frozen.mjs' },
      root: lane,
      cwd: lane,
      env: {
        ADLC_P4_ENFORCEMENT: '1',
        ADLC_TICKET: 'T-SHARED',
        ADLC_TICKET_STORE: badOverride,
      },
    });
    assert.equal(directLaneDenied.decision, 'deny', `expected deny for ${badOverride}`);
    assert.match(directLaneDenied.reason, /src\/frozen\.mjs/);
  }
});

test('OpenCode secondary build-gate ignores outer ADLC_TICKET_STORE override when nested worktree owns high-risk local store', async (t) => {
  const primary = tmp(t, 'oc-bg-primary-');
  const extLowStore = join(tmp(t, 'oc-bg-ext-'), 'outer-low.json');
  git(primary, 'init', '-b', 'main');
  mkdirSync(join(primary, '.adlc'), { recursive: true });
  writeFileSync(join(primary, '.adlc', 'tickets.json'), JSON.stringify({ tickets: [{ id: 'T-SHARED', title: 'Low', rails: [] }] }));
  writeFileSync(extLowStore, JSON.stringify({ tickets: [{ id: 'T-SHARED', title: 'Low', rails: [] }] }));
  mkdirSync(join(primary, 'src'), { recursive: true });
  writeFileSync(join(primary, 'src', 'a.mjs'), 'export const a = 1;\n');
  git(primary, 'add', '-A');
  git(primary, 'commit', '-m', 'init');

  const lane = join(primary, '.worktrees', 'bg-lane');
  git(primary, 'worktree', 'add', '-b', 'bg-lane', lane);
  writeFileSync(
    join(lane, '.adlc', 'tickets.json'),
    JSON.stringify({ tickets: [{ id: 'T-SHARED', title: 'High', category: 'architecture', rails: [] }] })
  );
  writeFileSync(join(lane, '.adlc', 'current-ticket.json'), JSON.stringify({ id: 'T-SHARED' }));

  const prevEnf = process.env.ADLC_P4_ENFORCEMENT;
  const prevStore = process.env.ADLC_TICKET_STORE;
  const prevTicket = process.env.ADLC_TICKET;
  process.env.ADLC_P4_ENFORCEMENT = '1';
  process.env.ADLC_TICKET_STORE = extLowStore;
  process.env.ADLC_TICKET = 'T-SHARED';
  t.after(() => {
    if (prevEnf === undefined) delete process.env.ADLC_P4_ENFORCEMENT;
    else process.env.ADLC_P4_ENFORCEMENT = prevEnf;
    if (prevStore === undefined) delete process.env.ADLC_TICKET_STORE;
    else process.env.ADLC_TICKET_STORE = prevStore;
    if (prevTicket === undefined) delete process.env.ADLC_TICKET;
    else process.env.ADLC_TICKET = prevTicket;
  });

  let beforeHook = null;
  let emitEvent = null;
  const ac = new AbortController();
  t.after(() => ac.abort());

  await plugin.setup({
    location: { directory: primary },
    signal: ac.signal,
    tool: {
      hook(stage, fn) {
        if (stage === 'execute.before') beforeHook = fn;
      },
      register() {},
    },
    permission: { hook() {} },
    event: {
      async *subscribe({ signal }) {
        while (!signal.aborted) {
          const ev = await new Promise((res) => {
            emitEvent = res;
            signal.addEventListener('abort', () => res(null), { once: true });
          });
          if (!ev) break;
          yield ev;
        }
      },
    },
  });

  // Mark session compacted so context is degraded
  await new Promise((r) => setTimeout(r, 10));
  emitEvent?.({ type: 'session.compaction.ended', data: { sessionID: 'sess-bg-oc' } });
  await new Promise((r) => setTimeout(r, 10));

  await assert.rejects(
    () =>
      beforeHook({
        tool: 'write',
        sessionID: 'sess-bg-oc',
        input: { path: join(lane, 'src', 'a.mjs'), content: 'x' },
      }),
    /build-gate|high-risk/i
  );
  ac.abort();
});
