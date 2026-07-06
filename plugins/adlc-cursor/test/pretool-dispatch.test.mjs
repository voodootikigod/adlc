// pretool-dispatch.test.mjs — T18 AC (P1 amendments 1+2): the single preToolUse
// dispatcher runs rails FIRST via the frozen guard's decide(), returns any deny
// VERBATIM, consults the buildgate ONLY on rails-allow + enforcement, and a
// buildgate import failure never takes down the rails path. The dispatcher is
// also driven with the guard suite's adversarial payload shapes and must be
// verdict-IDENTICAL to calling decide() directly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { dispatch } from '../hooks/adlc-pretool.mjs';
import { decide } from '../hooks/adlc-rails-guard.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DISPATCHER_SCRIPT = join(HERE, '..', 'hooks', 'adlc-pretool.mjs');

function fixture({ tickets = null, currentTicket = undefined } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'adlc-cursor-dispatch-'));
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

const payload = (tool, filePath) => ({ tool_name: tool, tool_input: { file_path: filePath } });
const env = (over = {}) => ({ ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: 'T1', ...over });

const RAILED = [{ id: 'T1', title: 'one', rails: ['src/frozen.js', 'src/contracts/**'] }];
// A HIGH-RISK ticket (declared) whose rails exclude src/free.js, so rails allow
// but the buildgate can fire.
const HIGH_RISK = [{ id: 'T1', title: 'hot', risk: 'high', rails: ['src/frozen.js'] }];

/** An importModule seam that fails every buildgate import. */
const brokenImporter = async () => { throw new Error('simulated missing @adlc/build-gate'); };

test('a rails DENY is returned VERBATIM — even when the buildgate would allow', async () => {
  const root = fixture({ tickets: HIGH_RISK });
  try {
    const p = payload('Write', 'src/frozen.js');
    const e = env({ ADLC_BUILD_GATE_ENFORCEMENT: '1' }); // gate on, session shallow → gate would allow
    const direct = decide(p, { root, env: e });
    assert.equal(direct.permission, 'deny');
    const dispatched = await dispatch(p, { root, env: e });
    assert.deepEqual(dispatched, direct, 'the rails deny must pass through unchanged');
  } finally { cleanup(root); }
});

test('the buildgate is consulted ONLY on rails-allow (never on a rails deny)', async () => {
  const root = fixture({ tickets: HIGH_RISK });
  try {
    const calls = [];
    const spyImporter = async (spec) => { calls.push(spec); return import(spec); };
    const e = env({ ADLC_BUILD_GATE_ENFORCEMENT: '1' });

    // Rails deny → the importer must never run.
    await dispatch(payload('Write', 'src/frozen.js'), { root, env: e, importModule: spyImporter });
    assert.deepEqual(calls, [], 'buildgate modules must not be imported on a rails deny');

    // Rails allow → the buildgate imports its lib subpaths.
    await dispatch(payload('Write', 'src/free.js'), { root, env: e, importModule: spyImporter });
    assert.ok(calls.length > 0, 'buildgate must be consulted on rails-allow under enforcement');
    assert.ok(calls.every((s) => s.startsWith('@adlc/build-gate/lib/')), `only deep lib subpaths imported, got: ${calls}`);
  } finally { cleanup(root); }
});

test('buildgate is DEFAULT-OFF: without ADLC_BUILD_GATE_ENFORCEMENT=1 it is never imported', async () => {
  const root = fixture({ tickets: HIGH_RISK });
  try {
    const calls = [];
    const spyImporter = async (spec) => { calls.push(spec); return import(spec); };
    const v = await dispatch(payload('Write', 'src/free.js'), { root, env: env(), importModule: spyImporter });
    assert.equal(v.permission, 'allow');
    assert.deepEqual(calls, [], 'the gate must be a no-op unless explicitly enabled');
  } finally { cleanup(root); }
});

test('a buildgate IMPORT FAILURE never takes down the rails path', async () => {
  const root = fixture({ tickets: HIGH_RISK });
  try {
    const e = env({ ADLC_BUILD_GATE_ENFORCEMENT: '1', ADLC_BUILD_GATE_DEPTH: '999' });

    // Rail-targeting payload → the rails deny still emits, identical to decide().
    const railHit = payload('Write', 'src/frozen.js');
    const denied = await dispatch(railHit, { root, env: e, importModule: brokenImporter });
    assert.deepEqual(denied, decide(railHit, { root, env: e }), 'rails deny must survive a buildgate import failure');
    assert.equal(denied.permission, 'deny');

    // Rails-allow payload → the gate degrades to allow (advisory), not a crash.
    const free = payload('Write', 'src/free.js');
    const allowed = await dispatch(free, { root, env: e, importModule: brokenImporter });
    assert.equal(allowed.permission, 'allow', 'a broken buildgate must degrade, not deny/crash');
  } finally { cleanup(root); }
});

// --- Adversarial payload shapes (round-2 amendment 1): the DISPATCHER verdict
// --- must be identical to calling the frozen guard's decide() directly. ------

test('(adversarial: batch edits[]) dispatcher verdict identical to decide()', async () => {
  const root = fixture({ tickets: RAILED });
  try {
    const p = { tool_name: 'MultiEdit', tool_input: { edits: [
      { file_path: 'src/a.js' }, { file_path: 'src/frozen.js' },
    ] } };
    const direct = decide(p, { root, env: env() });
    assert.equal(direct.permission, 'deny', 'sanity: the guard denies a rail hidden in edits[]');
    assert.deepEqual(await dispatch(p, { root, env: env() }), direct);
  } finally { cleanup(root); }
});

