// build-gate.test.mjs — tests for build-gate-inline.mjs, flail-inline.mjs, and persistent session depth tracking

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import {
  computeRiskTier,
  createDepthTracker,
  createPersistentTracker,
  decideBuildGate,
  checkBuildGate,
} from '../build-gate-inline.mjs';
import { createFlailTracker, detectEditChurn, flailMessage } from '../flail-inline.mjs';
import { runFromStdin, printStatus, printDoctor } from '../hooks/adlc-rails-guard.mjs';

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

test('printStatus & printDoctor: execute subcommand displays without crashing', () => {
  const root = mkdtempSync(join(tmpdir(), 'cmd-test-'));
  try {
    mkdirSync(join(root, '.adlc'), { recursive: true });
    writeFileSync(join(root, '.adlc', 'tickets.json'), JSON.stringify({ tickets: [] }));

    let logs = [];
    const origLog = console.log;
    console.log = (msg) => logs.push(msg);
    try {
      printStatus(root, { ADLC_P4_ENFORCEMENT: '1' });
      assert.ok(logs.some((l) => String(l).includes('ADLC Antigravity Status')));

      logs = [];
      printDoctor(root, {});
      assert.ok(logs.some((l) => String(l).includes('ADLC Antigravity Doctor')));
    } finally {
      console.log = origLog;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI subcommand end-to-end: adlc-rails-guard.cjs status and doctor subcommands execute via subprocess', () => {
  const cjsPath = join(process.cwd(), 'hooks', 'adlc-rails-guard.cjs');
  const statusOut = execSync(`node "${cjsPath}" status`, { encoding: 'utf8' });
  assert.ok(statusOut.includes('ADLC Antigravity Status'));

  const doctorOut = execSync(`node "${cjsPath}" doctor`, { encoding: 'utf8' });
  assert.ok(doctorOut.includes('ADLC Antigravity Doctor'));
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
