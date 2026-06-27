// rails-guard.test.mjs — enforcement proof for the Cursor preToolUse adapter and
// the afterFileEdit audit hook. Drives the REAL exported handlers (no Cursor
// binary) and also spawns the actual hook script to prove the stdin→stdout wire
// format. Covers AC3 (a)-(h) of .adlc/cursor-spec.md.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

import { decide, extractToolName, extractFilePath } from '../hooks/adlc-rails-guard.mjs';
import { audit } from '../hooks/adlc-audit.mjs';
import { PRETOOL_MATCHER } from '../rails-checker.mjs';

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

test('(matcher) the shipped preToolUse matcher is catch-all so EVERY tool reaches the guard', () => {
  // A narrow allowlist matcher would let a novel mutator name (modify_file,
  // save_file) bypass the guard before the fail-closed classifier runs. Route all.
  assert.equal(PRETOOL_MATCHER, '.*');
  const re = new RegExp(PRETOOL_MATCHER, 'i');
  for (const tool of ['Write', 'str_replace', 'modify_file', 'save_file', 'frobnicate', 'Read']) {
    assert.ok(re.test(tool), `matcher must route "${tool}" to the guard`);
  }
  // Drift guard: the committed hooks.json matcher must equal PRETOOL_MATCHER.
  const hooksJson = JSON.parse(readFileSync(join(HERE, '..', 'hooks.json'), 'utf8'));
  assert.equal(hooksJson.hooks.preToolUse[0].matcher, PRETOOL_MATCHER, 'hooks.json matcher drifted from PRETOOL_MATCHER');
});

test('(matcher-e2e) a novel mutator name routed to the guard fails CLOSED on a rail', () => {
  const root = fixture({ tickets: RAILED });
  try {
    for (const tool of ['modify_file', 'save_file', 'update_file']) {
      const v = decide(payload(tool, 'src/frozen.js'), { root, env: env() });
      assert.equal(v.permission, 'deny', `unknown mutator "${tool}" on a rail must fail closed`);
    }
  } finally { cleanup(root); }
});

test('(F2) corrupt tickets.json fails CLOSED — invalid JSON, throwing schema, and missing tickets', () => {
  for (const content of ['{ this is not valid json', '{"tickets":{}}', '{"tickets":"x"}', '{"nope":1}']) {
    const root = mkdtempSync(join(tmpdir(), 'adlc-cursor-'));
    try {
      mkdirSync(join(root, '.adlc'), { recursive: true });
      writeFileSync(join(root, '.adlc', 'tickets.json'), content);
      const v = decide(payload('Write', 'src/anything.js'), { root, env: env() });
      assert.equal(v.permission, 'deny', `tickets.json=${content} must fail closed, not drop declared rails`);
      assert.match(v.user_message, /failing closed|not found/);
    } finally { cleanup(root); }
  }
});

test('(multi-root) the guard checks the workspace root that OWNS the edited path', () => {
  // repo-a (first root, no ADLC) + repo-b (ADLC-initialized, has the rail).
  const repoA = mkdtempSync(join(tmpdir(), 'adlc-a-'));
  const repoB = fixture({ tickets: RAILED });
  try {
    const abs = join(repoB, 'src', 'frozen.js'); // absolute path under repo-b (the rail)
    const p = { tool_name: 'Edit', tool_input: { file_path: abs }, workspace_roots: [repoA, repoB] };
    // No explicit root: the adapter must pick repo-b (owns the path), not repo-a.
    const v = decide(p, { env: env() });
    assert.equal(v.permission, 'deny', 'edit to repo-b rail must be denied even when repo-a is listed first');
  } finally { cleanup(repoA); cleanup(repoB); }
});

test('(batch) MultiEdit/batch payloads with nested edits[]/files[] are rail-checked, not waved through', () => {
  const root = fixture({ tickets: RAILED });
  try {
    // edits[] (MultiEdit): a rail among the items must deny.
    const multi = { tool_name: 'MultiEdit', tool_input: { edits: [
      { file_path: 'src/free.js', old_string: 'a', new_string: 'b' },
      { file_path: 'src/frozen.js', old_string: 'a', new_string: 'b' },
    ] } };
    assert.equal(decide(multi, { root, env: env() }).permission, 'deny', 'edits[] rail must deny');

    // files[] string array.
    const files = { tool_name: 'apply_patch', tool_input: { files: ['src/free.js', 'src/frozen.js'] } };
    assert.equal(decide(files, { root, env: env() }).permission, 'deny', 'files[] rail must deny');

    // All-non-rail batch must allow.
    const clean = { tool_name: 'MultiEdit', tool_input: { edits: [{ file_path: 'src/free.js' }, { file_path: 'lib/ok.js' }] } };
    assert.equal(decide(clean, { root, env: env() }).permission, 'allow', 'non-rail batch must allow');
  } finally { cleanup(root); }
});

