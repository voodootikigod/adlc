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
  denyOwnerOf,
  handoffAppliesTo,
  isShellTool,
  recoveryTail,
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

/** A directory that never opted into ADLC — no .adlc/, nothing to enforce. */
function plainDir() {
  return mkdtempSync(join(tmpdir(), 'oc-plain-'));
}

/** Pin an active ticket for the duration of one test, ambient env or not. */
function withActiveTicket(id, fn) {
  const prior = process.env.ADLC_TICKET;
  process.env.ADLC_TICKET = id;
  try {
    return fn();
  } finally {
    if (prior === undefined) delete process.env.ADLC_TICKET;
    else process.env.ADLC_TICKET = prior;
  }
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
  const dir = repo();
  try {
    const seen = [];
    const evaluate = (o) => {
      seen.push(o.sessionId);
      return { deny: false, reasons: [] };
    };
    for (const sessionID of [undefined, '', null]) {
      checkHandoff({ tool: 'edit', args: {}, sessionID, root: dir, evaluate });
    }
    assert.deepEqual(seen, [null, null, null]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('outside an ADLC repo the gate never evaluates and never denies', () => {
  const dir = plainDir();
  try {
    let evaluated = 0;
    const evaluate = () => {
      evaluated += 1;
      return { deny: true, reasons: ['D1:should_never_be_reached'] };
    };
    for (const tool of ['edit', 'bash', 'write', 'custom_writer']) {
      assert.deepEqual(
        checkHandoff({ tool, args: { filePath: 'src/app.mjs' }, sessionID: 's1', root: dir, evaluate }),
        { decision: 'allow' },
      );
    }
    assert.equal(evaluated, 0, 'the deny-set has no jurisdiction over a repo that never opted in');
    assert.equal(existsSync(join(dir, '.adlc')), false, 'the gate must not create the store it looks for');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unusable root is a broken caller, not containment — it must not buy an allow', () => {
  const evaluate = () => ({ deny: true, reasons: ['D3:unauthorized_open:someone'] });
  for (const root of [undefined, '', null, 42]) {
    assert.equal(
      checkHandoff({ tool: 'edit', sessionID: 's1', root, evaluate }).decision,
      'deny',
      `a root of ${JSON.stringify(root)} proves nothing about whether this is an ADLC repo`,
    );
  }
});

test('the containment guard uses the caller root, not the process cwd', () => {
  // Re-deriving cwd would make an agent that cd-ed out of the repo look
  // un-enforced — and one that cd-ed INTO an unrelated ADLC checkout look
  // enforced against the wrong store.
  const inside = repo();
  const outside = plainDir();
  const priorCwd = process.cwd();
  try {
    process.chdir(outside);
    let evaluated = 0;
    const evaluate = () => {
      evaluated += 1;
      return { deny: false, reasons: [] };
    };
    checkHandoff({ tool: 'edit', sessionID: 's1', root: inside, evaluate });
    assert.equal(evaluated, 1, 'an ADLC root is still enforced from an unrelated cwd');

    process.chdir(inside);
    assert.deepEqual(
      checkHandoff({ tool: 'edit', sessionID: 's1', root: outside, evaluate }),
      { decision: 'allow' },
    );
    assert.equal(evaluated, 1, 'a non-ADLC root is still inert from an ADLC cwd');
  } finally {
    process.chdir(priorCwd);
    rmSync(inside, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('the active ticket is threaded to the gate, and resolved only when it is needed', () => {
  const dir = repo();
  try {
    const seen = [];
    let resolutions = 0;
    const evaluate = (o) => {
      seen.push(o.ticketId);
      return { deny: false, reasons: [] };
    };
    const ticketId = () => {
      resolutions += 1;
      return 'T-ACTIVE';
    };
    checkHandoff({ tool: 'edit', sessionID: 's1', root: dir, ticketId, evaluate });
    checkHandoff({ tool: 'read', sessionID: 's1', root: dir, ticketId, evaluate });
    checkHandoff({ tool: 'edit', sessionID: 's1', root: dir, ticketId: 'T-LITERAL', evaluate });
    checkHandoff({ tool: 'edit', sessionID: 's1', root: dir, ticketId: '', evaluate });
    assert.deepEqual(seen, ['T-ACTIVE', 'T-LITERAL', null], 'a blank id must reach the gate as null');
    assert.equal(resolutions, 1, 'the read-only hot path must not pay for a ticket-store read');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a self-deny recovery tail targets this session, exact command text', () => {
  // Asserted as the EXACT command text, placeholders included: what the operator
  // pastes into a host shell is the contract here, so `--ticket <id>` degrading
  // into `--ticket >=id>` is a real defect, not cosmetic drift.
  const tail = recoveryTail('ses_abc-1', ['D1:depth_band']);
  assert.match(
    tail,
    /`adlc handoff resume --session <new-session> --deny-session ses_abc-1 --write`/,
  );
  assert.match(
    tail,
    /`adlc handoff repair --session ses_abc-1 --ticket <id> --content-hash <hash> --write`/,
  );
  assert.ok(
    tail.indexOf('handoff resume') < tail.indexOf('handoff repair'),
    'resume must be the first move: repair rewrites an existing binding',
  );
  for (const unsafe of ['s1; rm -rf /', 'a b', 's1\n', '', null, undefined, 42]) {
    assert.match(
      recoveryTail(unsafe),
      /No safe session id/,
      `must not build a command from ${JSON.stringify(unsafe)}`,
    );
  }
});

test('a foreign deny recovers the OWNING session, not the blocked one', () => {
  // The common successor-session path: B is blocked because A's marker is open.
  // Every recovery command addresses the MARKER, so naming B sends the operator
  // to `repair --session B`, which finds no marker and refuses.
  const tail = recoveryTail('blocked-b', ['D3:unauthorized_open:owner-a']);
  assert.match(tail, /blocked-b/, 'the blocked session is still worth naming');
  assert.match(
    tail,
    /`adlc handoff repair --session owner-a --ticket <id> --content-hash <hash> --write`/,
  );
  assert.match(
    tail,
    /`adlc handoff resume --session <new-session> --deny-session owner-a --write`/,
  );
  assert.ok(
    tail.indexOf('handoff resume') < tail.indexOf('handoff repair'),
    'resume must be the first move: repair rewrites an existing binding',
  );
  assert.doesNotMatch(tail, /--session blocked-b /, 'must not address the marker as the blocked session');
  assert.doesNotMatch(tail, /--deny-session blocked-b/);
});

test('the deny owner is parsed only from the D3 reason, and is held to the value grammar', () => {
  assert.equal(denyOwnerOf(['D3:unauthorized_open:owner-a']), 'owner-a');
  assert.equal(denyOwnerOf(['D1:depth_band', 'D3:unauthorized_open:o2']), 'o2');
  for (const none of [[], ['D1:depth_band'], ['D2:denier_session'], null, undefined, 'D3:x']) {
    assert.equal(denyOwnerOf(none), null, `must not invent an owner from ${JSON.stringify(none)}`);
  }
  // The owner is read off a deny record on DISK — less trusted than the host's
  // own session id — so an unquotable one degrades instead of being pasted.
  const tail = recoveryTail('blocked-b', ['D3:unauthorized_open:evil; rm -rf /']);
  assert.match(tail, /cannot be printed as a safe, copy-pasteable shell command/);
  assert.doesNotMatch(tail, /rm -rf/);
});

test('a foreign deny still prints the owner command when this session has no safe id', () => {
  const tail = recoveryTail(undefined, ['D3:unauthorized_open:owner-a']);
  assert.match(tail, /`adlc handoff resume --session <new-session> --deny-session owner-a --write`/);
  assert.match(tail, /`adlc handoff repair --session owner-a --ticket <id> --content-hash <hash> --write`/);
  assert.ok(tail.indexOf('handoff resume') < tail.indexOf('handoff repair'));
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
  const dir = repo();
  try {
    const seen = [];
    const evaluate = (o) => {
      seen.push(o.manifestKey);
      return { deny: false, reasons: [], denyEverWritten: false };
    };
    checkHandoff({
      tool: 'edit',
      sessionID: 's1',
      root: dir,
      env: { ADLC_MANIFEST_KEY: 'k'.repeat(64) },
      evaluate,
    });
    checkHandoff({ tool: 'edit', sessionID: 's1', root: dir, env: {}, evaluate });
    assert.deepEqual(seen, ['k'.repeat(64), null]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed marker write stays sticky for the session across calls', () => {
  const dir = repo();
  try {
    const sticky = createStickyDenyState();
    const calls = [];
    // First call reports the D1 fact; the second must receive it back.
    const evaluate = (o) => {
      calls.push(o.denyEverWritten);
      return { deny: false, reasons: [], denyEverWritten: true };
    };
    checkHandoff({ tool: 'edit', sessionID: 's1', root: dir, sticky, evaluate });
    checkHandoff({ tool: 'edit', sessionID: 's1', root: dir, sticky, evaluate });
    // …and must not leak to a different session.
    checkHandoff({ tool: 'edit', sessionID: 's2', root: dir, sticky, evaluate });
    assert.deepEqual(calls, [false, true, false]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

test('a directory that never opted into ADLC is inert for a whole long session', async () => {
  // The release blocker: in an empty directory the depth band denied tool call
  // 30 and everything after it — bricking edits AND the shell repo-wide — and
  // created .adlc/.deny-store + .adlc/handoffs/denies/<session>.json in a repo
  // that never asked for any of it.
  const dir = plainDir();
  try {
    const hooks = await adlcRailsGuard({ worktree: dir });
    const calls = [
      { tool: 'edit', args: { filePath: 'src/app.mjs' } },
      { tool: 'bash', args: { command: 'ls -la' } },
      { tool: 'write', args: { filePath: 'README.md' } },
      { tool: 'custom_writer', args: { target: 'src/other.mjs' } },
      { tool: 'read', args: { filePath: 'src/app.mjs' } },
    ];
    for (let i = 0; i < 45; i += 1) {
      const { tool, args } = calls[i % calls.length];
      await hooks['tool.execute.before']({ tool, sessionID: 'plain-sess', callID: `c${i}` }, { args });
    }
    const permission = {};
    await hooks['permission.ask']({ type: 'edit', sessionID: 'plain-sess' }, permission);
    assert.equal(permission.status, undefined, 'permission.ask must be inert outside an ADLC repo too');
    assert.equal(
      existsSync(join(dir, '.adlc')),
      false,
      'the gate must not create .adlc/ in a repo that never opted into ADLC',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the deny marker is bound to the active ticket, so host repair/resume can act on it', async () => {
  // ticket_id:null is a marker `adlc handoff resume` refuses outright
  // ("ticket_id is null — cannot resume (use host repair)").
  const dir = repo();
  try {
    await withActiveTicket('T1', async () => {
      writeFileSync(join(dir, '.adlc', 'current-ticket.json'), JSON.stringify({ id: 'T1' }));
      const hooks = await adlcRailsGuard({ worktree: dir });
      await pumpDepth(hooks, 'bound-sess', HANDOFF_DEPTH);
      await assert.rejects(
        () =>
          hooks['tool.execute.before'](
            { tool: 'edit', sessionID: 'bound-sess', callID: 'c' },
            { args: { filePath: 'src/ok.mjs' } },
          ),
        /ADLC context-handoff/,
      );
      const marker = JSON.parse(
        readFileSync(join(dir, '.adlc', 'handoffs', 'denies', 'bound-sess.json'), 'utf8'),
      );
      assert.equal(marker.ticket_id, 'T1');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a conflicting active-ticket signal binds the marker to nothing, never to a guess', async () => {
  // ADLC_TICKET disagreeing with .adlc/current-ticket.json is a tamper signal.
  // The deny must still be recorded — it just must not claim a ticket, or host
  // repair would be handed a binding the repo never agreed to.
  const dir = repo();
  try {
    await withActiveTicket('T1', async () => {
      writeFileSync(join(dir, '.adlc', 'current-ticket.json'), JSON.stringify({ id: 'T-OTHER' }));
      const hooks = await adlcRailsGuard({ worktree: dir });
      await pumpDepth(hooks, 'conflict-sess', HANDOFF_DEPTH);
      await assert.rejects(
        () =>
          hooks['tool.execute.before'](
            { tool: 'edit', sessionID: 'conflict-sess', callID: 'c' },
            { args: { filePath: 'src/ok.mjs' } },
          ),
        /ADLC context-handoff/,
      );
      const marker = JSON.parse(
        readFileSync(join(dir, '.adlc', 'handoffs', 'denies', 'conflict-sess.json'), 'utf8'),
      );
      assert.equal(marker.ticket_id, null);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the deny message carries the session id and a recovery command against the deny OWNER', async () => {
  // This setup is a D3 foreign deny: denier-tail owns the open marker and
  // tail-sess is merely blocked by it. The command must address denier-tail —
  // an earlier version of this test asserted the tail-sess command and so
  // pinned the bug it was supposed to catch.
  const dir = repo();
  try {
    seedForeignDeny(dir, 'denier-tail');
    const hooks = await adlcRailsGuard({ worktree: dir });
    await assert.rejects(
      () =>
        hooks['tool.execute.before'](
          { tool: 'edit', sessionID: 'tail-sess', callID: 'c' },
          { args: { filePath: 'src/ok.mjs' } },
        ),
      (err) => {
        assert.match(err.message, /tail-sess/, 'the operator must be told which session is blocked');
        assert.match(err.message, /adlc handoff repair --session denier-tail/);
        assert.match(err.message, /adlc handoff resume --session <new-session> --deny-session denier-tail/);
        assert.doesNotMatch(err.message, /--session tail-sess /);
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a depth-band self-deny recovers this session, through the real hook', async () => {
  const dir = repo();
  try {
    const hooks = await adlcRailsGuard({ worktree: dir });
    await pumpDepth(hooks, 'self-sess', HANDOFF_DEPTH);
    await assert.rejects(
      () =>
        hooks['tool.execute.before'](
          { tool: 'edit', sessionID: 'self-sess', callID: 'c' },
          { args: { filePath: 'src/ok.mjs' } },
        ),
      (err) => {
        assert.match(err.message, /adlc handoff repair --session self-sess/);
        assert.match(err.message, /--deny-session self-sess/);
        return true;
      },
    );
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
