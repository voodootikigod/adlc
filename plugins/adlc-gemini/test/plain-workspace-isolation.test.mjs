// plain-workspace-isolation.test.mjs — a plain workspace (no .git, no .adlc)
// governed by an external ticket store is enforced against its own root even
// when a directory above it holds an unrelated .adlc, and the hook never
// writes into that foreign .adlc. The fixture reproduces a host-wide
// `/tmp/.adlc` by nesting the workspace under a parent that carries one.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { tmp } from '@adlc/core/test-kit';
import { onStop, preInvocation, runFromStdin } from '../hooks/adlc-rails-guard.mjs';
import { plainWorkspaceEnv } from './plain-workspace-env.mjs';

const FOREIGN_LEDGER = '{"not":"a ledger entry for this workspace"}\n';
const FOREIGN_SESSIONS = '{"foreign-session":{"corrupt":true}}';

function contaminatedPlainWorkspace(t) {
  const parent = tmp(t, 'gemini-plain-parent-');
  mkdirSync(join(parent, '.adlc'), { recursive: true });
  writeFileSync(join(parent, '.adlc', 'session-ledger.jsonl'), FOREIGN_LEDGER);
  writeFileSync(join(parent, '.adlc', 'sessions.json'), FOREIGN_SESSIONS);
  const ws = join(parent, 'ws');
  mkdirSync(join(ws, 'src'), { recursive: true });
  writeFileSync(join(ws, 'src', 'frozen.js'), '// frozen');
  writeFileSync(join(ws, 'src', 'editable.js'), '// work');
  mkdirSync(join(ws, 'test'), { recursive: true });
  writeFileSync(join(ws, 'test', 'sample.test.js'), 'import test from "node:test"; test("ok", () => {});\n');
  const storeDir = tmp(t, 'gemini-plain-store-');
  const store = join(storeDir, 'tickets.json');
  writeFileSync(store, JSON.stringify({ version: 1, tickets: [{ id: 'T1', title: 'External Ticket', rails: ['src/frozen.js'] }] }));
  const env = plainWorkspaceEnv({ workspace: ws, store, home: tmp(t, 'gemini-plain-home-') });
  return { parent, ws, env };
}

function assertForeignAdlcUntouched(parent) {
  const dir = join(parent, '.adlc');
  assert.deepEqual(readdirSync(dir).sort(), ['session-ledger.jsonl', 'sessions.json']);
  assert.equal(readFileSync(join(dir, 'session-ledger.jsonl'), 'utf8'), FOREIGN_LEDGER);
  assert.equal(readFileSync(join(dir, 'sessions.json'), 'utf8'), FOREIGN_SESSIONS);
}

test('a frozen rail in a plain workspace is denied for its own reason under a foreign .adlc', (t) => {
  const { parent, ws, env } = contaminatedPlainWorkspace(t);
  const v = runFromStdin(JSON.stringify({
    workspacePaths: [ws],
    toolCall: { name: 'write_to_file', args: { TargetFile: join(ws, 'src/frozen.js') } },
  }), env);
  assert.equal(v.allow_tool, false);
  assert.match(v.deny_reason, /frozen rail/);
  assertForeignAdlcUntouched(parent);
});

test('a plain workspace completes its lifecycle under a foreign .adlc without writing to it', (t) => {
  const { parent, ws, env } = contaminatedPlainWorkspace(t);
  const transcriptFile = join(ws, 'transcript.jsonl');
  writeFileSync(transcriptFile, [
    JSON.stringify({ type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'write_to_file', args: { TargetFile: join(ws, 'src/editable.js'), CodeContent: '// edit' } }] }),
    JSON.stringify({ type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'run_command', args: { CommandLine: 'node --test', Cwd: ws } }], exit_code: 0 }),
    JSON.stringify({ content: 'Finished.' }),
  ].join('\n') + '\n');
  const payload = { workspacePaths: [ws], transcriptPath: transcriptFile, conversationId: 'sess-plain-isolated' };
  preInvocation(payload, { env });
  const edit = runFromStdin(JSON.stringify({ ...payload, toolCall: { name: 'write_to_file', args: { TargetFile: join(ws, 'src/editable.js'), CodeContent: '// edit' } } }), env);
  assert.equal(edit.allow_tool, true, edit.deny_reason);
  const run = runFromStdin(JSON.stringify({ ...payload, toolCall: { name: 'run_command', args: { CommandLine: 'node --test', Cwd: ws } } }), env);
  assert.equal(run.allow_tool, true, run.deny_reason);
  const stop = onStop(payload, { env });
  assert.equal(stop.decision, 'stop', stop.reason);
  assertForeignAdlcUntouched(parent);
  assert.equal(existsSync(join(ws, '.adlc', 'sessions.json')), true, 'session state belongs to the workspace');
});
