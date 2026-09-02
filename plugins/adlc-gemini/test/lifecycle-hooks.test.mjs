import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, unlinkSync, utimesSync, existsSync, lstatSync, chmodSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
import { preInvocation, onStop, findAdlcRoot, runFromStdin, isReadonlyCommand, postToolUse } from '../hooks/adlc-rails-guard.mjs';
import { readTranscriptPrefixBounded, computePrefixHash, createPersistentTracker, checkBuildGate, resolveSessionId, getTestFilesMap, hasDiscoverableTests, getOrCreateSessionSecret } from '../build-gate-inline.mjs';
import { parseTranscriptRecords } from '../flail-inline.mjs';
import { ticketFilename } from '../generated-ticket-reader.mjs';
import { isShellTool } from '../rails-checker.mjs';

function setupTempRepo({ activeTicket = 'T1', rails = ['src/frozen.js'], scope = ['src/feature/**'], enforcement = '1', sharded = false } = {}) {
  const root = join(tmpdir(), `adlc-gemini-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(root, '.adlc'), { recursive: true });

  const ticket = {
    id: activeTicket ?? 'T1',
    title: 'Test Ticket 1',
    rails,
    scope,
  };

  if (sharded) {
    mkdirSync(join(root, '.adlc', 'tickets'), { recursive: true });
    writeFileSync(join(root, '.adlc', 'tickets', '.store.json'), JSON.stringify({ format: 'adlc-ticket-directory', version: 1 }));
    writeFileSync(join(root, '.adlc', 'tickets', ticketFilename(ticket.id)), JSON.stringify(ticket));
  } else {
    writeFileSync(join(root, '.adlc', 'tickets.json'), JSON.stringify({ version: 1, tickets: [ticket] }));
  }

  if (activeTicket) {
    writeFileSync(join(root, '.adlc', 'current-ticket.json'), JSON.stringify({ id: activeTicket }));
  }

  writeFileSync(join(root, '.adlc', 'sessions.json'), JSON.stringify({}));
  mkdirSync(join(root, 'test'), { recursive: true });
  writeFileSync(join(root, 'test', 'sample.test.js'), 'import test from "node:test"; test("sample", () => {});\n');

  const testHome = join(root, '.home');
  mkdirSync(testHome, { recursive: true });

  const env = {
    ADLC_P4_ENFORCEMENT: enforcement,
    ADLC_TEST_MODE: '1',
    ADLC_HOME_DIR: testHome,
  };

  return {
    root,
    env,
    cleanup() {
      try { rmSync(root, { recursive: true, force: true }); } catch (_) {}
    },
  };
}

test('preInvocation: injects context reminder when active ticket is present in legacy store', () => {
  const { root, env, cleanup } = setupTempRepo({ sharded: false });
  try {
    const payload = {
      workspacePaths: [root],
      conversationId: 'test-session-123',
    };
    const res = preInvocation(payload, { env });
    assert.equal(Array.isArray(res.injectSteps), true);
    assert.equal(res.injectSteps.length, 1);
    assert.match(res.injectSteps[0].ephemeralMessage, /Active Ticket: T1/);
    assert.match(res.injectSteps[0].ephemeralMessage, /src\/frozen\.js/);
  } finally {
    cleanup();
  }
});

test('preInvocation: injects context reminder when active ticket is present in sharded store', () => {
  const { root, env, cleanup } = setupTempRepo({ sharded: true });
  try {
    const payload = {
      workspacePaths: [root],
      conversationId: 'test-session-123',
    };
    const res = preInvocation(payload, { env });
    assert.equal(Array.isArray(res.injectSteps), true);
    assert.equal(res.injectSteps.length, 1);
    assert.match(res.injectSteps[0].ephemeralMessage, /Active Ticket: T1/);
    assert.match(res.injectSteps[0].ephemeralMessage, /src\/frozen\.js/);
  } finally {
    cleanup();
  }
});

test('preInvocation: returns empty injectSteps when no active ticket is present', () => {
  const { root, env, cleanup } = setupTempRepo({ activeTicket: null });
  try {
    const payload = {
      workspacePaths: [root],
      conversationId: 'test-session-123',
    };
    const res = preInvocation(payload, { env });
    assert.deepEqual(res, { injectSteps: [] });
  } finally {
    cleanup();
  }
});

test('onStop: returns decision: stop when enforcement is inactive', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '0' });
  try {
    const payload = {
      workspacePaths: [root],
      conversationId: 'test-session-123',
    };
    const res = onStop(payload, { env });
    assert.deepEqual(res, { decision: 'stop' });
  } finally {
    cleanup();
  }
});

test('onStop: intercepts unverified mutations when enforcement is active', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  const lines = [
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'write_to_file', args: { TargetFile: 'src/feature.js' } }],
    }),
    JSON.stringify({ content: 'Work finished.' }),
  ];
  writeFileSync(transcriptFile, lines.join('\n') + '\n');
  try {
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'test-session-123',
    };
    const res = onStop(payload, { env });
    assert.equal(res.decision, 'continue');
    assert.match(res.reason, /unverified file edits/);
  } finally {
    cleanup();
  }
});

test('onStop: allows stop when tests were executed via run_command after mutations', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  const lines = [
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'write_to_file', args: { TargetFile: 'src/feature.js' } }],
    }),
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'npm test', Cwd: root } }],
      exit_code: 0,
    }),
    JSON.stringify({ content: 'All tests passed.' }),
  ];
  writeFileSync(transcriptFile, lines.join('\n') + '\n');
  try {
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'test-session-123',
    };
    preInvocation(payload, { env });
    const tracker = createPersistentTracker(root, env);
    tracker.recordToolCall(payload.conversationId, { isMutating: true });
    tracker.recordToolCall(payload.conversationId, { isMutating: false });
    const res = onStop(payload, { env });
    assert.equal(res.decision, 'stop');
  } finally {
    cleanup();
  }
});

test('onStop: rejects plain prose mention of test command when mutations occurred and no tool executed', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  const lines = [
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'write_to_file', args: { TargetFile: 'src/feature.js' } }],
    }),
    JSON.stringify({ content: 'User says: please run npm test' }),
    JSON.stringify({ content: 'All done.' }),
  ];
  writeFileSync(transcriptFile, lines.join('\n') + '\n');
  try {
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'test-session-123',
    };
    const res = onStop(payload, { env });
    assert.equal(res.decision, 'continue');
    assert.match(res.reason, /unverified file edits/);
  } finally {
    cleanup();
  }
});

test('onStop: rejects scalar null and string lines in transcript under enforcement', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  const lines = [
    'null',
    '12345',
    'true',
    JSON.stringify({ content: 'Thinking...' }),
  ];
  writeFileSync(transcriptFile, lines.join('\n') + '\n');
  try {
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'test-session-123',
    };
    const res = onStop(payload, { env });
    assert.equal(res.decision, 'continue');
    assert.match(res.reason, /Invalid or schema-corrupted transcript records/);
  } finally {
    cleanup();
  }
});

test('onStop: rejects echo or printf commands that mention test runners as strings', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  const lines = [
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'write_to_file', args: { TargetFile: 'src/app.js' } }],
    }),
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'run_command', args: { CommandLine: "echo 'npm test'" } }],
      exit_code: 0,
    }),
    JSON.stringify({ content: 'Finished.' }),
  ];
  writeFileSync(transcriptFile, lines.join('\n') + '\n');
  try {
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'test-session-123',
    };
    const res = onStop(payload, { env });
    assert.equal(res.decision, 'continue');
    assert.match(res.reason, /unverified file edits/);
  } finally {
    cleanup();
  }
});

test('onStop: recognizes camelCase toolCalls array from Antigravity transcripts', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  const lines = [
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      toolCalls: [{ name: 'run_command', args: { CommandLine: 'npm test', Cwd: root } }],
      exit_code: 0,
    }),
    JSON.stringify({ content: 'Finished. TICKET-DONE' }),
  ];
  writeFileSync(transcriptFile, lines.join('\n') + '\n');
  try {
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'test-session-123',
    };
    const res = onStop(payload, { env });
    assert.equal(res.decision, 'stop');
  } finally {
    cleanup();
  }
});

test('onStop: rejects chained test commands with shell operators like npm test || true', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  const lines = [
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'write_to_file', args: { TargetFile: 'src/app.js' } }],
    }),
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'npm test || true' } }],
      exit_code: 0,
    }),
    JSON.stringify({ content: 'Finished.' }),
  ];
  writeFileSync(transcriptFile, lines.join('\n') + '\n');
  try {
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'test-session-123',
    };
    const res = onStop(payload, { env });
    assert.equal(res.decision, 'continue');
    assert.match(res.reason, /unverified file edits/);
  } finally {
    cleanup();
  }
});

test('onStop: rejects test record with missing exit code or failure status', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  const lines = [
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'write_to_file', args: { TargetFile: 'src/app.js' } }],
    }),
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'npm test' } }],
      // No exit_code or status: 'DONE'
    }),
    JSON.stringify({ content: 'Finished.' }),
  ];
  writeFileSync(transcriptFile, lines.join('\n') + '\n');
  try {
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'test-session-123',
    };
    const res = onStop(payload, { env });
    assert.equal(res.decision, 'continue');
    assert.match(res.reason, /unverified file edits/);
  } finally {
    cleanup();
  }
});

test('onStop: rejects completion when file edits occur after the test run', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  const lines = [
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'npm test', Cwd: root } }],
      exit_code: 0,
    }),
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'write_to_file', args: { TargetFile: 'src/app.js' } }],
    }),
    JSON.stringify({ content: 'Finished. TICKET-DONE' }),
  ];
  writeFileSync(transcriptFile, lines.join('\n') + '\n');
  try {
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'test-session-edits-after-test',
    };
    const res = onStop(payload, { env });
    assert.equal(res.decision, 'continue');
    assert.match(res.reason, /File edits occurred after the last test run/);
  } finally {
    cleanup();
  }
});

test('onStop: rejects completion when active ticket is missing from ticket store', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1' });
  // Corrupt ticket store so active ticket T1 is missing
  writeFileSync(join(root, '.adlc', 'tickets.json'), JSON.stringify({ version: 1, tickets: [] }));
  const transcriptFile = join(root, 'transcript.jsonl');
  const lines = [
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'npm test' } }],
      exit_code: 0,
    }),
    JSON.stringify({ content: 'Finished. TICKET-DONE' }),
  ];
  writeFileSync(transcriptFile, lines.join('\n') + '\n');
  try {
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'test-session-ticket-missing',
    };
    const res = onStop(payload, { env });
    assert.equal(res.decision, 'continue');
    assert.match(res.reason, /not found in validated ticket store/);
  } finally {
    cleanup();
  }
});

test('onStop: rejects completion when an unrecognized path-bearing writer runs after tests', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  const lines = [
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'npm test', Cwd: root } }],
      exit_code: 0,
    }),
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'set_file_contents', args: { TargetFile: 'src/config.json' } }],
    }),
    JSON.stringify({ content: 'Finished. TICKET-DONE' }),
  ];
  writeFileSync(transcriptFile, lines.join('\n') + '\n');
  try {
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'test-session-unrecognized-writer',
    };
    const res = onStop(payload, { env });
    assert.equal(res.decision, 'continue');
    assert.match(res.reason, /File edits occurred after the last test run/);
  } finally {
    cleanup();
  }
});

test('onStop: resolves repo root via ANTIGRAVITY_WORKSPACE in headless mode with empty workspacePaths', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  const lines = [
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'npm test', Cwd: root } }],
      exit_code: 0,
    }),
    JSON.stringify({ content: 'Finished. TICKET-DONE' }),
  ];
  writeFileSync(transcriptFile, lines.join('\n') + '\n');
  try {
    const payload = {
      workspacePaths: [],
      transcriptPath: transcriptFile,
      conversationId: 'test-session-headless',
    };
    const res = onStop(payload, { env: { ...env, ANTIGRAVITY_WORKSPACE: root } });
    assert.equal(res.decision, 'stop');
  } finally {
    cleanup();
  }
});

test('onStop: fails closed when active ticket state has conflict', () => {
  const { root, env, cleanup } = setupTempRepo({ activeTicket: 'T1', enforcement: '1' });
  // Pass conflicting env variable ADLC_TICKET pointing to T2
  const transcriptFile = join(root, 'transcript.jsonl');
  const lines = [
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'npm test' } }],
      exit_code: 0,
    }),
    JSON.stringify({ content: 'Finished. TICKET-DONE' }),
  ];
  writeFileSync(transcriptFile, lines.join('\n') + '\n');
  try {
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'test-session-conflict',
    };
    const res = onStop(payload, { env: { ...env, ADLC_TICKET: 'T2' } });
    assert.equal(res.decision, 'continue');
    assert.match(res.reason, /Active ticket state conflict detected/);
  } finally {
    cleanup();
  }
});

test('onStop: tracks shell commands as mutations and requires tests', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  const lines = [
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'node build.js' } }],
      exit_code: 0,
    }),
    JSON.stringify({ content: 'Finished.' }),
  ];
  writeFileSync(transcriptFile, lines.join('\n') + '\n');
  try {
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'test-session-shell-mutation',
    };
    const res = onStop(payload, { env });
    assert.equal(res.decision, 'continue');
    assert.match(res.reason, /unverified file edits/);
  } finally {
    cleanup();
  }
});

test('onStop: fails closed under enforcement when workspace root is unresolvable', () => {
  const payload = {
    workspacePaths: [],
    transcriptPath: '/tmp/nonexistent.jsonl',
    conversationId: 'test-session-noroot',
  };
  const res = onStop(payload, { env: { ADLC_P4_ENFORCEMENT: '1', ANTIGRAVITY_WORKSPACE: undefined, INIT_CWD: undefined, PWD: '/nonexistent' } });
  assert.equal(res.decision, 'continue');
  assert.match(res.reason, /Repository workspace root cannot be resolved/);
});

test('onStop: rejects test runner using --prefix pointing to external directory', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  const lines = [
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'write_to_file', args: { TargetFile: 'src/app.js' } }],
    }),
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'npm test --prefix /tmp/other' } }],
      exit_code: 0,
    }),
    JSON.stringify({ content: 'Finished.' }),
  ];
  writeFileSync(transcriptFile, lines.join('\n') + '\n');
  try {
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'test-session-prefix',
    };
    const res = onStop(payload, { env });
    assert.equal(res.decision, 'continue');
    assert.match(res.reason, /unverified file edits/);
  } finally {
    cleanup();
  }
});

test('onStop: discovers repo root from transcript paths in headless mode with empty workspacePaths', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1' });
  const transcriptFile = join(tmpdir(), `headless-transcript-${Date.now()}.jsonl`);
  const lines = [
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'write_to_file', args: { TargetFile: join(root, 'src', 'app.js') } }],
    }),
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'npm test', Cwd: root } }],
      exit_code: 0,
    }),
    JSON.stringify({ content: 'Finished.' }),
  ];
  writeFileSync(transcriptFile, lines.join('\n') + '\n');
  try {
    const payload = {
      workspacePaths: [],
      transcriptPath: transcriptFile,
      conversationId: 'test-session-headless-discovery',
    };
    preInvocation({ ...payload, workspacePaths: [root] }, { env });
    const tracker = createPersistentTracker(root, env);
    tracker.recordToolCall(payload.conversationId, { isMutating: true });
    tracker.recordToolCall(payload.conversationId, { isMutating: false });
    const res = onStop(payload, { env: { ...env, ANTIGRAVITY_WORKSPACE: undefined, INIT_CWD: undefined, PWD: '/nonexistent' } });
    assert.equal(res.decision, 'stop');
  } finally {
    try { rmSync(transcriptFile, { force: true }); } catch (_) {}
    cleanup();
  }
});

test('onStop: rejects test runner specifying test file outside repo root', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  const lines = [
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'write_to_file', args: { TargetFile: 'src/app.js' } }],
    }),
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'node --test /tmp/external-pass.test.mjs' } }],
      exit_code: 0,
    }),
    JSON.stringify({ content: 'Finished.' }),
  ];
  writeFileSync(transcriptFile, lines.join('\n') + '\n');
  try {
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'test-session-external-test',
    };
    const res = onStop(payload, { env });
    assert.equal(res.decision, 'continue');
    assert.match(res.reason, /unverified file edits/);
  } finally {
    cleanup();
  }
});

test('onStop: detects early mutations in large transcripts exceeding standard scan window', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  // Write early mutation, followed by > 300 KiB of readonly padding
  const paddingLine = JSON.stringify({ type: 'PLANNER_RESPONSE', content: 'padding '.repeat(200) });
  const lines = [
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'write_to_file', args: { TargetFile: 'src/app.js' } }],
    }),
    ...Array(300).fill(paddingLine),
    JSON.stringify({ content: 'Finished.' }),
  ];
  writeFileSync(transcriptFile, lines.join('\n') + '\n');
  try {
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'test-session-large-transcript',
    };
    const res = onStop(payload, { env });
    assert.equal(res.decision, 'continue');
    assert.match(res.reason, /unverified file edits/);
  } finally {
    cleanup();
  }
});

test('onStop: rejects test runner specifying quoted test file outside repo root', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  const lines = [
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'write_to_file', args: { TargetFile: 'src/app.js' } }],
    }),
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'node --test "/tmp/external-pass.test.mjs"' } }],
      exit_code: 0,
    }),
    JSON.stringify({ content: 'Finished.' }),
  ];
  writeFileSync(transcriptFile, lines.join('\n') + '\n');
  try {
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'test-session-quoted-external-test',
    };
    const res = onStop(payload, { env });
    assert.equal(res.decision, 'continue');
    assert.match(res.reason, /unverified file edits/);
  } finally {
    cleanup();
  }
});

test('onStop: recognizes verification from alternate arguments envelope', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  const lines = [
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'write_to_file', args: { TargetFile: 'src/app.js' } }],
    }),
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'run_command', arguments: { CommandLine: 'npm test', Cwd: root } }],
      exit_code: 0,
    }),
    JSON.stringify({ content: 'Finished.' }),
  ];
  writeFileSync(transcriptFile, lines.join('\n') + '\n');
  try {
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'test-session-alt-envelope',
    };
    preInvocation(payload, { env });
    const tracker = createPersistentTracker(root, env);
    tracker.recordToolCall(payload.conversationId, { isMutating: true });
    tracker.recordToolCall(payload.conversationId, { isMutating: false });
    const res = onStop(payload, { env });
    assert.equal(res.decision, 'stop');
  } finally {
    cleanup();
  }
});

test('onStop: rejects newline-separated multi-commands in verification runner', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  const lines = [
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'write_to_file', args: { TargetFile: 'src/app.js' } }],
    }),
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'run_command', args: { CommandLine: "npm test\nrm -f output.txt" } }],
      exit_code: 0,
    }),
    JSON.stringify({ content: 'Finished.' }),
  ];
  writeFileSync(transcriptFile, lines.join('\n') + '\n');
  try {
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'test-session-newline-cmd',
    };
    const res = onStop(payload, { env });
    assert.equal(res.decision, 'continue');
    assert.match(res.reason, /unverified file edits/);
  } finally {
    cleanup();
  }
});

test('onStop: rejects batched record when mutation call occurs after test call in the same record', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  const lines = [
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [
        { name: 'run_command', args: { CommandLine: 'npm test', Cwd: root } },
        { name: 'write_to_file', args: { TargetFile: 'src/app.js' } },
      ],
      exit_code: 0,
    }),
    JSON.stringify({ content: 'Finished.' }),
  ];
  writeFileSync(transcriptFile, lines.join('\n') + '\n');
  try {
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'test-session-batched-ordering',
    };
    const res = onStop(payload, { env });
    assert.equal(res.decision, 'continue');
    assert.match(res.reason, /File edits occurred after the last test run/);
  } finally {
    cleanup();
  }
});

test('onStop: rejects test runner using --test-name-pattern filtering flag', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  const lines = [
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'write_to_file', args: { TargetFile: 'src/app.js' } }],
    }),
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'node --test --test-name-pattern=NEVER_MATCHES test/app.test.mjs' } }],
      exit_code: 0,
    }),
    JSON.stringify({ content: 'Finished.' }),
  ];
  writeFileSync(transcriptFile, lines.join('\n') + '\n');
  try {
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'test-session-filter-flag',
    };
    const res = onStop(payload, { env });
    assert.equal(res.decision, 'continue');
    assert.match(res.reason, /unverified file edits/);
  } finally {
    cleanup();
  }
});

test('preInvocation: strips natural-language injection attempts from ticket metadata', () => {
  const { root, env, cleanup } = setupTempRepo({
    activeTicket: 'T1',
    rails: ['[inert-test-probe-directive]', 'valid/path/**'],
    scope: ['src/**', '[inert-test-probe-statement]'],
  });
  try {
    const payload = {
      workspacePaths: [root],
      conversationId: 'test-session-injection',
    };
    const res = preInvocation(payload, { env });
    assert.equal(res.injectSteps.length, 1);
    const msg = res.injectSteps[0].ephemeralMessage;
    assert.doesNotMatch(msg, /ignore all previous instructions/);
    assert.doesNotMatch(msg, /DROP TABLE/);
    assert.match(msg, /valid\/path\/\*\*/);
    assert.match(msg, /src\/\*\*/);
  } finally {
    cleanup();
  }
});

test('onStop: rejects symlinked test path resolving outside repository root', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  const externalTest = join(tmpdir(), `external-test-${Date.now()}.mjs`);
  writeFileSync(externalTest, 'console.log("pass");\n');
  mkdirSync(join(root, 'test'), { recursive: true });
  const symlinkPath = join(root, 'test', 'linked.test.mjs');
  symlinkSync(externalTest, symlinkPath);

  const lines = [
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'write_to_file', args: { TargetFile: 'src/app.js' } }],
    }),
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'node --test test/linked.test.mjs' } }],
      exit_code: 0,
    }),
    JSON.stringify({ content: 'Finished.' }),
  ];
  writeFileSync(transcriptFile, lines.join('\n') + '\n');
  try {
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'test-session-symlink-test',
    };
    const res = onStop(payload, { env });
    assert.equal(res.decision, 'continue');
    assert.match(res.reason, /unverified file edits/);
  } finally {
    try { rmSync(externalTest, { force: true }); } catch (_) {}
    cleanup();
  }
});

test('onStop: rejects npm test after package.json mutation and requires immutable test runner', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  const lines = [
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'write_to_file', args: { TargetFile: 'package.json' } }],
    }),
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'npm test' } }],
      exit_code: 0,
    }),
    JSON.stringify({ content: 'Finished.' }),
  ];
  writeFileSync(transcriptFile, lines.join('\n') + '\n');
  try {
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'test-session-package-mutated',
    };
    const res = onStop(payload, { env });
    assert.equal(res.decision, 'continue');
    assert.match(res.reason, /unverified file edits/);
  } finally {
    cleanup();
  }
});

test('onStop: rejects /dev/null test path', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  const lines = [
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'write_to_file', args: { TargetFile: 'src/app.js' } }],
    }),
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'node --test /dev/null' } }],
      exit_code: 0,
    }),
    JSON.stringify({ content: 'Finished.' }),
  ];
  writeFileSync(transcriptFile, lines.join('\n') + '\n');
  try {
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'test-session-dev-null',
    };
    const res = onStop(payload, { env });
    assert.equal(res.decision, 'continue');
    assert.match(res.reason, /unverified file edits/);
  } finally {
    cleanup();
  }
});

test('onStop: rejects npm test after non-readonly shell command and requires immutable test runner', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  const lines = [
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'echo "hello" > generated.txt' } }],
    }),
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'npm test' } }],
      exit_code: 0,
    }),
    JSON.stringify({ content: 'Finished.' }),
  ];
  writeFileSync(transcriptFile, lines.join('\n') + '\n');
  try {
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'test-session-shell-mutation',
    };
    const res = onStop(payload, { env });
    assert.equal(res.decision, 'continue');
    assert.match(res.reason, /unverified file edits/);
  } finally {
    cleanup();
  }
});

test('onStop: fails closed on corrupted/unparseable transcript records under enforcement', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  const lines = [
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'write_to_file', args: { TargetFile: 'src/app.js' } }],
    }),
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'node --test' } }],
      exit_code: 0,
    }),
    '{ malformed json line without closing brace',
  ];
  writeFileSync(transcriptFile, lines.join('\n') + '\n');
  try {
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'test-session-corrupt-line',
    };
    const res = onStop(payload, { env });
    assert.equal(res.decision, 'continue');
    assert.match(res.reason, /Corrupted or unparseable transcript records/);
  } finally {
    cleanup();
  }
});

test('onStop: rejects quoted external test path containing spaces', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  const lines = [
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'write_to_file', args: { TargetFile: 'src/app.js' } }],
    }),
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'node --test "/tmp/external pass.test.mjs"' } }],
      exit_code: 0,
    }),
    JSON.stringify({ content: 'Finished.' }),
  ];
  writeFileSync(transcriptFile, lines.join('\n') + '\n');
  try {
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'test-session-quoted-space',
    };
    const res = onStop(payload, { env });
    assert.equal(res.decision, 'continue');
    assert.match(res.reason, /unverified file edits/);
  } finally {
    cleanup();
  }
});

test('onStop: treats git diff --output as mutation requiring verification', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  const lines = [
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'node --test', Cwd: root } }],
      exit_code: 0,
    }),
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'git diff --output=src/app.js' } }],
      exit_code: 0,
    }),
    JSON.stringify({ content: 'Finished.' }),
  ];
  writeFileSync(transcriptFile, lines.join('\n') + '\n');
  try {
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'test-session-git-diff-output',
    };
    const res = onStop(payload, { env });
    assert.equal(res.decision, 'continue');
    assert.match(res.reason, /File edits occurred after the last test run/);
  } finally {
    cleanup();
  }
});

test('onStop: rejects node --test with external --require option', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  const lines = [
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'write_to_file', args: { TargetFile: 'src/app.js' } }],
    }),
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'node --test --require=/tmp/evil.cjs' } }],
      exit_code: 0,
    }),
    JSON.stringify({ content: 'Finished.' }),
  ];
  writeFileSync(transcriptFile, lines.join('\n') + '\n');
  try {
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'test-session-require-flag',
    };
    const res = onStop(payload, { env });
    assert.equal(res.decision, 'continue');
    assert.match(res.reason, /unverified file edits/);
  } finally {
    cleanup();
  }
});

test('onStop: rejects bare unpinned npx mocha without --no-install', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  const lines = [
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'write_to_file', args: { TargetFile: 'src/app.js' } }],
    }),
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'npx mocha' } }],
      exit_code: 0,
    }),
    JSON.stringify({ content: 'Finished.' }),
  ];
  writeFileSync(transcriptFile, lines.join('\n') + '\n');
  try {
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'test-session-bare-npx',
    };
    const res = onStop(payload, { env });
    assert.equal(res.decision, 'continue');
    assert.match(res.reason, /unverified file edits/);
  } finally {
    cleanup();
  }
});

test('onStop: allows npx --no-install adlc preflight', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  const lines = [
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'write_to_file', args: { TargetFile: 'src/app.js' } }],
    }),
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'npx --no-install adlc preflight', Cwd: root } }],
      exit_code: 0,
    }),
    JSON.stringify({ content: 'Finished.' }),
  ];
  writeFileSync(transcriptFile, lines.join('\n') + '\n');
  try {
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'test-session-pinned-npx',
    };
    preInvocation(payload, { env });
    const tracker = createPersistentTracker(root, env);
    tracker.recordToolCall(payload.conversationId, { isMutating: true });
    tracker.recordToolCall(payload.conversationId, { isMutating: false });
    const res = onStop(payload, { env });
    assert.equal(res.decision, 'stop');
  } finally {
    cleanup();
  }
});

test('onStop: rejects npm test when package.json is mutated via AbsolutePath or FilePath', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  const lines = [
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'edit', args: { FilePath: join(root, 'package.json') } }],
    }),
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'npm test' } }],
      exit_code: 0,
    }),
    JSON.stringify({ content: 'Finished.' }),
  ];
  writeFileSync(transcriptFile, lines.join('\n') + '\n');
  try {
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'test-session-filepath-pkg',
    };
    const res = onStop(payload, { env });
    assert.equal(res.decision, 'continue');
    assert.match(res.reason, /unverified file edits/);
  } finally {
    cleanup();
  }
});

test('onStop: rejects node --test --test-shard=1/2 partial suite', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  const lines = [
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'write_to_file', args: { TargetFile: 'src/app.js' } }],
    }),
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'node --test --test-shard=1/2' } }],
      exit_code: 0,
    }),
    JSON.stringify({ content: 'Finished.' }),
  ];
  writeFileSync(transcriptFile, lines.join('\n') + '\n');
  try {
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'test-session-shard-flag',
    };
    const res = onStop(payload, { env });
    assert.equal(res.decision, 'continue');
    assert.match(res.reason, /unverified file edits/);
  } finally {
    cleanup();
  }
});

test('preInvocation: includes trust-root rails in frozen rails reminder', () => {
  const { root, env, cleanup } = setupTempRepo({
    activeTicket: 'T1',
    rails: ['src/app.js'],
  });
  try {
    const payload = {
      workspacePaths: [root],
      conversationId: 'test-session-trust-roots',
    };
    const res = preInvocation(payload, { env });
    assert.equal(res.injectSteps.length, 1);
    const msg = res.injectSteps[0].ephemeralMessage;
    assert.match(msg, /\.adlc\/tickets\.json/);
    assert.match(msg, /\.adlc\/current-ticket\.json/);
    assert.match(msg, /src\/app\.js/);
  } finally {
    cleanup();
  }
});

test('preInvocation: discovers repo root from transcript paths in headless mode with empty workspacePaths', () => {
  const { root, env, cleanup } = setupTempRepo({ activeTicket: 'T1' });
  const headlessTranscript = join(tmpdir(), `headless-preinv-transcript-${Date.now()}.jsonl`);
  const lines = [
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'view_file', args: { AbsolutePath: join(root, 'src/index.js') } }],
    }),
  ];
  writeFileSync(headlessTranscript, lines.join('\n') + '\n');
  try {
    const payload = {
      workspacePaths: [],
      transcriptPath: headlessTranscript,
      conversationId: 'test-session-headless-preinv',
    };
    const res = preInvocation(payload, { env: { ...env, ANTIGRAVITY_WORKSPACE: '' } });
    assert.equal(res.injectSteps.length, 1);
    assert.match(res.injectSteps[0].ephemeralMessage, /Active Ticket: T1/);
  } finally {
    try { rmSync(headlessTranscript, { force: true }); } catch (_) {}
    cleanup();
  }
});

test('onStop: rejects node --test --test-skip-pattern', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  const lines = [
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'write_to_file', args: { TargetFile: 'src/app.js' } }],
    }),
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'run_command', args: { CommandLine: "node --test --test-skip-pattern='.*'" } }],
      exit_code: 0,
    }),
    JSON.stringify({ content: 'Finished.' }),
  ];
  writeFileSync(transcriptFile, lines.join('\n') + '\n');
  try {
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'test-session-skip-flag',
    };
    const res = onStop(payload, { env });
    assert.equal(res.decision, 'continue');
    assert.match(res.reason, /unverified file edits/);
  } finally {
    cleanup();
  }
});

test('onStop: rejects tampering with transcript file', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  const lines = [
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'write_to_file', args: { TargetFile: transcriptFile } }],
    }),
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'node --test' } }],
      exit_code: 0,
    }),
    JSON.stringify({ content: 'Finished.' }),
  ];
  writeFileSync(transcriptFile, lines.join('\n') + '\n');
  try {
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'test-session-tamper',
    };
    const res = onStop(payload, { env });
    assert.equal(res.decision, 'continue');
    assert.match(res.reason, /Tampering with session transcript files is strictly prohibited/);
  } finally {
    cleanup();
  }
});

test('onStop: rejects node --test --test-reporter-destination', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  const lines = [
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'write_to_file', args: { TargetFile: 'src/app.js' } }],
    }),
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'node --test --test-reporter-destination=package.json' } }],
      exit_code: 0,
    }),
    JSON.stringify({ content: 'Finished.' }),
  ];
  writeFileSync(transcriptFile, lines.join('\n') + '\n');
  try {
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'test-session-dest-flag',
    };
    const res = onStop(payload, { env });
    assert.equal(res.decision, 'continue');
    assert.match(res.reason, /unverified file edits/);
  } finally {
    cleanup();
  }
});

test('onStop: recognizes tool_call and tool_name snake_case envelopes in transcript', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  const lines = [
    JSON.stringify({
      tool_call: {
        tool_name: 'write_to_file',
        args: { TargetFile: 'src/feature.js' },
      },
    }),
    JSON.stringify({
      tool_call: {
        tool_name: 'run_command',
        args: { CommandLine: 'node --test', Cwd: root },
      },
      exit_code: 0,
    }),
    JSON.stringify({ content: 'Finished.' }),
  ];
  writeFileSync(transcriptFile, lines.join('\n') + '\n');
  try {
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'test-session-snake-case',
    };
    preInvocation(payload, { env });
    const tracker = createPersistentTracker(root, env);
    tracker.recordToolCall(payload.conversationId, { isMutating: true });
    tracker.recordToolCall(payload.conversationId, { isMutating: false });
    const res = onStop(payload, { env });
    assert.equal(res.decision, 'stop');
  } finally {
    cleanup();
  }
});

test('onStop: recognizes nested payload.toolCall envelope in transcript and requires verification', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  const lines = [
    JSON.stringify({
      payload: {
        toolCall: {
          name: 'write_to_file',
          args: { TargetFile: 'src/app.js' },
        },
      },
    }),
    JSON.stringify({ content: 'Finished without tests.' }),
  ];
  writeFileSync(transcriptFile, lines.join('\n') + '\n');
  try {
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'test-session-nested-payload',
    };
    const res = onStop(payload, { env });
    assert.equal(res.decision, 'continue');
    assert.match(res.reason, /unverified file edits/);
  } finally {
    cleanup();
  }
});

test('onStop: rejects arbitrary node scripts/test/ script as verification runner', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  const lines = [
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'write_to_file', args: { TargetFile: 'src/app.js' } }],
    }),
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'node scripts/test/claim.mjs' } }],
      exit_code: 0,
    }),
    JSON.stringify({ content: 'Finished.' }),
  ];
  writeFileSync(transcriptFile, lines.join('\n') + '\n');
  try {
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'test-session-arbitrary-script',
    };
    const res = onStop(payload, { env });
    assert.equal(res.decision, 'continue');
    assert.match(res.reason, /unverified file edits/);
  } finally {
    cleanup();
  }
});

test('onStop: rejects symlinked transcript files', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1' });
  const realTranscript = join(root, 'real_transcript.jsonl');
  const symlinkTranscript = join(root, 'symlink_transcript.jsonl');
  writeFileSync(realTranscript, JSON.stringify({ content: 'test' }) + '\n');
  try {
    symlinkSync(realTranscript, symlinkTranscript);
    const payload = {
      workspacePaths: [root],
      transcriptPath: symlinkTranscript,
      conversationId: 'test-session-symlink-transcript',
    };
    const res = onStop(payload, { env });
    assert.equal(res.decision, 'continue');
    assert.match(res.reason, /Session transcript is missing or unreadable/);
  } finally {
    try { unlinkSync(symlinkTranscript); } catch (_) {}
    cleanup();
  }
});

test('onStop: rejects modification to .adlc trust-root files during session', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  const lines = [
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'write_to_file', args: { TargetFile: '.adlc/tickets.json' } }],
    }),
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'node --test' } }],
      exit_code: 0,
    }),
    JSON.stringify({ content: 'Finished.' }),
  ];
  writeFileSync(transcriptFile, lines.join('\n') + '\n');
  try {
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'test-session-trust-root-mod',
    };
    const res = onStop(payload, { env });
    assert.equal(res.decision, 'continue');
    assert.match(res.reason, /Active ticket contract or trust-root store was modified/);
  } finally {
    cleanup();
  }
});

test('onStop: fails closed when active ticket pointer hash mismatches store', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1' });
  writeFileSync(join(root, '.adlc/current-ticket.json'), JSON.stringify({
    id: 'T1',
    ticketHash: '0000000000000000000000000000000000000000000000000000000000000000',
  }, null, 2));
  const transcriptFile = join(root, 'transcript.jsonl');
  writeFileSync(transcriptFile, JSON.stringify({ content: 'Clean run' }) + '\n');
  try {
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'test-session-hash-mismatch',
    };
    const res = onStop(payload, { env });
    assert.equal(res.decision, 'continue');
    assert.match(res.reason, /Active ticket hash mismatch/);
  } finally {
    cleanup();
  }
});

test('onStop: rejects shell modification of trust-root store or transcript', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  const lines = [
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'printf "{}" > .adlc/tickets.json' } }],
    }),
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'node --test' } }],
      exit_code: 0,
    }),
    JSON.stringify({ content: 'Finished.' }),
  ];
  writeFileSync(transcriptFile, lines.join('\n') + '\n');
  try {
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'test-session-shell-adlc-mod',
    };
    const res = onStop(payload, { env });
    assert.equal(res.decision, 'continue');
    assert.match(res.reason, /Shell modification of trust-root store or transcript is strictly prohibited/);
  } finally {
    cleanup();
  }
});

test('onStop: rejects bare node --test when CWD is a subdirectory inside repo', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1' });
  const subDir = join(root, 'empty-sub');
  mkdirSync(subDir, { recursive: true });
  const transcriptFile = join(root, 'transcript.jsonl');
  const lines = [
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'write_to_file', args: { TargetFile: 'src/app.js' } }],
    }),
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'node --test', Cwd: subDir } }],
      exit_code: 0,
    }),
    JSON.stringify({ content: 'Finished.' }),
  ];
  writeFileSync(transcriptFile, lines.join('\n') + '\n');
  try {
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'test-session-subdir-test',
    };
    const res = onStop(payload, { env });
    assert.equal(res.decision, 'continue');
    assert.match(res.reason, /unverified file edits/);
  } finally {
    cleanup();
  }
});

test('onStop: rejects bare node --test when Cwd is omitted', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  const lines = [
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'write_to_file', args: { TargetFile: 'src/app.js' } }],
    }),
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'node --test' } }],
      exit_code: 0,
    }),
    JSON.stringify({ content: 'Finished.' }),
  ];
  writeFileSync(transcriptFile, lines.join('\n') + '\n');
  try {
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'test-session-omitted-cwd',
    };
    const res = onStop(payload, { env });
    assert.equal(res.decision, 'continue');
    assert.match(res.reason, /unverified file edits/);
  } finally {
    cleanup();
  }
});

test('onStop: rejects stopping when active ticket is deleted while unverified mutations exist', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1' });
  // Remove current-ticket pointer to simulate deletion
  rmSync(join(root, '.adlc/current-ticket.json'), { force: true });
  const transcriptFile = join(root, 'transcript.jsonl');
  const lines = [
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'write_to_file', args: { TargetFile: 'src/app.js' } }],
    }),
    JSON.stringify({ content: 'Finished.' }),
  ];
  writeFileSync(transcriptFile, lines.join('\n') + '\n');
  try {
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'test-session-deleted-pointer',
    };
    const res = onStop(payload, { env: { ...env, ADLC_TICKET: '' } });
    assert.equal(res.decision, 'continue');
    assert.match(res.reason, /Active ticket is missing while unverified edits exist/);
  } finally {
    cleanup();
  }
});

test('onStop: rejects node --test --test-global-setup', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  const lines = [
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'write_to_file', args: { TargetFile: 'src/app.js' } }],
    }),
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'node --test --test-global-setup=setup.mjs', Cwd: root } }],
      exit_code: 0,
    }),
    JSON.stringify({ content: 'Finished.' }),
  ];
  writeFileSync(transcriptFile, lines.join('\n') + '\n');
  try {
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'test-session-global-setup',
    };
    const res = onStop(payload, { env });
    assert.equal(res.decision, 'continue');
    assert.match(res.reason, /unverified file edits/);
  } finally {
    cleanup();
  }
});

test('onStop: detects early mutation in large multi-chunk streaming transcript', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  const lines = [
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'write_to_file', args: { TargetFile: 'src/app.js' } }],
    }),
  ];
  // Add 1000 filler lines (~200 KiB to exceed standard single chunk)
  const filler = JSON.stringify({ type: 'USER_INPUT', content: 'x'.repeat(200) });
  for (let i = 0; i < 1000; i++) {
    lines.push(filler);
  }
  lines.push(JSON.stringify({ content: 'Finished without tests.' }));
  writeFileSync(transcriptFile, lines.join('\n') + '\n');
  try {
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'test-session-streaming-chunks',
    };
    const res = onStop(payload, { env });
    assert.equal(res.decision, 'continue');
    assert.match(res.reason, /unverified file edits/);
  } finally {
    cleanup();
  }
});

test('onStop: recognizes bash / execute_command as shell tool and rejects edit after test', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  const lines = [
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'node --test', Cwd: root } }],
      exit_code: 0,
    }),
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'bash', args: { command: 'echo "mutate" > src/app.js' } }],
      exit_code: 0,
    }),
    JSON.stringify({ content: 'Finished.' }),
  ];
  writeFileSync(transcriptFile, lines.join('\n') + '\n');
  try {
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'test-session-bash-tool',
    };
    const res = onStop(payload, { env });
    assert.equal(res.decision, 'continue');
    assert.match(res.reason, /File edits occurred after the last test run/);
  } finally {
    cleanup();
  }
});

test('onStop: rejects shell assignment variable tampering with .adlc', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  const lines = [
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'p=.adlc/tickets.json; printf "{}" > "$p"' } }],
    }),
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'node --test', Cwd: root } }],
      exit_code: 0,
    }),
    JSON.stringify({ content: 'Finished.' }),
  ];
  writeFileSync(transcriptFile, lines.join('\n') + '\n');
  try {
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'test-session-shell-var-adlc',
    };
    const res = onStop(payload, { env });
    assert.equal(res.decision, 'continue');
    assert.match(res.reason, /Shell modification of trust-root store or transcript is strictly prohibited/);
  } finally {
    cleanup();
  }
});

test('onStop: rejects node --test ~/pass.test.mjs tilde expansion', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  const lines = [
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'write_to_file', args: { TargetFile: 'src/app.js' } }],
    }),
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'node --test ~/pass.test.mjs', Cwd: root } }],
      exit_code: 0,
    }),
    JSON.stringify({ content: 'Finished.' }),
  ];
  writeFileSync(transcriptFile, lines.join('\n') + '\n');
  try {
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'test-session-tilde-path',
    };
    const res = onStop(payload, { env });
    assert.equal(res.decision, 'continue');
    assert.match(res.reason, /unverified file edits/);
  } finally {
    cleanup();
  }
});

test('onStop: rejects npx --no-install adlc after shell mutation and requires node --test', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  const lines = [
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'echo "hello" > src/app.js' } }],
      exit_code: 0,
    }),
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'npx --no-install adlc preflight' } }],
      exit_code: 0,
    }),
    JSON.stringify({ content: 'Finished.' }),
  ];
  writeFileSync(transcriptFile, lines.join('\n') + '\n');
  try {
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'test-session-shell-mutated-npx',
    };
    const res = onStop(payload, { env });
    assert.equal(res.decision, 'continue');
    assert.match(res.reason, /unverified file edits/);
  } finally {
    cleanup();
  }
});

test('onStop: treats opaque unclassified tool as mutating and requires verification', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  const lines = [
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'workspace_transform', args: { transformation: 'apply' } }],
    }),
    JSON.stringify({ content: 'Finished.' }),
  ];
  writeFileSync(transcriptFile, lines.join('\n') + '\n');
  try {
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'test-session-opaque-writer',
    };
    const res = onStop(payload, { env });
    assert.equal(res.decision, 'continue');
    assert.match(res.reason, /unverified file edits/);
  } finally {
    cleanup();
  }
});

test('onStop: rejects unterminated oversized line exceeding limit', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  // Write 1.5 MiB single line without newline
  writeFileSync(transcriptFile, '{"content":"' + 'a'.repeat(1500000) + '"}');
  try {
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'test-session-unterminated-huge',
    };
    const res = onStop(payload, { env });
    assert.equal(res.decision, 'continue');
    assert.match(res.reason, /Session transcript exceeds maximum supported size/);
  } finally {
    cleanup();
  }
});

test('onStop: rejects isolated single test file and requires full test suite', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  const lines = [
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'write_to_file', args: { TargetFile: 'src/core.js' } }],
    }),
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'node --test test/unrelated.test.mjs', Cwd: root } }],
      exit_code: 0,
    }),
    JSON.stringify({ content: 'Finished.' }),
  ];
  writeFileSync(transcriptFile, lines.join('\n') + '\n');
  try {
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'test-session-single-test-file',
    };
    const res = onStop(payload, { env });
    assert.equal(res.decision, 'continue');
    assert.match(res.reason, /unverified file edits/);
  } finally {
    cleanup();
  }
});

test('onStop: rejects opaque mutator modifying .adlc via unrecognized key', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  const lines = [
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'custom_writer', args: { dest_file: '.adlc/tickets.json', data: '{}' } }],
    }),
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'node --test', Cwd: root } }],
      exit_code: 0,
    }),
    JSON.stringify({ content: 'Finished.' }),
  ];
  writeFileSync(transcriptFile, lines.join('\n') + '\n');
  try {
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'test-session-opaque-adlc-tamper',
    };
    const res = onStop(payload, { env });
    assert.equal(res.decision, 'continue');
    assert.match(res.reason, /Active ticket contract or trust-root store was modified/);
  } finally {
    cleanup();
  }
});

test('onStop: rejects node --test test/ when Cwd is omitted', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  const lines = [
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'write_to_file', args: { TargetFile: 'src/core.js' } }],
    }),
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'node --test test/' } }],
      exit_code: 0,
    }),
    JSON.stringify({ content: 'Finished.' }),
  ];
  writeFileSync(transcriptFile, lines.join('\n') + '\n');
  try {
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'test-session-node-test-no-cwd',
    };
    const res = onStop(payload, { env });
    assert.equal(res.decision, 'continue');
    assert.match(res.reason, /unverified file edits/);
  } finally {
    cleanup();
  }
});

test('onStop: rejects npm test when Cwd is omitted', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  const lines = [
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'write_to_file', args: { TargetFile: 'src/core.js' } }],
    }),
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'npm test' } }],
      exit_code: 0,
    }),
    JSON.stringify({ content: 'Finished.' }),
  ];
  writeFileSync(transcriptFile, lines.join('\n') + '\n');
  try {
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'test-session-npm-test-no-cwd',
    };
    const res = onStop(payload, { env });
    assert.equal(res.decision, 'continue');
    assert.match(res.reason, /unverified file edits/);
  } finally {
    cleanup();
  }
});

test('onStop: rejects npm test with forwarded filter args like npm test -- -t foo', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  const lines = [
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'write_to_file', args: { TargetFile: 'src/core.js' } }],
    }),
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'npm test -- -t "specific test"', Cwd: root } }],
      exit_code: 0,
    }),
    JSON.stringify({ content: 'Finished.' }),
  ];
  writeFileSync(transcriptFile, lines.join('\n') + '\n');
  try {
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'test-session-npm-test-forwarded',
    };
    const res = onStop(payload, { env });
    assert.equal(res.decision, 'continue');
    assert.match(res.reason, /unverified file edits/);
  } finally {
    cleanup();
  }
});

test('onStop: rejects command substitution in shell tool and marks mutation', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  const lines = [
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'node --test', Cwd: root } }],
      exit_code: 0,
    }),
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'cat $(sed -i "s/old/new/" src/app.js) /dev/null', Cwd: root } }],
      exit_code: 0,
    }),
    JSON.stringify({ content: 'Finished.' }),
  ];
  writeFileSync(transcriptFile, lines.join('\n') + '\n');
  try {
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'test-session-cmd-substitution',
    };
    const res = onStop(payload, { env });
    assert.equal(res.decision, 'continue');
    assert.match(res.reason, /File edits occurred after the last test run/);
  } finally {
    cleanup();
  }
});

test('onStop: rejects npm test --workspace=@adlc/core', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  const lines = [
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'write_to_file', args: { TargetFile: 'src/core.js' } }],
    }),
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'npm test --workspace=@adlc/core', Cwd: root } }],
      exit_code: 0,
    }),
    JSON.stringify({ content: 'Finished.' }),
  ];
  writeFileSync(transcriptFile, lines.join('\n') + '\n');
  try {
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'test-session-npm-workspace',
    };
    const res = onStop(payload, { env });
    assert.equal(res.decision, 'continue');
    assert.match(res.reason, /unverified file edits/);
  } finally {
    cleanup();
  }
});

test('onStop: rejects completion when shell indirectly removes .adlc/tickets.json before tests', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1' });
  // Indirectly remove .adlc/tickets.json
  rmSync(join(root, '.adlc', 'tickets.json'), { force: true });
  const transcriptFile = join(root, 'transcript.jsonl');
  const lines = [
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'touch build.log', Cwd: root } }],
      exit_code: 0,
    }),
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'node --test', Cwd: root } }],
      exit_code: 0,
    }),
    JSON.stringify({ content: 'Finished.' }),
  ];
  writeFileSync(transcriptFile, lines.join('\n') + '\n');
  try {
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'test-session-shell-indirect-remove',
    };
    const res = onStop(payload, { env });
    assert.equal(res.decision, 'continue');
    assert.match(res.reason, /Repository workspace root cannot be resolved|Corrupt or unreadable ticket store|Trust-root files were corrupted/);
  } finally {
    cleanup();
  }
});

test('onStop: rejects untrusted arbitrary path with non-transcript filename in transcriptPath', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1' });
  const bogusFile = join(root, 'bogus-notes.txt');
  writeFileSync(bogusFile, '{"content":"fake"}');
  try {
    const payload = {
      workspacePaths: [root],
      transcriptPath: bogusFile,
      conversationId: 'test-session-bogus-file',
    };
    const res = onStop(payload, { env });
    assert.equal(res.decision, 'continue');
    assert.match(res.reason, /Session transcript is missing or unreadable/);
  } finally {
    cleanup();
  }
});

test('onStop: allows sharded store after non-verification shell command and successful test', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1' });
  // Migrate to sharded store layout
  const ticketsDir = join(root, '.adlc', 'tickets');
  mkdirSync(ticketsDir, { recursive: true });
  writeFileSync(join(ticketsDir, '.store.json'), JSON.stringify({
    format: 'adlc-ticket-directory',
    version: 1,
  }));
  const t1 = { id: 'T1', title: 'Ticket 1', status: 'open', rails: ['rail1'] };
  writeFileSync(join(ticketsDir, ticketFilename(t1.id)), JSON.stringify(t1));
  rmSync(join(root, '.adlc', 'tickets.json'), { force: true });

  const transcriptFile = join(root, 'transcript.jsonl');
  const lines = [
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'echo "building"', Cwd: root } }],
      exit_code: 0,
    }),
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'node --test', Cwd: root } }],
      exit_code: 0,
    }),
    JSON.stringify({ content: 'Finished.' }),
  ];
  writeFileSync(transcriptFile, lines.join('\n') + '\n');
  try {
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'test-session-sharded-shell',
    };
    const res = onStop(payload, { env });
    assert.equal(res.decision, 'stop');
  } finally {
    cleanup();
  }
});

test('onStop: rejects obfuscated shell mutation that corrupts ticket store contract', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1' });
  // Corrupt ticket store via invalid contract
  writeFileSync(join(root, '.adlc', 'tickets.json'), JSON.stringify({ version: 1, tickets: [{ id: 'T1', title: '' }] }));
  const transcriptFile = join(root, 'transcript.jsonl');
  const lines = [
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'touch /tmp/build.log', Cwd: root } }],
      exit_code: 0,
    }),
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'node --test', Cwd: root } }],
      exit_code: 0,
    }),
    JSON.stringify({ content: 'Finished.' }),
  ];
  writeFileSync(transcriptFile, lines.join('\n') + '\n');
  try {
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'test-session-obfuscated-tamper',
    };
    const res = onStop(payload, { env });
    assert.equal(res.decision, 'continue');
    assert.match(res.reason, /Corrupt or unreadable ticket store/);
  } finally {
    cleanup();
  }
});

test('findAdlcRoot: does not stop at nested empty .adlc directory and finds true root', () => {
  const { root, cleanup } = setupTempRepo();
  const nestedDir = join(root, 'src', 'subdir');
  const nestedAdlc = join(nestedDir, '.adlc');
  mkdirSync(nestedAdlc, { recursive: true });
  try {
    const found = findAdlcRoot(join(nestedDir, 'file.js'));
    assert.equal(found, root);
  } finally {
    cleanup();
  }
});

test('onStop: rejects mid-session active ticket pointer change', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1' });
  // Add T2 to ticket store
  const t2 = { id: 'T2', title: 'Ticket 2', status: 'open', rails: [] };
  const storeRaw = readFileSync(join(root, '.adlc', 'tickets.json'), 'utf8');
  const store = JSON.parse(storeRaw);
  store.tickets.push(t2);
  writeFileSync(join(root, '.adlc', 'tickets.json'), JSON.stringify(store));

  const transcriptFile = join(root, 'transcript.jsonl');
  const lines = [
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'node --test', Cwd: root } }],
      exit_code: 0,
    }),
    JSON.stringify({ content: 'Finished.' }),
  ];
  writeFileSync(transcriptFile, lines.join('\n') + '\n');
  try {
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'test-session-pointer-switch',
    };
    // Initialize session state with active ticket T1
    preInvocation(payload, { env });
    // Switch active ticket pointer mid-session
    writeFileSync(join(root, '.adlc', 'current-ticket.json'), JSON.stringify({ id: 'T2' }));
    const res = onStop(payload, { env });
    assert.equal(res.decision, 'continue');
    assert.match(res.reason, /Active ticket ID changed from T1 to T2/);
  } finally {
    cleanup();
  }
});

test('onStop: resolves transcript using ADLC_SESSION_ID when payload omits conversationId', () => {
  const cid = `session-env-${Date.now()}`;
  const appDataDir = join(tmpdir(), `adlc-brain-${Date.now()}`);
  const brainDir = join(appDataDir, 'brain', cid, '.system_generated', 'logs');
  mkdirSync(brainDir, { recursive: true });
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1' });
  const transcriptFile = join(brainDir, 'transcript.jsonl');
  const lines = [
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'node --test', Cwd: root } }],
      exit_code: 0,
    }),
    JSON.stringify({ content: 'Finished.' }),
  ];
  writeFileSync(transcriptFile, lines.join('\n') + '\n');
  try {
    const payload = {
      workspacePaths: [root],
    };
    const res = onStop(payload, { env: { ...env, ADLC_SESSION_ID: cid, ANTIGRAVITY_APP_DATA_DIR: appDataDir } });
    assert.equal(res.decision, 'stop');
  } finally {
    try { rmSync(appDataDir, { recursive: true, force: true }); } catch (_) {}
    cleanup();
  }
});

test('onStop: rejects Stop when transcript file is replaced with a different inode', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  const lines = [
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'node --test', Cwd: root } }],
      exit_code: 0,
    }),
    JSON.stringify({ content: 'Finished.' }),
  ];
  writeFileSync(transcriptFile, lines.join('\n') + '\n');
  try {
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'test-session-inode-tamper',
    };
    // Initialize session state with original transcript
    preInvocation(payload, { env });

    // Recreate transcript file with a new inode
    rmSync(transcriptFile, { force: true });
    writeFileSync(transcriptFile, lines.join('\n') + '\n');

    const res = onStop(payload, { env });
    assert.equal(res.decision, 'continue');
    assert.match(res.reason, /Session transcript file identity \(inode\/device\) changed/);
  } finally {
    cleanup();
  }
});

test('onStop: rejects Stop when transcript file shrinks in size (in-place truncation)', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  const longLines = [
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'write_to_file', args: { TargetFile: join(root, 'src/app.js') } }],
    }),
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'node --test', Cwd: root } }],
      exit_code: 0,
    }),
    JSON.stringify({ content: 'Finished with extensive notes and explanations.' }),
  ];
  writeFileSync(transcriptFile, longLines.join('\n') + '\n');
  try {
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'test-session-shrink-tamper',
    };
    // Initialize session state with full transcript
    preInvocation(payload, { env });

    // Truncate file in place
    writeFileSync(transcriptFile, '{"type":"PLANNER_RESPONSE"}\n');

    const res = onStop(payload, { env });
    assert.equal(res.decision, 'continue');
    assert.match(res.reason, /Session transcript file size shrank/);
  } finally {
    cleanup();
  }
});

test('onStop: rejects Stop when transcript prefix content is rewritten in place without changing file size', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  const record1 = JSON.stringify({
    type: 'PLANNER_RESPONSE',
    tool_calls: [{ name: 'write_to_file', args: { TargetFile: join(root, 'src/app.js') } }],
  });
  const record2 = JSON.stringify({
    type: 'PLANNER_RESPONSE',
    tool_calls: [{ name: 'run_command', args: { CommandLine: 'node --test', Cwd: root } }],
    exit_code: 0,
  });
  const initialContent = `${record1}\n${record2}\n`;
  writeFileSync(transcriptFile, initialContent);
  try {
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'test-session-prefix-tamper',
    };
    // Initialize session state with initial prefix
    preInvocation(payload, { env });

    // Rewrite transcript with different prefix but pad to exact same byte length
    const forgedRecord1 = JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'view_file', args: { AbsolutePath: join(root, 'src/app.js') } }],
    });
    let forgedContent = `${forgedRecord1}\n${record2}\n`;
    if (forgedContent.length < initialContent.length) {
      forgedContent = forgedContent + ' '.repeat(initialContent.length - forgedContent.length);
    }
    writeFileSync(transcriptFile, forgedContent);

    const res = onStop(payload, { env });
    assert.equal(res.decision, 'continue');
    assert.match(res.reason, /Session transcript prefix content was modified/);
  } finally {
    cleanup();
  }
});

test('readTranscriptPrefixBounded: reads and hashes up to maxBytes prefix cleanly', () => {
  const { root, cleanup } = setupTempRepo();
  const testFile = join(root, 'test-prefix.txt');
  writeFileSync(testFile, 'Hello World! Bounded prefix reading test content.');
  try {
    const { prefixHash, prefixLength } = readTranscriptPrefixBounded(testFile, 12);
    assert.equal(prefixLength, 12);
    assert.ok(prefixHash && typeof prefixHash === 'string');
  } finally {
    cleanup();
  }
});

test('computePrefixHash: correctly hashes multi-chunk streaming files', () => {
  const { root, cleanup } = setupTempRepo();
  const testFile = join(root, 'test-chunk.txt');
  // Create 128KB file to cross 64KB chunk boundary
  const chunkData = 'A'.repeat(64 * 1024) + 'B'.repeat(64 * 1024);
  writeFileSync(testFile, chunkData);
  try {
    const hash = computePrefixHash(testFile, chunkData.length);
    assert.ok(hash && typeof hash === 'string');
    const prefixHash = computePrefixHash(testFile, 64 * 1024);
    assert.ok(prefixHash && prefixHash !== hash);
  } finally {
    cleanup();
  }
});

test('onStop: rejects Stop when .adlc/sessions.json file is corrupted', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  const lines = [
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'node --test', Cwd: root } }],
      exit_code: 0,
    }),
    JSON.stringify({ content: 'Finished.' }),
  ];
  writeFileSync(transcriptFile, lines.join('\n') + '\n');
  try {
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'test-session-sessions-tamper',
    };
    preInvocation(payload, { env });

    // Corrupt .adlc/sessions.json
    const sessionsFile = join(root, '.adlc', 'sessions.json');
    writeFileSync(sessionsFile, '{ corrupted json');

    const res = onStop(payload, { env });
    assert.equal(res.decision, 'continue');
    assert.match(res.reason, /Session tracking store was corrupted or unreadable|Session baseline signature mismatch/);
  } finally {
    cleanup();
  }
});

test('onStop: rejects Stop when .adlc/sessions.json file is completely deleted mid-session', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  const lines = [
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'touch build.log', Cwd: root } }],
      exit_code: 0,
    }),
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'node --test', Cwd: root } }],
      exit_code: 0,
    }),
    JSON.stringify({ content: 'Finished.' }),
  ];
  writeFileSync(transcriptFile, lines.join('\n') + '\n');
  try {
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'test-session-deleted-sessions-file',
    };
    preInvocation(payload, { env });

    // Completely delete .adlc/sessions.json
    rmSync(join(root, '.adlc', 'sessions.json'), { force: true });

    const res = onStop(payload, { env });
    assert.equal(res.decision, 'continue');
    assert.match(res.reason, /Session tracking store was missing or deleted|Session baseline signature mismatch|Untracked tool execution records/);
  } finally {
    cleanup();
  }
});

test('onStop: rejects Stop when transcript contains untracked injected tool calls', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  // Initial 1 tool call recorded
  const initialLine = JSON.stringify({
    type: 'PLANNER_RESPONSE',
    tool_calls: [{ name: 'view_file', args: { AbsolutePath: join(root, 'src/feature/app.js') } }],
  });
  writeFileSync(transcriptFile, initialLine + '\n');
  try {
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'test-session-injected-tools',
    };
    preInvocation(payload, { env });
    const tracker = createPersistentTracker(root, env);
    tracker.recordToolCall('test-session-injected-tools', { isMutating: true });

    // Host recorded mutating depth: 1
    // Now inject multiple fake mutating tool calls into transcript that never ran via PreToolUse
    const forgedLines = [
      initialLine,
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        tool_calls: [{ name: 'write_to_file', args: { TargetFile: join(root, 'src/feature/app.js') } }],
      }),
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        tool_calls: [{ name: 'write_to_file', args: { TargetFile: join(root, 'src/feature/other.js') } }],
      }),
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        tool_calls: [{ name: 'run_command', args: { CommandLine: 'node --test', Cwd: root } }],
        exit_code: 0,
      }),
    ];
    writeFileSync(transcriptFile, forgedLines.join('\n') + '\n');

    const res = onStop(payload, { env });
    assert.equal(res.decision, 'continue');
    assert.match(res.reason, /Untracked or missing tool execution records detected in transcript/);
  } finally {
    cleanup();
  }
});

test('onStop: rejects Stop when transcript omits mutating tool calls recorded by host', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  const lines = [
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'node --test', Cwd: root } }],
      exit_code: 0,
    }),
    JSON.stringify({ content: 'Finished.' }),
  ];
  writeFileSync(transcriptFile, lines.join('\n') + '\n');
  try {
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'test-session-omitted-mutations',
    };
    preInvocation(payload, { env });
    const tracker = createPersistentTracker(root, env);
    // Host recorded 2 mutating calls, but transcript omitted them
    tracker.recordToolCall('test-session-omitted-mutations', { isMutating: true });
    tracker.recordToolCall('test-session-omitted-mutations', { isMutating: true });

    const res = onStop(payload, { env });
    assert.equal(res.decision, 'continue');
    assert.match(res.reason, /Untracked or missing tool execution records detected in transcript/);
  } finally {
    cleanup();
  }
});

test('onStop: rejects Stop when .adlc/sessions.json session entry is wiped to empty object', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  const lines = [
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'node --test', Cwd: root } }],
      exit_code: 0,
    }),
    JSON.stringify({ content: 'Finished.' }),
  ];
  writeFileSync(transcriptFile, lines.join('\n') + '\n');
  try {
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'test-session-wipe-entry',
    };
    preInvocation(payload, { env });

    // Wipe sessions.json session entry to empty object
    const sessionsFile = join(root, '.adlc', 'sessions.json');
    writeFileSync(sessionsFile, JSON.stringify({ 'test-session-wipe-entry': {} }));

    const res = onStop(payload, { env });
    assert.equal(res.decision, 'continue');
    assert.match(res.reason, /Session baseline signature mismatch|Session tracking entry was deleted, reset, or modified/);
  } finally {
    cleanup();
  }
});

test('onStop: allows Stop when readonly, mutating, and shell calls run through runFromStdin with successful test', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  const lines = [
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'view_file', args: { AbsolutePath: join(root, 'src/feature/app.js') } }],
    }),
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'write_to_file', args: { TargetFile: join(root, 'src/feature/app.js') } }],
    }),
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'node --test', Cwd: root } }],
      exit_code: 0,
    }),
    JSON.stringify({ content: 'Finished.' }),
  ];
  writeFileSync(transcriptFile, lines.join('\n') + '\n');
  try {
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'test-session-mixed-tools',
    };
    preInvocation(payload, { env });
    const tracker = createPersistentTracker(root, env);
    tracker.recordToolCall('test-session-mixed-tools', { isMutating: false });
    tracker.recordToolCall('test-session-mixed-tools', { isMutating: true });
    tracker.recordToolCall('test-session-mixed-tools', { isMutating: false });
    tracker.recordTranscript('test-session-mixed-tools', transcriptFile);

    const res = onStop(payload, { env });
    assert.equal(res.decision, 'stop');
  } finally {
    cleanup();
  }
});

test('onStop: rejects Stop when transcript suffix is modified after last tool call', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  const initialLine = JSON.stringify({
    type: 'PLANNER_RESPONSE',
    tool_calls: [{ name: 'write_to_file', args: { TargetFile: join(root, 'src/feature/app.js') } }],
  });
  writeFileSync(transcriptFile, initialLine + '\n');
  try {
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'test-session-suffix-tamper',
    };
    preInvocation(payload, { env });
    const tracker = createPersistentTracker(root, env);
    tracker.recordTranscript('test-session-suffix-tamper', transcriptFile);

    // Now tamper with the transcript suffix (replacing write with something else while keeping same length)
    const tamperedLine = JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'view_file_tampered', args: { AbsolutePath: join(root, 'src/feature/app.js') } }],
    }).padEnd(initialLine.length, ' ');
    writeFileSync(transcriptFile, tamperedLine + '\n');

    const res = onStop(payload, { env });
    assert.equal(res.decision, 'continue');
    assert.match(res.reason, /Session transcript (prefix )?content was modified/);
  } finally {
    cleanup();
  }
});

test('computePrefixHash: bounds hashing to MAX_TRANSCRIPT_HASH_BYTES on large multi-megabyte file', () => {
  const { root, cleanup } = setupTempRepo();
  const largeFile = join(root, 'large-transcript.jsonl');
  // Write 1 MiB transcript
  const chunk = 'x'.repeat(1024 * 1024);
  writeFileSync(largeFile, chunk);
  try {
    const hash = computePrefixHash(largeFile, 1024 * 1024);
    assert.ok(hash);
    assert.equal(typeof hash, 'string');
    assert.equal(hash.length, 64);
  } finally {
    cleanup();
  }
});

test('preInvocation: discovers repo root from early tool call in > 256 KiB transcript', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1' });
  const transcriptFile = join(root, 'large-headless-transcript.jsonl');
  // First line has the only absolute repo path
  const earlyLine = JSON.stringify({
    type: 'PLANNER_RESPONSE',
    tool_calls: [{ name: 'view_file', args: { AbsolutePath: join(root, 'src/early.js') } }],
  });
  // Pad with 300 KiB of unrelated lines
  const paddingLines = Array.from({ length: 300 }, (_, i) =>
    JSON.stringify({ type: 'USER_INPUT', content: `padding line ${i} ` + 'a'.repeat(1000) })
  );
  writeFileSync(transcriptFile, [earlyLine, ...paddingLines].join('\n') + '\n');
  try {
    const payload = {
      transcriptPath: transcriptFile,
      conversationId: 'test-session-large-headless',
    };
    const res = preInvocation(payload, { env });
    assert.ok(res.injectSteps);
    assert.ok(res.injectSteps.length > 0);
  } finally {
    cleanup();
  }
});

test('onStop: rejects Stop when session entry counters are zeroed out mid-session', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  const lines = [
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'write_to_file', args: { TargetFile: join(root, 'src/feature/app.js') } }],
    }),
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'node --test', Cwd: root } }],
      exit_code: 0,
    }),
    JSON.stringify({ content: 'Finished.' }),
  ];
  writeFileSync(transcriptFile, lines.join('\n') + '\n');
  try {
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'test-session-zeroed-counters',
    };
    preInvocation(payload, { env });
    const tracker = createPersistentTracker(root, env);
    tracker.recordToolCall('test-session-zeroed-counters', { isMutating: true });

    // Now zero out the mutatingCalls counter in sessions.json
    const sessionsFile = join(root, '.adlc', 'sessions.json');
    const sData = JSON.parse(readFileSync(sessionsFile, 'utf8'));
    sData['test-session-zeroed-counters'].mutatingCalls = 0;
    writeFileSync(sessionsFile, JSON.stringify(sData));

    const res = onStop(payload, { env });
    assert.equal(res.decision, 'continue');
    assert.match(res.reason, /Session baseline signature mismatch|Untracked or missing tool execution records|Session tracking entry was deleted, reset, or modified/);
  } finally {
    cleanup();
  }
});

test('runFromStdin: denied tool call on frozen rail does not advance session counters', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1', rails: ['src/frozen.js'] });
  try {
    const payload = JSON.stringify({
      conversationId: 'sess-denied-rail',
      toolCall: { name: 'write_to_file', args: { TargetFile: join(root, 'src/frozen.js'), CodeContent: 'bad' } },
      workspacePaths: [root],
    });
    const res = runFromStdin(payload, env);
    assert.equal(res.allow_tool, false);

    const tracker = createPersistentTracker(root, env);
    assert.equal(tracker.depth('sess-denied-rail'), 0);
    assert.equal(tracker.mutatingCalls('sess-denied-rail'), 0);
  } finally {
    cleanup();
  }
});

test('onStop: rejects Stop when transcript path changes mid-session', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1' });
  const transcript1 = join(root, 'transcript1.jsonl');
  const transcript2 = join(root, 'transcript2.jsonl');
  writeFileSync(transcript1, '{"type":"USER_INPUT"}\n');
  writeFileSync(transcript2, '{"type":"USER_INPUT"}\n');
  try {
    const payload1 = {
      workspacePaths: [root],
      transcriptPath: transcript1,
      conversationId: 'sess-path-switch',
    };
    preInvocation(payload1, { env });

    const payload2 = {
      workspacePaths: [root],
      transcriptPath: transcript2,
      conversationId: 'sess-path-switch',
    };
    const res = onStop(payload2, { env });
    assert.equal(res.decision, 'continue');
    assert.match(res.reason, /Session transcript path changed during session/);
  } finally {
    cleanup();
  }
});

test('onStop: rejects Stop when current-ticket.json is deleted mid-session even if ADLC_TICKET is set', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1', activeTicket: 'T1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  const lines = [
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'node --test', Cwd: root } }],
      exit_code: 0,
    }),
  ];
  writeFileSync(transcriptFile, lines.join('\n') + '\n');
  try {
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'sess-ptr-del',
    };
    const testEnv = { ...env, ADLC_TICKET: 'T1' };
    preInvocation(payload, { env: testEnv });

    // Now delete current-ticket.json
    unlinkSync(join(root, '.adlc', 'current-ticket.json'));

    const res = onStop(payload, { env: testEnv });
    assert.equal(res.decision, 'continue');
    assert.match(res.reason, /Active ticket pointer \(\.adlc\/current-ticket\.json\) was removed/);
  } finally {
    cleanup();
  }
});

test('onStop: rejects Stop when sessions.json baseline fields are tampered with', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1', activeTicket: 'T1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  const lines = [
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'node --test', Cwd: root } }],
      exit_code: 0,
    }),
  ];
  writeFileSync(transcriptFile, lines.join('\n') + '\n');
  try {
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'sess-tamper-sig',
    };
    preInvocation(payload, { env });
    const tracker = createPersistentTracker(root, env);
    tracker.recordToolCall('sess-tamper-sig', { isMutating: false });
    tracker.recordActiveTicket('sess-tamper-sig', 'T1', 'hash123');

    // Tamper with initialStoreHash directly in sessions.json
    const sessionsFile = join(root, '.adlc', 'sessions.json');
    const sData = JSON.parse(readFileSync(sessionsFile, 'utf8'));
    sData['sess-tamper-sig'].initialStoreHash = 'forged-hash';
    writeFileSync(sessionsFile, JSON.stringify(sData));

    const res = onStop(payload, { env });
    assert.equal(res.decision, 'continue');
    assert.match(res.reason, /Session baseline signature mismatch/);
  } finally {
    cleanup();
  }
});

test('onStop: rejects Stop when sessions.json is replaced by an array []', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1', activeTicket: 'T1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  const lines = [
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'node --test', Cwd: root } }],
      exit_code: 0,
    }),
  ];
  writeFileSync(transcriptFile, lines.join('\n') + '\n');
  try {
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'sess-array-store',
    };
    preInvocation(payload, { env });
    const sessionsFile = join(root, '.adlc', 'sessions.json');
    writeFileSync(sessionsFile, '[]');

    const res = onStop(payload, { env });
    assert.equal(res.decision, 'continue');
    assert.match(res.reason, /Session tracking store was corrupted or unreadable|Session baseline signature mismatch/);
  } finally {
    cleanup();
  }
});

test('findAdlcRoot: discovers root and enforces rails when ADLC_TICKET_STORE is configured', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1' });
  try {
    const customStore = join(root, 'custom-tickets.json');
    writeFileSync(customStore, JSON.stringify({
      version: 1,
      tickets: [
        { id: 'T1', title: 'T1', rails: ['src/frozen.js'] }
      ]
    }));
    const testEnv = { ...env, ADLC_TICKET_STORE: customStore, ADLC_TICKET: 'T1' };
    const discovered = findAdlcRoot(join(root, 'src', 'deep', 'nested', 'frozen.js'), testEnv);
    assert.equal(discovered, root);

    const payload = {
      workspacePaths: [root],
      toolCall: { name: 'write_to_file', args: { TargetFile: join(root, 'src', 'frozen.js'), CodeContent: 'new' } }
    };
    const res = runFromStdin(JSON.stringify(payload), testEnv);
    assert.equal(res.decision, 'deny');
    assert.match(res.reason, /frozen rail/);
  } finally {
    cleanup();
  }
});

test('findAdlcRoot: discovers root and enforces rails when ADLC_TICKET_STORE is external absolute path', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1' });
  const externalDir = join(tmpdir(), `adlc-ext-store-${Date.now()}`);
  mkdirSync(externalDir, { recursive: true });
  const externalStore = join(externalDir, 'ext-tickets.json');
  writeFileSync(externalStore, JSON.stringify({
    version: 1,
    tickets: [
      { id: 'T1', title: 'T1', rails: ['src/frozen.js'] }
    ]
  }));
  try {
    const testEnv = { ...env, ADLC_TICKET_STORE: externalStore, ADLC_TICKET: 'T1' };
    const discovered = findAdlcRoot(join(root, 'src', 'frozen.js'), testEnv);
    assert.equal(discovered, root);

    const payload = {
      workspacePaths: [root],
      toolCall: { name: 'write_to_file', args: { TargetFile: join(root, 'src', 'frozen.js'), CodeContent: 'new' } }
    };
    const res = runFromStdin(JSON.stringify(payload), testEnv);
    assert.equal(res.decision, 'deny');
    assert.match(res.reason, /frozen rail/);
  } finally {
    rmSync(externalDir, { recursive: true, force: true });
    cleanup();
  }
});

test('onStop: rejects Stop when mutable call counters in sessions.json are forged/tampered', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1', activeTicket: 'T1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  const lines = [
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'node --test', Cwd: root } }],
      exit_code: 0,
    }),
  ];
  writeFileSync(transcriptFile, lines.join('\n') + '\n');
  try {
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'sess-tamper-counters',
    };
    preInvocation(payload, { env });
    const tracker = createPersistentTracker(root, env);
    tracker.recordToolCall('sess-tamper-counters', { isMutating: true });
    tracker.recordActiveTicket('sess-tamper-counters', 'T1', 'hash123');

    // Tamper with mutatingCalls or totalCalls directly in sessions.json
    const sessionsFile = join(root, '.adlc', 'sessions.json');
    const sData = JSON.parse(readFileSync(sessionsFile, 'utf8'));
    sData['sess-tamper-counters'] = { mutatingCalls: 0, totalCalls: 0, initialStoreHash: 'fake', baselineSig: 'fake' };
    writeFileSync(sessionsFile, JSON.stringify(sData));

    const res = onStop(payload, { env });
    assert.equal(res.decision, 'continue');
    assert.match(res.reason, /Session baseline signature mismatch/);
  } finally {
    cleanup();
  }
});

test('onStop: rejects Stop when shell mutations ran prior to node --test verification', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1', activeTicket: 'T1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  const lines = [
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'write_to_file', args: { TargetFile: join(root, 'src/feature/app.js'), CodeContent: 'impl' } }],
    }),
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'sed -i "s/fail/pass/g" test/suite.js', Cwd: root } }],
    }),
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'node --test', Cwd: root } }],
      exit_code: 0,
    }),
  ];
  writeFileSync(transcriptFile, lines.join('\n') + '\n');
  try {
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'sess-shell-test-tamper',
    };
    preInvocation(payload, { env });

    // Simulate tool invocations through runFromStdin
    runFromStdin(JSON.stringify({ ...payload, toolCall: { name: 'write_to_file', args: { TargetFile: join(root, 'src/feature/app.js') } } }), env);
    runFromStdin(JSON.stringify({ ...payload, toolCall: { name: 'run_command', args: { CommandLine: 'sed -i "s/fail/pass/g" test/suite.js', Cwd: root } } }), env);
    runFromStdin(JSON.stringify({ ...payload, toolCall: { name: 'run_command', args: { CommandLine: 'node --test', Cwd: root } } }), env);

    const res = onStop(payload, { env });
    assert.equal(res.decision, 'stop', res.reason);
  } finally {
    cleanup();
  }
});

test('decide: fails closed when unclassified tool attempts to write to frozen rail via dest_file or file', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1', activeTicket: 'T1' });
  try {
    const payload1 = {
      workspacePaths: [root],
      toolCall: { name: 'sync', args: { dest_file: '.adlc/tickets.json' } },
    };
    const res1 = runFromStdin(JSON.stringify(payload1), env);
    assert.equal(res1.decision, 'deny');
    assert.match(res1.reason, /frozen rail/);

    const payload2 = {
      workspacePaths: [root],
      toolCall: { name: 'transfer', args: { file: join(root, '.adlc/current-ticket.json') } },
    };
    const res2 = runFromStdin(JSON.stringify(payload2), env);
    assert.equal(res2.decision, 'deny');
    assert.match(res2.reason, /frozen rail/);
  } finally {
    cleanup();
  }
});

test('onStop: rejects Stop when sessions.json entry is missing baselineSig under enforcement', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1', activeTicket: 'T1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  const lines = [
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'node --test', Cwd: root } }],
      exit_code: 0,
    }),
  ];
  writeFileSync(transcriptFile, lines.join('\n') + '\n');
  try {
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'sess-missing-sig',
    };
    preInvocation(payload, { env });

    // Remove baselineSig from sessions.json
    const sessionsFile = join(root, '.adlc', 'sessions.json');
    const sData = JSON.parse(readFileSync(sessionsFile, 'utf8'));
    delete sData['sess-missing-sig'].baselineSig;
    writeFileSync(sessionsFile, JSON.stringify(sData));

    const res = onStop(payload, { env });
    assert.equal(res.decision, 'continue');
    assert.match(res.reason, /Session baseline signature mismatch/);
  } finally {
    cleanup();
  }
});

test('isReadonlyCommand: allows safe git branch query forms and rejects mutating options', () => {
  assert.equal(isReadonlyCommand('git branch'), true);
  assert.equal(isReadonlyCommand('git branch -a'), true);
  assert.equal(isReadonlyCommand('git branch -r'), true);
  assert.equal(isReadonlyCommand('git branch --list'), true);
  assert.equal(isReadonlyCommand('git branch --show-current'), true);

  // Destructive / mutating branch commands
  assert.equal(isReadonlyCommand('git branch -d old-feat'), false);
  assert.equal(isReadonlyCommand('git branch -D old-feat'), false);
  assert.equal(isReadonlyCommand('git branch -m old-feat new-feat'), false);
  assert.equal(isReadonlyCommand('git branch -M old-feat new-feat'), false);
  assert.equal(isReadonlyCommand('git branch new-branch-name'), false);
  assert.equal(isReadonlyCommand('git branch -f target HEAD'), false);
  assert.equal(isReadonlyCommand('git branch --delete target'), false);
  assert.equal(isReadonlyCommand('git branch --set-upstream-to=origin/main'), false);
});

test('parseTranscriptRecords: reads regular file and safely handles non-file descriptor', () => {
  const { root, cleanup } = setupTempRepo();
  try {
    const transcriptFile = join(root, 'transcript.jsonl');
    writeFileSync(transcriptFile, JSON.stringify({ type: 'PLANNER_RESPONSE', content: 'test' }) + '\n');
    const records = parseTranscriptRecords(transcriptFile, { readFull: true });
    assert.equal(records.length, 1);
    assert.equal(records[0].content, 'test');

    // Non-existent or non-file returns empty array
    assert.deepEqual(parseTranscriptRecords(root, { readFull: true }), []);
    assert.deepEqual(parseTranscriptRecords(join(root, 'nonexistent.jsonl'), { readFull: true }), []);
  } finally {
    cleanup();
  }
});

test('onStop and runFromStdin: multi-root workspace binds verification to command Cwd', () => {
  const repoA = setupTempRepo({ activeTicket: 'T1' });
  const repoB = setupTempRepo({ activeTicket: 'T2' });
  try {
    const transcriptFile = join(repoB.root, 'transcript.jsonl');
    const lines = [
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        tool_calls: [{ name: 'write_to_file', args: { TargetFile: join(repoB.root, 'src/feature/b.js'), CodeContent: 'impl' } }],
      }),
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        tool_calls: [{ name: 'run_command', args: { CommandLine: 'node --test', Cwd: repoB.root } }],
        exit_code: 0,
      }),
    ];
    writeFileSync(transcriptFile, lines.join('\n') + '\n');

    const payload = {
      workspacePaths: [repoA.root, repoB.root],
      transcriptPath: transcriptFile,
      conversationId: 'sess-multi-root-cwd',
    };
    preInvocation(payload, { env: repoB.env });

    // runFromStdin should detect node --test with Cwd=repoB as verification (non-mutating)
    runFromStdin(JSON.stringify({ ...payload, toolCall: { name: 'write_to_file', args: { TargetFile: join(repoB.root, 'src/feature/b.js') } } }), repoB.env);
    const stdinPayload = {
      ...payload,
      toolCall: { name: 'run_command', args: { CommandLine: 'node --test', Cwd: repoB.root } },
    };
    const v = runFromStdin(JSON.stringify(stdinPayload), repoB.env);
    assert.equal(v.decision, 'allow');

    // onStop in repoB should succeed
    const res = onStop(payload, { env: repoB.env });
    assert.equal(res.decision, 'stop');
  } finally {
    repoA.cleanup();
    repoB.cleanup();
  }
});

test('checkBuildGate: denies build when baseline signature in sessions.json is tampered', () => {
  const { root, env, cleanup } = setupTempRepo({ activeTicket: 'T1', enforcement: '1' });
  try {
    const tracker = createPersistentTracker(root, env);
    tracker.recordToolCall('sess-bg-tamper', { isMutating: true });

    // Tamper with sessions.json
    const sessionsFile = join(root, '.adlc', 'sessions.json');
    const sData = JSON.parse(readFileSync(sessionsFile, 'utf8'));
    sData['sess-bg-tamper'].depth = 0;
    sData['sess-bg-tamper'].baselineSig = 'invalid_sig';
    writeFileSync(sessionsFile, JSON.stringify(sData));

    const res = checkBuildGate({ sessionID: 'sess-bg-tamper', tracker, root, env });
    assert.equal(res.decision, 'deny');
    assert.match(res.reason, /Session baseline signature mismatch/);
  } finally {
    cleanup();
  }
});

test('validateBaseline: detects compacted flag tampering in sessions.json', () => {
  const { root, env, cleanup } = setupTempRepo({ activeTicket: 'T1', enforcement: '1' });
  try {
    const tracker = createPersistentTracker(root, env);
    tracker.markCompacted('sess-compact-tamper');
    assert.equal(tracker.validateBaseline('sess-compact-tamper'), true);

    // Tamper with compacted in sessions.json
    const sessionsFile = join(root, '.adlc', 'sessions.json');
    const sData = JSON.parse(readFileSync(sessionsFile, 'utf8'));
    sData['sess-compact-tamper'].compacted = false;
    writeFileSync(sessionsFile, JSON.stringify(sData));

    assert.equal(tracker.validateBaseline('sess-compact-tamper'), false);
  } finally {
    cleanup();
  }
});

test('checkBuildGate: deleting sessions.json cannot reset depth gate for active session', () => {
  const { root, env, cleanup } = setupTempRepo({ activeTicket: 'T1', enforcement: '1' });
  try {
    const tracker = createPersistentTracker(root, env);
    // Record high depth
    for (let i = 0; i < 30; i++) {
      tracker.recordToolCall('sess-reset-depth', { isMutating: true });
    }

    // Delete sessions.json
    rmSync(join(root, '.adlc', 'sessions.json'), { force: true });

    // Validate baseline detects deletion
    assert.equal(tracker.validateBaseline('sess-reset-depth'), false);

    // checkBuildGate denies
    const res = checkBuildGate({ sessionID: 'sess-reset-depth', tracker, root, env });
    assert.equal(res.decision, 'deny');
    assert.match(res.reason, /Session baseline signature mismatch/);
  } finally {
    cleanup();
  }
});

test('withLock: recovers from malformed/crashed owner.json stale lock', () => {
  const { root, env, cleanup } = setupTempRepo({ activeTicket: 'T1', enforcement: '1' });
  try {
    const lockDir = join(root, '.adlc', 'sessions.lock');
    mkdirSync(lockDir, { recursive: true });
    // Write partial/corrupted owner.json with old mtime
    const ownerFile = join(lockDir, 'owner.json');
    writeFileSync(ownerFile, '{"pid": 999999, "nonce": "incomplete');
    // Set old mtime (> 3s ago)
    const oldTime = new Date(Date.now() - 5000);
    utimesSync(lockDir, oldTime, oldTime);

    const tracker = createPersistentTracker(root, env);
    // Should recover stale lock and successfully write tool call
    tracker.recordToolCall('sess-stale-corrupt-owner', { isMutating: true });
    assert.equal(tracker.totalCalls('sess-stale-corrupt-owner'), 1);
  } finally {
    cleanup();
  }
});

test('decide: symlinked workspace alias enforces frozen rail checks', () => {
  const { root, env, cleanup } = setupTempRepo({ activeTicket: 'T1', enforcement: '1', rails: ['src/frozen.js'] });
  const symlinkPath = join(tmpdir(), `adlc-symlink-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  try {
    symlinkSync(root, symlinkPath, 'dir');
    const payload = {
      workspacePaths: [symlinkPath],
      toolCall: { name: 'write_to_file', args: { TargetFile: join(symlinkPath, 'src/frozen.js') } },
    };
    const v = runFromStdin(JSON.stringify(payload), env);
    assert.equal(v.allow_tool, false);
    assert.equal(v.decision, 'deny');
    assert.match(v.deny_reason, /frozen rail/);
  } finally {
    try { unlinkSync(symlinkPath); } catch {}
    cleanup();
  }
});

