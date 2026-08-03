// build-gate.test.mjs — tests for build-gate-inline.mjs, flail-inline.mjs, and persistent session depth tracking

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import {
  computeRiskTier,
  createDepthTracker,
  createPersistentTracker,
  decideBuildGate,
  checkBuildGate,
  DEFAULT_DEPTH_THRESHOLD,
} from '../build-gate-inline.mjs';
import { createFlailTracker, detectEditChurn, flailMessage, DEFAULT_FLAIL_THRESHOLD } from '../flail-inline.mjs';
import { runFromStdin, printStatus, printDoctor } from '../hooks/adlc-rails-guard.mjs';
import { TRUST_ROOT_RAILS } from '../rails-checker.mjs';
import { ticketFilename } from '../generated-ticket-reader.mjs';

test('DEFAULT_DEPTH_THRESHOLD and DEFAULT_FLAIL_THRESHOLD pin exact boundary constants', () => {
  assert.equal(DEFAULT_DEPTH_THRESHOLD, 50);
  assert.equal(DEFAULT_FLAIL_THRESHOLD, 3);
});

test('TRUST_ROOT_RAILS contains all 6 required session and ticket trust roots', () => {
  assert.ok(TRUST_ROOT_RAILS.includes('.adlc/tickets.json'));
  assert.ok(TRUST_ROOT_RAILS.includes('.adlc/tickets/.store.json'));
  assert.ok(TRUST_ROOT_RAILS.includes('.adlc/tickets/**'));
  assert.ok(TRUST_ROOT_RAILS.includes('.adlc/current-ticket.json'));
  assert.ok(TRUST_ROOT_RAILS.includes('.adlc/sessions.json'));
  assert.ok(TRUST_ROOT_RAILS.includes('.adlc/sessions.lock/**'));
});

test('computeRiskTier: derives high risk for ticket declaring risk: high', () => {
  const { tier, signals } = computeRiskTier({ id: 'T1', title: 'test', risk: 'high' });
  assert.equal(tier, 'high');
  assert.ok(signals.includes('declared-risk-high'));
});

test('computeRiskTier: derives high risk for ticket touching trust root', () => {
  const { tier, signals } = computeRiskTier({ id: 'T1', title: 'test', scope: ['.adlc/tickets.json'] });
  assert.equal(tier, 'high');
  assert.ok(signals.includes('touches-trust-root'));
});

test('computeRiskTier: normal risk for standard ticket', () => {
  const { tier, signals } = computeRiskTier({ id: 'T1', title: 'test', scope: ['src/foo.mjs'] });
  assert.equal(tier, 'normal');
  assert.equal(signals.length, 0);
});

test('decideBuildGate: denies high risk ticket in degraded context', () => {
  const verdict = decideBuildGate({ riskTier: 'high', degraded: true, bypass: false, sessionID: 'real-sess' });
  assert.equal(verdict.decision, 'deny');
  assert.match(verdict.reason, /high-risk ticket build denied/);
});

test('decideBuildGate: allows high risk ticket in degraded context when bypass=true', () => {
  const verdict = decideBuildGate({ riskTier: 'high', degraded: true, bypass: true, sessionID: 'real-sess' });
  assert.equal(verdict.decision, 'allow');
  assert.equal(verdict.overridden, true);
});

test('decideBuildGate: denies high risk ticket when session ID is unresolvable default_session', () => {
  const verdict = decideBuildGate({ riskTier: 'high', degraded: true, bypass: false, sessionID: 'default_session' });
  assert.equal(verdict.decision, 'deny');
  assert.match(verdict.reason, /default_session/);
});

test('decideBuildGate: allows normal risk ticket even if degraded', () => {
  const verdict = decideBuildGate({ riskTier: 'normal', degraded: true, bypass: false });
  assert.equal(verdict.decision, 'allow');
});

