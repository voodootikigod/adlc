// rails-checker.test.mjs — AC3 enforcement proof for the OpenCode rails guard.
// Exercises the pure decision (checkRail) and the REAL exported
// tool.execute.before handler against representative payloads. Offline, no
// opencode binary, leaves no trace.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkRail, checkToolCall, extractTargets, resolveActiveTicketId } from '../rails-checker.mjs';
import { adlcRailsGuard } from '../index.mjs';

function repo({ tickets, current } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'oc-rails-'));
  mkdirSync(join(dir, '.adlc'), { recursive: true });
  if (tickets !== undefined) writeFileSync(join(dir, '.adlc', 'tickets.json'), JSON.stringify(tickets));
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

test('j: bash is deliberately not gated in-session (CI diff gate covers it)', () => {
  const dir = repo({ tickets: T1_RAILED });
  try {
    const r = checkToolCall({ tool: 'bash', args: { command: 'echo x > test/x.mjs' }, root: dir, env: { ...ON, ADLC_TICKET: 'T1' } });
    assert.equal(r.decision, 'allow');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- (k) ungated-name spoofing: an "ungated" tool carrying a rail target is denied ----
// A benign bash/todowrite/question never carries a file-path arg; if one does and it
// resolves to a frozen rail, allowing purely by name would hand a co-installed
// plugin a bypass. (Read-only names stay allowed — reading rails is legitimate;
// that residual class falls to the Phase 2.5 file.edited backstop + CI gate.)
for (const tool of ['todowrite', 'question', 'bash']) {
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
