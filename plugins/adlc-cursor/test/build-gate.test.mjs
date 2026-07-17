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
import { SESSION_TTL_MS, DEPTH_COUNTER_FILE } from '../constants.mjs';
import { DEFAULT_DEPTH_THRESHOLD } from '@adlc/build-gate/lib/depth-signal.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DISPATCHER_SCRIPT = join(HERE, '..', 'hooks', 'adlc-pretool.mjs');

const HIGH_RISK = [{ id: 'T9', title: 'hot', risk: 'high', rails: ['src/frozen.js'] }];
const NORMAL = [{ id: 'T9', title: 'calm', rails: ['src/frozen.js'] }];

function fixture(tickets) {
  const root = mkdtempSync(join(tmpdir(), 'adlc-cursor-bg-'));
  mkdirSync(join(root, '.adlc'), { recursive: true });
  writeFileSync(join(root, '.adlc', 'tickets.json'), JSON.stringify({ tickets }));
  return root;
}
const cleanup = (root) => rmSync(root, { recursive: true, force: true });
const counterPath = (root) => join(root, '.adlc', DEPTH_COUNTER_FILE);
const seedCounter = (root, data) => writeFileSync(counterPath(root), JSON.stringify(data));

// Rails must ALLOW these payloads (non-rail path) so the buildgate decides.
const editPayload = { tool_name: 'Write', tool_input: { file_path: 'src/free.js' } };
const readPayload = { tool_name: 'Read', tool_input: { file_path: 'src/free.js' } };
const env = (over = {}) => ({ ADLC_TICKET: 'T9', ADLC_BUILD_GATE_ENFORCEMENT: '1', ...over });

test('DENY: high-risk ticket + degraded session (depth past threshold) blocks a structured edit', async () => {
  const root = fixture(HIGH_RISK);
  try {
    seedCounter(root, { count: DEFAULT_DEPTH_THRESHOLD + 5, updatedAt: Date.now() });
    const v = await dispatch(editPayload, { root, env: env() });
    assert.equal(v.permission, 'deny');
    assert.match(v.user_message, /build-gate/);
    assert.match(v.agent_message, /fresh session/i);
  } finally { cleanup(root); }
});

test('ALLOW: high-risk ticket but shallow session (below threshold)', async () => {
  const root = fixture(HIGH_RISK);
  try {
    const v = await dispatch(editPayload, { root, env: env() });
    assert.deepEqual(v, { permission: 'allow' });
  } finally { cleanup(root); }
});

test('ALLOW: normal-risk ticket is never gated, no matter how deep the session', async () => {
  const root = fixture(NORMAL);
  try {
    seedCounter(root, { count: 10_000, updatedAt: Date.now() });
    const v = await dispatch(editPayload, { root, env: env() });
    assert.equal(v.permission, 'allow');
  } finally { cleanup(root); }
});

test('ALLOW: read-only tools are never buildgate-denied (depth still accrues)', async () => {
  const root = fixture(HIGH_RISK);
  try {
    seedCounter(root, { count: DEFAULT_DEPTH_THRESHOLD + 5, updatedAt: Date.now() });
    const v = await dispatch(readPayload, { root, env: env() });
    assert.equal(v.permission, 'allow');
    const after = JSON.parse(readFileSync(counterPath(root), 'utf8'));
    assert.equal(after.count, DEFAULT_DEPTH_THRESHOLD + 6, 'a read still bumps the session depth');
  } finally { cleanup(root); }
});

test('DENY: a NOVEL structured mutator name (classifier "other", not shell) is gated like the rails path treats it', async () => {
  // Cross-model review finding (PR #108): buildgate used a narrow
  // `classifyTool === "mutating"` check, so a novel mutator name the rails
  // classifier fail-closed-CHECKS as "other" (e.g. modify_file/save_file) would
  // slip past the fitness gate entirely — a coverage asymmetry with the rails
  // dispatcher. Buildgate must gate the same surface (mutating OR non-shell other).
  const root = fixture(HIGH_RISK);
  try {
    seedCounter(root, { count: DEFAULT_DEPTH_THRESHOLD + 5, updatedAt: Date.now() });
    const novel = { tool_name: 'modify_file', tool_input: { file_path: 'src/free.js' } };
    const v = await dispatch(novel, { root, env: env() });
    assert.equal(v.permission, 'deny', 'a novel structured mutator must be gated in a degraded high-risk session');
  } finally { cleanup(root); }
});