test('resolveSessionId: sanitizes prototype-key identifiers and oversized IDs', () => {
  assert.equal(resolveSessionId({ payload: { conversationId: 'constructor' } }), 'default_session');
  assert.equal(resolveSessionId({ payload: { conversationId: '__proto__' } }), 'default_session');
  assert.equal(resolveSessionId({ payload: { conversationId: 'prototype' } }), 'default_session');
  assert.equal(resolveSessionId({ payload: { conversationId: 'toString' } }), 'default_session');
  assert.equal(resolveSessionId({ payload: { conversationId: 'a'.repeat(200) } }), 'default_session');
  assert.equal(resolveSessionId({ payload: { conversationId: 'valid-session-123.test' } }), 'valid-session-123.test');
});

test('validateBaseline: detects tampering with edits, warned, or flailStatus in sessions.json', () => {
  const { root, env, cleanup } = setupTempRepo({ activeTicket: 'T1', enforcement: '1' });
  try {
    const tracker = createPersistentTracker(root, env);
    tracker.recordEdit('sess-flail-tamper', 'src/file1.js');
    assert.equal(tracker.validateBaseline('sess-flail-tamper'), true);

    const sessionsFile = join(root, '.adlc', 'sessions.json');
    const sData = JSON.parse(readFileSync(sessionsFile, 'utf8'));

    // Tamper with edits
    sData['sess-flail-tamper'].edits = [];
    writeFileSync(sessionsFile, JSON.stringify(sData));
    assert.equal(tracker.validateBaseline('sess-flail-tamper'), false);

    // Restore and tamper with flailStatus
    sData['sess-flail-tamper'].edits = [`Editing ${join(root, 'src/file1.js')}`];
    sData['sess-flail-tamper'].flailStatus = { verdict: 'clean', summary: '' };
    writeFileSync(sessionsFile, JSON.stringify(sData));
    assert.equal(tracker.validateBaseline('sess-flail-tamper'), false);
  } finally {
    cleanup();
  }
});

