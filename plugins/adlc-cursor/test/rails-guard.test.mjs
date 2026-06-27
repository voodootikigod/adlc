// rails-guard.test.mjs — enforcement proof for the Cursor preToolUse adapter and
// the afterFileEdit audit hook. Drives the REAL exported handlers (no Cursor
// binary) and also spawns the actual hook script to prove the stdin→stdout wire
// format. Covers AC3 (a)-(h) of .adlc/cursor-spec.md.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { decide, extractToolName, extractFilePath } from '../hooks/adlc-rails-guard.mjs';
import { audit } from '../hooks/adlc-audit.mjs';
import { MUTATING_MATCHER } from '../rails-checker.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const GUARD_SCRIPT = join(HERE, '..', 'hooks', 'adlc-rails-guard.mjs');

/** Build a fixture repo with the given tickets; returns its root. */
function fixture({ tickets = null, currentTicket = undefined } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'adlc-cursor-'));
  if (tickets) {
    mkdirSync(join(root, '.adlc'), { recursive: true });
    writeFileSync(join(root, '.adlc', 'tickets.json'), JSON.stringify({ tickets }));
    if (currentTicket !== undefined) {
      writeFileSync(join(root, '.adlc', 'current-ticket.json'), JSON.stringify({ id: currentTicket }));
    }
  }
  return root;
}
const cleanup = (root) => rmSync(root, { recursive: true, force: true });

/** A Cursor preToolUse payload. */
const payload = (tool, filePath) => ({ tool_name: tool, tool_input: { file_path: filePath } });
const env = (over = {}) => ({ ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: 'T1', ...over });

const RAILED = [{ id: 'T1', title: 'one', rails: ['src/frozen.js', 'src/contracts/**'] },
                { id: 'T2', title: 'two', rails: ['src/other.js'] }];

test('extractors pull tool name and path from the Cursor shape', () => {
  assert.equal(extractToolName(payload('Edit', 'a.js')), 'Edit');
  assert.equal(extractFilePath(payload('Edit', 'src/a.js')), 'src/a.js');
});

test('(a) allow when .adlc/tickets.json is absent', () => {
  const root = fixture();
  try {
    assert.deepEqual(decide(payload('Write', 'src/frozen.js'), { root, env: env() }), { permission: 'allow' });
  } finally { cleanup(root); }
});

test('(b) allow when ADLC_P4_ENFORCEMENT !== "1"', () => {
  const root = fixture({ tickets: RAILED });
  try {
    const v = decide(payload('Write', 'src/frozen.js'), { root, env: env({ ADLC_P4_ENFORCEMENT: '0' }) });
    assert.deepEqual(v, { permission: 'allow' });
  } finally { cleanup(root); }
});

test('(c) allow when no active ticket is resolved', () => {
  const root = fixture({ tickets: RAILED });
  try {
    const v = decide(payload('Write', 'src/frozen.js'), { root, env: { ADLC_P4_ENFORCEMENT: '1' } });
    assert.deepEqual(v, { permission: 'allow' });
  } finally { cleanup(root); }
});

test('(d) deny a Write AND an Edit to the active ticket rail', () => {
  const root = fixture({ tickets: RAILED });
  try {
    for (const tool of ['Write', 'Edit']) {
      const v = decide(payload(tool, 'src/frozen.js'), { root, env: env() });
      assert.equal(v.permission, 'deny', `${tool} should be denied`);
      assert.match(v.user_message, /frozen rail/);
      assert.match(v.agent_message, /FROZEN ADLC rail/);
    }
    // glob rail also denies
    const g = decide(payload('Write', 'src/contracts/export.schema.json'), { root, env: env() });
    assert.equal(g.permission, 'deny');
  } finally { cleanup(root); }
});

test('(e) deny an edit to .adlc/tickets.json (trust-root rail)', () => {
  const root = fixture({ tickets: RAILED });
  try {
    const v = decide(payload('Edit', '.adlc/tickets.json'), { root, env: env() });
    assert.equal(v.permission, 'deny');
  } finally { cleanup(root); }
});

test('(f) a DIFFERENT ticket rail does not deny under the active ticket', () => {
  const root = fixture({ tickets: RAILED });
  try {
    // src/other.js is T2's rail; active ticket is T1 → allow (not a union).
    const v = decide(payload('Write', 'src/other.js'), { root, env: env() });
    assert.deepEqual(v, { permission: 'allow' });
  } finally { cleanup(root); }
});

test('(g) conflicting ADLC_TICKET vs current-ticket.json denies (fail closed)', () => {
  const root = fixture({ tickets: RAILED, currentTicket: 'T2' });
  try {
    const v = decide(payload('Write', 'src/anything.js'), { root, env: env({ ADLC_TICKET: 'T1' }) });
    assert.equal(v.permission, 'deny');
    assert.match(v.user_message, /conflicting active-ticket/);
  } finally { cleanup(root); }
});

