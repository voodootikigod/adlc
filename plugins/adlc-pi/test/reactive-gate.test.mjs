// T21 reactive-gate tests: snapshot-scoped verification, no HEAD reverts,
// no git intent-to-add staging, operative-only suppression scanning, live
// ticket reload.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  snapshotFile, restoreSnapshot, diffAddedLines, scanAddedLines,
  parsePorcelain, listRailFiles,
} from '../lib/reactive-gate.mjs';
import { createExtension } from '../lib/extension.mjs';

const TICKET = {
  id: 'T1',
  title: 'Test Ticket',
  body: 'Do the thing',
  scope: ['src/**', 'docs/**'],
  rails: ['test/contracts/**'],
};

function makeRepo({ tickets = [TICKET], current = 'T1' } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'adlc-pi-rg-')));
  mkdirSync(join(root, '.adlc'), { recursive: true });
  writeFileSync(join(root, '.adlc', 'tickets.json'), JSON.stringify({ tickets }, null, 2));
  if (current !== null) {
    writeFileSync(join(root, '.adlc', 'current-ticket.json'), JSON.stringify({ id: current }));
  }
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'test', 'contracts'), { recursive: true });
  writeFileSync(join(root, 'test', 'contracts', 'auth.test.ts'), 'original contract\n');
  return root;
}

function fakePi(execResponses = {}) {
  const handlers = {};
  const commands = {};
  const execLog = [];
  return {
    on(name, fn) { handlers[name] = fn; },
    registerCommand(name, def) { commands[name] = def; },
    async exec(cmd, args) {
      execLog.push([cmd, ...args]);
      const key = `${cmd} ${args.join(' ')}`;
      for (const [prefix, out] of Object.entries(execResponses)) {
        if (key.startsWith(prefix)) return { stdout: typeof out === 'function' ? out() : out, stderr: '', code: 0 };
      }
      return { stdout: '', stderr: '', code: 0 };
    },
    handlers, commands, execLog,
  };
}

function fakeCtx(cwd) {
  const notices = [];
  return { cwd, ui: { setStatus() {}, notify(m, l) { notices.push({ m, l }); } }, notices };
}

async function boot(root, execResponses = {}) {
  const pi = fakePi(execResponses);
  createExtension({ env: {} })(pi);
  const ctx = fakeCtx(root);
  await pi.handlers.session_start({ type: 'session_start', reason: 'startup' }, ctx);
  return { pi, ctx };
}

const writeCall = (path, id = 'w1') => ({ type: 'tool_call', toolName: 'write', toolCallId: id, input: { path, content: 'x' } });
const writeResult = (id = 'w1') => ({ type: 'tool_result', toolName: 'write', toolCallId: id, input: {}, content: [], isError: false });
const bashCall = (command, id = 'b1') => ({ type: 'tool_call', toolName: 'bash', toolCallId: id, input: { command } });
const bashResult = (id = 'b1') => ({ type: 'tool_result', toolName: 'bash', toolCallId: id, input: {}, content: [], isError: false });

// =========================================================================
// Pure helpers
// =========================================================================

test('diffAddedLines: multiset difference with 1-based line numbers', () => {
  const added = diffAddedLines('a\nb\n', 'a\nNEW\nb\nb\n', 'f.ts');
  assert.deepEqual(added.map((l) => [l.lineNo, l.content]), [[2, 'NEW'], [4, 'b']]);
});

test('parsePorcelain: modified, untracked, renamed entries', () => {
  const files = parsePorcelain(' M src/a.ts\n?? new.txt\nR  old.txt -> renamed.txt\n');
  assert.deepEqual(files, ['src/a.ts', 'new.txt', 'renamed.txt']);
});