test('decide: external ticket store override is protected as a frozen trust root', () => {
  const { root, env, cleanup } = setupTempRepo({ activeTicket: 'T1', enforcement: '1' });
  const externalStore = join(tmpdir(), `adlc-external-store-${Date.now()}.json`);
  try {
    writeFileSync(externalStore, JSON.stringify({ version: 1, tickets: [{ id: 'T1', title: 'Ext', rails: ['src/frozen.js'] }] }));
    const customEnv = { ...env, ADLC_TICKET_STORE: externalStore };

    const payload = {
      workspacePaths: [root],
      toolCall: { name: 'write_to_file', args: { TargetFile: externalStore } },
    };
    const v = runFromStdin(JSON.stringify(payload), customEnv);
    assert.equal(v.allow_tool, false);
    assert.equal(v.decision, 'deny');
    assert.match(v.deny_reason, /frozen rail/);
  } finally {
    try { unlinkSync(externalStore); } catch {}
    cleanup();
  }
});

test('decide: external sharded ticket store directory is protected as a frozen trust root', () => {
  const { root, env, cleanup } = setupTempRepo({ activeTicket: 'T1', enforcement: '1' });
  const externalShardDir = join(tmpdir(), `adlc-external-shards-${Date.now()}`);
  try {
    mkdirSync(externalShardDir, { recursive: true });
    const shardFile = join(externalShardDir, 'T1.json');
    writeFileSync(shardFile, JSON.stringify({ id: 'T1', title: 'Ext Shard', rails: ['src/frozen.js'] }));
    const customEnv = { ...env, ADLC_TICKET_STORE: externalShardDir };

    const payload = {
      workspacePaths: [root],
      toolCall: { name: 'write_to_file', args: { TargetFile: shardFile } },
    };
    const v = runFromStdin(JSON.stringify(payload), customEnv);
    assert.equal(v.allow_tool, false);
    assert.equal(v.decision, 'deny');
    assert.match(v.deny_reason, /frozen rail/);
  } finally {
    try { rmSync(externalShardDir, { recursive: true, force: true }); } catch {}
    cleanup();
  }
});

