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
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createExtension } from '../lib/extension.mjs';
import { verify } from '@adlc/gate-manifest/lib/verify.mjs';
import { appendManifestEntry } from '@adlc/gate-manifest';
import { sha256 } from '@adlc/core';
import { migrateLegacyStore, migrationPlan } from '@adlc/tickets';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(HERE, '..');
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const RUNNER_BIN = join(REPO_ROOT, 'packages', 'runner', 'bin', 'adlc.mjs');
const SPEC_LINT_BIN = join(REPO_ROOT, 'packages', 'spec-lint', 'bin', 'spec-lint.mjs');
const PREMORTEM_BIN = join(REPO_ROOT, 'packages', 'premortem', 'bin', 'premortem.mjs');

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
// #104 (T76) — completed tickets are filtered OUT of BOTH enumerations (the
// argument completions and the interactive picker), so 40 shipped tickets stop
// being offered as activation candidates. Named-id activation of a completed
// ticket stays allowed — that is a lookup, not an enumeration.
// =========================================================================

const T2_DONE = { ...T2, completed: true };

test('#104: getArgumentCompletions excludes a completed ticket and keeps the open one', async () => {
  const root = makeRepo({ tickets: [T1, T2_DONE], current: 'T1' });
  try {
    const { pi } = await boot(root);
    const all = pi.commands['adlc-ticket'].getArgumentCompletions('');
    assert.deepEqual(all.map((i) => i.value), ['T1'], 'the completed ticket is not offered as a completion');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('#104: the interactive picker offers only open tickets, and activates the right one', async () => {
  const root = makeRepo({ tickets: [T1, T2_DONE], current: 'T1' });
  try {
    const { pi } = await boot(root);
    let offered = null;
    const ctx = fakeCtx(root, { select: (_title, options) => { offered = options; return options[0]; } });
    await pi.commands['adlc-ticket'].handler('', ctx);
    assert.equal(offered.length, 1, 'the completed ticket is not an option');
    assert.ok(offered[0].startsWith('T1'), 'the open ticket is the only option');
    // The picked label maps back to the OPEN ticket, not a filtered-away index.
    const pointer = JSON.parse(readFileSync(join(root, '.adlc', 'current-ticket.json'), 'utf8'));
    assert.equal(pointer.id, 'T1');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('#104: the selection maps back through the FILTERED list, not the raw ticket index', async () => {
  // Regression guard for the index remap: the completed ticket sorts FIRST, so
  // the open ticket lives at openTickets[0] but tickets[1]. If the handler mapped
  // the pick through the unfiltered `tickets` it would activate the COMPLETED
  // ticket the human never saw. A fixture whose open ticket sorts first cannot
  // tell the two apart — this one deliberately puts the completed ticket first.
  const root = makeRepo({ tickets: [{ ...T1, completed: true }, T2], current: 'T2' });
  try {
    const { pi } = await boot(root);
    let offered = null;
    const ctx = fakeCtx(root, { select: (_title, options) => { offered = options; return options[0]; } });
    await pi.commands['adlc-ticket'].handler('', ctx);
    assert.equal(offered.length, 1, 'only the open ticket is offered');
    assert.ok(offered[0].startsWith('T2'), 'the single option is the open ticket');
    const pointer = JSON.parse(readFileSync(join(root, '.adlc', 'current-ticket.json'), 'utf8'));
    assert.equal(pointer.id, 'T2', 'activates the open ticket that was picked, not the completed one at the same raw index');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('#104: a completed ticket is still activatable by explicit id (lookup, not enumeration)', async () => {
  const root = makeRepo({ tickets: [T1, T2_DONE], current: 'T1' });
  try {
    const { pi } = await boot(root);
    const ctx = fakeCtx(root);
    await pi.commands['adlc-ticket'].handler('T2', ctx);
    assert.ok(!ctx.notices.some((n) => n.level === 'error'), 'no error activating a completed id by name');
    const pointer = JSON.parse(readFileSync(join(root, '.adlc', 'current-ticket.json'), 'utf8'));
    assert.equal(pointer.id, 'T2', 'named activation of a completed ticket resolves');
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
//
// Every case below first seeds a ticket-bound premortem entry: since codex's
// cross-model review found the confirm dialog alone proved no interrogation
// occurred, the handler now refuses (before even opening the dialog) unless
// real parallax/premortem evidence exists for the active ticket — spec-lint
// is deliberately excluded (it asks a human zero questions) — see
// ticketInterrogationEvidence in lib/commands.mjs. Seeding it here isolates
// these tests to what they're actually about (the confirm/decline/missing-path
// paths), not the evidence-refusal path, which has its own dedicated test.
// =========================================================================

function seedInterrogationEvidence(root, ticket = 'T1') {
  appendManifestEntry({ gate: 'premortem', ticket }, join(root, '.adlc'), { key: null });
}

test('AC4: /adlc-approve-spec on an existing file with confirm=true appends a chain-valid entry naming the spec', async () => {
  const root = makeRepo({ current: 'T1' });
  try {
    const { pi } = await boot(root);
    mkdirSync(join(root, '.adlc', 'specs'), { recursive: true });
    const specRel = '.adlc/specs/feature.md';
    writeFileSync(join(root, specRel), '# Spec\nacceptance criteria\n');
    seedInterrogationEvidence(root);
    const ctx = fakeCtx(root, { confirm: () => true });

    await pi.commands['adlc-approve-spec'].handler(specRel, ctx);

    const manifest = readFileSync(join(root, '.adlc', 'manifest.jsonl'), 'utf8');
    assert.match(manifest, /spec-approval/);
    assert.match(manifest, /feature\.md/, 'entry names the spec path');
    const verdict = verify(join(root, '.adlc'), { key: null });
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
    seedInterrogationEvidence(root);
    const ctx = fakeCtx(root, { confirm: () => false });
    await pi.commands['adlc-approve-spec'].handler(specRel, ctx);
    const manifest = readFileSync(join(root, '.adlc', 'manifest.jsonl'), 'utf8');
    assert.equal(/spec-approval/.test(manifest), false, 'no spec-approval written on decline');
    assert.ok(ctx.notices.some((n) => /declined/.test(n.msg)));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('AC4: /adlc-approve-spec with no prior interrogation evidence refuses before opening a dialog', async () => {
  const root = makeRepo({ current: 'T1' });
  try {
    const { pi } = await boot(root);
    const specRel = '.adlc/specs/feature.md';
    mkdirSync(join(root, '.adlc', 'specs'), { recursive: true });
    writeFileSync(join(root, specRel), '# Spec\n');
    const ctx = fakeCtx(root, { confirm: () => true });
    await pi.commands['adlc-approve-spec'].handler(specRel, ctx);
    assert.equal(ctx.calls.confirm, 0, 'no dialog opened without prior interrogation evidence');
    assert.ok(ctx.notices.some((n) => n.level === 'error' && /adlc-spec/.test(n.msg)));
    assert.equal(existsSync(join(root, '.adlc', 'manifest.jsonl')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Codex cross-model review (adversarial-review, feat/p1-interrogation
// round 7): "Pi fabricates interrogation counts ... treats spec-lint as
// interrogation evidence". spec-lint is a deterministic acceptance-criteria
// linter — it asks a human zero questions — so it must NOT count as proof
// that interrogation occurred, even though p1 still separately requires a
// spec-lint record via PHASE_REQUIREMENTS.
test('AC4: /adlc-approve-spec refuses when spec-lint is the ONLY prior evidence (spec-lint asks zero human questions)', async () => {
  const root = makeRepo({ current: 'T1' });
  try {
    const { pi } = await boot(root);
    const specRel = '.adlc/specs/feature.md';
    mkdirSync(join(root, '.adlc', 'specs'), { recursive: true });
    writeFileSync(join(root, specRel), '# Spec\n');
    appendManifestEntry({ gate: 'spec-lint', ticket: 'T1' }, join(root, '.adlc'), { key: null });
    const ctx = fakeCtx(root, { confirm: () => true });

    await pi.commands['adlc-approve-spec'].handler(specRel, ctx);

    assert.equal(ctx.calls.confirm, 0, 'spec-lint alone must not open the approval dialog');
    assert.ok(ctx.notices.some((n) => n.level === 'error' && /adlc-spec/.test(n.msg)));
    const manifest = readFileSync(join(root, '.adlc', 'manifest.jsonl'), 'utf8');
    assert.doesNotMatch(manifest, /spec-approval/, 'spec-lint alone records no spec-approval');
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

// =========================================================================
// /adlc-approve-spec producer/consumer round-trip: the recorded entry must
// satisfy the REAL runner's p1 assertion, not just look chain-valid. Codex
// cross-model review (adversarial-review, feat/p1-interrogation full-branch
// pass) found this command recorded only {spec, sha256, verdict} while the
// runner's specApprovalIntegrityErrors requires approver/rounds/questions/
// sources/unresolved and a --files binding — every real Pi approval was
// unusable as P1 evidence. This test spawns the real `adlc run p1` CLI
// against the manifest the real handler wrote.
// =========================================================================

test('AC4: the recorded spec-approval satisfies the real runner p1 assertion (producer/consumer round-trip)', async () => {
  const root = makeRepo({ current: 'T1' });
  try {
    const { pi } = await boot(root);
    mkdirSync(join(root, '.adlc', 'specs'), { recursive: true });
    // A RELATIVE path, matching what a real user types — Pi's own command
    // resolves this to an ABSOLUTE path when it records the approval
    // (isAbsolute(specArg) ? specArg : join(root, specArg)). Codex
    // cross-model review round 4: an earlier version of this test hid a
    // real path-normalization bug by using the SAME absolute path for
    // every entry, which the raw-string comparison the finding caught
    // would never have exposed. Using the CLI producers here (not
    // appendManifestEntry) and a relative path proves the actual
    // documented /adlc-spec -> /adlc-approve-spec sequence works.
    const specRel = '.adlc/specs/feature.md';
    writeFileSync(join(root, specRel), '# Spec\n\n## Acceptance Criteria\n- foo: `test -f feature.md`\n');

    const specLintResult = spawnSync(process.execPath, [SPEC_LINT_BIN, specRel, '--record', '--ticket', 'T1', '--dir', '.adlc'], {
      cwd: root, encoding: 'utf8',
    });
    assert.equal(specLintResult.status, 0, `spec-lint --record must pass: ${specLintResult.stdout}${specLintResult.stderr}`);

    const premortemResult = spawnSync(process.execPath, [
      PREMORTEM_BIN, specRel, '--prompt-only', '--record-verdict', '-', '--ticket', 'T1',
    ], { cwd: root, encoding: 'utf8', input: 'No failure modes found.\n' });
    assert.equal(premortemResult.status, 0, `premortem --record-verdict must pass: ${premortemResult.stdout}${premortemResult.stderr}`);

    const ctx = fakeCtx(root, { confirm: () => true });
    await pi.commands['adlc-approve-spec'].handler(specRel, ctx);
    assert.ok(ctx.notices.some((n) => n.level === 'info' && /recorded spec approval/.test(n.msg)), JSON.stringify(ctx.notices));

    // p1 is ticket-required (P1 D4 — an unscoped check let one ticket's
    // audits satisfy another's approval); invoke it the same way real
    // callers now must.
    const result = spawnSync(process.execPath, [RUNNER_BIN, 'run', 'p1', '--dir', '.adlc', '--ticket', 'T1', '--json'], {
      cwd: root, encoding: 'utf8',
    });
    assert.equal(result.status, 0, `real p1 assertion must accept Pi's recorded approval: status=${result.status} ${result.stdout}${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, true, JSON.stringify(parsed));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Codex cross-model review (adversarial-review, feat/p1-interrogation
// rounds 5 and 7): rounds/questions must never be derived from
// priorSources.length (the count of DISTINCT GATE NAMES, max 2 now that
// spec-lint is excluded) — that undercounts a real multi-round /adlc-spec
// session, where premortem can be re-recorded across several rounds of the
// interrogation loop. This test records premortem TWICE (simulating two
// rounds) plus one unrelated spec-lint entry, and asserts: (a) sources
// stays a single distinct name (['premortem'] — spec-lint excluded), while
// (b) rounds/questions reflect the real entry count (2), not the distinct
// source count (1) and not a hand-fixed constant.
test('AC4: recorded rounds/questions reflect real entry count, not distinct-source cardinality or a fixed constant', async () => {
  const root = makeRepo({ current: 'T1' });
  try {
    const { pi } = await boot(root);
    mkdirSync(join(root, '.adlc', 'specs'), { recursive: true });
    const specRel = '.adlc/specs/feature.md';
    writeFileSync(join(root, specRel), '# Spec\n\n## Acceptance Criteria\n- foo: `test -f feature.md`\n');

    appendManifestEntry({ gate: 'spec-lint', ticket: 'T1' }, join(root, '.adlc'), { key: null });
    appendManifestEntry({ gate: 'premortem', ticket: 'T1', data: { round: 1 } }, join(root, '.adlc'), { key: null });
    appendManifestEntry({ gate: 'premortem', ticket: 'T1', data: { round: 2 } }, join(root, '.adlc'), { key: null });

    const ctx = fakeCtx(root, { confirm: () => true });
    await pi.commands['adlc-approve-spec'].handler(specRel, ctx);
    assert.ok(ctx.notices.some((n) => n.level === 'info' && /recorded spec approval/.test(n.msg)), JSON.stringify(ctx.notices));

    const lines = readFileSync(join(root, '.adlc', 'manifest.jsonl'), 'utf8').trim().split('\n');
    const approval = JSON.parse(lines.find((l) => JSON.parse(l).gate === 'spec-approval'));
    assert.deepEqual(approval.data.sources, ['premortem'], 'spec-lint must not appear as a claimed interrogation source');
    assert.equal(approval.data.rounds, 2, 'rounds must reflect the two recorded premortem entries');
    assert.equal(approval.data.questions, 2, 'questions must reflect the two recorded premortem entries');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('AC4: /adlc-approve-spec with no active ticket errors without a dialog (p1 requires a ticket-bound approval)', async () => {
  const root = makeRepo({ current: null });
  try {
    const { pi } = await boot(root);
    mkdirSync(join(root, '.adlc', 'specs'), { recursive: true });
    const specRel = '.adlc/specs/feature.md';
    writeFileSync(join(root, specRel), '# Spec\n');
    const ctx = fakeCtx(root, { confirm: () => true });

    await pi.commands['adlc-approve-spec'].handler(specRel, ctx);

    assert.equal(ctx.calls.confirm, 0, 'no dialog opened without an active ticket');
    assert.ok(ctx.notices.some((n) => n.level === 'error' && /active ticket/.test(n.msg)));
    assert.equal(existsSync(join(root, '.adlc', 'manifest.jsonl')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// =========================================================================
// Codex cross-model review round 4: ticketInterrogationEvidence read only
// the legacy root .adlc/manifest.jsonl. A segmented ("forest") repo — this
// repo included, per docs/specs/segmented-gate-manifest.md — records current
// evidence under .adlc/manifest.d/ instead, so a real /adlc-spec run there
// would leave /adlc-approve-spec unable to see it. Fixed by switching to
// readOwnManifestChain, the same reader packages/runner/lib/assertions.mjs
// uses. This test builds a real segmented repo (git-initialized branch
// identity + a hand-built segment, mirroring
// packages/gate-manifest/test/own-chain.test.mjs's own fixture pattern) and
// proves the approval command finds the segment's evidence.
// =========================================================================

function segmentedRepo(branch = 'feat/pi-segment-fixture') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'adlc-pi-cmd-seg-')));
  const g = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  g('init', '-q', '-b', branch);
  g('config', 'user.email', 't@t.co');
  g('config', 'user.name', 'tester');
  g('config', 'commit.gpgsign', 'false');
  writeFileSync(join(root, 'README.md'), 'fixture\n');
  g('add', '.');
  g('commit', '-q', '-m', 'init');
  mkdirSync(join(root, '.adlc'), { recursive: true });
  writeFileSync(join(root, '.adlc', 'tickets.json'), JSON.stringify({ tickets: [T1] }));
  writeFileSync(join(root, '.adlc', 'current-ticket.json'), JSON.stringify({ id: 'T1' }));
  return { root, branch };
}

function writeForestSegment(root, name, { branch, ticket, gate }) {
  const dir = join(root, '.adlc');
  // The segment's anchor (segment:'root', seq:1) must resolve to a real
  // root-manifest entry — matching line hash included — or the forest
  // reader refuses the whole chain as a dangling/mismatched anchor.
  const rootLine = JSON.stringify({ seq: 1, gate: 'cutover', prev: null });
  writeFileSync(join(dir, 'manifest.jsonl'), rootLine + '\n');
  mkdirSync(join(dir, 'manifest.d'), { recursive: true });
  writeFileSync(join(dir, 'manifest.d', '.store.json'), JSON.stringify({ format: 'adlc-manifest-segments', version: 1 }));
  const entry = {
    seq: 1,
    anchor: { segment: 'root', seq: 1, lineHash: sha256(rootLine) },
    branch,
    gate,
    ticket,
    prev: null,
  };
  writeFileSync(join(dir, 'manifest.d', name), JSON.stringify(entry) + '\n');
}

test('AC4: /adlc-approve-spec finds interrogation evidence recorded in a segmented (forest) manifest, not just the legacy root file', async () => {
  const { root, branch } = segmentedRepo();
  try {
    writeForestSegment(root, `seg-${'0'.repeat(26)}.jsonl`, { branch, ticket: 'T1', gate: 'premortem' });

    const { pi } = await boot(root);
    const specRel = '.adlc/specs/feature.md';
    mkdirSync(join(root, '.adlc', 'specs'), { recursive: true });
    writeFileSync(join(root, specRel), '# Spec\n');
    // Decline the dialog: the write side (recording spec-approval INTO the
    // same segment) exercises the segment writer's own unrelated anti-fork
    // safety check (an unsigned append to an already-committed segment is
    // refused to prevent shadowing evidence) — a different subsystem than
    // what this finding is about. Scoping to decline isolates the assertion
    // to what ticketInterrogationEvidence actually owns: finding the
    // evidence and opening the dialog at all.
    const ctx = fakeCtx(root, { confirm: () => false });

    await pi.commands['adlc-approve-spec'].handler(specRel, ctx);

    assert.equal(ctx.calls.confirm, 1, 'segment evidence was found, so the dialog opened (a root-only reader would have refused before this point)');
    assert.ok(!ctx.notices.some((n) => /run \/adlc-spec first/.test(n.msg)), JSON.stringify(ctx.notices));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
