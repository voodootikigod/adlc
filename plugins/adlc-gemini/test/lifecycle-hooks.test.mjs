import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { preInvocation, onStop } from '../hooks/adlc-rails-guard.mjs';
import { ticketFilename } from '../generated-ticket-reader.mjs';

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

  const env = {
    ADLC_P4_ENFORCEMENT: enforcement,
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
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'npm test' } }],
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

test('onStop: handles scalar null and string lines in transcript without crashing', () => {
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
    assert.equal(res.decision, 'stop');
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
      toolCalls: [{ name: 'run_command', args: { CommandLine: 'npm test' } }],
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
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'npm test' } }],
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
      conversationId: 'test-session-123',
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
      conversationId: 'test-session-123',
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
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'npm test' } }],
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
      conversationId: 'test-session-123',
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
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'npm test' } }],
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
    const res = onStop(payload, { env: { ...env, ANTIGRAVITY_WORKSPACE: undefined, INIT_CWD: undefined, PWD: '/nonexistent' } });
    assert.equal(res.reason, undefined);
    assert.equal(res.decision, 'stop');
  } finally {
    try { rmSync(transcriptFile, { force: true }); } catch (_) {}
    cleanup();
  }
});