test('decide: custom in-repo ticket store path is protected as a frozen trust root', () => {
  const { root, env, cleanup } = setupTempRepo({ activeTicket: 'T1', enforcement: '1' });
  try {
    const customStore = join(root, 'config/custom-tickets.json');
    mkdirSync(dirname(customStore), { recursive: true });
    writeFileSync(customStore, JSON.stringify({ version: 1, tickets: [{ id: 'T1', title: 'Custom In Repo', rails: ['src/frozen.js'] }] }));
    const customEnv = { ...env, ADLC_TICKET_STORE: 'config/custom-tickets.json' };

    const payload = {
      workspacePaths: [root],
      toolCall: { name: 'write_to_file', args: { TargetFile: customStore } },
    };
    const v = runFromStdin(JSON.stringify(payload), customEnv);
    assert.equal(v.allow_tool, false);
    assert.equal(v.decision, 'deny');
    assert.match(v.deny_reason, /frozen rail/);
  } finally {
    cleanup();
  }
});

test('onStop: rejects Stop when shell commands modify external ticket store override', () => {
  const { root, env, cleanup } = setupTempRepo({ activeTicket: 'T1', enforcement: '1' });
  const externalStore = join(tmpdir(), `adlc-ext-shell-store-${Date.now()}.json`);
  const transcriptFile = join(root, 'transcript.jsonl');
  try {
    writeFileSync(externalStore, JSON.stringify({ version: 1, tickets: [{ id: 'T1', title: 'Ext', rails: ['src/frozen.js'] }] }));
    const customEnv = { ...env, ADLC_TICKET_STORE: externalStore };

    const lines = [
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        tool_calls: [{ name: 'run_command', args: { CommandLine: `node -e 'require("fs").writeFileSync(process.env.ADLC_TICKET_STORE, "...")'`, Cwd: root } }],
        exit_code: 0,
      }),
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        tool_calls: [{ name: 'run_command', args: { CommandLine: 'node --test', Cwd: root } }],
        exit_code: 0,
      }),
      JSON.stringify({ content: 'Finished.' }),
    ];
    writeFileSync(transcriptFile, lines.join('\n') + '\n');

    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'sess-ext-shell-modify',
    };
    preInvocation(payload, { env: customEnv });
    runFromStdin(JSON.stringify({ ...payload, toolCall: { name: 'run_command', args: { CommandLine: `node -e 'require("fs").writeFileSync(process.env.ADLC_TICKET_STORE, "...")'`, Cwd: root } } }), customEnv);
    runFromStdin(JSON.stringify({ ...payload, toolCall: { name: 'run_command', args: { CommandLine: 'node --test', Cwd: root } } }), customEnv);

    const res = onStop(payload, { env: customEnv });
    assert.equal(res.decision, 'continue');
    assert.match(res.reason, /Shell modification of (trust-root|custom ticket)/);
  } finally {
    try { unlinkSync(externalStore); } catch {}
    cleanup();
  }
});