test('(rename) a rename/move with a frozen rail in EITHER slot (path or target_path) is denied', () => {
  const root = fixture({ tickets: RAILED });
  try {
    // frozen destination behind a non-rail source
    assert.equal(decide({ tool_name: 'rename_file', tool_input: { path: 'src/free.js', target_path: 'src/frozen.js' } }, { root, env: env() }).permission, 'deny');
    // frozen source moved to a non-rail destination
    assert.equal(decide({ tool_name: 'move_file', tool_input: { path: 'src/frozen.js', target_path: 'src/free.js' } }, { root, env: env() }).permission, 'deny');
    // neither slot is a rail -> allow
    assert.equal(decide({ tool_name: 'rename_file', tool_input: { path: 'src/a.js', target_path: 'src/b.js' } }, { root, env: env() }).permission, 'allow');
  } finally { cleanup(root); }
});

test('(patch) apply_patch command string naming a rail is denied; a non-rail patch allows', () => {
  const root = fixture({ tickets: RAILED });
  try {
    const railPatch = '*** Begin Patch\n*** Update File: src/frozen.js\n@@\n-a\n+b\n*** End Patch';
    assert.equal(decide({ tool_name: 'apply_patch', tool_input: { command: railPatch } }, { root, env: env() }).permission, 'deny');
    const freePatch = '*** Begin Patch\n*** Add File: src/new.js\n+x\n*** End Patch';
    assert.equal(decide({ tool_name: 'apply_patch', tool_input: { command: freePatch } }, { root, env: env() }).permission, 'allow');
  } finally { cleanup(root); }
});

test('(no-path) a MUTATING tool with no extractable path fails CLOSED under enforcement, OPEN otherwise; reads allow', () => {
  const root = fixture({ tickets: RAILED });
  try {
    // mutating tool, nothing to inspect, enforcement on -> deny (opaque, can't verify)
    assert.equal(decide({ tool_name: 'edit_file', tool_input: {} }, { root, env: env() }).permission, 'deny');
    // same, enforcement off -> allow (guard is a no-op)
    assert.equal(decide({ tool_name: 'edit_file', tool_input: {} }, { root, env: { ADLC_P4_ENFORCEMENT: '0' } }).permission, 'allow');
    // read-only tool with no path -> always allow
    assert.equal(decide({ tool_name: 'codebase_search', tool_input: { query: 'x' } }, { root, env: env() }).permission, 'allow');
  } finally { cleanup(root); }
});

test('(no-path preconditions) a pathless opaque tool NO-OPs when uninitialized / no active ticket', () => {
  const op = { tool_name: 'edit_file', tool_input: {} };
  // uninitialized repo (enforcement on, no tickets.json) -> allow (no-op)
  const bare = mkdtempSync(join(tmpdir(), 'adlc-cursor-'));
  try {
    assert.equal(decide(op, { root: bare, env: env() }).permission, 'allow', 'uninitialized must no-op, not deny');
  } finally { cleanup(bare); }
  // initialized but NO active ticket -> allow (no-op), matching a path-bearing edit
  const r = fixture({ tickets: RAILED });
  try {
    assert.equal(decide(op, { root: r, env: { ADLC_P4_ENFORCEMENT: '1' } }).permission, 'allow', 'no active ticket must no-op');
    // but a conflict still fails closed even with no path
    mkdirSync(join(r, '.adlc'), { recursive: true });
    writeFileSync(join(r, '.adlc', 'current-ticket.json'), JSON.stringify({ id: 'T2' }));
    assert.equal(decide(op, { root: r, env: env() }).permission, 'deny', 'conflict must fail closed');
  } finally { cleanup(r); }
});

test('(shell) shell/terminal commands with no file path are NOT denied under enforcement (npm test must run)', () => {
  const root = fixture({ tickets: RAILED });
  try {
    for (const t of ['Bash', 'run_terminal_cmd', 'terminal', 'shell', 'powershell']) {
      assert.equal(decide({ tool_name: t, tool_input: { command: 'npm test && npm run build' } }, { root, env: env() }).permission, 'allow', `${t} must run during P4`);
    }
    // but a shell payload that DOES expose a rail target (patch envelope) is still checked
    assert.equal(decide({ tool_name: 'Bash', tool_input: { command: '*** Update File: src/frozen.js' } }, { root, env: env() }).permission, 'deny');
  } finally { cleanup(root); }
});