test('(h) afterFileEdit audit NEVER blocks, even on a rail path', () => {
  const root = fixture({ tickets: RAILED });
  try {
    const res = audit({ file_path: 'src/frozen.js' }, { root, env: env() });
    // It observes the rail touch but returns no permission/deny channel.
    assert.equal(res.rail, true);
    assert.ok(!('permission' in res));
    // A non-rail path is simply not flagged.
    assert.deepEqual(audit({ file_path: 'src/free.js' }, { root, env: env() }), { rail: false });
  } finally { cleanup(root); }
});

test('read-only tools are never gated', () => {
  const root = fixture({ tickets: RAILED });
  try {
    assert.deepEqual(decide(payload('Read', 'src/frozen.js'), { root, env: env() }), { permission: 'allow' });
    assert.deepEqual(decide(payload('codebase_search', 'src/frozen.js'), { root, env: env() }), { permission: 'allow' });
  } finally { cleanup(root); }
});

// --- P5 prosecution regressions (ADR 0006): the in-session deny must cover
//     Cursor's in-place edit tool, unrecognized tools, and symlink aliases. ---

test('(d2) search_replace / str_replace edits to a rail are denied (not waved through as a read)', () => {
  const root = fixture({ tickets: RAILED });
  try {
    for (const tool of ['search_replace', 'SearchReplace', 'str_replace', 'reapply']) {
      const v = decide(payload(tool, 'src/frozen.js'), { root, env: env() });
      assert.equal(v.permission, 'deny', `${tool} editing a rail must be denied`);
    }
  } finally { cleanup(root); }
});

test('(d3) an UNRECOGNIZED structured tool carrying a rail path fails closed (denied)', () => {
  const root = fixture({ tickets: RAILED });
  try {
    // "frobnicate" is unknown — it must not be classified read-only and waved through.
    const v = decide(payload('frobnicate', 'src/frozen.js'), { root, env: env() });
    assert.equal(v.permission, 'deny', 'unknown tool on a rail must fail closed');
  } finally { cleanup(root); }
});

test('(d4) a symlink whose real target is a frozen rail is denied', () => {
  const root = fixture({ tickets: RAILED });
  try {
    // Create src/frozen.js (the rail) and an alias symlink pointing at it.
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'frozen.js'), '// rail');
    let linked = false;
    try { symlinkSync(join(root, 'src', 'frozen.js'), join(root, 'alias.js')); linked = true; } catch { /* FS without symlink perms */ }
    if (!linked) return; // skip on platforms that can't symlink
    const v = decide(payload('Edit', 'alias.js'), { root, env: env() });
    assert.equal(v.permission, 'deny', 'editing a symlink aliasing a rail must be denied');
  } finally { cleanup(root); }
});

// --- Cross-model review regressions (ADR 0006): the HOOK-ROUTING boundary, not
//     just the decision function, must cover the mutators; corrupt tickets fail closed. ---

test('(matcher) the shipped preToolUse matcher routes every mutation tool to the guard', () => {
  // Build the regex the way Cursor would interpret the matcher string (strip the
  // inline (?i) flag, apply case-insensitively) and confirm it MATCHES the tools
  // the classifier treats as mutating — otherwise the guard is never invoked and
  // decide()'s deny is dead code in production (the F1 finding).
  const re = new RegExp(MUTATING_MATCHER.replace('(?i)', ''), 'i');
  for (const tool of ['Write', 'Edit', 'MultiEdit', 'search_replace', 'str_replace', 'reapply', 'delete_file', 'create_file', 'rename_file', 'apply_patch']) {
    assert.ok(re.test(tool), `matcher must route "${tool}" to the guard`);
  }
  // Drift guard: the committed hooks.json matcher must equal the derived one.
  const hooksJson = JSON.parse(readFileSync(join(HERE, '..', 'hooks.json'), 'utf8'));
  assert.equal(hooksJson.hooks.preToolUse[0].matcher, MUTATING_MATCHER, 'hooks.json matcher drifted from MUTATING_MATCHER');
});

test('(F2) a corrupt/invalid tickets.json fails CLOSED under active enforcement', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-cursor-'));
  try {
    mkdirSync(join(root, '.adlc'), { recursive: true });
    writeFileSync(join(root, '.adlc', 'tickets.json'), '{ this is not valid json');
    const v = decide(payload('Write', 'src/anything.js'), { root, env: env() });
    assert.equal(v.permission, 'deny', 'corrupt tickets.json must not silently drop declared rails');
    assert.match(v.user_message, /failing closed/);
  } finally { cleanup(root); }
});

test('wire format: the real script reads stdin JSON and writes a {permission} verdict', () => {
  const root = fixture({ tickets: RAILED });
  try {
    const out = execFileSync(process.execPath, [GUARD_SCRIPT], {
      input: JSON.stringify(payload('Write', 'src/frozen.js')),
      cwd: root,
      env: { ...process.env, ...env() },
    }).toString();
    const verdict = JSON.parse(out);
    assert.equal(verdict.permission, 'deny');
    assert.match(verdict.user_message, /frozen rail/);
  } finally { cleanup(root); }
});
