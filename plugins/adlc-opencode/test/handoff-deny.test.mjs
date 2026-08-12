// handoff-deny.test.mjs — OpenCode context-rot handoff deny (slice 5).
// Drives the REAL exported plugin factory's `tool.execute.before` /
// `permission.ask` handlers, never a re-implementation of them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ensureDenyMarker, writeDenyRecord, HANDOFF_DEPTH } from '@adlc/context-handoff';

import { adlcRailsGuard } from '../index.mjs';
import {
  checkHandoff,
  createStickyDenyState,
  handoffAppliesTo,
  isShellTool,
  shellCommandOf,
  toRepoRelative,
} from '../lib/handoff-gate.mjs';

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'oc-handoff-'));
  mkdirSync(join(dir, '.adlc'), { recursive: true });
  writeFileSync(
    join(dir, '.adlc', 'tickets.json'),
    JSON.stringify({ tickets: [{ id: 'T1', title: 'fixture', rails: [] }] }),
  );
  return dir;
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

/** Drive N tool calls through the tracker so depth reaches the handoff band. */
async function pumpDepth(hooks, sessionID, n) {
  for (let i = 0; i < n; i += 1) {
    try {
      await hooks['tool.execute.before']({ tool: 'read', sessionID, callID: 'c' }, { args: {} });
    } catch {
      /* read is never gated; depth still counts */
    }
  }
}

// ---- pure glue -------------------------------------------------------------

test('the deny-set applies to mutators and the shell, never to read-only tools', () => {
  for (const t of ['edit', 'write', 'patch', 'bash', 'shell', 'unknown_tool']) {
    assert.equal(handoffAppliesTo(t), true, `${t} must be gated`);
  }
  for (const t of ['read', 'grep', 'glob', 'list', 'webfetch', '']) {
    assert.equal(handoffAppliesTo(t), false, `${t} must not be gated`);
  }
});

test('shell tools and their command text are recognized', () => {
  assert.equal(isShellTool('bash'), true);
  assert.equal(isShellTool('Shell'), true);
  assert.equal(isShellTool('edit'), false);
  assert.equal(shellCommandOf({ command: 'ls' }), 'ls');
  assert.equal(shellCommandOf({ cmd: 'ls' }), 'ls');
  assert.equal(shellCommandOf(null), '');
});

test('edit targets are made repo-relative', () => {
  const root = '/tmp/some-root';
  assert.equal(toRepoRelative(join(root, 'src/app.mjs'), root), 'src/app.mjs');
  assert.equal(toRepoRelative('src/app.mjs', root), 'src/app.mjs');
  assert.equal(toRepoRelative('/elsewhere/x.mjs', root), '/elsewhere/x.mjs');
});

test('a blank sessionID reaches the gate as null, not as an id', () => {
  const seen = [];
  const evaluate = (o) => {
    seen.push(o.sessionId);
    return { deny: false, reasons: [] };
  };
  for (const sessionID of [undefined, '', null]) {
    checkHandoff({ tool: 'edit', args: {}, sessionID, root: '/tmp', evaluate });
  }
  assert.deepEqual(seen, [null, null, null]);
});

// ---- the real hook ---------------------------------------------------------

