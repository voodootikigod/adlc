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

test('onStop: intercepts unverified completion claims when enforcement is active', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  writeFileSync(transcriptFile, JSON.stringify({ content: 'Work finished. TICKET-DONE' }) + '\n');
  try {
    const payload = {
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'test-session-123',
    };
    const res = onStop(payload, { env });
    assert.equal(res.decision, 'continue');
    assert.match(res.reason, /requires running test\/verification commands before completing/);
  } finally {
    cleanup();
  }
});

test('onStop: allows stop when tests were executed before completion claim', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  const lines = [
    JSON.stringify({ content: 'Running test suite: npm test' }),
    JSON.stringify({ content: 'All tests passed. TICKET-DONE' }),
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

test('onStop: allows stop when session concludes without claiming TICKET-DONE', () => {
  const { root, env, cleanup } = setupTempRepo({ enforcement: '1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  writeFileSync(transcriptFile, JSON.stringify({ content: 'Still thinking...' }) + '\n');
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