test('decide: plain workspace without .git or .adlc enforces rails under external ticket store', () => {
  const plainWs = join(tmpdir(), `adlc-plain-ws-${Date.now()}`);
  mkdirSync(join(plainWs, 'src'), { recursive: true });
  writeFileSync(join(plainWs, 'src', 'frozen.js'), '// frozen');

  const externalStore = join(tmpdir(), `adlc-plain-ext-store-${Date.now()}.json`);
  try {
    writeFileSync(externalStore, JSON.stringify({
      version: 1,
      tickets: [{ id: 'T1', title: 'External Ticket', rails: ['src/frozen.js'] }],
    }));
    const env = {
      ADLC_P4_ENFORCEMENT: '1',
      ADLC_TICKET_STORE: externalStore,
      ADLC_TICKET: 'T1',
    };

    const payload = {
      workspacePaths: [plainWs],
      toolCall: { name: 'write_to_file', args: { TargetFile: join(plainWs, 'src/frozen.js') } },
    };
    const v = runFromStdin(JSON.stringify(payload), env);
    assert.equal(v.allow_tool, false);
    assert.equal(v.decision, 'deny');
    assert.match(v.deny_reason, /frozen rail/);
  } finally {
    try { unlinkSync(externalStore); } catch {}
    try { rmSync(plainWs, { recursive: true, force: true }); } catch {}
  }
});

test('lifecycle: full lifecycle on plain workspace with external ticket store', () => {
  const plainWs = join(tmpdir(), `adlc-plain-lifecycle-${Date.now()}`);
  mkdirSync(join(plainWs, 'src'), { recursive: true });
  writeFileSync(join(plainWs, 'src', 'editable.js'), '// work');
  mkdirSync(join(plainWs, 'test'), { recursive: true });
  writeFileSync(join(plainWs, 'test', 'sample.test.js'), 'import test from "node:test"; test("ok", () => {});\n');
  const transcriptFile = join(plainWs, 'transcript.jsonl');

  const externalStore = join(tmpdir(), `adlc-plain-life-store-${Date.now()}.json`);
  try {
    writeFileSync(externalStore, JSON.stringify({
      version: 1,
      tickets: [{ id: 'T1', title: 'External Ticket', rails: ['src/frozen.js'] }],
    }));
    const env = {
      ADLC_P4_ENFORCEMENT: '1',
      ADLC_TICKET_STORE: externalStore,
      ADLC_TICKET: 'T1',
    };

    const lines = [
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        tool_calls: [{ name: 'write_to_file', args: { TargetFile: join(plainWs, 'src/editable.js'), CodeContent: '// edit' } }],
      }),
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        tool_calls: [{ name: 'run_command', args: { CommandLine: 'node --test', Cwd: plainWs } }],
        exit_code: 0,
      }),
      JSON.stringify({ content: 'Finished.' }),
    ];
    writeFileSync(transcriptFile, lines.join('\n') + '\n');

    const basePayload = {
      workspacePaths: [plainWs],
      transcriptPath: transcriptFile,
      conversationId: 'sess-plain-lifecycle',
    };

    preInvocation(basePayload, { env });
    const runRes1 = runFromStdin(JSON.stringify({ ...basePayload, toolCall: { name: 'write_to_file', args: { TargetFile: join(plainWs, 'src/editable.js'), CodeContent: '// edit' } } }), env);
    assert.equal(runRes1.allow_tool, true);

    const runRes2 = runFromStdin(JSON.stringify({ ...basePayload, toolCall: { name: 'run_command', args: { CommandLine: 'node --test', Cwd: plainWs } } }), env);
    assert.equal(runRes2.allow_tool, true);

    const stopRes = onStop(basePayload, { env });
    assert.equal(stopRes.decision, 'stop');
  } finally {
    try { unlinkSync(externalStore); } catch {}
    try { rmSync(plainWs, { recursive: true, force: true }); } catch {}
  }
});

test('decide and onStop: unknown command-shaped tools (custom_shell / terminal_modify) are treated as shell tools', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  try {
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'sess-custom-shell',
    };

    // 1. decide denies when custom shell tool targets trust root
    const vDeny = runFromStdin(JSON.stringify({
      ...payload,
      toolCall: { name: 'custom_shell', args: { CommandLine: 'rm -f .adlc/tickets.json' } },
    }), env);
    assert.equal(vDeny.allow_tool, false);
    assert.match(vDeny.deny_reason, /shell modification of ticket store/);

    // 2. onStop detects custom shell tool mutation and enforces test run
    const lines = [
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        tool_calls: [{ name: 'custom_shell', args: { CommandLine: 'echo "mod" > src/app.js', Cwd: root } }],
      }),
      JSON.stringify({ content: 'Attempting stop without test' }),
    ];
    writeFileSync(transcriptFile, lines.join('\n') + '\n');

    preInvocation(payload, { env });
    runFromStdin(JSON.stringify({
      ...payload,
      toolCall: { name: 'custom_shell', args: { CommandLine: 'echo "mod" > src/app.js', Cwd: root } },
    }), env);

    const stopRes = onStop(payload, { env });
    assert.equal(stopRes.decision, 'continue');
    assert.match(stopRes.reason, /Active ticket has unverified file edits/);
  } finally {
    cleanup();
  }
});

test('decide and onStop: mixed command/path arguments targeting frozen rails are denied', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1', activeTicket: 'T1' });
  try {
    const customStore = join(root, '.adlc/tickets.json');
    writeFileSync(customStore, JSON.stringify({
      version: 1,
      tickets: [{ id: 'T1', title: 'T1', rails: ['src/frozen.js'] }],
    }));

    // 1. Tool with execute: true and TargetFile pointing to frozen rail
    const payload1 = {
      workspacePaths: [root],
      toolCall: { name: 'custom_mutator', args: { execute: true, TargetFile: join(root, 'src/frozen.js'), CodeContent: 'mod' } },
    };
    const v1 = runFromStdin(JSON.stringify(payload1), env);
    assert.equal(v1.allow_tool, false);
    assert.equal(v1.decision, 'deny');
    assert.match(v1.deny_reason, /frozen rail/);

    // 2. Tool with CommandLine and TargetFile pointing to ticket trust root
    const payload2 = {
      workspacePaths: [root],
      toolCall: { name: 'custom_mutator', args: { CommandLine: 'echo hello', TargetFile: join(root, '.adlc/tickets.json'), CodeContent: '{}' } },
    };
    const v2 = runFromStdin(JSON.stringify(payload2), env);
    assert.equal(v2.allow_tool, false);
    assert.equal(v2.decision, 'deny');
    assert.match(v2.deny_reason, /frozen rail/);
  } finally {
    cleanup();
  }
});

