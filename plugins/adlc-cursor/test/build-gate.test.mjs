// build-gate.test.mjs — T18 AC1/AC2 + the fresh-session AC (P1 amendment 3):
// the Cursor buildgate (inside the preToolUse dispatcher) denies a high-risk
// ticket edit in a degraded session, allows otherwise, honors ONLY an audited
// bypass, imports its logic from @adlc/build-gate deep subpaths (no local
// copies), and a FRESH session always starts un-degraded (TTL/conversation-id
// counter reset). Offline; temp dirs; drives the real hook entry.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { dispatch, bumpDepthCounter, extractConversationId } from '../hooks/adlc-pretool.mjs';
import { SESSION_TTL_MS } from '../constants.mjs';
import { sessionSafeId } from '../lib/session-identity.mjs';
import { DEFAULT_DEPTH_THRESHOLD } from '@adlc/build-gate/lib/depth-signal.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DISPATCHER_SCRIPT = join(HERE, '..', 'hooks', 'adlc-pretool.mjs');

const HIGH_RISK = [{ id: 'T9', title: 'hot', risk: 'high', rails: ['src/frozen.js'] }];
const NORMAL = [{ id: 'T9', title: 'calm', rails: ['src/frozen.js'] }];

function fixture(tickets) {
  const root = mkdtempSync(join(tmpdir(), 'adlc-cursor-bg-'));
  const stateDir = mkdtempSync(join(tmpdir(), 'adlc-cursor-bg-state-'));
  mkdirSync(join(root, '.adlc'), { recursive: true });
  writeFileSync(join(root, '.adlc', 'tickets.json'), JSON.stringify({ tickets }));
  return { root, stateDir };
}
const cleanup = (fx) => {
  rmSync(fx.root, { recursive: true, force: true });
  rmSync(fx.stateDir, { recursive: true, force: true });
};
const counterPath = (fx, sessionId = null) => {
  const name = sessionId
    ? `cursor-buildgate-depth-${sessionSafeId(sessionId)}.json`
    : 'cursor-buildgate-depth-anonymous.json';
  return join(fx.stateDir, name);
};
const seedCounter = (fx, data, sessionId = data.conversationId ?? data.sessionId ?? null) => {
  writeFileSync(counterPath(fx, sessionId), JSON.stringify(data));
};

// Rails must ALLOW these payloads (non-rail path) so the buildgate decides.
const editPayload = { tool_name: 'Write', tool_input: { file_path: 'src/free.js' }, session_id: 'bg-sess' };
const readPayload = { tool_name: 'Read', tool_input: { file_path: 'src/free.js' }, session_id: 'bg-sess' };
const env = (fx, over = {}) => ({
  ADLC_TICKET: 'T9',
  ADLC_BUILD_GATE_ENFORCEMENT: '1',
  ADLC_CURSOR_STATE_DIR: fx.stateDir,
  ...over,
});

test('DENY: high-risk ticket + degraded session (depth past threshold) blocks a structured edit', async () => {
  const fx = fixture(HIGH_RISK);
  try {
    seedCounter(fx, { count: DEFAULT_DEPTH_THRESHOLD + 5, updatedAt: Date.now(), sessionId: 'bg-sess' }, 'bg-sess');
    const v = await dispatch(editPayload, { root: fx.root, env: env(fx) });
    assert.equal(v.permission, 'deny');
    assert.match(v.user_message, /build-gate/);
    assert.match(v.agent_message, /fresh session/i);
  } finally { cleanup(fx); }
});

test('ALLOW: high-risk ticket but shallow session (below threshold)', async () => {
  const fx = fixture(HIGH_RISK);
  try {
    const v = await dispatch(editPayload, { root: fx.root, env: env(fx) });
    assert.deepEqual(v, { permission: 'allow' });
  } finally { cleanup(fx); }
});

test('ALLOW: normal-risk ticket is never gated, no matter how deep the session', async () => {
  const fx = fixture(NORMAL);
  try {
    seedCounter(fx, { count: 10_000, updatedAt: Date.now(), sessionId: 'bg-sess' }, 'bg-sess');
    const v = await dispatch(editPayload, { root: fx.root, env: env(fx) });
    assert.equal(v.permission, 'allow');
  } finally { cleanup(fx); }
});