test('ALLOW: a shell/terminal tool is NOT buildgate-gated (shell is exempt in-session; writes go to CI)', async () => {
  const root = fixture(HIGH_RISK);
  try {
    seedCounter(root, { count: DEFAULT_DEPTH_THRESHOLD + 5, updatedAt: Date.now() });
    const shell = { tool_name: 'run_terminal_cmd', tool_input: { command: 'sed -i s/a/b/ src/free.js' } };
    const v = await dispatch(shell, { root, env: env() });
    assert.equal(v.permission, 'allow', 'shell tools are exempt from the in-session gate (mutation surface excludes shell)');
  } finally { cleanup(root); }
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
  const root = fixture(HIGH_RISK);
  try {
    seedCounter(root, { count: DEFAULT_DEPTH_THRESHOLD + 5, updatedAt: Date.now() });
    const pathless = { tool_name: 'Write', tool_input: {}, workspace_roots: [root] };
    const v = await dispatch(pathless, { env: env() }); // no `root` → forces resolveOwning(payload, undefined)
    assert.equal(v.permission, 'deny', 'a pathless high-risk edit in a degraded session still gates (no crash)');
    assert.match(v.user_message, /build-gate/, 'the deny came from the buildgate — i.e. resolveOwning resolved the root and consultBuildGate ran');
  } finally { cleanup(root); }
});

