// T24 tests: the /adlc-* command surface (spec Phase 3.1).
//
// AC1 asserts the six prompt templates + manifest field. AC2–AC5 drive the real
// registerCommand handlers through the same fake-pi harness the other wiring
// tests use, so a regression in the command wiring fails here. The extension is
// booted end-to-end (createExtension()(pi)) so /adlc-ticket exercises the real
// reload path shared with the gate.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createExtension } from '../lib/extension.mjs';
import { verify } from '@adlc/gate-manifest/lib/verify.mjs';
import { migrateLegacyStore, migrationPlan } from '@adlc/tickets';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(HERE, '..');

const T1 = {
  id: 'T1', title: 'First ticket', body: 'Do the first thing',
  scope: ['src/**'], rails: ['test/contracts/**'], edges: [], duration: 1, category: 'feature',
};
const T2 = {
  id: 'T2', title: 'Second ticket', body: 'Do the second thing',
  scope: ['lib/**'], rails: ['test/contracts/**'], edges: [], duration: 1, category: 'feature',
};

function makeRepo({ tickets = [T1, T2], current = 'T1' } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'adlc-pi-cmd-')));
  mkdirSync(join(root, '.adlc'), { recursive: true });
  writeFileSync(join(root, '.adlc', 'tickets.json'), JSON.stringify({ tickets }, null, 2));
  if (current !== null) {
    writeFileSync(join(root, '.adlc', 'current-ticket.json'), JSON.stringify({ id: current }));
  }
  return root;
}

// A fake pi with the surface the command handlers touch: on/registerCommand,
// exec (configurable), and appendEntry for the evidence rail.
function fakePi({ exec } = {}) {
  const handlers = {};
  const commands = {};
  const entries = [];
  return {
    on(name, fn) { handlers[name] = fn; },
    registerCommand(name, def) { commands[name] = def; },
    async exec(cmd, args) {
      if (typeof exec === 'function') return exec(cmd, args);
      return { stdout: '', stderr: '', code: 0 };
    },
    appendEntry(customType, data) { entries.push({ customType, data }); },
    handlers, commands, entries,
  };
}

// ctx with configurable dialogs. select/confirm default to a resolved value;
// hasUI defaults true (TUI). Records dialog invocations for degradation asserts.
function fakeCtx(cwd, { hasUI = true, select, confirm } = {}) {
  const notices = [];
  const calls = { select: 0, confirm: 0 };
  return {
    cwd,
    hasUI,
    ui: {
      setStatus() {},
      notify(msg, level) { notices.push({ msg, level }); },
      async select(title, options) {
        calls.select += 1;
        return typeof select === 'function' ? select(title, options) : options[0];
      },
      async confirm(title, message) {
        calls.confirm += 1;
        return typeof confirm === 'function' ? confirm(title, message) : true;
      },
    },
    notices,
    calls,
  };
}

async function boot(root, { env = {}, exec } = {}) {
  const pi = fakePi({ exec });
  createExtension({ env })(pi);
  const ctx = fakeCtx(root);
  await pi.handlers.session_start({ type: 'session_start', reason: 'startup' }, ctx);
  return { pi };
}

// Minimal frontmatter reader: the block between the first two '---' fences.
function readFrontmatter(file) {
  const text = readFileSync(file, 'utf8');
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const fields = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z-]+):\s*(.*)$/);
    if (kv) fields[kv[1]] = kv[2];
  }
  return fields;
}

// =========================================================================
// AC1 — six prompt templates with frontmatter + the pi.prompts manifest field
// =========================================================================

test('AC1: six prompt templates exist with frontmatter description; pi.prompts manifest points at ./prompts', () => {
  const expected = [
    'adlc-spec', 'adlc-decompose', 'adlc-verify-build',
    'adlc-prosecute', 'adlc-distill', 'adlc-maintain',
  ];
  for (const name of expected) {
    const file = join(PLUGIN_ROOT, 'prompts', `${name}.md`);
    assert.ok(existsSync(file), `prompt template missing: ${name}.md`);
    const fm = readFrontmatter(file);
    assert.ok(fm, `no frontmatter block in ${name}.md`);
    assert.ok(fm.description && fm.description.trim().length > 0, `no description in ${name}.md`);
  }
  // argument-hint is present on the templates that accept a target argument.
  for (const name of ['adlc-spec', 'adlc-decompose', 'adlc-verify-build', 'adlc-prosecute', 'adlc-distill']) {
    const fm = readFrontmatter(join(PLUGIN_ROOT, 'prompts', `${name}.md`));
    assert.ok(fm['argument-hint'] && fm['argument-hint'].trim().length > 0, `no argument-hint in ${name}.md`);
  }
  const pkg = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'package.json'), 'utf8'));
  assert.ok(Array.isArray(pkg.pi.prompts), 'package.json pi.prompts must be an array');
  assert.ok(pkg.pi.prompts.includes('./prompts'), 'pi.prompts must include "./prompts"');
});

