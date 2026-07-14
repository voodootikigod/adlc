import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', 'adlc-lifecycle.mjs');

function fixture(fn) {
  const root = mkdtempSync(join(tmpdir(), 'adlc-codex-lifecycle-'));
  mkdirSync(join(root, '.adlc'), { recursive: true });
  writeFileSync(join(root, '.adlc/tickets.json'), `${JSON.stringify({ tickets: [{ id: 'T1', title: 'Lifecycle', scope: ['src/**'], rails: ['test/**'], edges: [] }] }, null, 2)}\n`);
  writeFileSync(join(root, '.adlc/current-ticket.json'), '{"id":"T1"}\n');
  try { return fn(root); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

function run(root, mode, payload, env = {}) {
  return spawnSync(process.execPath, [HOOK, mode], {
    cwd: root,
    env: { ...process.env, PLUGIN_DATA: join(root, '.plugin-data'), ...env },
    input: JSON.stringify({ cwd: root, ...payload }),
    encoding: 'utf8',
  });
}

test('injects current ADLC context into sessions and subagents', () => {
  fixture((root) => {
    for (const event of ['SessionStart', 'SubagentStart']) {
      const result = run(root, 'context', { hook_event_name: event });
      assert.equal(result.status, 0);
      const output = JSON.parse(result.stdout);
      assert.equal(output.hookSpecificOutput.hookEventName, event);
      assert.match(output.hookSpecificOutput.additionalContext, /current ticket: T1/);
      assert.match(output.hookSpecificOutput.additionalContext, /rail protection auto-active/);
    }
    const compact = JSON.parse(run(root, 'context', { hook_event_name: 'PostCompact' }).stdout);
    assert.match(compact.systemMessage, /current ticket: T1/);
  });
});

test('flail advisory stays silent until the same failure repeats three times', () => {
  fixture((root) => {
    const payload = { hook_event_name: 'PostToolUse', tool_name: 'exec_command', tool_response: 'Error: build failed with exit code 1' };
    assert.equal(run(root, 'flail', payload).stdout, '');
    assert.equal(run(root, 'flail', payload).stdout, '');
    const third = run(root, 'flail', payload);
    assert.equal(third.status, 0);
    assert.match(JSON.parse(third.stdout).systemMessage, /repeated 3 times/);
  });
});

test('advisory verification and malformed state warn but always exit zero', () => {
  fixture((root) => {
    const verify = run(root, 'verify', { hook_event_name: 'Stop' }, { ADLC_CLI_COMMAND: join(root, 'missing-adlc') });
    assert.equal(verify.status, 0);
    assert.match(JSON.parse(verify.stdout).systemMessage, /evidence advisory/);
    writeFileSync(join(root, '.adlc/current-ticket.json'), '{not json');
    const malformed = run(root, 'context', { hook_event_name: 'SessionStart' });
    assert.equal(malformed.status, 0);
    assert.match(JSON.parse(malformed.stdout).systemMessage, /could not complete/);
  });
});