test('clean repo without deny/handoff → the edit runs', async () => {
  const dir = repo();
  try {
    const hooks = await adlcRailsGuard({ worktree: dir });
    await hooks['tool.execute.before'](
      { tool: 'edit', sessionID: 's1', callID: 'c' },
      { args: { filePath: 'src/ok.mjs' } },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an open deny for another session aborts the edit', async () => {
  const dir = repo();
  try {
    seedForeignDeny(dir);
    const hooks = await adlcRailsGuard({ worktree: dir });
    await assert.rejects(
      () =>
        hooks['tool.execute.before'](
          { tool: 'edit', sessionID: 's1', callID: 'c' },
          { args: { filePath: 'src/ok.mjs' } },
        ),
      /ADLC context-handoff.*D3:unauthorized_open:denier-1/s,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the shell is fail-closed-all under the deny-set', async () => {
  const dir = repo();
  try {
    seedForeignDeny(dir, 'denier-2');
    const hooks = await adlcRailsGuard({ worktree: dir });
    await assert.rejects(
      () =>
        hooks['tool.execute.before'](
          { tool: 'bash', sessionID: 's1', callID: 'c' },
          { args: { command: 'ls' } },
        ),
      /bash_fail_closed_under_deny/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an agent shell `adlc handoff repair` is tagged mutating-cli under the deny-set', async () => {
  const dir = repo();
  try {
    seedForeignDeny(dir, 'denier-3');
    const hooks = await adlcRailsGuard({ worktree: dir });
    await assert.rejects(
      () =>
        hooks['tool.execute.before'](
          { tool: 'bash', sessionID: 's1', callID: 'c' },
          { args: { command: 'adlc handoff repair --write' } },
        ),
      /bash_handoff_mutating_cli/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('read-only tools still run under the deny-set', async () => {
  const dir = repo();
  try {
    seedForeignDeny(dir, 'denier-4');
    const hooks = await adlcRailsGuard({ worktree: dir });
    await hooks['tool.execute.before'](
      { tool: 'read', sessionID: 's1', callID: 'c' },
      { args: { filePath: 'src/ok.mjs' } },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the denier stays denied after its record is consumed (D2)', async () => {
  const dir = repo();
  try {
    seedForeignDeny(dir, 'denier-sticky');
    writeDenyRecord(dir, {
      session_id: 'denier-sticky',
      ticket_id: 'T1',
      content_hash: 'abc',
      status: 'consumed',
      since: new Date().toISOString(),
      host: 'test',
      schema: 1,
    });
    const hooks = await adlcRailsGuard({ worktree: dir });
    await assert.rejects(
      () =>
        hooks['tool.execute.before'](
          { tool: 'edit', sessionID: 'denier-sticky', callID: 'c' },
          { args: { filePath: 'src/ok.mjs' } },
        ),
      /D2:denier_session/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the in-process depth tracker drives the band and writes a deny marker', async () => {
  const dir = repo();
  try {
    const hooks = await adlcRailsGuard({ worktree: dir });
    await pumpDepth(hooks, 'deep-sess', HANDOFF_DEPTH);
    await assert.rejects(
      () =>
        hooks['tool.execute.before'](
          { tool: 'edit', sessionID: 'deep-sess', callID: 'c' },
          { args: { filePath: 'src/ok.mjs' } },
        ),
      /ADLC context-handoff/,
    );
    const marker = join(dir, '.adlc', 'handoffs', 'denies', 'deep-sess.json');
    assert.equal(existsSync(marker), true, 'the handoff band must write denies/<session>.json');
    assert.match(readFileSync(marker, 'utf8'), /"host": "opencode"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a fresh session is denied by the open record, not by its own depth', async () => {
  const dir = repo();
  try {
    const hooks = await adlcRailsGuard({ worktree: dir });
    await pumpDepth(hooks, 'deep-sess', HANDOFF_DEPTH);
    await assert.rejects(
      () =>
        hooks['tool.execute.before'](
          { tool: 'edit', sessionID: 'deep-sess', callID: 'c' },
          { args: { filePath: 'src/ok.mjs' } },
        ),
      /ADLC context-handoff/,
    );
    // The fresh session is denied too — but by D3 (an open foreign deny), not
    // by its own depth. That distinction is the whole point of the deny-set.
    await assert.rejects(
      () =>
        hooks['tool.execute.before'](
          { tool: 'edit', sessionID: 'fresh-sess', callID: 'c' },
          { args: { filePath: 'src/ok.mjs' } },
        ),
      /D3:unauthorized_open:deep-sess/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('no usable sessionID fails closed under an active deny store', async () => {
  const dir = repo();
  try {
    seedForeignDeny(dir, 'denier-5');
    const hooks = await adlcRailsGuard({ worktree: dir });
    await assert.rejects(
      () =>
        hooks['tool.execute.before'](
          { tool: 'edit', callID: 'c' },
          { args: { filePath: 'src/ok.mjs' } },
        ),
      /D0:invalid_session_id/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('no usable sessionID on a clean repo still allows the edit', async () => {
  const dir = repo();
  try {
    const hooks = await adlcRailsGuard({ worktree: dir });
    await hooks['tool.execute.before'](
      { tool: 'edit', callID: 'c' },
      { args: { filePath: 'src/ok.mjs' } },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writing a handoff trust-root artifact is denied even with a cold store', async () => {
  const dir = repo();
  try {
    const hooks = await adlcRailsGuard({ worktree: dir });
    await assert.rejects(
      () =>
        hooks['tool.execute.before'](
          { tool: 'write', sessionID: 's1', callID: 'c' },
          { args: { filePath: '.adlc/handoffs/denies/s1.json' } },
        ),
      /path_protected/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('advisoryHooks downgrades the rail guard but NOT the handoff deny', async () => {
  const dir = repo();
  try {
    seedForeignDeny(dir, 'denier-6');
    const hooks = await adlcRailsGuard({ worktree: dir }, { advisoryHooks: true });
    await assert.rejects(
      () =>
        hooks['tool.execute.before'](
          { tool: 'edit', sessionID: 's1', callID: 'c' },
          { args: { filePath: 'src/ok.mjs' } },
        ),
      /ADLC context-handoff/,
      'the deny-set has no CI backstop — an env/option downgrade must not clear it',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the dormant permission.ask lever denies under the deny-set', async () => {
  const dir = repo();
  try {
    seedForeignDeny(dir, 'denier-7');
    const hooks = await adlcRailsGuard({ worktree: dir });
    const output = {};
    await hooks['permission.ask']({ type: 'edit', sessionID: 's1' }, output);
    assert.equal(output.status, 'deny');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('permission.ask leaves read-only kinds alone', async () => {
  const dir = repo();
  try {
    seedForeignDeny(dir, 'denier-8');
    const hooks = await adlcRailsGuard({ worktree: dir });
    const output = {};
    await hooks['permission.ask']({ type: 'read', sessionID: 's1' }, output);
    assert.equal(output.status, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the manifest key is threaded so a signed resume-auth can be verified', () => {
  const seen = [];
  const evaluate = (o) => {
    seen.push(o.manifestKey);
    return { deny: false, reasons: [], denyEverWritten: false };
  };
  checkHandoff({
    tool: 'edit',
    sessionID: 's1',
    root: '/tmp',
    env: { ADLC_MANIFEST_KEY: 'k'.repeat(64) },
    evaluate,
  });
  checkHandoff({ tool: 'edit', sessionID: 's1', root: '/tmp', env: {}, evaluate });
  assert.deepEqual(seen, ['k'.repeat(64), null]);
});

test('a failed marker write stays sticky for the session across calls', () => {
  const sticky = createStickyDenyState();
  const calls = [];
  // First call reports the D1 fact; the second must receive it back.
  const evaluate = (o) => {
    calls.push(o.denyEverWritten);
    return { deny: false, reasons: [], denyEverWritten: true };
  };
  checkHandoff({ tool: 'edit', sessionID: 's1', root: '/tmp', sticky, evaluate });
  checkHandoff({ tool: 'edit', sessionID: 's1', root: '/tmp', sticky, evaluate });
  // …and must not leak to a different session.
  checkHandoff({ tool: 'edit', sessionID: 's2', root: '/tmp', sticky, evaluate });
  assert.deepEqual(calls, [false, true, false]);
});

test('the plugin declares the package it enforces with', () => {
  const pkg = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  );
  assert.ok(pkg.dependencies['@adlc/context-handoff'], 'must depend on @adlc/context-handoff');
  assert.ok(pkg.files.includes('lib/'), 'files must ship lib/');
});

test('a custom tool naming a trust-root artifact via target is denied', async () => {
  // extractTargets is the rail checker's extractor and covers the shapes
  // OpenCode's own mutators use; third-party writers commonly pass `target`,
  // which it does not read. Those reached the handoff core with an empty path
  // list and were allowed on a cold store.
  const dir = repo();
  try {
    const hooks = await adlcRailsGuard({ worktree: dir });
    for (const args of [
      { target: '.adlc/.deny-store' },
      { targetPath: '.adlc/handoffs/denies/s1.json' },
    ]) {
      await assert.rejects(
        () =>
          hooks['tool.execute.before'](
            { tool: 'custom_writer', sessionID: 's1', callID: 'c' },
            { args },
          ),
        /path_protected/,
        `must deny: ${JSON.stringify(args)}`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a custom tool naming an ordinary target is still allowed', async () => {
  const dir = repo();
  try {
    const hooks = await adlcRailsGuard({ worktree: dir });
    for (const args of [{ target: 'src/app.mjs' }, {}]) {
      await hooks['tool.execute.before'](
        { tool: 'custom_writer', sessionID: 's1', callID: 'c' },
        { args },
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a custom tool naming a protected directory is denied', async () => {
  // The structured classifier had no ancestor coverage, so a delete/move tool
  // handed the handoffs directory got through while `rm -rf` on it did not.
  const dir = repo();
  try {
    const hooks = await adlcRailsGuard({ worktree: dir });
    for (const args of [{ target: '.adlc/handoffs' }, { path: '.adlc' }]) {
      await assert.rejects(
        () =>
          hooks['tool.execute.before'](
            { tool: 'custom_deleter', sessionID: 's1', callID: 'c' },
            { args },
          ),
        /path_protected/,
        `must deny: ${JSON.stringify(args)}`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
