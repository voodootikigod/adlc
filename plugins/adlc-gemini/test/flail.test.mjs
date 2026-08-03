import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  normalizeError,
  detectRepeatedErrors,
  detectEditChurn,
  resolveTranscriptPath,
  parseTranscriptLines,
  analyzeFlail,
  createFlailTracker,
  MAX_SCAN_BYTES,
} from '../flail-inline.mjs';
import { createPersistentTracker } from '../build-gate-inline.mjs';
import { runFromStdin, printStatus } from '../hooks/adlc-rails-guard.mjs';

test('normalizeError strips line numbers, hex, quotes, absolute paths, and digits', () => {
  const raw1 = 'Error: Failed to build target "/Users/test/app.js" at line 42 (0xDEADBEEF)';
  const raw2 = 'Error: Failed to build target "C:\\Users\\test\\app.js" at line 99 (0x1234)';
  const norm1 = normalizeError(raw1);
  const norm2 = normalizeError(raw2);

  assert.equal(norm1, norm2);
  assert.equal(norm1, 'error: failed to build target at line ()');
});

test('detectRepeatedErrors detects error signatures repeating >= maxRepeat times', () => {
  const lines = [
    'Error: Failed to compile src/a.js at line 10',
    'Info: compiling...',
    'Error: Failed to compile src/b.js at line 20',
    'Error: Failed to compile src/c.js at line 30',
  ];
  const detected = detectRepeatedErrors(lines, 3);
  assert.equal(detected.length, 1);
  assert.equal(detected[0].count, 3);
  assert.equal(detected[0].signature, 'error: failed to compile at line');
});

test('detectEditChurn identifies files edited >= threshold times', () => {
  const logs = ['Editing src/foo.ts', 'Editing src/bar.ts', 'Editing src/foo.ts', 'Editing src/foo.ts'];
  const churning = detectEditChurn(logs, 3);
  assert.equal(churning.length, 1);
  assert.equal(churning[0].path, 'src/foo.ts');
  assert.equal(churning[0].count, 3);
});

