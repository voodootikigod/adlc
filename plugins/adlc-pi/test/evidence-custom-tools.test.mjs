// T23 tests: gate-evidence rail (session + chained manifest), custom-tool
// coverage, user_bash advisory, and the position-aware suppression delta.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, symlinkSync, chmodSync, existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkCustomTool, extractToolPaths } from '../lib/rails-checker.mjs';
import { operativeMarkerSet, scanOperativeDelta, mergeViolations } from '../lib/reactive-gate.mjs';
import { recordGateEvent } from '../lib/evidence.mjs';
import { verify } from '@adlc/gate-manifest/lib/verify.mjs';
import { createExtension } from '../lib/extension.mjs';

// Marker fixtures are concatenated so this test file's diff never carries an
// operative-looking suppression literal (the repo's own gates scan it).
const TS_IGNORE = '@ts-' + 'ignore';

const TICKET = {
  id: 'T1',
  title: 'Test Ticket',
  body: 'Do the thing',
  scope: ['src/**', 'docs/**'],
  rails: ['test/contracts/**'],
};

function makeRepo({ tickets = [TICKET], current = 'T1' } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'adlc-pi-ev-')));
  mkdirSync(join(root, '.adlc'), { recursive: true });
  writeFileSync(join(root, '.adlc', 'tickets.json'), JSON.stringify({ tickets }, null, 2));
  if (current !== null) writeFileSync(join(root, '.adlc', 'current-ticket.json'), JSON.stringify({ id: current }));
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'test', 'contracts'), { recursive: true });
  writeFileSync(join(root, 'test', 'contracts', 'auth.test.ts'), 'contract\n');
  return root;
}

function fakePi() {
  const handlers = {};
  const entries = [];
  const steers = [];
  return {
    on(name, fn) { handlers[name] = fn; },
    registerCommand() {},
    async exec() { return { stdout: '', stderr: '', code: 0 }; },
    sendMessage(msg, opts) { steers.push({ msg, opts }); },
    appendEntry(customType, data) { entries.push({ customType, data }); },
    handlers, entries, steers,
  };
}

function fakeCtx(cwd) {
  const notices = [];
  return {
    cwd,
    ui: { setStatus() {}, notify(m, l) { notices.push({ m, l }); } },
    getContextUsage: () => ({ tokens: 10, contextWindow: 1000, percent: 1 }),
    notices,
  };
}

async function boot(root) {
  const pi = fakePi();
  createExtension({ env: {} })(pi);
  const ctx = fakeCtx(root);
  await pi.handlers.session_start({ type: 'session_start', reason: 'startup' }, ctx);
  return { pi, ctx };
}

const call = (toolName, input, id = 'c1') => ({ type: 'tool_call', toolName, toolCallId: id, input });

// =========================================================================
// AC1 — evidence rail: session entry + chained manifest line; deny survives
// a failing ledger
// =========================================================================