test('ALLOW: read-only tools are never buildgate-denied (depth still accrues)', async () => {
  const fx = fixture(HIGH_RISK);
  try {
    seedCounter(fx, { count: DEFAULT_DEPTH_THRESHOLD + 5, updatedAt: Date.now(), sessionId: 'bg-sess' }, 'bg-sess');
    const v = await dispatch(readPayload, { root: fx.root, env: env(fx) });
    assert.equal(v.permission, 'allow');
    const after = JSON.parse(readFileSync(counterPath(fx, 'bg-sess'), 'utf8'));
    assert.equal(after.count, DEFAULT_DEPTH_THRESHOLD + 6, 'a read still bumps the session depth');
  } finally { cleanup(fx); }
});

test('DENY: a NOVEL structured mutator name (classifier "other", not shell) is gated like the rails path treats it', async () => {
  // Cross-model review finding (PR #108): buildgate used a narrow
  // `classifyTool === "mutating"` check, so a novel mutator name the rails
  // classifier fail-closed-CHECKS as "other" (e.g. modify_file/save_file) would
  // slip past the fitness gate entirely — a coverage asymmetry with the rails
  // dispatcher. Buildgate must gate the same surface (mutating OR non-shell other).
  const fx = fixture(HIGH_RISK);
  try {
    seedCounter(fx, { count: DEFAULT_DEPTH_THRESHOLD + 5, updatedAt: Date.now(), sessionId: 'bg-sess' }, 'bg-sess');
    const novel = { tool_name: 'modify_file', tool_input: { file_path: 'src/free.js' }, session_id: 'bg-sess' };
    const v = await dispatch(novel, { root: fx.root, env: env(fx) });
    assert.equal(v.permission, 'deny', 'a novel structured mutator must be gated in a degraded high-risk session');
  } finally { cleanup(fx); }
});

test('ALLOW: a shell/terminal tool is NOT buildgate-gated (shell is exempt in-session; writes go to CI)', async () => {
  const fx = fixture(HIGH_RISK);
  try {
    seedCounter(fx, { count: DEFAULT_DEPTH_THRESHOLD + 5, updatedAt: Date.now(), sessionId: 'bg-sess' }, 'bg-sess');
    const shell = { tool_name: 'run_terminal_cmd', tool_input: { command: 'sed -i s/a/b/ src/free.js' } };
    const v = await dispatch(shell, { root: fx.root, env: env(fx) });
    assert.equal(v.permission, 'allow', 'shell tools are exempt from the in-session gate (mutation surface excludes shell)');
  } finally { cleanup(fx); }
});

test('PATHLESS mutator, NO explicit root → the resolveOwning(payload, undefined) branch does not crash and still gates', async () => {
  // Regression for a finding cross-model review re-raises every pass: dispatch()
  // resolves the owning root via `root ?? resolveOwning(payload, extractFilePaths(payload)[0])`.
  // Every OTHER buildgate test passes an explicit `root`, short-circuiting the `??`,
  // so `resolveOwning(payload, undefined)` — the real hook path when a mutating tool
  // carries no file path — was never exercised by a committed test. Drive it directly:
  // a pathless mutator (extractFilePaths[0] === undefined), rails allowing (P4
  // enforcement off), buildgate ON, and NO `root` option so resolveOwning runs. It
  // must not throw and must still gate via the workspace_roots-resolved root.
  const fx = fixture(HIGH_RISK);
  try {
    seedCounter(fx, { count: DEFAULT_DEPTH_THRESHOLD + 5, updatedAt: Date.now(), sessionId: 'bg-sess' }, 'bg-sess');
    const pathless = { tool_name: 'Write', tool_input: {}, workspace_roots: [fx.root], session_id: 'bg-sess' };
    const v = await dispatch(pathless, { env: env(fx) }); // no `root` → forces resolveOwning(payload, undefined)
    assert.equal(v.permission, 'deny', 'a pathless high-risk edit in a degraded session still gates (no crash)');
    assert.match(v.user_message, /build-gate/, 'the deny came from the buildgate — i.e. resolveOwning resolved the root and consultBuildGate ran');
  } finally { cleanup(fx); }
});