test('snapshot/restore round-trip preserves exact pre-tool state', () => {
  const root = makeRepo();
  try {
    writeFileSync(join(root, 'src', 'a.ts'), 'user edits\n');
    const snap = snapshotFile(root, 'src/a.ts');
    writeFileSync(join(root, 'src', 'a.ts'), 'tool overwrote\n');
    assert.equal(restoreSnapshot(root, snap), true);
    assert.equal(readFileSync(join(root, 'src', 'a.ts'), 'utf8'), 'user edits\n');
    // restoring an "absent" snapshot deletes the created file
    const created = snapshotFile(root, 'src/new.ts');
    writeFileSync(join(root, 'src', 'new.ts'), 'created\n');
    assert.equal(restoreSnapshot(root, created), true);
    assert.equal(existsSync(join(root, 'src', 'new.ts')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('listRailFiles: trust roots + rail-glob matches from ls-files/status', () => {
  const root = makeRepo();
  try {
    const files = listRailFiles(root, TICKET, 'src/a.ts\ntest/contracts/auth.test.ts\n', '?? other.txt\n');
    assert.ok(files.includes('test/contracts/auth.test.ts'));
    assert.ok(files.includes('.adlc/tickets.json'));
    assert.ok(!files.includes('src/a.ts'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// =========================================================================
// AC3 — operative-only suppression scanning
// =========================================================================

// Marker fixtures are concatenated so this test file's diff never carries an
// operative-looking suppression literal (the repo's own gates scan it).
const TS_IGNORE = '@ts-' + 'ignore';
const ESLINT_DISABLE = 'eslint-' + 'disable';

test('AC3: marker inside a fenced .mdx block is NOT flagged; operative code line IS', () => {
  const mdx = `intro\n\`\`\`ts\n// ${TS_IGNORE} example in docs\n\`\`\`\ndone\n`;
  const fencedAdded = diffAddedLines('', mdx, 'docs/page.mdx');
  const clean = scanAddedLines(fencedAdded, new Map([['docs/page.mdx', mdx]]), [], '');
  assert.equal(clean.length, 0, 'fenced marker must be inert');

  const code = `const a = 1;\n// ${TS_IGNORE}\nconst b: string = 2;\n`;
  const codeAdded = diffAddedLines('', code, 'src/a.ts');
  const flagged = scanAddedLines(codeAdded, new Map([['src/a.ts', code]]), [], '');
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0].marker, TS_IGNORE);
});

test('AC3: prose .md files are exempt; allowed markers pass', () => {
  const md = `Never use \`${ESLINT_DISABLE}\` casually.\n`;
  const clean = scanAddedLines(diffAddedLines('', md, 'docs/guide.md'), new Map([['docs/guide.md', md]]), [], '');
  assert.equal(clean.length, 0);

  const code = `// ${ESLINT_DISABLE}-next-line no-console\n`;
  const allowed = scanAddedLines(
    diffAddedLines('', code, 'src/a.ts'),
    new Map([['src/a.ts', code]]),
    [ESLINT_DISABLE],
    ''
  );
  assert.equal(allowed.length, 0, 'ticket-allowed marker must pass');
});

// =========================================================================
// AC1 — snapshot revert preserves user edits
// =========================================================================

test('AC1: violating write is reverted to pre-tool state; user edits survive', async () => {
  const root = makeRepo();
  try {
    // The user's own uncommitted edits, present BEFORE the tool call.
    writeFileSync(join(root, 'src', 'a.ts'), 'user uncommitted work\n');
    const { pi, ctx } = await boot(root);

    assert.equal(await pi.handlers.tool_call(writeCall('src/a.ts'), ctx), undefined);
    // The tool writes a suppression marker.
    writeFileSync(join(root, 'src', 'a.ts'), `user uncommitted work\n// ${TS_IGNORE}\nbad();\n`);
    const result = await pi.handlers.tool_result(writeResult(), ctx);

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /GATE FAILED/);
    assert.equal(
      readFileSync(join(root, 'src', 'a.ts'), 'utf8'),
      'user uncommitted work\n',
      'revert restores the pre-tool snapshot, not HEAD — user edits intact, only the tool write undone'
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('clean write passes and leaves the file as written', async () => {
  const root = makeRepo();
  try {
    const { pi, ctx } = await boot(root);
    await pi.handlers.tool_call(writeCall('src/ok.ts'), ctx);
    writeFileSync(join(root, 'src', 'ok.ts'), 'clean content\n');
    const result = await pi.handlers.tool_result(writeResult(), ctx);
    assert.equal(result, undefined);
    assert.equal(readFileSync(join(root, 'src', 'ok.ts'), 'utf8'), 'clean content\n');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// =========================================================================
// AC2 — no git intent-to-add staging; bash rail creation detected + reverted
// =========================================================================

test('AC2: untracked rail-file creation by an allowed bash mutation is detected and removed', async () => {
  const root = makeRepo();
  try {
    const evil = join(root, 'test', 'contracts', 'evil.ts');
    const { pi, ctx } = await boot(root, {
      'git ls-files': 'src/a.ts\ntest/contracts/auth.test.ts\n',
      // Pre-call status: clean. Post-call status: the rail file appeared.
      'git status --porcelain': () => (existsSync(evil) ? '?? test/contracts/evil.ts\n' : ''),
    });

    // A transparent mutation the classifier allows (targets look safe)…
    assert.equal(await pi.handlers.tool_call(bashCall('cp src/a.ts src/b.ts'), ctx), undefined);
    // …but the command actually also created a rail file (classifier miss).
    writeFileSync(evil, 'sneaky\n');

    const result = await pi.handlers.tool_result(bashResult(), ctx);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /frozen rails/);
    assert.equal(existsSync(evil), false, 'created rail file removed');
    // AC2: the gate never stages anything via git intent-to-add
    assert.ok(!pi.execLog.some((c) => c[0] === 'git' && c[1] === 'add'), 'gate must never run git add');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('bash rail EDIT is restored to pre-command content (not HEAD)', async () => {
  const root = makeRepo();
  try {
    const railPath = join(root, 'test', 'contracts', 'auth.test.ts');
    // The rail carries uncommitted user edits (the human may edit rails).
    writeFileSync(railPath, 'user-edited contract\n');
    let mutated = false;
    const { pi, ctx } = await boot(root, {
      'git ls-files': 'test/contracts/auth.test.ts\n',
      'git status --porcelain': () => (mutated ? ' M test/contracts/auth.test.ts\n' : ' M test/contracts/auth.test.ts\n'),
    });

    await pi.handlers.tool_call(bashCall('cp src/a.ts src/b.ts'), ctx);
    writeFileSync(railPath, 'clobbered by shell\n');
    mutated = true;

    const result = await pi.handlers.tool_result(bashResult(), ctx);
    assert.equal(result.isError, true);
    assert.equal(
      readFileSync(railPath, 'utf8'),
      'user-edited contract\n',
      'rail restored to pre-command state, preserving the user’s uncommitted rail edits'
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('degraded bash snapshot never DELETES a modified rail — reports unrestorable', async () => {
  const root = makeRepo();
  try {
    const railPath = join(root, 'test', 'contracts', 'auth.test.ts');
    const pi = fakePi({
      // git introspection broken at tool_call time → degraded snapshot…
      'git ls-files': () => { throw new Error('git broken'); },
      // …but status recovers by result time and shows the rail modified.
      'git status --porcelain': ' M test/contracts/auth.test.ts\n',
    });
    createExtension({ env: {} })(pi);
    const ctx = fakeCtx(root);
    await pi.handlers.session_start({ type: 'session_start', reason: 'startup' }, ctx);

    await pi.handlers.tool_call(bashCall('cp src/a.ts src/b.ts'), ctx);
    writeFileSync(railPath, 'modified during degraded call\n');

    const result = await pi.handlers.tool_result(bashResult(), ctx);
    assert.equal(result.isError, true);
    assert.ok(existsSync(railPath), 'a modified rail must never be deleted on a degraded snapshot');
    assert.match(result.content[0].text, /restore these manually|degraded/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('suppression-scan cap trip is surfaced as a warning, not silent', async () => {
  const root = makeRepo();
  try {
    const count = 55; // > BASH_SCAN_FILE_CAP
    const statusLines = [];
    for (let i = 0; i < count; i++) {
      writeFileSync(join(root, 'src', `f${i}.ts`), 'clean\n');
      statusLines.push(`?? src/f${i}.ts`);
    }
    const { pi, ctx } = await boot(root, {
      'git ls-files': '',
      'git status --porcelain': () => statusLines.join('\n') + '\n',
    });

    await pi.handlers.tool_call(bashCall('cp src/a.ts src/b.ts'), ctx);
    // Pre-call status already listed them, so make them "touched": the fake
    // returns identical status both times, but preStamps captured their
    // hashes — rewrite one byte so every file's stamp changes.
    for (let i = 0; i < count; i++) writeFileSync(join(root, 'src', `f${i}.ts`), 'clean2\n');

    const result = await pi.handlers.tool_result(bashResult(), ctx);
    assert.equal(result, undefined, 'no violations — clean content');
    assert.ok(
      ctx.notices.some((n) => n.l === 'warning' && /truncated/.test(n.m)),
      'cap trip must emit a truncation warning'
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('read-only bash commands are not snapshotted or scanned', async () => {
  const root = makeRepo();
  try {
    const { pi, ctx } = await boot(root);
    await pi.handlers.tool_call(bashCall('git status'), ctx);
    const result = await pi.handlers.tool_result(bashResult(), ctx);
    assert.equal(result, undefined);
    assert.equal(pi.execLog.length, 0, 'no git bookkeeping for read-only commands');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// =========================================================================
// AC4 — live ticket lifecycle (turn_start reload)
// =========================================================================

test('AC4: ticket activated after session start is picked up on the next turn', async () => {
  const root = makeRepo({ current: null });
  try {
    const { pi, ctx } = await boot(root);
    // Inert: no doctrine, no gating.
    let r = await pi.handlers.before_agent_start({ type: 'before_agent_start', prompt: '', systemPrompt: 'BASE', systemPromptOptions: {} }, ctx);
    assert.equal(r.systemPrompt, undefined);

    // Activate mid-session.
    writeFileSync(join(root, '.adlc', 'current-ticket.json'), JSON.stringify({ id: 'T1' }));
    await pi.handlers.turn_start({ type: 'turn_start' }, ctx);

    r = await pi.handlers.before_agent_start({ type: 'before_agent_start', prompt: '', systemPrompt: 'BASE', systemPromptOptions: {} }, ctx);
    assert.ok(r.systemPrompt.startsWith('BASE'));
    assert.ok(r.systemPrompt.includes('T1'));

    const denied = await pi.handlers.tool_call(writeCall('test/contracts/auth.test.ts'), ctx);
    assert.equal(denied.block, true, 'gating active after mid-session activation');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('AC4: ticket switch mid-session swaps the enforcement context', async () => {
  const t2 = { id: 'T2', title: 'Other', body: '', scope: ['docs/**'], rails: ['src/**'] };
  const root = makeRepo({ tickets: [TICKET, t2], current: 'T1' });
  try {
    const { pi, ctx } = await boot(root);
    assert.equal(await pi.handlers.tool_call(writeCall('src/ok.ts', 'a'), ctx), undefined, 'src writable under T1');

    writeFileSync(join(root, '.adlc', 'current-ticket.json'), JSON.stringify({ id: 'T2' }));
    await pi.handlers.turn_start({ type: 'turn_start' }, ctx);

    const denied = await pi.handlers.tool_call(writeCall('src/ok.ts', 'b'), ctx);
    assert.equal(denied.block, true, 'src frozen under T2');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