test('AC1: a rail deny records a session entry AND a chain-valid manifest line', async () => {
  const root = makeRepo();
  try {
    const { pi, ctx } = await boot(root);
    const denied = await pi.handlers.tool_call(call('write', { path: 'test/contracts/auth.test.ts', content: 'x' }), ctx);
    assert.equal(denied.block, true);

    assert.equal(pi.entries.length, 1, 'session evidence entry appended');
    assert.equal(pi.entries[0].customType, 'adlc-gate-event');
    assert.equal(pi.entries[0].data.type, 'rail-deny');

    const manifest = readFileSync(join(root, '.adlc', 'manifest.jsonl'), 'utf8');
    assert.match(manifest, /pi-rail-deny/);
    // The mirror must be CHAIN-VALID (raw appends would corrupt the ledger).
    const verdict = verify(join(root, '.adlc'), { key: null });
    assert.equal(verdict.valid, true, `manifest chain must verify: ${JSON.stringify(verdict)}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('AC1: suppression revert records evidence; a failing ledger does not stop the revert', async () => {
  const root = makeRepo();
  try {
    const { pi, ctx } = await boot(root);
    await pi.handlers.tool_call(call('write', { path: 'src/a.ts', content: 'x' }, 'w1'), ctx);
    writeFileSync(join(root, 'src', 'a.ts'), `// ${TS_IGNORE}\nbad();\n`);
    // Break the ledger AFTER the tool call so only the evidence write fails.
    chmodSync(join(root, '.adlc'), 0o555);
    const result = await pi.handlers.tool_result({ type: 'tool_result', toolName: 'write', toolCallId: 'w1', input: {}, content: [], isError: false }, ctx);
    chmodSync(join(root, '.adlc'), 0o755);

    assert.equal(result.isError, true, 'revert verdict unaffected by ledger failure');
    assert.equal(existsSync(join(root, 'src', 'a.ts')), false, 'snapshot restore still happened (file did not pre-exist)');
    assert.equal(pi.entries.some((e) => e.data.type === 'suppression-revert'), true, 'session entry still recorded');
    assert.ok(ctx.notices.some((n) => n.l === 'warning' && /evidence write failed/.test(n.m)), 'ledger failure degraded to a warning');
  } finally {
    chmodSync(join(root, '.adlc'), 0o755);
    rmSync(root, { recursive: true, force: true });
  }
});

// =========================================================================
// AC2/AC3 — custom-tool coverage
// =========================================================================

test('AC2: synthetic third-party write tool against a rail is denied; in-scope not blocked; no-path tool recorded unvetted', async () => {
  const root = makeRepo();
  try {
    const { pi, ctx } = await boot(root);

    const denied = await pi.handlers.tool_call(call('write_file', { file: 'test/contracts/auth.test.ts', contents: 'x' }), ctx);
    assert.equal(denied.block, true);
    assert.match(denied.reason, /frozen rail/);

    const allowed = await pi.handlers.tool_call(call('write_file', { file: 'src/ok.ts', contents: 'x' }, 'c2'), ctx);
    assert.equal(allowed, undefined);

    const unvetted = await pi.handlers.tool_call(call('run_linter', {}, 'c3'), ctx);
    assert.equal(unvetted, undefined, 'no-path unknown tool is allowed');
    assert.equal(pi.entries.filter((e) => e.data.type === 'unvetted-tool' && e.data.tool === 'run_linter').length, 1);

    // once per tool name per session
    await pi.handlers.tool_call(call('run_linter', {}, 'c4'), ctx);
    assert.equal(pi.entries.filter((e) => e.data.type === 'unvetted-tool').length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('AC3: symlink through a custom tool path arg is resolved and denied', async () => {
  const root = makeRepo();
  try {
    symlinkSync(join(root, 'test', 'contracts', 'auth.test.ts'), join(root, 'src', 'alias.ts'));
    const { pi, ctx } = await boot(root);
    const denied = await pi.handlers.tool_call(call('write_file', { path: 'src/alias.ts' }), ctx);
    assert.equal(denied.block, true);
    assert.match(denied.reason, /frozen rail/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('extractToolPaths: path keys, arrays, and repo-resolving strings; prose ignored', () => {
  const root = makeRepo();
  try {
    writeFileSync(join(root, 'src', 'real.ts'), 'x\n');
    const paths = extractToolPaths(
      { file: 'a.ts', targets: undefined, path: 'b.ts', note: 'just prose here', existing: 'src/real.ts', missing: 'src/none.ts' },
      root
    );
    assert.ok(paths.includes('a.ts'));
    assert.ok(paths.includes('b.ts'));
    assert.ok(paths.includes('src/real.ts'), 'repo-resolving string collected');
    assert.ok(!paths.includes('just prose here'));
    assert.ok(!paths.includes('src/none.ts'), 'non-existing non-key string ignored');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('checkCustomTool: read-only built-ins are vetted allows', () => {
  const root = makeRepo();
  try {
    const verdict = checkCustomTool('grep', { path: 'test/contracts/auth.test.ts' }, TICKET, root);
    assert.equal(verdict.decision, 'allow');
    assert.equal(verdict.unvetted, undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// =========================================================================
// AC4 — user_bash advisory
// =========================================================================

test('AC4: rail-mutating user_bash warns + records, never blocks; read-only stays silent', async () => {
  const root = makeRepo();
  try {
    const { pi, ctx } = await boot(root);
    const result = await pi.handlers.user_bash(
      { type: 'user_bash', command: 'echo x > test/contracts/auth.test.ts', excludeFromContext: false, cwd: root },
      ctx
    );
    assert.equal(result, undefined, 'human commands are never blocked');
    assert.ok(ctx.notices.some((n) => n.l === 'warning' && /frozen rail/.test(n.m)));
    assert.equal(pi.entries.filter((e) => e.data.type === 'user-bash-rail-override').length, 1);

    const before = pi.entries.length;
    await pi.handlers.user_bash({ type: 'user_bash', command: 'git status', excludeFromContext: false, cwd: root }, ctx);
    await pi.handlers.user_bash({ type: 'user_bash', command: 'npm run build', excludeFromContext: false, cwd: root }, ctx);
    assert.equal(pi.entries.length, before, 'read-only and non-rail commands record nothing');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// =========================================================================
// AC5 — position-aware suppression delta
// =========================================================================

test('AC5: marker relocated out of a fenced .mdx block is flagged; the reverse move is not', () => {
  const markerLine = `// ${TS_IGNORE} sample`;
  const fenced = `intro\n\`\`\`ts\n${markerLine}\n\`\`\`\nrest\n`;
  const operative = `${markerLine}\nintro\n\`\`\`ts\n\`\`\`\nrest\n`;

  const flagged = scanOperativeDelta(fenced, operative, 'docs/page.mdx', [], '');
  assert.equal(flagged.length, 1, 'inert→operative relocation must be flagged');
  assert.equal(flagged[0].marker, TS_IGNORE);
  assert.equal(flagged[0].lineNo, 1);

  const reverse = scanOperativeDelta(operative, fenced, 'docs/page.mdx', [], '');
  assert.equal(reverse.length, 0, 'operative→inert move is never flagged');
});

test('AC5 (wiring): relocation caught through the real write gate even though the line multiset is unchanged', async () => {
  const root = makeRepo();
  const markerLine = `// ${TS_IGNORE} sample`;
  try {
    writeFileSync(join(root, 'docs') , '', { flag: 'wx' }); // ensure parent creation below
  } catch { /* dir path created next */ }
  rmSync(join(root, 'docs'), { force: true });
  mkdirSync(join(root, 'docs'), { recursive: true });
  try {
    const target = join(root, 'docs', 'page.mdx');
    writeFileSync(target, `intro\n\`\`\`ts\n${markerLine}\n\`\`\`\nrest\n`);
    const { pi, ctx } = await boot(root);
    await pi.handlers.tool_call(call('edit', { path: 'docs/page.mdx', edits: [] }, 'e1'), ctx);
    writeFileSync(target, `${markerLine}\nintro\n\`\`\`ts\n\`\`\`\nrest\n`);
    const result = await pi.handlers.tool_result({ type: 'tool_result', toolName: 'edit', toolCallId: 'e1', input: {}, content: [], isError: false }, ctx);
    assert.equal(result.isError, true, 'relocation must fail the gate');
    assert.match(result.content[0].text, /GATE FAILED/);
    assert.equal(readFileSync(target, 'utf8'), `intro\n\`\`\`ts\n${markerLine}\n\`\`\`\nrest\n`, 'reverted to pre-tool snapshot');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('F1 regression: a PRE-EXISTING operative marker plus unrelated added lines is NOT flagged (no over-reversion)', () => {
  const oldContent = `// ${TS_IGNORE}\nconst a = 1;\n`;
  const newContent = `// ${TS_IGNORE}\nconst a = 1;\nconst b = 2;\n`;
  const delta = scanOperativeDelta(oldContent, newContent, 'src/a.ts', [], '');
  assert.equal(delta.length, 0, 'the before.has(marker) guard must suppress pre-existing operative markers');
});

test('F1 regression (wiring): appending clean lines to a file that already carries a marker passes the gate', async () => {
  const root = makeRepo();
  try {
    const target = join(root, 'src', 'legacy.ts');
    writeFileSync(target, `// ${TS_IGNORE}\nold();\n`);
    const { pi, ctx } = await boot(root);
    await pi.handlers.tool_call(call('edit', { path: 'src/legacy.ts', edits: [] }, 'e9'), ctx);
    writeFileSync(target, `// ${TS_IGNORE}\nold();\nnewClean();\n`);
    const result = await pi.handlers.tool_result({ type: 'tool_result', toolName: 'edit', toolCallId: 'e9', input: {}, content: [], isError: false }, ctx);
    assert.equal(result, undefined, 'legit append must not be reverted');
    assert.equal(readFileSync(target, 'utf8'), `// ${TS_IGNORE}\nold();\nnewClean();\n`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('F2 regression: opaque and expansion rail-resets by the human are advised + recorded', async () => {
  const root = makeRepo();
  try {
    const { pi, ctx } = await boot(root);
    await pi.handlers.user_bash({ type: 'user_bash', command: 'git checkout -- test/contracts/auth.test.ts', excludeFromContext: false, cwd: root }, ctx);
    await pi.handlers.user_bash({ type: 'user_bash', command: 'echo x > $RAIL_FILE', excludeFromContext: false, cwd: root }, ctx);
    assert.equal(pi.entries.filter((e) => e.data.type === 'user-bash-rail-override').length, 2, 'opaque + expansion mutations both audited');
    // non-mutating unverifiable command stays silent (no advisory spam)
    const before = pi.entries.length;
    await pi.handlers.user_bash({ type: 'user_bash', command: 'npm run build', excludeFromContext: false, cwd: root }, ctx);
    assert.equal(pi.entries.length, before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('F3 regression: one level of nested tool input is extracted and rail-checked', async () => {
  const root = makeRepo();
  try {
    const { pi, ctx } = await boot(root);
    const denied = await pi.handlers.tool_call(call('patcher', { opts: { path: 'test/contracts/auth.test.ts' } }, 'n1'), ctx);
    assert.equal(denied.block, true, 'nested path must be rail-checked');
    const paths = extractToolPaths({ opts: { file: 'a.ts' }, deep: { more: { path: 'b.ts' } } }, root);
    assert.ok(paths.includes('a.ts'));
    assert.ok(!paths.includes('b.ts'), 'recursion is bounded to one level (CI backstop beyond)');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('operativeMarkerSet: .md prose exempt; code files fully operative', () => {
  assert.equal(operativeMarkerSet(`uses ${TS_IGNORE} in prose\n`, 'docs/guide.md').size, 0);
  const set = operativeMarkerSet(`// ${TS_IGNORE}\n`, 'src/a.ts');
  assert.equal(set.has(TS_IGNORE), true);
});

test('mergeViolations dedupes by file+marker', () => {
  const a = { file: 'f', marker: 'm', lineNo: 1, content: 'x' };
  const b = { file: 'f', marker: 'm', lineNo: 9, content: 'y' };
  const c = { file: 'g', marker: 'm', lineNo: 2, content: 'z' };
  assert.equal(mergeViolations([a], [b, c]).length, 2);
});

// recordGateEvent unit: both sinks fed
test('recordGateEvent writes both sinks and degrades per-sink', () => {
  const root = makeRepo();
  try {
    const pi = fakePi();
    const ctx = fakeCtx(root);
    recordGateEvent({ pi, ctx, root, ticketId: 'T1', type: 'shell-deny', detail: { reason: 'r' } });
    assert.equal(pi.entries.length, 1);
    assert.match(readFileSync(join(root, '.adlc', 'manifest.jsonl'), 'utf8'), /pi-shell-deny/);

    // session sink broken → warning, manifest still written
    const brokenPi = { ...fakePi(), appendEntry() { throw new Error('boom'); } };
    recordGateEvent({ pi: brokenPi, ctx, root, ticketId: 'T1', type: 'shell-deny', detail: {} });
    assert.ok(ctx.notices.some((n) => /session evidence write failed/.test(n.m)));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