test('parseTranscriptLines extracts content and error text from JSONL transcript files', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'flail-test-'));
  try {
    const transcriptPath = join(tmpDir, 'transcript.jsonl');
    const records = [
      JSON.stringify({ step_index: 0, content: 'User request\nStarting build...' }),
      JSON.stringify({ step_index: 1, content: 'Error: Cannot find module lodash line 1' }),
      JSON.stringify({ step_index: 2, text: 'Error: Cannot find module express line 2' }),
    ];
    writeFileSync(transcriptPath, records.join('\n'));

    const lines = parseTranscriptLines(transcriptPath);
    assert.ok(lines.includes('Error: Cannot find module lodash line 1'));
    assert.ok(lines.includes('Error: Cannot find module express line 2'));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('analyzeFlail flags both edit churn and repeated errors', () => {
  const edits = ['Editing src/a.js', 'Editing src/a.js', 'Editing src/a.js'];
  const transcriptLines = [
    'Error: Test failure in test/suite.js line 10',
    'Error: Test failure in test/suite.js line 25',
  ];

  const res = analyzeFlail({ edits, transcriptLines, threshold: 3, maxErrorRepeat: 2 });
  assert.equal(res.verdict, 'flail');
  assert.equal(res.signals.length, 2);
  assert.match(res.summary, /file edit churn/i);
  assert.match(res.summary, /repeated error signatures/i);
});

test('createFlailTracker records history and returns flail analysis', () => {
  const tracker = createFlailTracker({ threshold: 2, maxErrorRepeat: 2 });
  const sessionID = 'session-123';

  let res = tracker.record({
    sessionID,
    filePath: 'src/main.js',
    transcriptLines: ['Error: Build failed line 1'],
  });
  assert.equal(res.verdict, 'clean');

  res = tracker.record({
    sessionID,
    filePath: 'src/main.js',
    transcriptLines: ['Error: Build failed line 2'],
  });
  assert.equal(res.verdict, 'flail');
  assert.ok(res.isNewSignal);
});

test('runFromStdin denies mutating tools when session is flailing under enforcement', () => {
  const root = mkdtempSync(join(tmpdir(), 'flail-e2e-'));
  try {
    mkdirSync(join(root, '.adlc'), { recursive: true });
    mkdirSync(join(root, 'src'), { recursive: true });
    const ticket = { id: 'T-FLAIL', title: 'Flail test ticket', scope: ['src/**'] };
    writeFileSync(join(root, '.adlc', 'tickets.json'), JSON.stringify({ tickets: [ticket] }));
    writeFileSync(join(root, '.adlc', 'current-ticket.json'), JSON.stringify({ id: 'T-FLAIL' }));

    // Mock transcript dir structure
    const convId = 'conv-flail-999';
    const brainLogsDir = join(root, 'brain', convId, '.system_generated', 'logs');
    mkdirSync(brainLogsDir, { recursive: true });
    const transcriptFile = join(brainLogsDir, 'transcript.jsonl');
    writeFileSync(transcriptFile, [
      JSON.stringify({ content: 'Error: Adversarial review check failed on line 12' }),
      JSON.stringify({ content: 'Error: Adversarial review check failed on line 45' }),
    ].join('\n'));

    const env = {
      ADLC_P4_ENFORCEMENT: '1',
      ANTIGRAVITY_APP_DATA_DIR: root,
    };

    const targetFile = join(root, 'src', 'app.js');
    const payload = JSON.stringify({
      conversationId: convId,
      toolCall: { name: 'write_to_file', args: { TargetFile: targetFile, CodeContent: 'x' } },
      workspacePaths: [root],
    });

    const res = runFromStdin(payload, env);
    assert.equal(res.allow_tool, false);
    assert.match(res.deny_reason, /flail-detector — session is flailing/i);
    assert.match(res.deny_reason, /repeated error signatures/i);

    // Readonly tools are allowed even during flailing sessions
    const readonlyPayload = JSON.stringify({
      conversationId: convId,
      toolCall: { name: 'view_file', args: { AbsolutePath: targetFile } },
      workspacePaths: [root],
    });
    const resReadonly = runFromStdin(readonlyPayload, env);
    assert.equal(resReadonly.allow_tool, true);

    // Tools classified as 'other' do not record file edit churn
    const otherFile = join(root, 'src', 'other.js');
    const otherPayload = JSON.stringify({
      conversationId: convId,
      toolCall: { name: 'custom_file_op', args: { path: otherFile } },
      workspacePaths: [root],
    });
    const resOther = runFromStdin(otherPayload, env);
    assert.equal(resOther.allow_tool, true);
    const trackerCheck = createPersistentTracker(root);
    assert.equal(trackerCheck.edits(convId).includes(`Editing ${otherFile}`), false);

    // Standalone ADLC_FLAIL_ENFORCEMENT=1 without ADLC_P4_ENFORCEMENT
    const flailOnlyEnv = {
      ADLC_FLAIL_ENFORCEMENT: '1',
      ANTIGRAVITY_APP_DATA_DIR: root,
    };
    const resFlailOnly = runFromStdin(payload, flailOnlyEnv);
    assert.equal(resFlailOnly.allow_tool, false);
    assert.match(resFlailOnly.deny_reason, /flail-detector — session is flailing/i);

    // Advisory mode (neither ADLC_P4_ENFORCEMENT nor ADLC_FLAIL_ENFORCEMENT set)
    const advisoryEnv = {
      ANTIGRAVITY_APP_DATA_DIR: root,
    };
    const resAdvisory = runFromStdin(payload, advisoryEnv);
    assert.equal(resAdvisory.allow_tool, true);

    // Bypass check
    const bypassEnv = { ...env, ADLC_FLAIL_BYPASS: '1' };
    const resBypass = runFromStdin(payload, bypassEnv);
    assert.equal(resBypass.allow_tool, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveTranscriptPath rejects path traversal sequences in conversationId', () => {
  assert.equal(resolveTranscriptPath({ conversationId: '../secret' }), null);
  assert.equal(resolveTranscriptPath({ conversationId: 'foo/bar' }), null);
  assert.equal(resolveTranscriptPath({ conversationId: 'c:\\windows' }), null);
});

test('MAX_SCAN_BYTES is exactly 256 KiB (262144 bytes)', () => {
  assert.equal(MAX_SCAN_BYTES, 262144);
});

test('createPersistentTracker handles null sessionID, missing ticket store, null filePath, and 200 edit cap', () => {
  const root = mkdtempSync(join(tmpdir(), 'tracker-test-'));
  try {
    mkdirSync(join(root, '.adlc'), { recursive: true });
    writeFileSync(join(root, '.adlc', 'tickets.json'), JSON.stringify({ tickets: [{ id: 'T1' }] }));

    const tracker = createPersistentTracker(root);

    // 1. null sessionID returns clean without recording or creating store entries
    const nullSessRes = tracker.recordEdit(null, 'src/app.js');
    assert.equal(nullSessRes.verdict, 'clean');
    assert.ok(Array.isArray(nullSessRes.repeatedErrors));
    const storePath = join(root, '.adlc', 'ticket-store.json');
    const storeObj = existsSync(storePath) ? JSON.parse(readFileSync(storePath, 'utf8')) : {};
    assert.equal('null' in storeObj, false);
    assert.equal('undefined' in storeObj, false);

    // 2. missing ticket store returns clean without recording or creating store file
    const noStoreRoot = mkdtempSync(join(tmpdir(), 'no-store-'));
    try {
      const noStoreTracker = createPersistentTracker(noStoreRoot);
      const noStoreRes = noStoreTracker.recordEdit('s1', 'src/app.js');
      assert.equal(noStoreRes.verdict, 'clean');
      assert.ok(Array.isArray(noStoreRes.repeatedErrors));
      assert.equal(existsSync(join(noStoreRoot, '.adlc', 'ticket-store.json')), false);
    } finally {
      rmSync(noStoreRoot, { recursive: true, force: true });
    }

    // 3. null filePath does not push an edit entry
    tracker.recordEdit('s-null-path', null);
    assert.deepEqual(tracker.edits('s-null-path'), []);

    // 4. 200 edit limit cap
    const sId = 's-cap-200';
    for (let i = 1; i <= 205; i++) {
      tracker.recordEdit(sId, `src/file-${i}.js`);
    }
    const edits = tracker.edits(sId);
    assert.equal(edits.length, 200);
    assert.equal(edits[0], 'Editing src/file-6.js');
    assert.equal(edits[199], 'Editing src/file-205.js');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