test('BYPASS-AUDITED: ADLC_BUILD_GATE_BYPASS=1 allows AND durably records a build-gate-bypass manifest entry', async () => {
  const fx = fixture(HIGH_RISK);
  try {
    seedCounter(fx, { count: DEFAULT_DEPTH_THRESHOLD + 5, updatedAt: Date.now(), sessionId: 'bg-sess' }, 'bg-sess');
    const v = await dispatch(editPayload, { root: fx.root, env: env(fx, { ADLC_BUILD_GATE_BYPASS: '1' }) });
    assert.equal(v.permission, 'allow');
    const ledger = join(fx.root, '.adlc', 'manifest.jsonl');
    assert.ok(existsSync(ledger), 'the override must be recorded');
    const entries = readFileSync(ledger, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const bypass = entries.find((e) => e.gate === 'build-gate-bypass');
    assert.ok(bypass, 'a build-gate-bypass entry must exist');
    assert.equal(bypass.ticket, 'T9');
  } finally { cleanup(fx); }
});

test('BYPASS-UNAUDITED: an override that cannot be durably recorded is REFUSED (deny)', async () => {
  const fx = fixture(HIGH_RISK);
  try {
    seedCounter(fx, { count: DEFAULT_DEPTH_THRESHOLD + 5, updatedAt: Date.now(), sessionId: 'bg-sess' }, 'bg-sess');
    // Make the ledger unwritable: a DIRECTORY at .adlc/manifest.jsonl makes the
    // append throw inside recordOverride → returns false → deny.
    mkdirSync(join(fx.root, '.adlc', 'manifest.jsonl'));
    const v = await dispatch(editPayload, { root: fx.root, env: env(fx, { ADLC_BUILD_GATE_BYPASS: '1' }) });
    assert.equal(v.permission, 'deny');
    assert.match(v.user_message, /unaudited bypass is refused/);
  } finally { cleanup(fx); }
});

test('FAIL CLOSED: conflicting active-ticket signal denies a structured edit under gate enforcement', async () => {
  const fx = fixture(HIGH_RISK);
  try {
    writeFileSync(join(fx.root, '.adlc', 'current-ticket.json'), JSON.stringify({ id: 'OTHER' }));
    const v = await dispatch(editPayload, { root: fx.root, env: env(fx) }); // ADLC_TICKET=T9 vs file=OTHER
    assert.equal(v.permission, 'deny');
    // Assert the CONTRACT, not one phrase of the prose: fail closed, name BOTH
    // tickets so the operator can see the disagreement, and give the real remedy.
    // Pinning a single wording made this fail once the message started carrying
    // the canonical reason (which is what tells a typo'd-key operator what broke).
    assert.match(v.user_message, /T9/);
    assert.match(v.user_message, /OTHER/);
    assert.match(v.user_message, /worktree/i);
  } finally { cleanup(fx); }
});

test('NO-OP: without an active ticket the gate allows (opt-in convention)', async () => {
  const fx = fixture(HIGH_RISK);
  try {
    seedCounter(fx, { count: 10_000, updatedAt: Date.now(), sessionId: 'bg-sess' }, 'bg-sess');
    const v = await dispatch(editPayload, { root: fx.root, env: { ADLC_BUILD_GATE_ENFORCEMENT: '1' } });
    assert.equal(v.permission, 'allow');
  } finally { cleanup(fx); }
});

// --- Fresh-session AC (P1 amendment 3): the counter resets/expires -----------

test('FRESH SESSION: a stale counter (older than SESSION_TTL_MS) resets — a new session is not denied by stale depth', async () => {
  const fx = fixture(HIGH_RISK);
  try {
    seedCounter(fx, { count: 10_000, updatedAt: Date.now() - SESSION_TTL_MS - 1000, sessionId: 'bg-sess' }, 'bg-sess');
    const v = await dispatch(editPayload, { root: fx.root, env: env(fx) });
    assert.equal(v.permission, 'allow', 'stale depth must not degrade a fresh session');
    const after = JSON.parse(readFileSync(counterPath(fx, 'bg-sess'), 'utf8'));
    assert.equal(after.count, 1, 'the counter must restart from zero');
  } finally { cleanup(fx); }
});

test('FRESH SESSION: a different session_id uses an independent counter (starts un-degraded)', async () => {
  const fx = fixture(HIGH_RISK);
  try {
    seedCounter(fx, { count: 10_000, updatedAt: Date.now(), sessionId: 'conv-A' }, 'conv-A');
    const p = { tool_name: 'Write', tool_input: { file_path: 'src/free.js' }, session_id: 'conv-B' };
    const v = await dispatch(p, { root: fx.root, env: env(fx) });
    assert.equal(v.permission, 'allow', 'a new conversation must start un-degraded');
    const after = JSON.parse(readFileSync(counterPath(fx, 'conv-B'), 'utf8'));
    assert.equal(after.count, 1);
    assert.equal(after.sessionId, 'conv-B');
  } finally { cleanup(fx); }
});

test('SAME SESSION: a fresh (in-TTL) counter keeps accruing and still denies', async () => {
  const fx = fixture(HIGH_RISK);
  try {
    seedCounter(fx, { count: DEFAULT_DEPTH_THRESHOLD + 5, updatedAt: Date.now(), sessionId: 'conv-A' }, 'conv-A');
    const v = await dispatch({ tool_name: 'Write', tool_input: { file_path: 'src/free.js' }, session_id: 'conv-A' }, { root: fx.root, env: env(fx) });
    assert.equal(v.permission, 'deny');
  } finally { cleanup(fx); }
});

test('bumpDepthCounter unit: corrupt counter file counts as a fresh session', () => {
  const fx = fixture(HIGH_RISK);
  try {
    writeFileSync(counterPath(fx), 'not json at all');
    assert.equal(bumpDepthCounter(fx.root, { env: env(fx) }), 1);
    assert.equal(bumpDepthCounter(fx.root, { env: env(fx) }), 2);
  } finally { cleanup(fx); }
});

test('extractConversationId reads pinned session aliases and rejects generation/thread', () => {
  assert.equal(extractConversationId({ conversation_id: 'c1' }), 'c1');
  assert.equal(extractConversationId({ sessionId: 's1' }), 's1');
  assert.equal(extractConversationId({ tool_name: 'Write' }), null);
  assert.equal(extractConversationId({ generation_id: 'g1' }), null);
  assert.equal(extractConversationId(null), null);
});

test('ADLC_BUILD_GATE_DEPTH env input overrides the persisted counter', async () => {
  const fx = fixture(HIGH_RISK);
  try {
    const v = await dispatch(editPayload, {
      root: fx.root,
      env: env(fx, { ADLC_BUILD_GATE_DEPTH: String(DEFAULT_DEPTH_THRESHOLD + 1) }),
    });
    assert.equal(v.permission, 'deny');
  } finally { cleanup(fx); }
});

// --- AC2: delegation to @adlc/build-gate, no local risk/decide copies --------

test('AC2: the dispatcher imports @adlc/build-gate lib subpaths and has NO local risk/decide/degrade copy', () => {
  const src = readFileSync(DISPATCHER_SCRIPT, 'utf8');
  for (const sub of ['risk.mjs', 'decide.mjs', 'depth-signal.mjs', 'active-ticket.mjs', 'override.mjs']) {
    assert.ok(src.includes(`@adlc/build-gate/lib/${sub}`), `must import @adlc/build-gate/lib/${sub}`);
  }
  assert.ok(!/function\s+(deriveRiskSignals|computeRiskTier|isDegraded|decideBuildGate|recordOverride)\s*\(/.test(src),
    'no hand-copied risk/decide/degrade/override implementation');
  assert.match(src, /await importModule\(/, 'buildgate imports must be lazy (dynamic import)');
});

// --- Wire format: drive the REAL hook entry with fixture payloads ------------

test('wire format: the real dispatcher script denies under gate enforcement in a degraded session', () => {
  const fx = fixture(HIGH_RISK);
  try {
    seedCounter(fx, { count: DEFAULT_DEPTH_THRESHOLD + 5, updatedAt: Date.now(), sessionId: 'bg-sess' }, 'bg-sess');
    const out = execFileSync(process.execPath, [DISPATCHER_SCRIPT], {
      cwd: fx.root,
      env: { ...process.env, ADLC_TICKET: 'T9', ADLC_BUILD_GATE_ENFORCEMENT: '1', ADLC_P4_ENFORCEMENT: '', ADLC_CURSOR_STATE_DIR: fx.stateDir },
      input: JSON.stringify({ tool_name: 'Write', tool_input: { file_path: 'src/free.js' }, workspace_roots: [fx.root], session_id: 'bg-sess' }),
    }).toString();
    assert.equal(JSON.parse(out).permission, 'deny');
  } finally { cleanup(fx); }
});

test('wire format: the real dispatcher script allows the same edit in a fresh session', () => {
  const fx = fixture(HIGH_RISK);
  try {
    const out = execFileSync(process.execPath, [DISPATCHER_SCRIPT], {
      cwd: fx.root,
      env: { ...process.env, ADLC_TICKET: 'T9', ADLC_BUILD_GATE_ENFORCEMENT: '1', ADLC_P4_ENFORCEMENT: '', ADLC_CURSOR_STATE_DIR: fx.stateDir },
      input: JSON.stringify({ tool_name: 'Write', tool_input: { file_path: 'src/free.js' }, workspace_roots: [fx.root], session_id: 'bg-sess' }),
    }).toString();
    assert.equal(JSON.parse(out).permission, 'allow');
  } finally { cleanup(fx); }
});
