import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

// #378 — pin that verifyOutput's spawn actually passes --allow-legacy-unsigned. A
// shim recording its own argv, since verifyOutput's args array is otherwise opaque
// to a test (ADLC_CLI_COMMAND only substitutes the binary, not the fixed args).
test('verify spawns gate-manifest verify with --allow-legacy-unsigned', () => {
  fixture((root) => {
    const shim = join(root, 'fake-adlc');
    const log = join(root, 'argv.log');
    writeFileSync(shim, `#!/bin/sh\necho "$@" > "${log}"\nexit 0\n`);
    chmodSync(shim, 0o755);
    const verify = run(root, 'verify', { hook_event_name: 'Stop' }, { ADLC_CLI_COMMAND: shim });
    assert.equal(verify.status, 0);
    const argv = readFileSync(log, 'utf8').trim();
    assert.equal(argv, 'gate-manifest verify --json --allow-legacy-unsigned');
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

// ---- flail state must never CREATE a .adlc/ outside an ADLC repo ----
//
// `flailOutput` does `mkdirSync(dataRoot, { recursive: true })`, and the default
// dataRoot was `<cwd>/.adlc/.plugin-data` with no repo guard. A tool failure in
// any directory therefore created a `.adlc/` there — with cwd=$HOME that made
// `~/.adlc`, which then reads back as an ADLC repo marker to every ancestor
// walk and captures unrelated projects beneath it.

const FAILING_TOOL = { tool_name: 'bash', tool_response: 'npm ERR! failed with exit code 1' };

/** Env with PLUGIN_DATA genuinely ABSENT — setting it to '' would not exercise
 *  the default path (the old code used `??`, which treats '' as present). */
function envWithoutPluginData(extra = {}) {
  const e = { ...process.env, ...extra };
  if (!('PLUGIN_DATA' in extra)) delete e.PLUGIN_DATA;
  return e;
}

test('a tool failure outside an ADLC repo creates no .adlc directory', () => {
  const plain = mkdtempSync(join(tmpdir(), 'adlc-codex-plain-'));
  try {
    const result = spawnSync(process.execPath, [HOOK, 'flail'], {
      cwd: plain,
      // No PLUGIN_DATA: exercise the DEFAULT path, which is the one that bit us.
      env: envWithoutPluginData(),
      input: JSON.stringify({ cwd: plain, ...FAILING_TOOL }),
      encoding: 'utf8',
    });
    assert.equal(result.status, 0);
    assert.equal(existsSync(join(plain, '.adlc')), false, 'hook created a .adlc/ outside a repo');
  } finally {
    rmSync(plain, { recursive: true, force: true });
  }
});

test('a tool failure inside a real ADLC repo still records flail state', () => {
  fixture((root) => {
    const result = spawnSync(process.execPath, [HOOK, 'flail'], {
      cwd: root,
      env: envWithoutPluginData(),
      input: JSON.stringify({ cwd: root, ...FAILING_TOOL }),
      encoding: 'utf8',
    });
    assert.equal(result.status, 0);
    assert.ok(
      existsSync(join(root, '.adlc', '.plugin-data', 'flail-state.json')),
      'flail detection must keep working where it belongs',
    );
  });
});

test('an explicit PLUGIN_DATA is honored even outside a repo (the host chose it)', () => {
  const plain = mkdtempSync(join(tmpdir(), 'adlc-codex-explicit-'));
  try {
    const chosen = join(plain, 'host-state');
    const result = spawnSync(process.execPath, [HOOK, 'flail'], {
      cwd: plain,
      env: envWithoutPluginData({ PLUGIN_DATA: chosen }),
      input: JSON.stringify({ cwd: plain, ...FAILING_TOOL }),
      encoding: 'utf8',
    });
    assert.equal(result.status, 0);
    assert.ok(existsSync(join(chosen, 'flail-state.json')));
    assert.equal(existsSync(join(plain, '.adlc')), false);
  } finally {
    rmSync(plain, { recursive: true, force: true });
  }
});

// A hook usually runs with cwd set to a SUBDIRECTORY of the repo, so testing the
// cwd alone would silently disable flail detection for most of a project
// (adversarial-review finding). Resolve the enclosing ADLC root instead.
test('a tool failure in a SUBDIRECTORY records against the repo root', () => {
  fixture((root) => {
    const sub = join(root, 'packages', 'app');
    mkdirSync(sub, { recursive: true });
    const result = spawnSync(process.execPath, [HOOK, 'flail'], {
      cwd: sub,
      env: envWithoutPluginData(),
      input: JSON.stringify({ cwd: sub, ...FAILING_TOOL }),
      encoding: 'utf8',
    });
    assert.equal(result.status, 0);
    assert.ok(
      existsSync(join(root, '.adlc', '.plugin-data', 'flail-state.json')),
      'flail state must be recorded at the enclosing ADLC root',
    );
    assert.equal(existsSync(join(sub, '.adlc')), false, 'and must not create a nested .adlc in the subdir');
  });
});

// A nested independent repo must not write its flail state into an ancestor
// project's .adlc/ (adversarial-review finding): the walk stops at a .git
// boundary rather than treating it as a waypoint.
test('the ancestor walk stops at a .git boundary instead of leaking into a parent project', () => {
  const ws = mkdtempSync(join(tmpdir(), 'adlc-codex-boundary-'));
  try {
    mkdirSync(join(ws, '.adlc'), { recursive: true });
    writeFileSync(join(ws, '.adlc', 'tickets.json'), '{"tickets":[]}\n');
    const child = join(ws, 'child-repo');
    mkdirSync(join(child, '.git'), { recursive: true });
    const result = spawnSync(process.execPath, [HOOK, 'flail'], {
      cwd: child,
      env: envWithoutPluginData(),
      input: JSON.stringify({ cwd: child, ...FAILING_TOOL }),
      encoding: 'utf8',
    });
    assert.equal(result.status, 0);
    assert.equal(existsSync(join(ws, '.adlc', '.plugin-data')), false, 'leaked into the parent project');
    assert.equal(existsSync(join(child, '.adlc')), false, 'created a .adlc in the nested repo');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
