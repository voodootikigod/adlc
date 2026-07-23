// subagent.test.mjs — T67 AC11/AC12: P5 marker + Task/subagent policy.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeP5Marker, clearP5Marker, readP5Marker } from '../lib/session-state.mjs';
import { decideP5SubagentPolicy } from '../lib/p5-subagent-policy.mjs';
import { handleSubagentStart } from '../hooks/adlc-subagent.mjs';
import { handlePreCompact } from '../hooks/adlc-precompact.mjs';
import { dispatch } from '../hooks/adlc-pretool.mjs';
import { mergeHooks } from '../lib/scaffold.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, 'fixtures');

function stateEnv() {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-p5-'));
  return { env: { ADLC_CURSOR_STATE_DIR: dir }, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('no marker → ordinary explore/shell allowed on subagentStart + preToolUse Task', async () => {
  const { env, cleanup } = stateEnv();
  try {
    const payload = JSON.parse(readFileSync(join(FIX, 'pretool-task-unrelated.json'), 'utf8'));
    const sub = handleSubagentStart(payload, { env });
    assert.equal(sub.permission, 'allow');
    const d = await dispatch(payload, { env });
    assert.equal(d.permission, 'allow');
  } finally { cleanup(); }
});

test('fresh matching marker allows prosecutor Task; asks/denies unrelated', async () => {
  const { env, cleanup } = stateEnv();
  try {
    writeP5Marker({ sessionId: 'sess-p5-a', ticketId: 'T1', runId: 'run-1', env });
    const okPayload = JSON.parse(readFileSync(join(FIX, 'pretool-task-prosecutor.json'), 'utf8'));
    const badPayload = JSON.parse(readFileSync(join(FIX, 'pretool-task-unrelated.json'), 'utf8'));

    assert.equal((await dispatch(okPayload, { env })).permission, 'allow');
    assert.equal(handleSubagentStart(
      JSON.parse(readFileSync(join(FIX, 'subagent-start-prosecutor.json'), 'utf8')),
      { env },
    ).permission, 'allow');

    const unrelated = await dispatch(badPayload, { env });
    assert.ok(['ask', 'deny'].includes(unrelated.permission), unrelated.permission);
    const subBad = handleSubagentStart(badPayload, { env });
    assert.ok(['ask', 'deny'].includes(subBad.permission));
  } finally { cleanup(); }
});

test('session A marker must not restrict session B', async () => {
  const { env, cleanup } = stateEnv();
  try {
    writeP5Marker({ sessionId: 'sess-A', ticketId: 'T1', runId: 'run-a', env });
    const b = {
      session_id: 'sess-B',
      tool_name: 'Task',
      tool_input: { subagent_type: 'shell' },
      tool_use_id: 'tu-b',
    };
    assert.equal((await dispatch(b, { env })).permission, 'allow');
    assert.equal(handleSubagentStart(b, { env }).permission, 'allow');
  } finally { cleanup(); }
});

test('barrier: overlapping cleanup must not delete the newer runId', () => {
  const { env, cleanup } = stateEnv();
  try {
    writeP5Marker({ sessionId: 'sess-x', ticketId: 'T1', runId: 'run-old', env });
    // A reads for cleanup
    const seen = readP5Marker('sess-x', { env });
    assert.equal(seen.runId, 'run-old');
    // B replaces
    writeP5Marker({ sessionId: 'sess-x', ticketId: 'T1', runId: 'run-new', env });
    // A resumes with stale runId — must not delete B
    assert.equal(clearP5Marker({ sessionId: 'sess-x', runId: 'run-old', env }), false);
    assert.equal(readP5Marker('sess-x', { env })?.runId, 'run-new');
    assert.equal(clearP5Marker({ sessionId: 'sess-x', runId: 'run-new', env }), true);
  } finally { cleanup(); }
});

test('anonymous marker does not restrict a named session', async () => {
  const { env, cleanup } = stateEnv();
  try {
    writeP5Marker({ sessionId: null, ticketId: 'T1', runId: 'anon-1', env });
    const named = {
      session_id: 'named-1',
      tool_name: 'Task',
      tool_input: { subagent_type: 'shell' },
    };
    assert.equal((await dispatch(named, { env })).permission, 'allow');
  } finally { cleanup(); }
});

test('preCompact is observational and mentions ticket when resolvable', () => {
  const out = handlePreCompact({ session_id: 's1' }, { env: {} });
  assert.ok(out.user_message.includes('ADLC'));
  assert.ok(!('permission' in out) || out.permission !== 'deny');
});

test('scaffold mergeHooks wires preCompact + subagentStart/Stop', () => {
  const merged = mergeHooks({});
  assert.ok(merged.hooks.preCompact?.some((e) => /adlc-precompact/.test(e.command)));
  assert.ok(merged.hooks.subagentStart?.some((e) => /adlc-subagent/.test(e.command)));
  assert.ok(merged.hooks.subagentStop?.some((e) => /adlc-subagent/.test(e.command) && /--stop/.test(e.command)));
  for (const e of [...merged.hooks.preCompact, ...merged.hooks.subagentStart, ...merged.hooks.subagentStop]) {
    assert.equal(e.failClosed, false);
    assert.equal(e.timeout, 10);
  }
});

test('decideP5SubagentPolicy unit: stale marker ≡ absent', () => {
  const { env, cleanup } = stateEnv();
  try {
    const now = Date.now();
    writeP5Marker({ sessionId: 's-stale', ticketId: 'T1', runId: 'r1', env, now: now - 1 });
    const d = decideP5SubagentPolicy({
      session_id: 's-stale',
      tool_input: { subagent_type: 'shell' },
    }, { env, now: now + 10 ** 12 }); // far future → TTL expired
    assert.equal(d.permission, 'allow');
  } finally { cleanup(); }
});