test('BYPASS-AUDITED: ADLC_BUILD_GATE_BYPASS=1 allows AND durably records a build-gate-bypass manifest entry', async () => {
  const root = fixture(HIGH_RISK);
  try {
    seedCounter(root, { count: DEFAULT_DEPTH_THRESHOLD + 5, updatedAt: Date.now() });
    const v = await dispatch(editPayload, { root, env: env({ ADLC_BUILD_GATE_BYPASS: '1' }) });
    assert.equal(v.permission, 'allow');
    const ledger = join(root, '.adlc', 'manifest.jsonl');
    assert.ok(existsSync(ledger), 'the override must be recorded');
    const entries = readFileSync(ledger, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const bypass = entries.find((e) => e.gate === 'build-gate-bypass');
    assert.ok(bypass, 'a build-gate-bypass entry must exist');
    assert.equal(bypass.ticket, 'T9');
  } finally { cleanup(root); }
});

test('BYPASS-UNAUDITED: an override that cannot be durably recorded is REFUSED (deny)', async () => {
  const root = fixture(HIGH_RISK);
  try {
    seedCounter(root, { count: DEFAULT_DEPTH_THRESHOLD + 5, updatedAt: Date.now() });
    // Make the ledger unwritable: a DIRECTORY at .adlc/manifest.jsonl makes the
    // append throw inside recordOverride → returns false → deny.
    mkdirSync(join(root, '.adlc', 'manifest.jsonl'));
    const v = await dispatch(editPayload, { root, env: env({ ADLC_BUILD_GATE_BYPASS: '1' }) });
    assert.equal(v.permission, 'deny');
    assert.match(v.user_message, /unaudited bypass is refused/);
  } finally { cleanup(root); }
});

test('FAIL CLOSED: conflicting active-ticket signal denies a structured edit under gate enforcement', async () => {
  const root = fixture(HIGH_RISK);
  try {
    writeFileSync(join(root, '.adlc', 'current-ticket.json'), JSON.stringify({ id: 'OTHER' }));
    const v = await dispatch(editPayload, { root, env: env() }); // ADLC_TICKET=T9 vs file=OTHER
    assert.equal(v.permission, 'deny');
    // Assert the CONTRACT, not one phrase of the prose: fail closed, name BOTH
    // tickets so the operator can see the disagreement, and give the real remedy.
    // Pinning a single wording made this fail once the message started carrying
    // the canonical reason (which is what tells a typo'd-key operator what broke).
    assert.match(v.user_message, /T9/);
    assert.match(v.user_message, /OTHER/);
    assert.match(v.user_message, /worktree/i);
  } finally { cleanup(root); }
});

test('NO-OP: without an active ticket the gate allows (opt-in convention)', async () => {
  const root = fixture(HIGH_RISK);
  try {
    seedCounter(root, { count: 10_000, updatedAt: Date.now() });
    const v = await dispatch(editPayload, { root, env: { ADLC_BUILD_GATE_ENFORCEMENT: '1' } });
    assert.equal(v.permission, 'allow');
  } finally { cleanup(root); }
});

// --- Fresh-session AC (P1 amendment 3): the counter resets/expires -----------

test('FRESH SESSION: a stale counter (older than SESSION_TTL_MS) resets — a new session is not denied by stale depth', async () => {
  const root = fixture(HIGH_RISK);
  try {
    seedCounter(root, { count: 10_000, updatedAt: Date.now() - SESSION_TTL_MS - 1000 });
    const v = await dispatch(editPayload, { root, env: env() });
    assert.equal(v.permission, 'allow', 'stale depth must not degrade a fresh session');
    const after = JSON.parse(readFileSync(counterPath(root), 'utf8'));
    assert.equal(after.count, 1, 'the counter must restart from zero');
  } finally { cleanup(root); }
});

test('FRESH SESSION: a conversation-id change resets the counter even inside the TTL window', async () => {
  const root = fixture(HIGH_RISK);
  try {
    seedCounter(root, { count: 10_000, updatedAt: Date.now(), conversationId: 'conv-A' });
    const p = { ...editPayload, conversation_id: 'conv-B' };
    const v = await dispatch(p, { root, env: env() });
    assert.equal(v.permission, 'allow', 'a new conversation must start un-degraded');
    const after = JSON.parse(readFileSync(counterPath(root), 'utf8'));
    assert.equal(after.count, 1);
    assert.equal(after.conversationId, 'conv-B');
  } finally { cleanup(root); }
});

test('SAME SESSION: a fresh (in-TTL, same-conversation) counter keeps accruing and still denies', async () => {
  const root = fixture(HIGH_RISK);
  try {
    seedCounter(root, { count: DEFAULT_DEPTH_THRESHOLD + 5, updatedAt: Date.now(), conversationId: 'conv-A' });
    const v = await dispatch({ ...editPayload, conversation_id: 'conv-A' }, { root, env: env() });
    assert.equal(v.permission, 'deny');
  } finally { cleanup(root); }
});

test('bumpDepthCounter unit: corrupt counter file counts as a fresh session', () => {
  const root = fixture(HIGH_RISK);
  try {
    writeFileSync(counterPath(root), 'not json at all');
    assert.equal(bumpDepthCounter(root), 1);
    assert.equal(bumpDepthCounter(root), 2);
  } finally { cleanup(root); }
});

test('extractConversationId reads the id defensively and returns null when absent', () => {
  assert.equal(extractConversationId({ conversation_id: 'c1' }), 'c1');
  assert.equal(extractConversationId({ sessionId: 's1' }), 's1');
  assert.equal(extractConversationId({ tool_name: 'Write' }), null);
  assert.equal(extractConversationId(null), null);
});

test('ADLC_BUILD_GATE_DEPTH env input overrides the persisted counter', async () => {
  const root = fixture(HIGH_RISK);
  try {
    const v = await dispatch(editPayload, {
      root,
      env: env({ ADLC_BUILD_GATE_DEPTH: String(DEFAULT_DEPTH_THRESHOLD + 1) }),
    });
    assert.equal(v.permission, 'deny');
  } finally { cleanup(root); }
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
  const root = fixture(HIGH_RISK);
  try {
    seedCounter(root, { count: DEFAULT_DEPTH_THRESHOLD + 5, updatedAt: Date.now() });
    const out = execFileSync(process.execPath, [DISPATCHER_SCRIPT], {
      cwd: root,
      env: { ...process.env, ADLC_TICKET: 'T9', ADLC_BUILD_GATE_ENFORCEMENT: '1', ADLC_P4_ENFORCEMENT: '' },
      input: JSON.stringify({ tool_name: 'Write', tool_input: { file_path: 'src/free.js' }, workspace_roots: [root] }),
    }).toString();
    assert.equal(JSON.parse(out).permission, 'deny');
  } finally { cleanup(root); }
});

test('wire format: the real dispatcher script allows the same edit in a fresh session', () => {
  const root = fixture(HIGH_RISK);
  try {
    const out = execFileSync(process.execPath, [DISPATCHER_SCRIPT], {
      cwd: root,
      env: { ...process.env, ADLC_TICKET: 'T9', ADLC_BUILD_GATE_ENFORCEMENT: '1', ADLC_P4_ENFORCEMENT: '' },
      input: JSON.stringify({ tool_name: 'Write', tool_input: { file_path: 'src/free.js' }, workspace_roots: [root] }),
    }).toString();
    assert.equal(JSON.parse(out).permission, 'allow');
  } finally { cleanup(root); }
});
