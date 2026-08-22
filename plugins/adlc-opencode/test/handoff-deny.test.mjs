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
  createInitLatch,
  createStickyDenyState,
  denyTargetsOf,
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

/**
 * Pin an active ticket for the duration of one test, ambient env or not.
 *
 * `await fn()` inside the try, not `return fn()`: the latter completes the try
 * block as soon as the callback returns its promise, so the restore runs while
 * the async body is still suspended. These tests would still pass — the plugin
 * snapshots process.env synchronously at construction — but only by accident of
 * that timing, and the helper would be quietly wrong for any callback that
 * reads the environment after an await.
 */
async function withActiveTicket(id, fn) {
  const prior = process.env.ADLC_TICKET;
  process.env.ADLC_TICKET = id;
  try {
    return await fn();
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
  // The REAL reason shape for a band self-deny, verified against the gate:
  // D2 plus D3:unauthorized_open:<self>. An invented ['D1:depth_band'] set
  // would exercise a path the gate never produces.
  const tail = recoveryTail('ses_abc-1', ['D2:denier_session', 'D3:unauthorized_open:ses_abc-1']);
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
  // Shell-safe is NOT enough: the CLI's requireSafeSession also rejects path
  // separators, '..' and basename mismatches, and a leading '-' is parsed as a
  // flag. Printing any of those yields a command that cannot run — guidance
  // shaped like help that prolongs the deny.
  for (const cliInvalid of ['../session', 'a/b', 'x/..', '-rf', '..']) {
    const esc = cliInvalid.replace(/[.\\/*+?^${}()|[\]]/g, '\\$&');
    assert.doesNotMatch(
      recoveryTail(cliInvalid, [`D3:unauthorized_open:${cliInvalid}`]),
      new RegExp(`--(deny-)?session ${esc}`),
      `the CLI rejects ${JSON.stringify(cliInvalid)}, so it must not be printed as an argument`,
    );
    // Assert the PROPERTY, not the prose: the rejected id must never appear as
    // a command argument, however the message chooses to explain itself.
    const ownerTail = recoveryTail('blocked', [`D3:unauthorized_open:${cliInvalid}`]);
    assert.doesNotMatch(
      ownerTail,
      new RegExp(`--(deny-)?session ${cliInvalid.replace(/[.\\/*+?^${}()|[\]]/g, '\\$&')}`),
      `an owner of ${JSON.stringify(cliInvalid)} must not be printed as a command argument`,
    );
  }
  for (const unsafe of ['s1; rm -rf /', 'a b', 's1\n', '', null, undefined, 42]) {
    const t = recoveryTail(unsafe);
    assert.doesNotMatch(t, /--deny-session/, `must not build a command from ${JSON.stringify(unsafe)}`);
    assert.doesNotMatch(t, /rm -rf/, 'and must never echo the unsafe id back');
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
  // Every marker this plugin writes carries a null content hash today, so the
  // missing-hash refusal is the one an operator actually hits. A fallback
  // condition naming only the unbound ticket_id reads as "not my situation".
  // runResume has THREE refusals and repair answers all of them ("refresh final
  // AND bind"). Enumerating a subset strands whoever hits the missing one, and
  // an absolute "never repair a bound marker" steered them off the only fix.
  assert.match(tail, /content_hash/, 'the fallback must name the refusal operators actually see');
  assert.match(tail, /ticket_id/);
  assert.match(tail, /final checkpoint it cannot read/, 'a bound marker with no final is still stuck');
  assert.match(tail, /only AFTER resume has actually refused/, 'the rule is order, not bind state');
  assert.doesNotMatch(tail, /never be the first move against a marker that already has one/);
  assert.doesNotMatch(tail, /--session blocked-b /, 'must not address the marker as the blocked session');
  assert.doesNotMatch(tail, /--deny-session blocked-b/);
});

test('the deny owner is parsed only from the D3 reason, and is held to the value grammar', () => {
  assert.deepEqual(denyTargetsOf(['D3:unauthorized_open:owner-a']).owners, ['owner-a']);
  assert.deepEqual(denyTargetsOf(['D1:depth_band', 'D3:unauthorized_open:o2']).owners, ['o2']);
  // One reason per open record, so several open denies name several owners.
  // Taking only the first cleared one marker and left the operator denied.
  assert.deepEqual(
    denyTargetsOf(['D2:denier_session', 'D3:unauthorized_open:a', 'D3:unauthorized_open:b']).owners,
    ['a', 'b'],
  );
  // An INVALID record's label is a session_id read off a record the gate just
  // rejected — never a binding to point a repair command at.
  const bad = denyTargetsOf(['D3:invalid_record:corrupt-1']);
  assert.deepEqual(bad.owners, [], 'an invalid record must not become a repair target');
  assert.equal(bad.invalid, true);
  for (const none of [[], ['D1:depth_band'], ['D2:denier_session'], null, undefined, 'D3:x']) {
    assert.deepEqual(denyTargetsOf(none).owners, [], `must not invent an owner from ${JSON.stringify(none)}`);
  }
  // The owner is read off a deny record on DISK — less trusted than the host's
  // own session id — so an unquotable one degrades instead of being pasted.
  const tail = recoveryTail('blocked-b', ['D3:unauthorized_open:evil; rm -rf /']);
  assert.match(tail, /no owner id in the deny store can be rendered as a safe, copy-pasteable shell word/);
  assert.doesNotMatch(tail, /rm -rf/, 'the unquotable id must never reach the message');
  // And it must NOT fall back to the blocked session: repair against a session
  // that owns no marker is the round-1 defect re-entering by another door.
  assert.doesNotMatch(tail, /--deny-session blocked-b/);
});

test('a directory contaminated by the OLD bug does not activate enforcement after upgrade', async () => {
  // The bug this ticket fixes CREATED .adlc/.deny-store and a deny marker in
  // ordinary directories. If the containment guard keyed on .adlc existing,
  // those artifacts would vouch for themselves: installing the fix would leave
  // exactly the repos it exists to free still bricked — and bricked past reach
  // of the agent shell needed to clean them up.
  const dir = plainDir();
  try {
    mkdirSync(join(dir, '.adlc', 'handoffs', 'denies'), { recursive: true });
    writeFileSync(join(dir, '.adlc', '.deny-store'), '');
    writeFileSync(
      join(dir, '.adlc', 'handoffs', 'denies', 'old-victim.json'),
      JSON.stringify({
        session_id: 'old-victim',
        ticket_id: null,
        content_hash: null,
        status: 'open',
        since: new Date().toISOString(),
        host: 'opencode',
        schema: 1,
      }),
    );
    const hooks = await adlcRailsGuard({ worktree: dir });
    for (let i = 0; i < 40; i += 1) {
      await hooks['tool.execute.before'](
        { tool: 'edit', sessionID: 'after-upgrade', callID: `c${i}` },
        { args: { filePath: 'src/app.mjs' } },
      );
    }
    await hooks['tool.execute.before'](
      { tool: 'bash', sessionID: 'after-upgrade', callID: 'shell' },
      { args: { command: 'rm -rf .adlc' } },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an external ticket-store override is enforced even with no local .adlc', () => {
  // ADLC_TICKET_STORE may point at an absolute store outside the worktree, and
  // resolveRailsInForce accepts that as initialized. If containment also
  // demanded a local .adlc, the rail guard would enforce while the deny-set
  // stood down — a session past the band editing freely, no marker written.
  const dir = plainDir();
  const store = plainDir();
  try {
    const ticketsPath = join(store, 'tickets.json');
    writeFileSync(ticketsPath, JSON.stringify({ tickets: [{ id: 'T1', rails: [] }] }));
    assert.equal(existsSync(join(dir, '.adlc')), false, 'fixture must have no local .adlc');
    let evaluated = 0;
    const evaluate = () => {
      evaluated += 1;
      return { deny: false, reasons: [] };
    };
    checkHandoff({
      tool: 'edit',
      sessionID: 's1',
      root: dir,
      env: { ADLC_TICKET_STORE: ticketsPath },
      evaluate,
    });
    assert.equal(evaluated, 1, 'an externally-configured ADLC repo must still reach the gate');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(store, { recursive: true, force: true });
  }
});

test('an external-store repo is ARMED end to end: the band denies and writes a marker', async () => {
  // The unit check above proves the gate is reached; this proves enforcement
  // actually lands — a deny AND a marker on disk — through the real plugin
  // factory, in a worktree whose .adlc does not exist until the deny creates it.
  const dir = plainDir();
  const store = plainDir();
  const prior = process.env.ADLC_TICKET_STORE;
  process.env.ADLC_TICKET_STORE = join(store, 'tickets.json');
  try {
    writeFileSync(process.env.ADLC_TICKET_STORE, JSON.stringify({ tickets: [{ id: 'T1', rails: [] }] }));
    const hooks = await adlcRailsGuard({ worktree: dir });
    await pumpDepth(hooks, 'ext-sess', HANDOFF_DEPTH);
    await assert.rejects(
      () =>
        hooks['tool.execute.before'](
          { tool: 'edit', sessionID: 'ext-sess', callID: 'c' },
          { args: { filePath: 'src/ok.mjs' } },
        ),
      /ADLC context-handoff/,
      'the deny-set must be armed wherever the rail guard is',
    );
    assert.equal(
      existsSync(join(dir, '.adlc', 'handoffs', 'denies', 'ext-sess.json')),
      true,
      'enforcement must record the deny, not just refuse the call',
    );
  } finally {
    if (prior === undefined) delete process.env.ADLC_TICKET_STORE;
    else process.env.ADLC_TICKET_STORE = prior;
    rmSync(dir, { recursive: true, force: true });
    rmSync(store, { recursive: true, force: true });
  }
});

test('deleting the ticket store mid-session cannot disarm the deny-set', async () => {
  // The containment signal is an unprotected FILE: isProtectedHandoffPath
  // ('.adlc/tickets.json') is false and `rm .adlc/tickets.json` is not a
  // mutating-shell match, while the rail guard is inactive without
  // ADLC_P4_ENFORCEMENT. Without a latch an agent could delete the store below
  // the band and then edit freely forever, never writing a deny.
  const dir = repo();
  try {
    const hooks = await adlcRailsGuard({ worktree: dir });
    // Arm the latch with calls made while the repo is genuinely initialized.
    await hooks['tool.execute.before'](
      { tool: 'edit', sessionID: 'evader', callID: 'c0' },
      { args: { filePath: 'src/ok.mjs' } },
    );
    rmSync(join(dir, '.adlc', 'tickets.json'), { force: true });
    await pumpDepth(hooks, 'evader', HANDOFF_DEPTH);
    await assert.rejects(
      () =>
        hooks['tool.execute.before'](
          { tool: 'edit', sessionID: 'evader', callID: 'c' },
          { args: { filePath: 'src/ok.mjs' } },
        ),
      /ADLC context-handoff/,
      'removing the containment signal must not buy an exit from the deny-set',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('deleting the store on the VERY FIRST call still cannot disarm the deny-set', async () => {
  // "Delete it before the latch arms" is the obvious move against a lazily
  // armed latch. It fails because the hook runs BEFORE the tool it gates, so
  // the store is still present when containment reads it and the latch arms on
  // the very call requesting the deletion. That ordering is not self-evident
  // from the code, so it is pinned here.
  //
  // The deletion uses a STRUCTURED tool deliberately. Probed: `rm
  // .adlc/tickets.json` is already refused as path_protected_shell:.adlc, but
  // structured writes/deletes naming .adlc/tickets.json (path, target and
  // filePath shapes alike) are all ALLOWED — the structured route is the one
  // that can actually remove the containment signal.
  const dir = repo();
  try {
    const hooks = await adlcRailsGuard({ worktree: dir });
    await hooks['tool.execute.before'](
      { tool: 'custom_deleter', sessionID: 'evader-0', callID: 'c0' },
      { args: { path: '.adlc/tickets.json' } },
    );
    rmSync(join(dir, '.adlc', 'tickets.json'), { force: true });
    assert.equal(existsSync(join(dir, '.adlc', 'tickets.json')), false, 'store really is gone');
    await pumpDepth(hooks, 'evader-0', HANDOFF_DEPTH);
    await assert.rejects(
      () =>
        hooks['tool.execute.before'](
          { tool: 'edit', sessionID: 'evader-0', callID: 'c1' },
          { args: { filePath: 'src/ok.mjs' } },
        ),
      /ADLC context-handoff/,
      'the latch armed on the deleting call itself',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the latch only ever arms on a real store, so a contaminated dir stays inert', () => {
  const dir = plainDir();
  try {
    mkdirSync(join(dir, '.adlc', 'handoffs', 'denies'), { recursive: true });
    writeFileSync(join(dir, '.adlc', '.deny-store'), '');
    const latch = createInitLatch();
    let evaluated = 0;
    const evaluate = () => {
      evaluated += 1;
      return { deny: true, reasons: ['D3:unauthorized_open:x'] };
    };
    for (let i = 0; i < 5; i += 1) {
      assert.deepEqual(
        checkHandoff({ tool: 'edit', sessionID: 's1', root: dir, initLatch: latch, evaluate }),
        { decision: 'allow' },
      );
    }
    assert.equal(latch.armed(dir), false, 'a dir that never had a store must never arm');
    assert.equal(evaluated, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an initialized repo is still enforced — the guard is not just "no .adlc"', () => {
  // Guards against the contamination fix over-correcting into a no-op.
  const dir = repo();
  try {
    let evaluated = 0;
    const evaluate = () => {
      evaluated += 1;
      return { deny: false, reasons: [] };
    };
    checkHandoff({ tool: 'edit', sessionID: 's1', root: dir, evaluate });
    assert.equal(evaluated, 1, 'a repo with a ticket store must still reach the gate');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('every open deny is named, not just the first, and --dir is pinned to the repo', () => {
  const tail = recoveryTail(
    'blocked-b',
    ['D2:denier_session', 'D3:unauthorized_open:owner-a', 'D3:unauthorized_open:owner-c'],
    '/repo/root',
  );
  assert.match(tail, /2 open denies are blocking this repo \(owner-a, owner-c\)/);
  // Without --dir the CLI resolves the store against the pasting shell's cwd,
  // exits 0 against some other directory, and leaves this repo denied.
  assert.match(tail, /--deny-session owner-a --dir \/repo\/root\/\.adlc --write/);
  assert.match(tail, /--content-hash <hash> --dir \/repo\/root\/\.adlc --write/);
});

test('a repo path that cannot be a safe shell word drops --dir and says to cd', () => {
  const tail = recoveryTail('s1', ['D3:unauthorized_open:o1'], "/repo/it's here");
  assert.doesNotMatch(tail, /--dir [^i]/, 'no --dir FLAG, though the prose may explain its absence');
  assert.match(tail, /Run them from the repo root/);
  const spaced = recoveryTail('s1', ['D3:unauthorized_open:o1'], '/repo/my root');
  assert.match(spaced, /--dir '\/repo\/my root\/\.adlc'/, 'a mere space is quotable, not a degrade');
});

test('an invalid deny record is never a repair target and sends the operator to the store', () => {
  const tail = recoveryTail('blocked-b', ['D3:invalid_record:corrupt-1'], '/repo/root');
  assert.doesNotMatch(tail, /--deny-session corrupt-1/, 'a record the gate rejected is not a binding');
  assert.doesNotMatch(tail, /--deny-session blocked-b/, 'nor is the blocked session a marker owner');
  assert.match(tail, /judged INVALID/);
  assert.match(tail, /Inspect \.adlc\/handoffs\/denies\//);
});

test('a consumed self-deny is called out, because clearing the open denies will not release it', () => {
  // D2 fires on the session's OWN record even once consumed, but the D3 loop
  // skips records that are not `open` — so a consumed self-record yields D2
  // with no self owner, and neither resume nor repair acts on it (repair binds
  // an OPEN deny). Without saying so, the operator clears every listed owner
  // and is still denied.
  const both = recoveryTail('A', ['D2:denier_session', 'D3:unauthorized_open:C'], '/r');
  assert.match(both, /--deny-session C/, 'the open foreign deny is still actionable');
  assert.match(both, /consumed but still blocking/);
  assert.match(both, /FRESH session/);

  // A band self-deny reports D2 AND its own open D3, so the record IS
  // actionable and the sticky note would be wrong there.
  const bandSelf = recoveryTail('A', ['D2:denier_session', 'D3:unauthorized_open:A'], '/r');
  assert.doesNotMatch(bandSelf, /consumed but still blocking/);

  // D2 alone: nothing to target, and the stickiness is the whole story.
  const alone = recoveryTail('A', ['D2:denier_session'], '/r');
  assert.doesNotMatch(alone, /--deny-session/);
  assert.match(alone, /consumed but still blocking/);
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