test('discoverRootFromTranscriptRecords: discovers root in headless mode using dest_file, outputPath, and nested payloads', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1', activeTicket: 'T1', scope: ['src/**', 'dist/**'] });
  const externalTranscript = join(tmpdir(), `headless-transcript-${Date.now()}.jsonl`);
  try {
    // 1. Transcript with dest_file and outputPath
    const lines = [
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        tool_calls: [{ name: 'write_file', args: { dest_file: join(root, 'src/app.js'), CodeContent: '// write' } }],
      }),
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        tool_calls: [{ name: 'bundle', args: { config: { outputPath: join(root, 'dist/bundle.js') } } }],
      }),
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        tool_calls: [{ name: 'run_command', args: { CommandLine: 'node --test', Cwd: root } }],
        exit_code: 0,
      }),
      JSON.stringify({ content: 'Done.' }),
    ];
    writeFileSync(externalTranscript, lines.join('\n') + '\n');

    const headlessPayload = {
      workspacePaths: [],
      transcriptPath: externalTranscript,
      conversationId: 'sess-headless-dest-file',
    };

    const headlessEnv = { ...env, PROJECT_ROOT: '', PWD: tmpdir() };

    // PreInvocation discovers root from transcript records
    const preRes = preInvocation(headlessPayload, { env: headlessEnv });
    assert.ok(preRes);

    const v1 = runFromStdin(JSON.stringify({ ...headlessPayload, toolCall: { name: 'write_file', args: { dest_file: join(root, 'src/app.js'), CodeContent: '// write' } } }), headlessEnv);
    assert.equal(v1.allow_tool, true, v1.deny_reason);

    const v2 = runFromStdin(JSON.stringify({ ...headlessPayload, toolCall: { name: 'bundle', args: { config: { outputPath: join(root, 'dist/bundle.js') } } } }), headlessEnv);
    assert.equal(v2.allow_tool, true, v2.deny_reason);

    const v3 = runFromStdin(JSON.stringify({ ...headlessPayload, toolCall: { name: 'run_command', args: { CommandLine: 'node --test', Cwd: root } } }), headlessEnv);
    assert.equal(v3.allow_tool, true, v3.deny_reason);

    // Stop completes successfully having resolved root from transcript
    const stopRes = onStop(headlessPayload, { env: headlessEnv });
    assert.equal(stopRes.decision, 'stop', stopRes.reason);
  } finally {
    try { unlinkSync(externalTranscript); } catch {}
    cleanup();
  }
});

test('onStop: rejects Stop when current session entry is missing or evicted from sessions.json', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1', activeTicket: 'T1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  try {
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'sess-evicted-123',
    };

    const lines = [
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        tool_calls: [{ name: 'write_to_file', args: { TargetFile: join(root, 'src/feature/app.js'), CodeContent: '// edit' } }],
      }),
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        tool_calls: [{ name: 'run_command', args: { CommandLine: 'node --test', Cwd: root } }],
        exit_code: 0,
      }),
      JSON.stringify({ content: 'Finished.' }),
    ];
    writeFileSync(transcriptFile, lines.join('\n') + '\n');

    preInvocation(payload, { env });
    runFromStdin(JSON.stringify({
      ...payload,
      toolCall: { name: 'write_to_file', args: { TargetFile: join(root, 'src/feature/app.js'), CodeContent: '// edit' } },
    }), env);
    runFromStdin(JSON.stringify({
      ...payload,
      toolCall: { name: 'run_command', args: { CommandLine: 'node --test', Cwd: root } },
    }), env);

    // Evict or remove the session key from sessions.json
    const sessionsFile = join(root, '.adlc', 'sessions.json');
    writeFileSync(sessionsFile, JSON.stringify({
      'other-session-456': { depth: 1, baselineSig: 'dummy' },
    }));

    const stopRes = onStop(payload, { env });
    assert.equal(stopRes.decision, 'continue');
    assert.match(stopRes.reason, /Session tracking entry was deleted, evicted, reset, or missing|Session baseline signature mismatch or missing tracking entry/);
  } finally {
    cleanup();
  }
});

test('onStop: rejects npm run check as verification after file edits', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1', activeTicket: 'T1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  try {
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'sess-check-script',
    };

    const lines = [
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        tool_calls: [{ name: 'write_to_file', args: { TargetFile: join(root, 'src/feature/app.js'), CodeContent: '// edit' } }],
      }),
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        tool_calls: [{ name: 'run_command', args: { CommandLine: 'npm run check', Cwd: root } }],
        exit_code: 0,
      }),
      JSON.stringify({ content: 'Finished.' }),
    ];
    writeFileSync(transcriptFile, lines.join('\n') + '\n');

    preInvocation(payload, { env });
    runFromStdin(JSON.stringify({
      ...payload,
      toolCall: { name: 'write_to_file', args: { TargetFile: join(root, 'src/feature/app.js'), CodeContent: '// edit' } },
    }), env);
    runFromStdin(JSON.stringify({
      ...payload,
      toolCall: { name: 'run_command', args: { CommandLine: 'npm run check', Cwd: root } },
    }), env);

    const stopRes = onStop(payload, { env });
    assert.equal(stopRes.decision, 'continue');
    assert.match(stopRes.reason, /Active ticket has unverified file edits/);
  } finally {
    cleanup();
  }
});

test('subprocess integration: cjs shim executes across separate Node processes with durable baseline', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1', activeTicket: 'T1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  const cjsShim = join(__dirname, '..', 'hooks', 'adlc-rails-guard.cjs');
  try {
    const lines = [
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        tool_calls: [{ name: 'write_to_file', args: { TargetFile: join(root, 'src/feature/app.js'), CodeContent: '// edit' } }],
      }),
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        tool_calls: [{ name: 'run_command', args: { CommandLine: 'npm test', Cwd: root } }],
        exit_code: 0,
      }),
      JSON.stringify({ content: 'Done.' }),
    ];
    writeFileSync(transcriptFile, lines.join('\n') + '\n');

    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'sess-subprocess-123',
    };

    // 1. Process 1: PreInvocation
    const proc1 = spawnSync(process.execPath, [cjsShim, 'preinvocation'], {
      input: JSON.stringify(payload),
      env: { ...process.env, ...env },
      encoding: 'utf8',
    });
    assert.equal(proc1.status, 0);

    // 2. Process 2: PreToolUse (write_to_file)
    const proc2 = spawnSync(process.execPath, [cjsShim], {
      input: JSON.stringify({
        ...payload,
        toolCall: { name: 'write_to_file', args: { TargetFile: join(root, 'src/feature/app.js'), CodeContent: '// edit' } },
      }),
      env: { ...process.env, ...env },
      encoding: 'utf8',
    });
    assert.equal(proc2.status, 0);
    const v2 = JSON.parse(proc2.stdout);
    assert.equal(v2.allow_tool, true);

    // 3. Process 3: PreToolUse (run_command: npm test)
    const proc3 = spawnSync(process.execPath, [cjsShim], {
      input: JSON.stringify({
        ...payload,
        toolCall: { name: 'run_command', args: { CommandLine: 'npm test', Cwd: root } },
      }),
      env: { ...process.env, ...env },
      encoding: 'utf8',
    });
    assert.equal(proc3.status, 0);

    // 4. Process 4: onStop
    const proc4 = spawnSync(process.execPath, [cjsShim, 'stop'], {
      input: JSON.stringify(payload),
      env: { ...process.env, ...env },
      encoding: 'utf8',
    });
    assert.equal(proc4.status, 0);
    const stopOut = JSON.parse(proc4.stdout);
    assert.equal(stopOut.decision, 'stop', stopOut.reason);
  } finally {
    cleanup();
  }
});

test('checkBuildGate: deleting sessions.json is recovered via session ledger and remains denied', () => {
  const { root, env, cleanup } = setupTempRepo({
    enforcement: '1',
    activeTicket: 'T-CONTRACT-1',
  });
  // Update ticket to high risk
  const ticketsFile = join(root, '.adlc', 'tickets.json');
  writeFileSync(ticketsFile, JSON.stringify({
    version: 1,
    tickets: [{ id: 'T-CONTRACT-1', category: 'contract', rails: [], scope: ['src/**'] }],
  }));

  try {
    const sessionID = 'sess-ledger-test-1';
    const tracker = createPersistentTracker(root, env);
    tracker.recordActiveTicket(sessionID, 'T-CONTRACT-1');

    // Simulate 50 calls to exceed threshold
    for (let i = 0; i < 50; i++) {
      tracker.recordToolCall(sessionID, { isMutating: true });
    }

    // Gate should deny because depth 50 >= 50
    const gate1 = checkBuildGate({ sessionID, tracker, root, env });
    assert.equal(gate1.decision, 'deny');

    // Delete sessions.json
    const sessionsFile = join(root, '.adlc', 'sessions.json');
    if (existsSync(sessionsFile)) unlinkSync(sessionsFile);

    // Fresh tracker instance in new process context
    const freshTracker = createPersistentTracker(root, env);
    const gate2 = checkBuildGate({ sessionID, tracker: freshTracker, root, env });
    // Replayed from ledger, so still denied!
    assert.equal(gate2.decision, 'deny');
    assert.equal(freshTracker.depth(sessionID), 50);
  } finally {
    cleanup();
  }
});

test('isReadonlyCommand: treats attempts to read session secret or ledger as non-readonly', () => {
  assert.equal(isReadonlyCommand('cat .adlc/.session-secret'), false);
  assert.equal(isReadonlyCommand('cat /tmp/.adlc-host-secrets/session.secret'), false);
  assert.equal(isReadonlyCommand('head .adlc/session-ledger.jsonl'), false);
  assert.equal(isReadonlyCommand('cat .adlc/sessions.json'), false);
  assert.equal(isReadonlyCommand('cat src/index.js'), true);
});

test('writeStore: bounds active session storage to MAX_TRACKED_SESSIONS without evicting active session', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1', activeTicket: 'T1' });
  try {
    const tracker = createPersistentTracker(root, env);
    for (let i = 1; i <= 105; i++) {
      tracker.recordToolCall(`session-bulk-${i}`, { isMutating: false });
    }
    const store = tracker.rawStore();
    const keys = Object.keys(store).filter((k) => k !== '_corrupted');
    assert.ok(keys.length <= 100, `Expected <= 100 sessions, got ${keys.length}`);
    assert.ok(keys.includes('session-bulk-105'), 'Active session must not be evicted');
  } finally {
    cleanup();
  }
});

test('appendLedger: compacts snapshot records and accurately recovers session state', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1', activeTicket: 'T1' });
  try {
    const sessionID = 'sess-compaction-test';
    const tracker = createPersistentTracker(root, env);
    tracker.recordActiveTicket(sessionID, 'T1', 'mock-hash-123');
    for (let i = 0; i < 20; i++) {
      tracker.recordToolCall(sessionID, { isMutating: i % 2 === 0 });
    }
    // Verify initial state
    assert.equal(tracker.depth(sessionID), 20);
    assert.equal(tracker.mutatingCalls(sessionID), 10);

    // Delete sessions.json and recover via ledger replay
    const sessionsFile = join(root, '.adlc', 'sessions.json');
    if (existsSync(sessionsFile)) unlinkSync(sessionsFile);

    const freshTracker = createPersistentTracker(root, env);
    assert.equal(freshTracker.depth(sessionID), 20);
    assert.equal(freshTracker.mutatingCalls(sessionID), 10);
    assert.equal(freshTracker.initialTicket(sessionID), 'T1');
  } finally {
    cleanup();
  }
});

test('isShellTool: does not treat unknown code/script executors as trusted shells', async () => {
  const { isShellTool } = await import('../rails-checker.mjs');
  assert.equal(isShellTool('run_command', { CommandLine: 'ls' }), true);
  assert.equal(isShellTool('bash', { command: 'echo 1' }), true);
  assert.equal(isShellTool('python_exec', { code: 'print(1)' }), false);
  assert.equal(isShellTool('generate_code', { script: 'main.py' }), false);
  assert.equal(isShellTool('eval_js', { code: 'process.exit()' }), false);
});

test('checkBuildGate: corrupt sessions.json fails closed under enforcement', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1', activeTicket: 'T1' });
  try {
    const sessionID = 'sess-corrupted-test';
    // Write corrupted sessions.json
    const sessionsFile = join(root, '.adlc', 'sessions.json');
    writeFileSync(sessionsFile, '{ invalid json');

    const tracker = createPersistentTracker(root, env);
    const gate = checkBuildGate({ sessionID, tracker, root, env });
    assert.equal(gate.decision, 'deny');
    assert.match(gate.reason, /corrupted or unreadable/i);
  } finally {
    cleanup();
  }
});

test('appendLedger: quarantines oversized unparseable ledger', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1', activeTicket: 'T1' });
  try {
    const sessionID = 'sess-oversized-test';
    const ledgerFile = join(root, '.adlc', 'session-ledger.jsonl');
    // Pre-populate with unparseable oversized data > 2 MiB
    writeFileSync(ledgerFile, 'A'.repeat(3 * 1024 * 1024));

    const tracker = createPersistentTracker(root, env);
    tracker.recordToolCall(sessionID, { isMutating: true });

    // Verify ledger was rotated/quarantined and new ledger is small
    const stat = lstatSync(ledgerFile);
    assert.ok(stat.size < 512 * 1024, `Expected new ledger < 512 KiB, got ${stat.size}`);
  } finally {
    cleanup();
  }
});

test('onStop: allows verification via node --test after shell edit mutation', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1', activeTicket: 'T1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  try {
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'sess-shell-verify-test',
    };
    preInvocation(payload, { env });

    // 1. Shell mutation (e.g. sed)
    runFromStdin(JSON.stringify({
      ...payload,
      toolCall: { name: 'run_command', args: { CommandLine: 'sed -i "s/foo/bar/g" src/app.js', Cwd: root } },
    }), env);

    // 2. Full test suite run using immutable runner
    runFromStdin(JSON.stringify({
      ...payload,
      toolCall: { name: 'run_command', args: { CommandLine: 'node --test', Cwd: root } },
    }), env);

    const lines = [
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        tool_calls: [{ name: 'run_command', args: { CommandLine: 'sed -i "s/foo/bar/g" src/app.js', Cwd: root } }],
      }),
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        tool_calls: [{ name: 'run_command', args: { CommandLine: 'node --test', Cwd: root } }],
        exit_code: 0,
      }),
    ];
    writeFileSync(transcriptFile, lines.join('\n') + '\n');

    const res = onStop(payload, { env });
    assert.equal(res.decision, 'stop', res.reason);
  } finally {
    cleanup();
  }
});

test('flail: editing filenames containing "error" does not trigger false positive repeated error flail', async () => {
  const { analyzeFlail } = await import('../flail-inline.mjs');
  const res = analyzeFlail({
    edits: ['Editing src/error-handler.js', 'Editing src/error-handler.js'],
    transcriptSteps: [],
  });
  // 2 edits is below edit-churn threshold 3 and should NOT trigger repeated error
  assert.equal(res.verdict, 'clean');
});

test('onStop: rejects untracked mutating transcript without session tracker entry', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1', activeTicket: 'T1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  try {
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'sess-untracked-forged',
    };
    // Initialize tracker for a different session so session store exists
    const tracker = createPersistentTracker(root, env);
    tracker.recordToolCall('other-session-1', { isMutating: false });

    // Forged transcript with mutation and test, but NO preInvocation or runFromStdin recorded
    const lines = [
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        tool_calls: [{ name: 'write_to_file', args: { TargetFile: join(root, 'src/app.js'), CodeContent: '// forged' } }],
      }),
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        tool_calls: [{ name: 'run_command', args: { CommandLine: 'npm test', Cwd: root } }],
        exit_code: 0,
      }),
    ];
    writeFileSync(transcriptFile, lines.join('\n') + '\n');

    const res = onStop(payload, { env });
    assert.equal(res.decision, 'continue');
    assert.match(res.reason, /Untracked.*tool execution records|Session tracking entry was deleted, evicted, reset, or missing/i);
  } finally {
    cleanup();
  }
});

test('onStop: rejects npm test verification after shell mutation modified package.json', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1', activeTicket: 'T1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  try {
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'sess-shell-pkg-tamper',
    };
    preInvocation(payload, { env });

    // 1. Shell command rewriting package.json
    runFromStdin(JSON.stringify({
      ...payload,
      toolCall: { name: 'run_command', args: { CommandLine: 'node -e "fs.writeFileSync(\'package.json\', \'{}\')"', Cwd: root } },
    }), env);

    // 2. npm test run
    runFromStdin(JSON.stringify({
      ...payload,
      toolCall: { name: 'run_command', args: { CommandLine: 'npm test', Cwd: root } },
    }), env);

    const lines = [
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        tool_calls: [{ name: 'run_command', args: { CommandLine: 'node -e "fs.writeFileSync(\'package.json\', \'{}\')"', Cwd: root } }],
      }),
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        tool_calls: [{ name: 'run_command', args: { CommandLine: 'npm test', Cwd: root } }],
        exit_code: 0,
      }),
    ];
    writeFileSync(transcriptFile, lines.join('\n') + '\n');

    const res = onStop(payload, { env });
    assert.equal(res.decision, 'continue');
    assert.match(res.reason, /unverified file edits|Edits exist in this session.*no successful verification command/i);
  } finally {
    cleanup();
  }
});

test('onStop: allows completion after read-only view of .adlc/tickets.json', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1', activeTicket: 'T1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  try {
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'sess-read-tickets-ok',
    };
    preInvocation(payload, { env });

    // 1. Read-only view_file on .adlc/tickets.json
    runFromStdin(JSON.stringify({
      ...payload,
      toolCall: { name: 'view_file', args: { AbsolutePath: join(root, '.adlc', 'tickets.json') } },
    }), env);

    // 2. File edit
    runFromStdin(JSON.stringify({
      ...payload,
      toolCall: { name: 'write_to_file', args: { TargetFile: join(root, 'src/app.js'), CodeContent: '// ok' } },
    }), env);

    // 3. Test verification
    runFromStdin(JSON.stringify({
      ...payload,
      toolCall: { name: 'run_command', args: { CommandLine: 'npm test', Cwd: root } },
    }), env);

    const lines = [
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        tool_calls: [{ name: 'view_file', args: { AbsolutePath: join(root, '.adlc', 'tickets.json') } }],
      }),
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        tool_calls: [{ name: 'write_to_file', args: { TargetFile: join(root, 'src/app.js'), CodeContent: '// ok' } }],
      }),
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        tool_calls: [{ name: 'run_command', args: { CommandLine: 'npm test', Cwd: root } }],
        exit_code: 0,
      }),
    ];
    writeFileSync(transcriptFile, lines.join('\n') + '\n');

    const res = onStop(payload, { env });
    assert.equal(res.decision, 'stop', res.reason);
  } finally {
    cleanup();
  }
});

test('onStop: rejects completion when ledger is truncated while sessions.json remains', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1', activeTicket: 'T1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  try {
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'sess-stop-ledger-trunc',
    };
    preInvocation(payload, { env });

    runFromStdin(JSON.stringify({
      ...payload,
      toolCall: { name: 'write_to_file', args: { TargetFile: join(root, 'src/app.js'), CodeContent: '// ok' } },
    }), env);

    runFromStdin(JSON.stringify({
      ...payload,
      toolCall: { name: 'run_command', args: { CommandLine: 'npm test', Cwd: root } },
    }), env);

    const lines = [
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        tool_calls: [{ name: 'write_to_file', args: { TargetFile: join(root, 'src/app.js'), CodeContent: '// ok' } }],
      }),
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        tool_calls: [{ name: 'run_command', args: { CommandLine: 'npm test', Cwd: root } }],
        exit_code: 0,
      }),
    ];
    writeFileSync(transcriptFile, lines.join('\n') + '\n');

    // Truncate ledger file to drop last line
    const ledgerFile = join(root, '.adlc', 'session-ledger.jsonl');
    const raw = readFileSync(ledgerFile, 'utf8');
    const ledgerLines = raw.split('\n').filter(Boolean);
    writeFileSync(ledgerFile, ledgerLines.slice(0, -1).join('\n') + '\n');

    const res = onStop(payload, { env });
    assert.equal(res.decision, 'continue');
    assert.match(res.reason, /ledger integrity verification failed/i);
  } finally {
    cleanup();
  }
});

test('onStop: rejects Stop when session infrastructure is absent and transcript has mutations', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1', activeTicket: 'T1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  try {
    // Delete sessions.json and session-ledger.jsonl if created
    rmSync(join(root, '.adlc', 'sessions.json'), { force: true });
    rmSync(join(root, '.adlc', 'session-ledger.jsonl'), { force: true });

    // NO preInvocation or runFromStdin recorded (PreToolUse skipped)
    const lines = [
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        tool_calls: [{ name: 'write_to_file', args: { TargetFile: join(root, 'src/app.js'), CodeContent: '// unauthenticated' } }],
      }),
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        tool_calls: [{ name: 'run_command', args: { CommandLine: 'node --test', Cwd: root } }],
        exit_code: 0,
      }),
    ];
    writeFileSync(transcriptFile, lines.join('\n') + '\n');

    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'sess-no-infra-untracked',
    };

    const res = onStop(payload, { env });
    assert.equal(res.decision, 'continue');
    assert.match(res.reason, /Session tracking store was missing or deleted|Untracked or missing tool execution records|Session tracking entry is missing/i);
  } finally {
    cleanup();
  }
});

test('onStop: rejects Stop when sessions.json contains empty object {} and transcript has mutations', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1', activeTicket: 'T1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  try {
    // Write empty sessions.json and empty session-ledger.jsonl
    writeFileSync(join(root, '.adlc', 'sessions.json'), JSON.stringify({}));
    writeFileSync(join(root, '.adlc', 'session-ledger.jsonl'), '');

    // NO preInvocation or runFromStdin recorded for this session
    const lines = [
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        tool_calls: [{ name: 'write_to_file', args: { TargetFile: join(root, 'src/app.js'), CodeContent: '// untracked edit' } }],
      }),
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        tool_calls: [{ name: 'run_command', args: { CommandLine: 'node --test', Cwd: root } }],
        exit_code: 0,
      }),
    ];
    writeFileSync(transcriptFile, lines.join('\n') + '\n');

    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'sess-empty-store-untracked',
    };

    const res = onStop(payload, { env });
    assert.equal(res.decision, 'continue');
    assert.match(res.reason, /Session tracking entry was deleted, evicted, reset, or missing|Session ledger integrity verification failed|Untracked tool execution records/i);
  } finally {
    cleanup();
  }
});

test('onStop: recognizes functionCall envelope with mutations and requires test verification', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1', activeTicket: 'T1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  try {
    const lines = [
      JSON.stringify({
        functionCall: {
          name: 'write_to_file',
          args: { TargetFile: join(root, 'src/app.js'), CodeContent: '// edit' },
        },
      }),
      JSON.stringify({ content: 'Attempting stop without running tests' }),
    ];
    writeFileSync(transcriptFile, lines.join('\n') + '\n');

    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'sess-function-call',
    };
    preInvocation(payload, { env });
    const tracker = createPersistentTracker(root, env);
    tracker.recordToolCall(payload.conversationId, { isMutating: true });

    const res = onStop(payload, { env });
    assert.equal(res.decision, 'continue');
    assert.match(res.reason, /unverified file edits/i);
  } finally {
    cleanup();
  }
});

test('onStop: rejects transcript record with unrecognized tool envelope under enforcement', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1', activeTicket: 'T1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  try {
    const lines = [
      JSON.stringify({
        invalid_tool_envelope: 12345,
      }),
    ];
    writeFileSync(transcriptFile, lines.join('\n') + '\n');

    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'sess-bad-envelope',
    };
    preInvocation(payload, { env });

    const res = onStop(payload, { env });
    assert.equal(res.decision, 'continue');
    assert.match(res.reason, /schema corruption detected/i);
  } finally {
    cleanup();
  }
});

test('onStop: allows stop with mixed text and functionCall parts followed by successful verification', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1', activeTicket: 'T1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  try {
    const lines = [
      JSON.stringify({
        parts: [
          { text: 'Starting implementation...' },
          { functionCall: { name: 'write_to_file', args: { TargetFile: join(root, 'src/app.js'), CodeContent: '// edit' } } },
        ],
      }),
      JSON.stringify({
        parts: [
          { text: 'Running test verification suite...' },
          { functionCall: { name: 'run_command', args: { CommandLine: 'node --test', Cwd: root } } },
        ],
        exit_code: 0,
      }),
      JSON.stringify({ content: 'Finished successfully.' }),
    ];
    writeFileSync(transcriptFile, lines.join('\n') + '\n');

    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'sess-mixed-parts',
    };
    preInvocation(payload, { env });
    const tracker = createPersistentTracker(root, env);
    tracker.recordToolCall(payload.conversationId, { isMutating: true });
    tracker.recordToolCall(payload.conversationId, { isMutating: false });

    const res = onStop(payload, { env });
    assert.equal(res.decision, 'stop');
  } finally {
    cleanup();
  }
});

test('onStop: allows stop when verification command is inside nested options envelope', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1', activeTicket: 'T1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  try {
    const lines = [
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        tool_calls: [
          { name: 'write_to_file', args: { TargetFile: join(root, 'src/app.js'), CodeContent: '// edit' } },
        ],
      }),
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        tool_calls: [
          { name: 'run_command', args: { options: { CommandLine: 'node --test', Cwd: root } } },
        ],
        exit_code: 0,
      }),
      JSON.stringify({ content: 'Finished with verified tests.' }),
    ];
    writeFileSync(transcriptFile, lines.join('\n') + '\n');

    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'sess-nested-options-test',
    };
    preInvocation(payload, { env });
    const tracker = createPersistentTracker(root, env);
    tracker.recordToolCall(payload.conversationId, { isMutating: true });
    tracker.recordToolCall(payload.conversationId, { isMutating: false });

    const res = onStop(payload, { env });
    assert.equal(res.decision, 'stop');
  } finally {
    cleanup();
  }
});

test('runFromStdin: denies shell command attempting to read session secrets under enforcement', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1', activeTicket: 'T1' });
  try {
    const payload = {
      workspacePaths: [root],
      toolCall: {
        name: 'run_command',
        args: {
          CommandLine: 'cat /dev/shm/.adlc-secrets-1000/session-1234.secret',
          Cwd: root,
        },
      },
    };
    const res = runFromStdin(JSON.stringify(payload), env);
    assert.equal(res.allow_tool, false);
    assert.match(res.deny_reason, /shell modification of ticket store or trust-root rails is strictly prohibited/);
  } finally {
    cleanup();
  }
});

test('runFromStdin: denies shell command attempting to read master key under enforcement', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1', activeTicket: 'T1' });
  try {
    const payload = {
      workspacePaths: [root],
      toolCall: {
        name: 'run_command',
        args: {
          CommandLine: 'cat ~/.adlc/.master-key',
          Cwd: root,
        },
      },
    };
    const res = runFromStdin(JSON.stringify(payload), env);
    assert.equal(res.allow_tool, false);
    assert.match(res.deny_reason, /shell modification of ticket store or trust-root rails is strictly prohibited/);
  } finally {
    cleanup();
  }
});

test('onStop: rejects npm test after non-readonly shell mutation, requiring immutable node --test', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1', activeTicket: 'T1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  try {
    const lines = [
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        tool_calls: [
          { name: 'run_command', args: { CommandLine: 'touch src/newfile.js', Cwd: root } },
        ],
        exit_code: 0,
      }),
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        tool_calls: [
          { name: 'run_command', args: { CommandLine: 'npm test', Cwd: root } },
        ],
        exit_code: 0,
      }),
      JSON.stringify({ content: 'Attempting stop' }),
    ];
    writeFileSync(transcriptFile, lines.join('\n') + '\n');

    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'sess-shell-mut-npm-test',
    };
    preInvocation(payload, { env });
    const tracker = createPersistentTracker(root, env);
    tracker.recordToolCall(payload.conversationId, { isMutating: true });
    tracker.recordToolCall(payload.conversationId, { isMutating: false });

    const res = onStop(payload, { env });
    assert.equal(res.decision, 'continue');
    assert.match(res.reason, /unverified file edits/i);
  } finally {
    cleanup();
  }
});

test('onStop: rejects same-size in-place rewrite of test result from exit_code 1 to 0', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1', activeTicket: 'T1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  try {
    const lines = [
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        tool_calls: [
          { name: 'write_to_file', args: { TargetFile: join(root, 'src/app.js'), CodeContent: '// edit' } },
        ],
      }),
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        tool_calls: [
          { name: 'run_command', args: { CommandLine: 'node --test', Cwd: root } },
        ],
        exit_code: 1,
      }),
    ];
    writeFileSync(transcriptFile, lines.join('\n') + '\n');

    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'sess-tamper-exit-code',
    };
    preInvocation(payload, { env });
    const tracker = createPersistentTracker(root, env);
    tracker.recordToolCall(payload.conversationId, { isMutating: true });
    tracker.recordToolCall(payload.conversationId, { isMutating: false });

    // PostToolUse records the test result with exit_code 1 and actual transcript hash
    postToolUse({ ...payload, exit_code: 1 }, { env });

    // Tamperer modifies exit_code in-place from 1 to 0 (same length)
    const tampered = readFileSync(transcriptFile, 'utf8').replace(/"exit_code":\s*1/, '"exit_code":0');
    writeFileSync(transcriptFile, tampered);

    const res = onStop(payload, { env });
    assert.equal(res.decision, 'continue');
    assert.match(res.reason, /Session transcript (prefix )?content was modified during session/i);
  } finally {
    cleanup();
  }
});

test('createPersistentTracker: recordEdit bounds oversized filePath before ledger append and preserves ledger integrity', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1', activeTicket: 'T1' });
  const ledgerFile = join(root, '.adlc', 'session-ledger.jsonl');
  try {
    const tracker = createPersistentTracker(root, env);
    const hugePath = 'src/' + 'a'.repeat(2 * 1024 * 1024) + '.js'; // 2 MiB string
    tracker.recordEdit('sess-huge-path', hugePath);

    assert.ok(existsSync(ledgerFile));
    const ledgerContent = readFileSync(ledgerFile, 'utf8');
    const lines = ledgerContent.split('\n').filter(Boolean);
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.payload.type, 'recordEdit');
    // Ensure the stored filePath in payload is bounded to 512 chars, NOT the 2 MiB string
    assert.ok(parsed.payload.filePath.length <= 512);
    assert.ok(Buffer.byteLength(lines[0], 'utf8') < 2048);

    // Ledger validation succeeds
    assert.equal(tracker.validateLedger('sess-huge-path'), true);
  } finally {
    cleanup();
  }
});

test('isReadonlyCommand: rejects external-diff, textconv, and config override git commands', () => {
  assert.equal(isReadonlyCommand('git status'), true);
  assert.equal(isReadonlyCommand('git rev-parse HEAD'), true);
  assert.equal(isReadonlyCommand('git branch -a'), true);

  // git diff/log/show require both --no-pager AND --no-ext-diff to guarantee no external helper execution
  assert.equal(isReadonlyCommand('git --no-pager diff --no-ext-diff'), true);
  assert.equal(isReadonlyCommand('git --no-pager log --no-ext-diff -n 5'), true);
  assert.equal(isReadonlyCommand('git --no-pager show --no-ext-diff HEAD'), true);

  // Without both --no-pager and --no-ext-diff, diff/log/show can invoke configured helpers
  assert.equal(isReadonlyCommand('git diff'), false);
  assert.equal(isReadonlyCommand('git log -n 5'), false);
  assert.equal(isReadonlyCommand('git show HEAD'), false);
  assert.equal(isReadonlyCommand('git diff --ext-diff'), false);
  assert.equal(isReadonlyCommand('git diff --no-ext-diff'), false); // missing --no-pager
  assert.equal(isReadonlyCommand('git --no-pager diff'), false); // missing --no-ext-diff
  assert.equal(isReadonlyCommand('git diff --textconv'), false);
  assert.equal(isReadonlyCommand('git diff --output=diff.txt'), false);
  assert.equal(isReadonlyCommand('git diff -o diff.txt'), false);
  assert.equal(isReadonlyCommand('git -c diff.external=malicious diff'), false);
  assert.equal(isReadonlyCommand('git --config-env=diff.external=ENV_VAR diff'), false);
  assert.equal(isReadonlyCommand('git log --ext-diff'), false);
  assert.equal(isReadonlyCommand('git show --textconv'), false);
  assert.equal(isReadonlyCommand('git branch new-feature-branch'), false);
  assert.equal(isReadonlyCommand('git checkout main'), false);
});

test('onStop: treats git diff without --no-ext-diff or with external helpers as mutating and requires verification', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1', activeTicket: 'T1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  try {
    const lines = [
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        tool_calls: [
          { name: 'run_command', args: { CommandLine: 'git diff', Cwd: root } },
        ],
        exit_code: 0,
      }),
      JSON.stringify({ content: 'Attempting stop' }),
    ];
    writeFileSync(transcriptFile, lines.join('\n') + '\n');

    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'sess-git-bare-diff',
    };
    preInvocation(payload, { env });
    const tracker = createPersistentTracker(root, env);
    tracker.recordToolCall(payload.conversationId, { isMutating: true });

    const res = onStop(payload, { env });
    assert.equal(res.decision, 'continue');
    assert.match(res.reason, /unverified file edits/i);
  } finally {
    cleanup();
  }
});

test('runFromStdin: denies shell command with Windows backslashes attempting to access .adlc or ticket store', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1', activeTicket: 'T1' });
  try {
    const payload = {
      workspacePaths: [root],
      toolCall: {
        name: 'run_command',
        args: {
          CommandLine: 'powershell -Command Remove-Item .\\.adlc\\tickets.json',
          Cwd: root,
        },
      },
    };
    const res = runFromStdin(JSON.stringify(payload), env);
    assert.equal(res.allow_tool, false);
    assert.match(res.deny_reason, /shell modification of ticket store or trust-root rails is strictly prohibited/);
  } finally {
    cleanup();
  }
});

test('runFromStdin: denies shell command with Windows backslashes targeting .master-key or session secret', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1', activeTicket: 'T1' });
  try {
    const payload = {
      workspacePaths: [root],
      toolCall: {
        name: 'run_command',
        args: {
          CommandLine: 'type ~\\.adlc\\.master-key',
          Cwd: root,
        },
      },
    };
    const res = runFromStdin(JSON.stringify(payload), env);
    assert.equal(res.allow_tool, false);
    assert.match(res.deny_reason, /shell modification of ticket store or trust-root rails is strictly prohibited/);
  } finally {
    cleanup();
  }
});

test('runFromStdin: denies structured write targeting ~/.adlc/.master-key even when outside workspace', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1', activeTicket: 'T1' });
  try {
    const payload = {
      workspacePaths: [root],
      toolCall: {
        name: 'write_to_file',
        args: {
          TargetFile: join(homedir(), '.adlc', '.master-key'),
          CodeContent: 'tampered-key-content',
        },
      },
    };
    const res = runFromStdin(JSON.stringify(payload), env);
    assert.equal(res.allow_tool, false);
    assert.match(res.deny_reason, /modification of master key or trust-root session secrets is strictly prohibited/);
  } finally {
    cleanup();
  }
});

test('onStop: rejects node --test verification when all test files were deleted', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1', activeTicket: 'T1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  try {
    // Delete discoverable tests in workspace
    rmSync(join(root, 'test'), { recursive: true, force: true });

    const lines = [
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        tool_calls: [
          { name: 'replace_file_content', args: { TargetFile: join(root, 'src/feature/code.js') } },
        ],
      }),
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        tool_calls: [
          { name: 'run_command', args: { CommandLine: 'node --test', Cwd: root } },
        ],
        exit_code: 0,
        content: 'ℹ tests 0\nℹ pass 0\n',
      }),
      JSON.stringify({ content: 'Done' }),
    ];
    writeFileSync(transcriptFile, lines.join('\n') + '\n');

    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'sess-zero-tests-deleted',
    };
    preInvocation(payload, { env });
    runFromStdin(JSON.stringify({ ...payload, toolCall: { name: 'replace_file_content', args: { TargetFile: join(root, 'src/feature/code.js') } } }), env);
    runFromStdin(JSON.stringify({ ...payload, toolCall: { name: 'run_command', args: { CommandLine: 'node --test', Cwd: root } } }), env);

    const res = onStop(payload, { env });
    assert.equal(res.decision, 'continue');
    assert.match(res.reason, /unverified file edits/i);
  } finally {
    cleanup();
  }
});

test('onStop: rejects node --test verification when output indicates zero tests executed', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1', activeTicket: 'T1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  try {
    const lines = [
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        tool_calls: [
          { name: 'replace_file_content', args: { TargetFile: join(root, 'src/feature/code.js') } },
        ],
      }),
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        tool_calls: [
          { name: 'run_command', args: { CommandLine: 'node --test', Cwd: root } },
        ],
        exit_code: 0,
        content: 'ℹ tests 0\nℹ pass 0\nℹ duration_ms 1.2\n',
      }),
      JSON.stringify({ content: 'Done' }),
    ];
    writeFileSync(transcriptFile, lines.join('\n') + '\n');

    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'sess-zero-tests-output',
    };
    preInvocation(payload, { env });
    runFromStdin(JSON.stringify({ ...payload, toolCall: { name: 'replace_file_content', args: { TargetFile: join(root, 'src/feature/code.js') } } }), env);
    runFromStdin(JSON.stringify({ ...payload, toolCall: { name: 'run_command', args: { CommandLine: 'node --test', Cwd: root } } }), env);

    const res = onStop(payload, { env });
    assert.equal(res.decision, 'continue');
    assert.match(res.reason, /unverified file edits/i);
  } finally {
    cleanup();
  }
});

test('onStop: rejects Stop when an existing test file was modified or weakened during session', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1', activeTicket: 'T1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  try {
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'sess-weaken-test',
    };
    preInvocation(payload, { env });

    // Mutate code and weaken existing test file
    writeFileSync(join(root, 'test', 'sample.test.js'), '// weakened test file without assertions\n');

    const lines = [
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        tool_calls: [
          { name: 'replace_file_content', args: { TargetFile: join(root, 'src/feature/code.js') } },
        ],
      }),
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        tool_calls: [
          { name: 'replace_file_content', args: { TargetFile: join(root, 'test/sample.test.js') } },
        ],
      }),
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        tool_calls: [
          { name: 'run_command', args: { CommandLine: 'node --test', Cwd: root } },
        ],
        exit_code: 0,
        content: 'ℹ tests 1\nℹ pass 1\n',
      }),
      JSON.stringify({ content: 'Done' }),
    ];
    writeFileSync(transcriptFile, lines.join('\n') + '\n');

    runFromStdin(JSON.stringify({ ...payload, toolCall: { name: 'replace_file_content', args: { TargetFile: join(root, 'src/feature/code.js') } } }), env);
    runFromStdin(JSON.stringify({ ...payload, toolCall: { name: 'replace_file_content', args: { TargetFile: join(root, 'test/sample.test.js') } } }), env);
    runFromStdin(JSON.stringify({ ...payload, toolCall: { name: 'run_command', args: { CommandLine: 'node --test', Cwd: root } } }), env);

    const res = onStop(payload, { env });
    assert.equal(res.decision, 'continue');
    assert.match(res.reason, /Pre-existing test file .* was modified during session, weakening the verification suite/i);
  } finally {
    cleanup();
  }
});

test('onStop: rejects Stop when an existing test file was deleted during session', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1', activeTicket: 'T1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  try {
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'sess-delete-existing-test',
    };
    preInvocation(payload, { env });

    // Delete existing test file but add a replacement
    rmSync(join(root, 'test', 'sample.test.js'), { force: true });
    writeFileSync(join(root, 'test', 'replacement.test.js'), 'import test from "node:test"; test("ok", () => {});\n');

    const lines = [
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        tool_calls: [
          { name: 'replace_file_content', args: { TargetFile: join(root, 'src/feature/code.js') } },
        ],
      }),
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        tool_calls: [
          { name: 'run_command', args: { CommandLine: 'node --test', Cwd: root } },
        ],
        exit_code: 0,
        content: 'ℹ tests 1\nℹ pass 1\n',
      }),
      JSON.stringify({ content: 'Done' }),
    ];
    writeFileSync(transcriptFile, lines.join('\n') + '\n');

    runFromStdin(JSON.stringify({ ...payload, toolCall: { name: 'replace_file_content', args: { TargetFile: join(root, 'src/feature/code.js') } } }), env);
    runFromStdin(JSON.stringify({ ...payload, toolCall: { name: 'run_command', args: { CommandLine: 'node --test', Cwd: root } } }), env);

    const res = onStop(payload, { env });
    assert.equal(res.decision, 'continue');
    assert.match(res.reason, /Pre-existing test file .* was deleted or renamed/i);
  } finally {
    cleanup();
  }
});

test('getTestFilesMap and hasDiscoverableTests: recursively discovers nested monorepo test suites', () => {
  const { root, cleanup } = setupTempRepo({ enforcement: '1' });
  try {
    // Create nested package test suites
    mkdirSync(join(root, 'packages', 'nested-core', 'test'), { recursive: true });
    writeFileSync(join(root, 'packages', 'nested-core', 'test', 'core.test.mjs'), 'import test from "node:test";\n');
    mkdirSync(join(root, 'plugins', 'custom-plugin', 'test'), { recursive: true });
    writeFileSync(join(root, 'plugins', 'custom-plugin', 'test', 'plugin.test.js'), 'import test from "node:test";\n');

    const testMap = getTestFilesMap(root);
    assert.ok(testMap['packages/nested-core/test/core.test.mjs']);
    assert.ok(testMap['plugins/custom-plugin/test/plugin.test.js']);
    assert.ok(hasDiscoverableTests(root));
  } finally {
    cleanup();
  }
});

test('validateBaseline and validateLedger: fail closed when sessions.json baseline fields are tampered with', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1', activeTicket: 'T1' });
  try {
    const tracker = createPersistentTracker(root, env);
    tracker.recordActiveTicket('sess-tamper-baseline', 'T1', 'store-hash-1');
    tracker.recordToolCall('sess-tamper-baseline', { isMutating: true });

    assert.equal(tracker.validateBaseline('sess-tamper-baseline'), true);
    assert.equal(tracker.validateLedger('sess-tamper-baseline'), true);

    // Tamper with initialActiveTicket in sessions.json
    const sessionsFile = join(root, '.adlc', 'sessions.json');
    const store = JSON.parse(readFileSync(sessionsFile, 'utf8'));
    store['sess-tamper-baseline'].initialActiveTicket = 'TAMPERED_TICKET_ID';
    writeFileSync(sessionsFile, JSON.stringify(store));

    // Must fail closed because it disagrees with canonical ledger
    assert.equal(tracker.validateBaseline('sess-tamper-baseline'), false);
    assert.equal(tracker.validateLedger('sess-tamper-baseline'), false);
  } finally {
    cleanup();
  }
});

test('createPersistentTracker: rejects symlinked session ledger file', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1' });
  const externalTarget = join(tmpdir(), `external-target-${Date.now()}.jsonl`);
  writeFileSync(externalTarget, '');
  try {
    const ledgerFile = join(root, '.adlc', 'session-ledger.jsonl');
    symlinkSync(externalTarget, ledgerFile);

    const tracker = createPersistentTracker(root, env);
    // Attempting to append to a symlinked ledger must fail closed (return null) and not write to external target
    const res = tracker.recordToolCall('sess-symlink', { isMutating: true });
    assert.equal(readFileSync(externalTarget, 'utf8'), '');
  } finally {
    try { unlinkSync(externalTarget); } catch {}
    cleanup();
  }
});

test('decide: denies structured target payloads via terminal_modify and custom_shell targeting trust root', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1', activeTicket: 'T1' });
  try {
    const payload1 = {
      workspacePaths: [root],
      toolCall: {
        name: 'terminal_modify',
        args: {
          TargetFile: join(root, '.adlc', 'tickets.json'),
          CodeContent: '{"tickets":{}}',
        },
      },
    };
    const res1 = runFromStdin(JSON.stringify(payload1), env);
    assert.equal(res1.allow_tool, false);
    assert.match(res1.deny_reason, /frozen rail/i);

    const payload2 = {
      workspacePaths: [root],
      toolCall: {
        name: 'custom_shell',
        args: {
          TargetFile: join(root, '.adlc', 'tickets.json'),
          CodeContent: '{"tickets":{}}',
        },
      },
    };
    const res2 = runFromStdin(JSON.stringify(payload2), env);
    assert.equal(res2.allow_tool, false);
    assert.match(res2.deny_reason, /frozen rail/i);
  } finally {
    cleanup();
  }
});

test('getTestFilesMap and onStop: discovers and protects deep test suites beyond 6 directory levels', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1', activeTicket: 'T1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  try {
    // Create test suite 8 levels deep: nested/d1/d2/d3/d4/d5/d6/d7/deep.test.js
    const deepDir = join(root, 'nested', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7');
    mkdirSync(deepDir, { recursive: true });
    const deepFile = join(deepDir, 'deep.test.js');
    writeFileSync(deepFile, 'import test from "node:test"; test("deep", () => {});\n');

    const testMap = getTestFilesMap(root);
    assert.ok(testMap['nested/d1/d2/d3/d4/d5/d6/d7/deep.test.js']);

    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'sess-deep-test',
    };
    preInvocation(payload, { env });

    // Modify the deep test file (weakening it)
    writeFileSync(deepFile, '// weakened\n');

    const lines = [
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        tool_calls: [
          { name: 'replace_file_content', args: { TargetFile: join(root, 'src/feature/code.js') } },
        ],
      }),
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        tool_calls: [
          { name: 'run_command', args: { CommandLine: 'node --test', Cwd: root } },
        ],
        exit_code: 0,
        content: 'ℹ tests 1\nℹ pass 1\n',
      }),
      JSON.stringify({ content: 'Done' }),
    ];
    writeFileSync(transcriptFile, lines.join('\n') + '\n');

    runFromStdin(JSON.stringify({ ...payload, toolCall: { name: 'replace_file_content', args: { TargetFile: join(root, 'src/feature/code.js') } } }), env);
    runFromStdin(JSON.stringify({ ...payload, toolCall: { name: 'run_command', args: { CommandLine: 'node --test', Cwd: root } } }), env);

    const res = onStop(payload, { env });
    assert.equal(res.decision, 'continue');
    assert.match(res.reason, /Pre-existing test file .* was modified during session, weakening the verification suite/i);
  } finally {
    cleanup();
  }
});

test('decide: denies obfuscated shell commands targeting master key or escaping workspace', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1', activeTicket: 'T1' });
  try {
    const commands = [
      "find /home -type f -name '.[m]aster-key' -exec cat {} +",
      "find .. -name '.[a]dlc' -exec ls {} +",
      "cat ~/.adlc/.master-key",
      "cat $HOME/.config/adlc/secrets/.auth-key",
      "cat /dev/shm/.adlc/secrets",
      "find /etc -name 'passwd'",
      "cat ../../../.adlc/.master-key",
      "cat '.[m]aster-key'",
      'cat ".[a]dlc/session-secret"',
    ];

    for (const cmd of commands) {
      const payload = {
        workspacePaths: [root],
        toolCall: {
          name: 'run_command',
          args: { CommandLine: cmd, Cwd: root },
        },
      };
      const res = runFromStdin(JSON.stringify(payload), env);
      assert.equal(res.allow_tool, false, `Expected deny for: ${cmd}`);
      assert.match(res.deny_reason, /(strictly prohibited|filesystem paths outside workspace)/i);
    }
  } finally {
    cleanup();
  }
});

test('postToolUse and onStop: invalidate and reject session if secret disclosure occurs', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1', activeTicket: 'T1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  try {
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'sess-secret-leak',
    };
    preInvocation(payload, { env });

    const secret = getOrCreateSessionSecret(root, env);
    assert.ok(secret);

    // Simulate tool output that leaks the secret
    postToolUse({
      ...payload,
      output: `Leaked secret: ${secret}`,
    }, { env });

    // The session should now be invalidated in the tracker
    const tracker = createPersistentTracker(root, env);
    assert.equal(tracker.isCorrupted(), true);

    // In addition, if transcript contains the secret, onStop must reject completion
    writeFileSync(transcriptFile, JSON.stringify({ content: `Disclosed: ${secret}` }) + '\n');
    const res = onStop(payload, { env });
    assert.equal(res.decision, 'continue');
    assert.match(res.reason, /(Secret disclosure detected in session transcript|Session tracking store was corrupted|Session invalidated due to secret disclosure)/i);
  } finally {
    cleanup();
  }
});

test('decide: denies structured writes targeting ~/.config/adlc/secrets/.auth-key and ~/.config/adlc', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1', activeTicket: 'T1' });
  const home = homedir() || '';
  try {
    const targets = [
      join(home, '.config', 'adlc', 'secrets', '.auth-key'),
      '~/.config/adlc/secrets/.auth-key',
      join(home, '.config', 'adlc', 'secrets'),
    ];

    for (const target of targets) {
      const payload = {
        workspacePaths: [root],
        toolCall: {
          name: 'write_to_file',
          args: { TargetFile: target, CodeContent: 'tampered-key' },
        },
      };
      const res = runFromStdin(JSON.stringify(payload), env);
      assert.equal(res.allow_tool, false, `Expected deny for target: ${target}`);
      assert.match(res.deny_reason, /strictly prohibited|frozen rail/i);
    }
  } finally {
    cleanup();
  }
});

test('postToolUse and fresh process: secret disclosure invalidation is durable in ledger across fresh tracker instances', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1', activeTicket: 'T1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  try {
    const sessionID = 'durable-leak-sess';
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: sessionID,
    };
    preInvocation(payload, { env });

    const secret = getOrCreateSessionSecret(root, env);
    assert.ok(secret);

    // Disclose secret in postToolUse
    postToolUse({
      ...payload,
      output: `Leaked secret: ${secret}`,
    }, { env });

    // In a completely fresh process / tracker instance
    const freshTracker = createPersistentTracker(root, env);
    assert.equal(freshTracker.isInvalidated(sessionID), true);

    // Any subsequent tool call in this session must be denied
    const mutatePayload = {
      ...payload,
      toolCall: {
        name: 'replace_file_content',
        args: { TargetFile: join(root, 'src/feature/code.js'), ReplacementContent: 'x' },
      },
    };
    const decideRes = runFromStdin(JSON.stringify(mutatePayload), env);
    assert.equal(decideRes.allow_tool, false);
    assert.match(decideRes.deny_reason, /session invalidated due to secret disclosure/i);

    // onStop must also reject
    const stopRes = onStop(payload, { env });
    assert.equal(stopRes.decision, 'continue');
    assert.match(stopRes.reason, /(Session invalidated due to secret disclosure|Session tracking store was corrupted)/i);
  } finally {
    cleanup();
  }
});

test('isReadonlyCommand: rejects file reading commands targeting paths outside workspace', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1', activeTicket: 'T1' });
  try {
    const externalReads = [
      'cat /proc/self/environ',
      'cat /tmp/other-secret',
      'head /etc/passwd',
      'tail /var/log/syslog',
      'cat ../external.txt',
    ];

    for (const cmd of externalReads) {
      assert.equal(isReadonlyCommand(cmd, { root }), false, `Expected non-readonly for: ${cmd}`);
      const payload = {
        workspacePaths: [root],
        toolCall: {
          name: 'run_command',
          args: { CommandLine: cmd, Cwd: root },
        },
      };
      const res = runFromStdin(JSON.stringify(payload), env);
      assert.equal(res.allow_tool, false, `Expected deny for: ${cmd}`);
    }

    // Inside workspace should be allowed
    writeFileSync(join(root, 'package.json'), '{}');
    assert.equal(isReadonlyCommand('cat package.json', { root }), true);
    assert.equal(isReadonlyCommand('head package.json', { root }), true);
  } finally {
    cleanup();
  }
});

test('getTestFilesMap and onStop: baselines test/foo.js, test/foo.cjs, test/foo_test.js, test/test.js and rejects modification/deletion', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1', activeTicket: 'T1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  try {
    mkdirSync(join(root, 'test'), { recursive: true });
    writeFileSync(join(root, 'test/foo.js'), 'console.log("foo test");');
    writeFileSync(join(root, 'test/foo.cjs'), 'console.log("foo cjs test");');
    writeFileSync(join(root, 'test/foo_test.js'), 'console.log("foo_test");');
    writeFileSync(join(root, 'test/test.js'), 'console.log("test.js");');

    const testMap = getTestFilesMap(root);
    assert.ok(testMap['test/foo.js']);
    assert.ok(testMap['test/foo.cjs']);
    assert.ok(testMap['test/foo_test.js']);
    assert.ok(testMap['test/test.js']);

    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'sess-node-tests',
    };
    preInvocation(payload, { env });

    // Modifying test/foo.js must cause onStop to reject
    writeFileSync(join(root, 'test/foo.js'), 'console.log("weakened");');
    const lines = [
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        tool_calls: [
          { name: 'replace_file_content', args: { TargetFile: join(root, 'src/feature/code.js') } },
        ],
      }),
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        tool_calls: [
          { name: 'run_command', args: { CommandLine: 'node --test', Cwd: root } },
        ],
        exit_code: 0,
        content: 'ℹ tests 4\nℹ pass 4\n',
      }),
    ];
    writeFileSync(transcriptFile, lines.join('\n') + '\n');
    runFromStdin(JSON.stringify({ ...payload, toolCall: { name: 'replace_file_content', args: { TargetFile: join(root, 'src/feature/code.js') } } }), env);
    runFromStdin(JSON.stringify({ ...payload, toolCall: { name: 'run_command', args: { CommandLine: 'node --test', Cwd: root } } }), env);

    const resMod = onStop(payload, { env });
    assert.equal(resMod.decision, 'continue');
    assert.match(resMod.reason, /Pre-existing test file "test\/foo\.js" was modified during session/i);

    // Deleting test/foo.cjs must also cause onStop to reject
    unlinkSync(join(root, 'test/foo.cjs'));
    const resDel = onStop(payload, { env });
    assert.equal(resDel.decision, 'continue');
    assert.match(resDel.reason, /Pre-existing test file "test\/foo\.cjs" was deleted or renamed/i);
  } finally {
    cleanup();
  }
});

test('getOrCreateSessionSecret: rejects world-readable legacy master key with mode 0644', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1', activeTicket: 'T1' });
  const tmpHome = join(root, 'custom-isolated-home');
  const legacyDir = join(tmpHome, '.adlc');
  const legacyKey = join(legacyDir, '.master-key');
  const privateDir = join(tmpHome, '.config', 'adlc', 'secrets');
  const authKey = join(privateDir, '.auth-key');
  try {
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(legacyKey, 'a'.repeat(64), { mode: 0o644 });
    chmodSync(legacyKey, 0o644);

    const testEnv = { ...env, ADLC_HOME_DIR: tmpHome };
    const secret = getOrCreateSessionSecret(root, testEnv);
    assert.ok(secret);
    assert.ok(existsSync(authKey));
    const authStat = statSync(authKey);
    assert.equal(authStat.mode & 0o077, 0);
  } finally {
    cleanup();
  }
});

test('decide: denies view_file and readonly tools targeting master key or session secret', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1', activeTicket: 'T1' });
  try {
    const targets = [
      '~/.config/adlc/secrets/.auth-key',
      '~/.adlc/.master-key',
      join(root, '.adlc', '.session-secret'),
      join(root, '.adlc', 'sessions.json'),
      join(root, '.adlc', 'session-ledger.jsonl'),
    ];

    for (const target of targets) {
      const payload = {
        workspacePaths: [root],
        toolCall: {
          name: 'view_file',
          args: { AbsolutePath: target },
        },
      };
      const res = runFromStdin(JSON.stringify(payload), env);
      assert.equal(res.allow_tool, false, `Expected deny for view_file on: ${target}`);
      assert.match(res.deny_reason, /frozen rail — (modification|access).*master key or trust-root session secrets/i);
    }
  } finally {
    cleanup();
  }
});

test('isReadonlyCommand: rejects symlink in workspace pointing to secrets or outside workspace', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1', activeTicket: 'T1' });
  try {
    // Create symlink pointing outside workspace to /etc/passwd
    const externalLink = join(root, 'link-passwd');
    try {
      symlinkSync('/etc/passwd', externalLink);
      assert.equal(isReadonlyCommand(`cat ${externalLink}`, { root }), false);
      assert.equal(isReadonlyCommand('cat link-passwd', { root }), false);
    } catch {}

    // Create symlink pointing to session secret
    const secretLink = join(root, 'link-secret');
    try {
      symlinkSync(join(root, '.adlc', '.session-secret'), secretLink);
      assert.equal(isReadonlyCommand(`cat ${secretLink}`, { root }), false);
      assert.equal(isReadonlyCommand('cat link-secret', { root }), false);
    } catch {}
  } finally {
    cleanup();
  }
});

test('getTestFilesMap and onStop: discovers and protects .jsx, .mts, and .cts test files', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1', activeTicket: 'T1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  try {
    mkdirSync(join(root, 'test'), { recursive: true });
    writeFileSync(join(root, 'test/Button.test.jsx'), '// jsx test');
    writeFileSync(join(root, 'test/handler.test.mts'), '// mts test');
    writeFileSync(join(root, 'test/service.test.cts'), '// cts test');

    const testMap = getTestFilesMap(root);
    assert.ok(testMap['test/Button.test.jsx']);
    assert.ok(testMap['test/handler.test.mts']);
    assert.ok(testMap['test/service.test.cts']);

    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'sess-modern-ext-tests',
    };
    preInvocation(payload, { env });

    // Modifying Button.test.jsx must cause onStop to reject
    writeFileSync(join(root, 'test/Button.test.jsx'), '// weakened');
    const lines = [
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        tool_calls: [
          { name: 'replace_file_content', args: { TargetFile: join(root, 'src/feature/code.js') } },
        ],
      }),
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        tool_calls: [
          { name: 'run_command', args: { CommandLine: 'node --test', Cwd: root } },
        ],
        exit_code: 0,
        content: 'ℹ tests 4\nℹ pass 4\n',
      }),
    ];
    writeFileSync(transcriptFile, lines.join('\n') + '\n');
    runFromStdin(JSON.stringify({ ...payload, toolCall: { name: 'replace_file_content', args: { TargetFile: join(root, 'src/feature/code.js') } } }), env);
    runFromStdin(JSON.stringify({ ...payload, toolCall: { name: 'run_command', args: { CommandLine: 'node --test', Cwd: root } } }), env);

    const resMod = onStop(payload, { env });
    assert.equal(resMod.decision, 'continue');
    assert.match(resMod.reason, /Pre-existing test file "test\/Button\.test\.jsx" was modified during session/i);
  } finally {
    cleanup();
  }
});

test('decide and onStop: denies shell reads and writes through symlinks targeting trust root', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1', activeTicket: 'T1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  try {
    const sessionSecretFile = join(root, '.adlc', '.session-secret');
    writeFileSync(sessionSecretFile, 'secret-content');

    // Create innocent-looking symlink inside workspace pointing to session secret
    const innocentLink = join(root, 'innocent-link.txt');
    symlinkSync(sessionSecretFile, innocentLink);

    // 1. Live PreToolUse decide() check on reads through symlink (grep, base64, cat)
    const readCommands = [
      'grep "" innocent-link.txt',
      'base64 innocent-link.txt',
      'cat innocent-link.txt',
      'head innocent-link.txt',
    ];
    for (const cmd of readCommands) {
      const payload = {
        workspacePaths: [root],
        toolCall: {
          name: 'run_command',
          args: { CommandLine: cmd, Cwd: root },
        },
      };
      const res = runFromStdin(JSON.stringify(payload), env);
      assert.equal(res.allow_tool, false, `Expected deny for read command: ${cmd}`);
      assert.match(res.deny_reason, /strictly prohibited|symlink targeting trust root/i);
    }

    // 2. Live PreToolUse decide() check on writes through symlink (echo >, tee, cp)
    const writeCommands = [
      'echo "pwned" > innocent-link.txt',
      'tee innocent-link.txt',
      'cp package.json innocent-link.txt',
    ];
    for (const cmd of writeCommands) {
      const payload = {
        workspacePaths: [root],
        toolCall: {
          name: 'run_command',
          args: { CommandLine: cmd, Cwd: root },
        },
      };
      const res = runFromStdin(JSON.stringify(payload), env);
      assert.equal(res.allow_tool, false, `Expected deny for write command: ${cmd}`);
      assert.match(res.deny_reason, /strictly prohibited|symlink targeting trust root/i);
    }

    // 3. onStop audit check: if transcript records a command targeting the symlink, onStop must reject
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'sess-symlink-audit',
    };
    preInvocation(payload, { env });

    const lines = [
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        tool_calls: [{ name: 'run_command', args: { CommandLine: 'grep "" innocent-link.txt', Cwd: root } }],
      }),
    ];
    writeFileSync(transcriptFile, lines.join('\n') + '\n');
    const stopRes = onStop(payload, { env });
    assert.equal(stopRes.decision, 'continue');
    assert.match(stopRes.reason, /Shell modification of trust-root store or transcript is strictly prohibited/i);
  } finally {
    cleanup();
  }
});

test('isShellTool: reclassifies disguised exec tool carrying TargetFile as non-shell (mutating)', () => {
  const args = { TargetFile: '.adlc/tickets.json', operation: 'overwrite', content: 'hack' };
  assert.equal(isShellTool('exec', args), false);
  assert.equal(isShellTool('bash', args), false);
  assert.equal(isShellTool('run', args), false);
});

test('onStop: disguised exec-named mutator targeting frozen rail is caught and rejected', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1', activeTicket: 'T1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  try {
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'sess-disguised-exec',
    };
    preInvocation(payload, { env });

    const lines = [
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        tool_calls: [{ name: 'exec', args: { TargetFile: join(root, '.adlc/tickets.json'), operation: 'overwrite', content: '{}' } }],
      }),
    ];
    writeFileSync(transcriptFile, lines.join('\n') + '\n');
    const stopRes = onStop(payload, { env });
    assert.equal(stopRes.decision, 'continue');
    assert.match(stopRes.reason, /Active ticket contract or trust-root store was modified during session/i);
  } finally {
    cleanup();
  }
});

test('getTestFilesMap: discovers symlinked test directories and files under __tests__', () => {
  const { root, cleanup } = setupTempRepo();
  try {
    // 1. Files under __tests__
    mkdirSync(join(root, '__tests__'), { recursive: true });
    writeFileSync(join(root, '__tests__/unit.js'), 'console.log("unit test");');

    // 2. Symlinked test directory
    const realTestsDir = join(root, 'actual_tests');
    mkdirSync(realTestsDir, { recursive: true });
    writeFileSync(join(realTestsDir, 'suite.js'), 'console.log("suite");');
    const symlinkDir = join(root, 'specs');
    symlinkSync(realTestsDir, symlinkDir);

    const map = getTestFilesMap(root);
    assert.ok(map['__tests__/unit.js'], 'Expected __tests__/unit.js to be discovered');
    assert.ok(map['specs/suite.js'], 'Expected specs/suite.js through symlink to be discovered');
  } finally {
    cleanup();
  }
});

test('checkBuildGate and validateBaseline: fail closed when sessions.json and session-ledger.jsonl are both deleted mid-session', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1', activeTicket: 'T1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  try {
    const cid = 'sess-wiped-tracking';
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: cid,
    };
    preInvocation(payload, { env });

    // Mark high-risk ticket
    const ticketStore = {
      version: 1,
      tickets: [{ id: 'T1', title: 'High Risk Arch', category: 'architecture', rails: [], scope: ['src/**'] }],
    };
    writeFileSync(join(root, '.adlc', 'tickets.json'), JSON.stringify(ticketStore));

    // Add tool call to transcript
    const lines = [
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        tool_calls: [{ name: 'write_to_file', args: { TargetFile: join(root, 'src/code.js'), CodeContent: 'x' } }],
      }),
    ];
    writeFileSync(transcriptFile, lines.join('\n') + '\n');

    // Wipe both sessions.json and session-ledger.jsonl
    unlinkSync(join(root, '.adlc', 'sessions.json'));
    if (existsSync(join(root, '.adlc', 'session-ledger.jsonl'))) {
      unlinkSync(join(root, '.adlc', 'session-ledger.jsonl'));
    }

    const tracker = createPersistentTracker(root, env);
    // validateBaseline must fail closed because transcript has tool calls but tracking was wiped!
    assert.equal(tracker.validateBaseline(cid), false);

    // checkBuildGate must also deny
    const gateRes = checkBuildGate({ sessionID: cid, tracker, root, env });
    assert.equal(gateRes.decision, 'deny');
    assert.match(gateRes.reason, /(tampering detected|Session baseline signature mismatch|tracking store was removed mid-session)/i);
  } finally {
    cleanup();
  }
});




