test('(shell-masquerade) a structured mutator named like a shell tool still fails CLOSED', () => {
  // The shell exemption must not let a pathless structured mutator whose name merely
  // contains "shell"/"terminal"/"powershell" bypass the fail-closed branch.
  const root = fixture({ tickets: RAILED });
  try {
    // (a) names with a mutating hint (edit/write/replace) — denied by precedence
    // (b) names with NO mutating hint but a shell token (modify/set) — denied because
    //     the shell exemption matches EXACT known shell names only, not tokens
    for (const t of ['terminal_edit', 'shell_edit', 'powershell_write', 'shell_replace', 'terminal_modify', 'shell_modify', 'terminal_set', 'powershell_morph']) {
      assert.equal(decide({ tool_name: t, tool_input: {} }, { root, env: env() }).permission, 'deny', `${t} must not masquerade as shell`);
    }
    // real shell tools still allowed (regression guard for over-correction)
    for (const t of ['Bash', 'run_terminal_cmd', 'terminal', 'shell', 'pwsh', 'run_command']) {
      assert.equal(decide({ tool_name: t, tool_input: { command: 'npm test' } }, { root, env: env() }).permission, 'allow', `${t} must run during P4`);
    }
  } finally { cleanup(root); }
});

test('(fail-safe) an unexpected throw in the deny path fails CLOSED under active enforcement, OPEN when off', () => {
  // Force checkRail to throw (a non-string root makes path.join throw) to exercise
  // the categorical catch: under active enforcement an error must NOT become a
  // silent allow; with enforcement off the guard is a no-op so it fails open.
  const p = payload('Write', 'src/x.js');
  assert.equal(decide(p, { root: 42, env: { ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: 'T1' } }).permission, 'deny');
  assert.equal(decide(p, { root: 42, env: { ADLC_P4_ENFORCEMENT: '0' } }).permission, 'allow');
});

test('(F2-rails) a malformed rail entry (non-string) fails CLOSED, not open', () => {
  // @adlc/core only checks rails is an array, not its element types. A non-string
  // rail makes globMatch throw; without a guard the adapter catch fails open.
  const root = mkdtempSync(join(tmpdir(), 'adlc-cursor-'));
  try {
    mkdirSync(join(root, '.adlc'), { recursive: true });
    writeFileSync(join(root, '.adlc', 'tickets.json'),
      JSON.stringify({ tickets: [{ id: 'T1', title: 'x', rails: [123, 'src/frozen.js'] }] }));
    const v = decide(payload('Write', 'src/frozen.js'), { root, env: env() });
    assert.equal(v.permission, 'deny', 'a malformed rail entry must fail closed');
    assert.match(v.user_message, /malformed rail|failing closed/);
  } finally { cleanup(root); }
});

test('(multi-root symlink) a NEW file under a symlinked root, in a frozen glob, is denied', () => {
  // repoB/link -> repoA; repoA freezes src/contracts/**. A not-yet-existing file
  // addressed as repoB/link/src/contracts/new.json must resolve into repoA and deny.
  const repoA = mkdtempSync(join(tmpdir(), 'adlc-a-'));
  mkdirSync(join(repoA, '.adlc'), { recursive: true });
  mkdirSync(join(repoA, 'src'), { recursive: true });
  writeFileSync(join(repoA, '.adlc', 'tickets.json'),
    JSON.stringify({ tickets: [{ id: 'T1', title: 'x', rails: ['src/contracts/**'] }] }));
  const repoB = mkdtempSync(join(tmpdir(), 'adlc-b-'));
  let linked = false;
  try { symlinkSync(repoA, join(repoB, 'link')); linked = true; } catch { /* FS w/o symlink */ }
  try {
    if (!linked) return;
    const abs = join(repoB, 'link', 'src', 'contracts', 'new.schema.json'); // new file, deep non-existent tail
    const p = { tool_name: 'Write', tool_input: { file_path: abs }, workspace_roots: [repoB, repoA] };
    assert.equal(decide(p, { env: env() }).permission, 'deny', 'new file under a symlinked frozen glob must deny');
  } finally { cleanup(repoA); cleanup(repoB); }
});

test('(multi-root ..) a non-normalized path is attributed to the repo it RESOLVES into', () => {
  // repoB (uninitialized, listed first) and repoA (has the rail). The payload path
  // lexically prefixes repoB but ../-resolves into repoA — raw prefix matching would
  // pick repoB (uninitialized -> allow); normalized ownership must pick repoA -> deny.
  const repoA = fixture({ tickets: RAILED });
  const repoB = mkdtempSync(join(tmpdir(), 'adlc-b-'));
  try {
    const sneaky = join(repoB, '..', basename(repoA), 'src', 'frozen.js'); // resolves to repoA/src/frozen.js
    const p = { tool_name: 'Write', tool_input: { file_path: sneaky }, workspace_roots: [repoB, repoA] };
    const v = decide(p, { env: env() });
    assert.equal(v.permission, 'deny', 'non-normalized path resolving into repoA rail must be denied');
  } finally { cleanup(repoA); cleanup(repoB); }
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