test('checkBuildGate: threshold 0 is respected and not discarded as default 50', () => {
  const root = mkdtempSync(join(tmpdir(), 'thresh-0-'));
  try {
    mkdirSync(join(root, '.adlc'), { recursive: true });
    const ticket = { id: 'T-ZERO', title: 'Zero threshold', risk: 'high', scope: ['src/**'] };
    writeFileSync(join(root, '.adlc', 'tickets.json'), JSON.stringify({ tickets: [ticket] }));
    writeFileSync(join(root, '.adlc', 'current-ticket.json'), JSON.stringify({ id: 'T-ZERO' }));

    const env = { ADLC_P4_ENFORCEMENT: '1', ADLC_BUILD_GATE_DEPTH_THRESHOLD: '0' };
    const tracker = createPersistentTracker(root, env);
    const gate = checkBuildGate({ sessionID: 's-zero', tracker, root, env });
    assert.equal(gate.decision, 'deny');
    assert.match(gate.reason, /depth 0 >= 0/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('checkBuildGate: fails closed on active ticket pointer conflict', () => {
  const root = mkdtempSync(join(tmpdir(), 'conflict-'));
  try {
    mkdirSync(join(root, '.adlc'), { recursive: true });
    writeFileSync(join(root, '.adlc', 'tickets.json'), JSON.stringify({ tickets: [] }));
    writeFileSync(join(root, '.adlc', 'current-ticket.json'), JSON.stringify({ id: 'T-FILE' }));

    const env = { ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: 'T-ENV' };
    const gate = checkBuildGate({ sessionID: 's-conflict', root, env });
    assert.equal(gate.decision, 'deny');
    assert.match(gate.reason, /ticket pointer conflict/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('checkBuildGate: fails closed on corrupt tickets.json store', () => {
  const root = mkdtempSync(join(tmpdir(), 'corrupt-'));
  try {
    mkdirSync(join(root, '.adlc'), { recursive: true });
    writeFileSync(join(root, '.adlc', 'tickets.json'), '{ invalid json ');
    writeFileSync(join(root, '.adlc', 'current-ticket.json'), JSON.stringify({ id: 'T-1' }));

    const env = { ADLC_P4_ENFORCEMENT: '1' };
    const gate = checkBuildGate({ sessionID: 's-corrupt', root, env });
    assert.equal(gate.decision, 'deny');
    assert.match(gate.reason, /corrupt or unparseable ticket store/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('printStatus & printDoctor: execute subcommand displays without crashing and resolves subdirectories', () => {
  const root = mkdtempSync(join(tmpdir(), 'cmd-test-'));
  const subDir = join(root, 'src', 'nested');
  try {
    mkdirSync(join(root, '.adlc'), { recursive: true });
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(root, '.adlc', 'tickets.json'), JSON.stringify({ tickets: [] }));

    let logs = [];
    const origLog = console.log;
    console.log = (msg) => logs.push(msg);
    try {
      printStatus(subDir, { ADLC_P4_ENFORCEMENT: '1' });
      assert.ok(logs.some((l) => String(l).includes(`Root: ${root}`)), 'printStatus must resolve parent ADLC root from subdirectory');

      logs = [];
      printDoctor(subDir, {});
      assert.ok(logs.some((l) => String(l).includes(`Root Directory: ${root}`)), 'printDoctor must resolve parent ADLC root from subdirectory');
    } finally {
      console.log = origLog;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI subcommand end-to-end: adlc-rails-guard.cjs status and doctor subcommands execute via subprocess', () => {
  const cjsPath = fileURLToPath(new URL('../hooks/adlc-rails-guard.cjs', import.meta.url));
  const statusOut = execSync(`node "${cjsPath}" status`, { encoding: 'utf8' });
  assert.ok(statusOut.includes('ADLC Gemini Status'));

  const doctorOut = execSync(`node "${cjsPath}" doctor`, { encoding: 'utf8' });
  assert.ok(doctorOut.includes('ADLC Gemini Doctor'));
});

test('checkBuildGate: denies when active ticket ID is absent from tickets.json under enforcement', () => {
  const root = mkdtempSync(join(tmpdir(), 'missing-ticket-'));
  try {
    mkdirSync(join(root, '.adlc'), { recursive: true });
    writeFileSync(join(root, '.adlc', 'current-ticket.json'), JSON.stringify({ id: 'T-GHOST' }));
    writeFileSync(join(root, '.adlc', 'tickets.json'), JSON.stringify({ tickets: [{ id: 'T-1', title: 'Real' }] }));

    const res = checkBuildGate({ root, env: { ADLC_P4_ENFORCEMENT: '1' } });
    assert.equal(res.decision, 'deny');
    assert.ok(res.reason.includes('not found in tickets.json'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('checkBuildGate: correctly loads active ticket from sharded .adlc/tickets/.store.json', () => {
  const root = mkdtempSync(join(tmpdir(), 'sharded-ticket-'));
  try {
    mkdirSync(join(root, '.adlc', 'tickets'), { recursive: true });
    writeFileSync(join(root, '.adlc', 'current-ticket.json'), JSON.stringify({ id: 'T-1' }));
    writeFileSync(join(root, '.adlc', 'tickets', '.store.json'), JSON.stringify({ format: 'adlc-ticket-directory', version: 1 }));
    const shard = { id: 'T-1', title: 'Normal Ticket', risk: 'normal' };
    writeFileSync(join(root, '.adlc', 'tickets', ticketFilename('T-1')), JSON.stringify(shard));

    const res = checkBuildGate({ root, env: { ADLC_P4_ENFORCEMENT: '1' } });
    assert.equal(res.decision, 'allow');
    assert.ok(res.reason.includes("ticket risk tier is 'normal'"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runFromStdin: pathless run_command payload advances tool call depth', () => {
  const root = mkdtempSync(join(tmpdir(), 'pathless-cmd-'));
  try {
    mkdirSync(join(root, '.adlc'), { recursive: true });
    writeFileSync(join(root, '.adlc', 'tickets.json'), JSON.stringify({ tickets: [] }));

    const payload = JSON.stringify({
      conversationId: 'sess-pathless',
      toolCall: { name: 'run_command', command: 'npm test' },
      workspacePaths: [root],
    });
    runFromStdin(payload);
    const tracker = createPersistentTracker(root);
    assert.equal(tracker.depth('sess-pathless'), 1, 'pathless run_command must advance session depth');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('createDepthTracker: tracks tool call count per session', () => {
  const tracker = createDepthTracker();
  assert.equal(tracker.depth('s1'), 0);
  tracker.recordToolCall('s1');
  tracker.recordToolCall('s1');
  assert.equal(tracker.depth('s1'), 2);
  assert.equal(tracker.isCompacted('s1'), false);
  tracker.markCompacted('s1');
  assert.equal(tracker.isCompacted('s1'), true);
});

test('createPersistentTracker: reclaims orphaned stale lock directory even if owner.json is missing', () => {
  const root = mkdtempSync(join(tmpdir(), 'orphan-lock-'));
  try {
    mkdirSync(join(root, '.adlc', 'sessions.lock'), { recursive: true });
    writeFileSync(join(root, '.adlc', 'tickets.json'), JSON.stringify({ tickets: [] }));

    // Set mtime of orphaned lock dir to 5 seconds ago
    const oldTime = (Date.now() - 5000) / 1000;
    utimesSync(join(root, '.adlc', 'sessions.lock'), oldTime, oldTime);

    const tracker = createPersistentTracker(root);
    tracker.recordToolCall('sess-orphan');
    assert.equal(tracker.depth('sess-orphan'), 1, 'stale orphaned lock without owner.json must be reclaimed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('createPersistentTracker: persists depth across calls to .adlc/sessions.json when ADLC repo exists', () => {
  const root = mkdtempSync(join(tmpdir(), 'persist-test-'));
  try {
    mkdirSync(join(root, '.adlc'), { recursive: true });
    writeFileSync(join(root, '.adlc', 'tickets.json'), JSON.stringify({ tickets: [] }));

    const t1 = createPersistentTracker(root);
    t1.recordToolCall('sess-100');
    t1.recordToolCall('sess-100');
    assert.equal(t1.depth('sess-100'), 2);

    const t2 = createPersistentTracker(root);
    assert.equal(t2.depth('sess-100'), 2);
    t2.markCompacted('sess-100');

    const t3 = createPersistentTracker(root);
    assert.equal(t3.isCompacted('sess-100'), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runFromStdin: non-ADLC repo creates NO .adlc directory or session artifacts on disk', () => {
  const root = mkdtempSync(join(tmpdir(), 'non-adlc-'));
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    const targetFile = join(root, 'src', 'app.mjs');
    const payload = JSON.stringify({
      conversationId: 'sess-clean',
      toolCall: { name: 'write_to_file', args: { TargetFile: targetFile, CodeContent: '// test' } }
    });
    const res = runFromStdin(payload, {});
    assert.equal(res.allow_tool, true);
    assert.equal(existsSync(join(root, '.adlc')), false, '.adlc directory must not be created on non-ADLC repo');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runFromStdin same-root multi-path: dedupes tool call count to 1 per payload per root', () => {
  const root = mkdtempSync(join(tmpdir(), 'dedupe-root-'));
  try {
    mkdirSync(join(root, '.adlc'), { recursive: true });
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, '.adlc', 'tickets.json'), JSON.stringify({ tickets: [] }));

    const file1 = join(root, 'src', 'a.mjs');
    const file2 = join(root, 'src', 'b.mjs');

    const payload = JSON.stringify({
      conversationId: 'same-root-sess',
      toolCall: { name: 'write_to_file', args: { TargetFile: file1, FilePath: file2, CodeContent: '// dedupe' } }
    });

    const res = runFromStdin(payload, {});
    assert.equal(res.allow_tool, true);

    const tracker = createPersistentTracker(root);
    assert.equal(tracker.depth('same-root-sess'), 1, 'depth should increment by 1 for a single tool call touching multiple paths in the same root');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runFromStdin end-to-end: denies high-risk ticket edits once context depth threshold is crossed', () => {
  const root = mkdtempSync(join(tmpdir(), 'e2e-gate-'));
  try {
    mkdirSync(join(root, '.adlc'), { recursive: true });
    mkdirSync(join(root, 'src'), { recursive: true });
    const ticket = { id: 'T-HIGH', title: 'High risk contract', risk: 'high', scope: ['src/**'] };
    writeFileSync(join(root, '.adlc', 'tickets.json'), JSON.stringify({ tickets: [ticket] }));
    writeFileSync(join(root, '.adlc', 'current-ticket.json'), JSON.stringify({ id: 'T-HIGH' }));

    const targetFile = join(root, 'src', 'app.mjs');
    const env = { ADLC_P4_ENFORCEMENT: '1', ADLC_BUILD_GATE_DEPTH_THRESHOLD: '3' };

    const payloadStr = (step) => JSON.stringify({
      conversationId: 'e2e-session-1',
      toolCall: { name: 'write_to_file', args: { TargetFile: targetFile, CodeContent: `// step ${step}` } }
    });

    // Calls 1 and 2 should pass
    let res = runFromStdin(payloadStr(1), env);
    assert.equal(res.allow_tool, true);
    res = runFromStdin(payloadStr(2), env);
    assert.equal(res.allow_tool, true);

    // Call 3 crosses depth threshold 3 on a high risk ticket → DENIED
    res = runFromStdin(payloadStr(3), env);
    assert.equal(res.allow_tool, false);
    assert.match(res.deny_reason, /build-gate/i);
    assert.match(res.deny_reason, /tool-call depth 3 >= 3/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runFromStdin multi-root: routes session tracking to respective ADLC roots', () => {
  const rootA = mkdtempSync(join(tmpdir(), 'multi-a-'));
  const rootB = mkdtempSync(join(tmpdir(), 'multi-b-'));
  try {
    mkdirSync(join(rootA, '.adlc'), { recursive: true });
    mkdirSync(join(rootB, '.adlc'), { recursive: true });
    mkdirSync(join(rootA, 'src'), { recursive: true });
    mkdirSync(join(rootB, 'src'), { recursive: true });

    writeFileSync(join(rootA, '.adlc', 'tickets.json'), JSON.stringify({ tickets: [] }));
    writeFileSync(join(rootB, '.adlc', 'tickets.json'), JSON.stringify({ tickets: [] }));

    const fileA = join(rootA, 'src', 'a.mjs');
    const fileB = join(rootB, 'src', 'b.mjs');

    const payload = JSON.stringify({
      conversationId: 'multi-sess',
      toolCall: { name: 'write_to_file', args: { TargetFile: fileA, FilePath: fileB, CodeContent: '// multi' } }
    });

    const res = runFromStdin(payload, {});
    assert.equal(res.allow_tool, true);

    const tA = createPersistentTracker(rootA);
    const tB = createPersistentTracker(rootB);

    assert.equal(tA.depth('multi-sess'), 1);
    assert.equal(tB.depth('multi-sess'), 1);
  } finally {
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
  }
});

test('session store freeze: write to .adlc/sessions.json and .adlc/sessions.lock/** is denied under enforcement as a rail violation', () => {
  const root = mkdtempSync(join(tmpdir(), 'freeze-sess-'));
  try {
    mkdirSync(join(root, '.adlc'), { recursive: true });
    writeFileSync(join(root, '.adlc', 'tickets.json'), JSON.stringify({
      tickets: [{ id: 'T-1', scope: ['src/**'], rails: [] }]
    }));
    writeFileSync(join(root, '.adlc', 'current-ticket.json'), JSON.stringify({ id: 'T-1' }));

    const sessFile = join(root, '.adlc', 'sessions.json');
    const payload1 = JSON.stringify({
      conversationId: 'freeze-test',
      toolCall: { name: 'write_to_file', args: { TargetFile: sessFile, CodeContent: '{}' } },
      workspacePaths: [root],
    });

    const res1 = runFromStdin(payload1, { ADLC_P4_ENFORCEMENT: '1' });
    assert.equal(res1.allow_tool, false);
    assert.match(res1.deny_reason, /frozen rail/i);

    const lockFile = join(root, '.adlc', 'sessions.lock', 'owner.json');
    const payload2 = JSON.stringify({
      conversationId: 'freeze-test',
      toolCall: { name: 'write_to_file', args: { TargetFile: lockFile, CodeContent: '{}' } },
      workspacePaths: [root],
    });

    const res2 = runFromStdin(payload2, { ADLC_P4_ENFORCEMENT: '1' });
    assert.equal(res2.allow_tool, false);
    assert.match(res2.deny_reason, /frozen rail/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('flail-inline: detectEditChurn identifies churning file edits', () => {
  const logs = ['Editing src/a.js', 'Editing src/b.js', 'Editing src/a.js', 'Editing src/a.js'];
  const churning = detectEditChurn(logs, 3);
  assert.equal(churning.length, 1);
  assert.equal(churning[0].path, 'src/a.js');
  assert.equal(churning[0].count, 3);
});

test('createFlailTracker: records mutations and emits warning on threshold', () => {
  const tracker = createFlailTracker({ threshold: 3 });
  let res = tracker.record({ sessionID: 's1', tool: 'write_to_file', filePath: 'src/app.mjs' });
  assert.equal(res.churning.length, 0);
  res = tracker.record({ sessionID: 's1', tool: 'write_to_file', filePath: 'src/app.mjs' });
  assert.equal(res.churning.length, 0);
  res = tracker.record({ sessionID: 's1', tool: 'write_to_file', filePath: 'src/app.mjs' });
  assert.equal(res.churning.length, 1);
  assert.equal(res.churning[0].path, 'src/app.mjs');
});