test('(adversarial: apply_patch envelope) dispatcher verdict identical to decide()', async () => {
  const root = fixture({ tickets: RAILED });
  try {
    const p = { tool_name: 'apply_patch', tool_input: {
      command: '*** Begin Patch\n*** Update File: src/frozen.js\n@@\n-a\n+b\n*** End Patch',
    } };
    const direct = decide(p, { root, env: env() });
    assert.equal(direct.permission, 'deny', 'sanity: the guard denies a rail named in a patch envelope');
    assert.deepEqual(await dispatch(p, { root, env: env() }), direct);
  } finally { cleanup(root); }
});

test('(adversarial: pathless structured mutator under enforcement) dispatcher verdict identical to decide()', async () => {
  const root = fixture({ tickets: RAILED });
  try {
    const p = { tool_name: 'edit_file', tool_input: { opaque: true }, workspace_roots: [root] };
    const direct = decide(p, { root, env: env() });
    assert.equal(direct.permission, 'deny', 'sanity: a pathless mutator fails closed under enforcement');
    assert.deepEqual(await dispatch(p, { root, env: env() }), direct);
  } finally { cleanup(root); }
});

test('(adversarial: corrupt tickets.json) dispatcher verdict identical to decide()', async () => {
  const root = fixture({ tickets: RAILED });
  try {
    writeFileSync(join(root, '.adlc', 'tickets.json'), '{ definitely not json');
    const p = payload('Write', 'src/anything.js');
    const direct = decide(p, { root, env: env() });
    assert.equal(direct.permission, 'deny', 'sanity: corrupt tickets.json fails closed');
    assert.deepEqual(await dispatch(p, { root, env: env() }), direct);
  } finally { cleanup(root); }
});

test('(adversarial sweep) allow-side payloads are also verdict-identical', async () => {
  const root = fixture({ tickets: RAILED });
  try {
    for (const p of [
      payload('Read', 'src/frozen.js'),                             // read-only
      payload('Write', 'src/free.js'),                              // non-rail write
      { tool_name: 'Bash', tool_input: { command: 'npm test' } },   // shell, no path
      { tool_name: 'MultiEdit', tool_input: { edits: [{ file_path: 'src/a.js' }] } },
    ]) {
      assert.deepEqual(await dispatch(p, { root, env: env() }), decide(p, { root, env: env() }));
    }
  } finally { cleanup(root); }
});

// --- Wire format: the real dispatcher script -------------------------------

test('wire format: the dispatcher script reads stdin JSON and writes a {permission} verdict', () => {
  const root = fixture({ tickets: RAILED });
  try {
    const out = execFileSync(process.execPath, [DISPATCHER_SCRIPT], {
      cwd: root,
      env: { ...process.env, ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: 'T1', ADLC_BUILD_GATE_ENFORCEMENT: '' },
      input: JSON.stringify({ tool_name: 'Write', tool_input: { file_path: 'src/frozen.js' }, workspace_roots: [root] }),
    }).toString();
    assert.equal(JSON.parse(out).permission, 'deny');
  } finally { cleanup(root); }
});

test('wire format: malformed stdin fails CLOSED under enforcement, OPEN otherwise (guard parity)', () => {
  const root = fixture({ tickets: RAILED });
  try {
    const run = (envOver) => JSON.parse(execFileSync(process.execPath, [DISPATCHER_SCRIPT], {
      cwd: root, env: { ...process.env, ...envOver }, input: '{ not json',
    }).toString());
    assert.equal(run({ ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: 'T1' }).permission, 'deny');
    assert.equal(run({ ADLC_P4_ENFORCEMENT: '', ADLC_TICKET: '' }).permission, 'allow');
  } finally { cleanup(root); }
});

// --- Delegation pinning: the dispatcher must not re-assemble extraction ------

test('the dispatcher obtains the RAILS verdict only from decide(), before any extraction (round-2 amendment 1)', () => {
  const src = readFileSync(DISPATCHER_SCRIPT, 'utf8');
  assert.match(src, /import \{ decide[^}]*\} from '\.\/adlc-rails-guard\.mjs'/, 'must import the frozen guard decide()');
  assert.ok(!/checkRail/.test(src), 'must not rebuild the rails verdict from checkRail');
  // The round-2 amendment bans re-ASSEMBLING the rails verdict from lower-level
  // pieces (which would drop the hardened MultiEdit/apply_patch/symlink/multi-root
  // handling). It does NOT ban using the guard's OWN exported extractFilePaths for
  // buildgate owning-root resolution — that reuses the hardened extractor instead
  // of re-implementing it, and it is reached only AFTER the rails-allow gate.
  // Enforce that invariant structurally: (a) the rails verdict comes from a raw
  // decide(payload,...) call, (b) any non-allow is returned before extraction runs,
  // (c) extractFilePaths (if used) appears only after that early-return. The
  // behavioral byte-identity tests above are the real guarantee; this pins the shape.
  const railsCall = src.search(/decide\(payload\b/);
  const denyReturn = src.search(/permission !== 'allow'\)\s*return/);
  assert.ok(railsCall !== -1, 'rails verdict must come from decide(payload, ...)');
  assert.ok(denyReturn !== -1 && denyReturn > railsCall, 'any non-allow rails verdict must be returned verbatim');
  const extractUse = src.search(/extractFilePaths\(payload\)/);
  if (extractUse !== -1) {
    assert.ok(extractUse > denyReturn, 'extractFilePaths may only run AFTER the rails-allow early-return (buildgate root resolution), never to build the rails verdict');
  }
  assert.ok(!/\bextractFilePath\b(?!s)/.test(src), 'must not use a singular single-path extractor to build the rails verdict');
});