// =========================================================================
// AC2 — /adlc-ticket <id> writes the pointer, records evidence, and the NEXT
// tool_call gates against the new ticket with no turn boundary
// =========================================================================

test('AC2: /adlc-ticket <id> activates immediately — next tool_call gates the new ticket', async () => {
  const root = makeRepo({ current: 'T1' });
  try {
    const { pi } = await boot(root);
    const ctx = fakeCtx(root);

    // Under T1 (scope src/**), a write to src/ is in-scope; a lib/ write is not.
    const beforeSrc = await pi.handlers.tool_call(
      { type: 'tool_call', toolName: 'write', toolCallId: 'a', input: { path: 'src/x.ts', content: 'x' } }, ctx);
    assert.equal(beforeSrc, undefined, 'src write allowed under T1');

    await pi.commands['adlc-ticket'].handler('T2', ctx);

    // Pointer rewritten to T2.
    const pointer = JSON.parse(readFileSync(join(root, '.adlc', 'current-ticket.json'), 'utf8'));
    assert.equal(pointer.id, 'T2');
    // Evidence recorded (session entry + chained manifest line).
    assert.ok(pi.entries.some((e) => e.data.type === 'ticket-switch'), 'session evidence for the switch');
    assert.match(readFileSync(join(root, '.adlc', 'manifest.jsonl'), 'utf8'), /pi-ticket-switch/);

    // No turn boundary: the very next tool_call must gate against T2 (scope
    // lib/**), so the previously-allowed src/ write is now out of scope and a
    // lib/ write is allowed.
    const afterSrc = await pi.handlers.tool_call(
      { type: 'tool_call', toolName: 'write', toolCallId: 'b', input: { path: 'src/x.ts', content: 'x' } }, ctx);
    assert.equal(afterSrc.block, true, 'src write now blocked under T2');
    assert.match(afterSrc.reason, /scope/);
    const afterLib = await pi.handlers.tool_call(
      { type: 'tool_call', toolName: 'write', toolCallId: 'c', input: { path: 'lib/y.ts', content: 'y' } }, ctx);
    assert.equal(afterLib, undefined, 'lib write allowed under T2');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('AC2: /adlc-ticket <unknown-id> notifies an error and leaves the pointer unchanged', async () => {
  const root = makeRepo({ current: 'T1' });
  try {
    const { pi } = await boot(root);
    const ctx = fakeCtx(root);
    await pi.commands['adlc-ticket'].handler('T999', ctx);
    assert.ok(ctx.notices.some((n) => n.level === 'error' && /not found/.test(n.msg)));
    const pointer = JSON.parse(readFileSync(join(root, '.adlc', 'current-ticket.json'), 'utf8'));
    assert.equal(pointer.id, 'T1', 'pointer unchanged on unknown id');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('AC2: /adlc-ticket getArgumentCompletions completes ticket ids by prefix', async () => {
  const root = makeRepo({ current: 'T1' });
  try {
    const { pi } = await boot(root);
    const all = pi.commands['adlc-ticket'].getArgumentCompletions('');
    assert.deepEqual(all.map((i) => i.value).sort(), ['T1', 'T2']);
    const none = pi.commands['adlc-ticket'].getArgumentCompletions('Z');
    assert.equal(none, null, 'no matches returns null');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// =========================================================================
// AC3 — /adlc-ticket with no args surfaces ui.select; undefined leaves state
// =========================================================================

test('AC3: /adlc-ticket with no args offers one option per ticket and activates the choice', async () => {
  const root = makeRepo({ current: 'T1' });
  try {
    const { pi } = await boot(root);
    let offered = null;
    const ctx = fakeCtx(root, { select: (_title, options) => { offered = options; return options[1]; } });
    await pi.commands['adlc-ticket'].handler('', ctx);
    assert.equal(ctx.calls.select, 1, 'select was surfaced');
    assert.equal(offered.length, 2, 'one option per ticket');
    assert.ok(offered[0].startsWith('T1'), 'option carries the id');
    const pointer = JSON.parse(readFileSync(join(root, '.adlc', 'current-ticket.json'), 'utf8'));
    assert.equal(pointer.id, 'T2', 'chose the second ticket');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('AC3: /adlc-ticket select returning undefined (non-TUI cancel) leaves state unchanged and notifies', async () => {
  const root = makeRepo({ current: 'T1' });
  try {
    const { pi } = await boot(root);
    const ctx = fakeCtx(root, { select: () => undefined });
    await pi.commands['adlc-ticket'].handler('', ctx);
    assert.ok(ctx.notices.some((n) => /cancelled/.test(n.msg)), 'notifies the cancel');
    const pointer = JSON.parse(readFileSync(join(root, '.adlc', 'current-ticket.json'), 'utf8'));
    assert.equal(pointer.id, 'T1', 'pointer unchanged after cancel');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('AC3: /adlc-ticket with no args in non-TUI mode requires an id (no hang, no prompt)', async () => {
  const root = makeRepo({ current: 'T1' });
  try {
    const { pi } = await boot(root);
    const ctx = fakeCtx(root, { hasUI: false });
    await pi.commands['adlc-ticket'].handler('', ctx);
    assert.equal(ctx.calls.select, 0, 'no dialog attempted without a UI');
    assert.ok(ctx.notices.some((n) => /non-interactive/.test(n.msg)));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// =========================================================================
// AC4 — /adlc-approve-spec: confirm=true records a chain-valid entry; false
// records nothing; missing path errors without a dialog
// =========================================================================

test('AC4: /adlc-approve-spec on an existing file with confirm=true appends a chain-valid entry naming the spec', async () => {
  const root = makeRepo({ current: 'T1' });
  try {
    const { pi } = await boot(root);
    mkdirSync(join(root, '.adlc', 'specs'), { recursive: true });
    const specRel = '.adlc/specs/feature.md';
    writeFileSync(join(root, specRel), '# Spec\nacceptance criteria\n');
    const ctx = fakeCtx(root, { confirm: () => true });

    await pi.commands['adlc-approve-spec'].handler(specRel, ctx);

    const manifest = readFileSync(join(root, '.adlc', 'manifest.jsonl'), 'utf8');
    assert.match(manifest, /spec-approval/);
    assert.match(manifest, /feature\.md/, 'entry names the spec path');
    const verdict = verify(join(root, '.adlc'));
    assert.equal(verdict.valid, true, `manifest chain must verify: ${JSON.stringify(verdict)}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('AC4: /adlc-approve-spec with confirm=false records nothing', async () => {
  const root = makeRepo({ current: 'T1' });
  try {
    const { pi } = await boot(root);
    const specRel = '.adlc/specs/feature.md';
    mkdirSync(join(root, '.adlc', 'specs'), { recursive: true });
    writeFileSync(join(root, specRel), '# Spec\n');
    const ctx = fakeCtx(root, { confirm: () => false });
    await pi.commands['adlc-approve-spec'].handler(specRel, ctx);
    assert.equal(existsSync(join(root, '.adlc', 'manifest.jsonl')), false, 'no manifest written on decline');
    assert.ok(ctx.notices.some((n) => /declined/.test(n.msg)));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('AC4: /adlc-approve-spec on a nonexistent path errors without opening a dialog', async () => {
  const root = makeRepo({ current: 'T1' });
  try {
    const { pi } = await boot(root);
    const ctx = fakeCtx(root, { confirm: () => true });
    await pi.commands['adlc-approve-spec'].handler('.adlc/specs/missing.md', ctx);
    assert.equal(ctx.calls.confirm, 0, 'no dialog opened for a missing spec');
    assert.ok(ctx.notices.some((n) => n.level === 'error' && /cannot read/.test(n.msg)));
    assert.equal(existsSync(join(root, '.adlc', 'manifest.jsonl')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('AC4: /adlc-approve-spec with no path errors without a dialog', async () => {
  const root = makeRepo({ current: 'T1' });
  try {
    const { pi } = await boot(root);
    const ctx = fakeCtx(root, { confirm: () => true });
    await pi.commands['adlc-approve-spec'].handler('', ctx);
    assert.equal(ctx.calls.confirm, 0);
    assert.ok(ctx.notices.some((n) => n.level === 'error'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// =========================================================================
// AC5 — /adlc-init scaffolds a bare repo, is idempotent, and refuses to
// scaffold when the adlc CLI is missing
// =========================================================================

test('AC5: /adlc-init on a bare repo creates sharded stores + gitignore entries and is idempotent', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'adlc-pi-init-')));
  try {
    const pi = fakePi();
    createExtension({ env: {} })(pi);
    const ctx = fakeCtx(root);

    await pi.commands['adlc-init'].handler('', ctx);

    const ticketsPath = join(root, '.adlc', 'tickets', '.store.json');
    const archivePath = join(root, '.adlc', 'ticket-archive', '.store.json');
    assert.ok(existsSync(ticketsPath), 'active sharded store created');
    assert.ok(existsSync(archivePath), 'archive sharded store created');
    const gitignore = readFileSync(join(root, '.gitignore'), 'utf8');
    assert.match(gitignore, /^\.adlc\/\*$/m, '.adlc/* ignore added');
    assert.match(gitignore, /^!\.adlc\/tickets\.json$/m, 'tickets.json negation added');

    // Idempotent: a second run changes nothing on disk.
    const beforeTickets = readFileSync(ticketsPath, 'utf8');
    const beforeGitignore = readFileSync(join(root, '.gitignore'), 'utf8');
    await pi.commands['adlc-init'].handler('', ctx);
    assert.equal(readFileSync(ticketsPath, 'utf8'), beforeTickets, 'store manifest unchanged on second run');
    assert.equal(readFileSync(join(root, '.gitignore'), 'utf8'), beforeGitignore, '.gitignore unchanged on second run');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('P5 follow-up: /adlc-init never clobbers a POPULATED tickets.json (byte-identical after run)', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'adlc-pi-init-pop-')));
  try {
    mkdirSync(join(root, '.adlc'), { recursive: true });
    const ticketsPath = join(root, '.adlc', 'tickets.json');
    const populated = JSON.stringify({ tickets: [{ id: 'T1', title: 'Real work', body: 'precious' }] }, null, 2) + '\n';
    writeFileSync(ticketsPath, populated);

    const pi = fakePi();
    createExtension({ env: {} })(pi);
    const ctx = fakeCtx(root);
    await pi.commands['adlc-init'].handler('', ctx);

    assert.equal(readFileSync(ticketsPath, 'utf8'), populated, 'existing tickets must be byte-identical after init');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('/adlc-init previews legacy migration and decline preserves the writable flat file', async () => {
  const root = makeRepo({ current: null });
  try {
    const pi = fakePi({ exec: async (_cmd, args) => {
      if (args[0] === '--version') return { code: 0, stdout: '1.3.0' };
      return { code: 0, stdout: JSON.stringify(migrationPlan(root)) };
    } });
    createExtension({ env: {} })(pi);
    const before = readFileSync(join(root, '.adlc/tickets.json'), 'utf8');
    const ctx = fakeCtx(root, { confirm: () => false });
    await pi.commands['adlc-init'].handler('', ctx);
    assert.equal(ctx.calls.confirm, 1);
    assert.equal(readFileSync(join(root, '.adlc/tickets.json'), 'utf8'), before);
    assert.equal(existsSync(join(root, '.adlc/tickets')), false);
    assert.ok(ctx.notices.some((notice) => /Continuing on the legacy flat file/.test(notice.msg)));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('/adlc-init migrates legacy storage only after explicit approval', async () => {
  const root = makeRepo({ current: null });
  try {
    const pi = fakePi({ exec: async (_cmd, args) => {
      if (args[0] === '--version') return { code: 0, stdout: '1.3.0' };
      if (args.includes('--write')) {
        const result = migrateLegacyStore(root, { write: true, yes: true, requireClean: false });
        return { code: 0, stdout: JSON.stringify(result) };
      }
      return { code: 0, stdout: JSON.stringify(migrationPlan(root)) };
    } });
    createExtension({ env: {} })(pi);
    const ctx = fakeCtx(root, { confirm: () => true });
    await pi.commands['adlc-init'].handler('', ctx);
    assert.equal(ctx.calls.confirm, 1);
    assert.equal(existsSync(join(root, '.adlc/tickets.json')), false);
    assert.equal(existsSync(join(root, '.adlc/tickets/.store.json')), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('AC5: /adlc-init with the adlc CLI missing notifies the install command and does not scaffold', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'adlc-pi-init-')));
  try {
    // pi.exec rejects (command not found) — the guard must fail closed.
    const pi = fakePi({ exec: async () => { throw new Error('spawn adlc ENOENT'); } });
    createExtension({ env: {} })(pi);
    const ctx = fakeCtx(root);
    await pi.commands['adlc-init'].handler('', ctx);
    assert.ok(ctx.notices.some((n) => n.level === 'error' && /npm install -g @adlc\/cli/.test(n.msg)));
    assert.equal(existsSync(join(root, '.adlc')), false, 'no .adlc/ scaffolded when the CLI is missing');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('AC5: /adlc-init with the adlc CLI returning non-zero also refuses to scaffold', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'adlc-pi-init-')));
  try {
    const pi = fakePi({ exec: async () => ({ stdout: '', stderr: 'nope', code: 127 }) });
    createExtension({ env: {} })(pi);
    const ctx = fakeCtx(root);
    await pi.commands['adlc-init'].handler('', ctx);
    assert.ok(ctx.notices.some((n) => n.level === 'error' && /npm install -g @adlc\/cli/.test(n.msg)));
    assert.equal(existsSync(join(root, '.adlc')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
