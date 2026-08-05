// lifecycle-flail.test.mjs — flail state must never CREATE a `.adlc/` outside
// an ADLC repo.
//
// `flailOutput` does `mkdirSync(dataRoot, { recursive: true })`, and the default
// dataRoot was `<cwd>/.adlc/.plugin-data` with no repo guard. A tool failure in
// any directory therefore created a `.adlc/` there — with cwd=$HOME that made
// `~/.adlc`, which then reads back as an ADLC repo marker to every ancestor walk
// and captures unrelated projects beneath it. Mirrors the codex suite; the two
// lifecycle hooks are line-for-line siblings here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', 'adlc-lifecycle.mjs');
const FAILING_TOOL = { tool_name: 'bash', tool_response: 'npm ERR! failed with exit code 1' };

/** Env with PLUGIN_DATA genuinely ABSENT — setting it to '' would not exercise
 *  the default path (the old code used `??`, which treats '' as present). */
function envWithoutPluginData(extra = {}) {
  const e = { ...process.env, ...extra };
  if (!('PLUGIN_DATA' in extra)) delete e.PLUGIN_DATA;
  return e;
}

function runFlail(cwd, env) {
  return spawnSync(process.execPath, [HOOK, 'flail'], {
    cwd,
    env,
    input: JSON.stringify({ cwd, ...FAILING_TOOL }),
    encoding: 'utf8',
  });
}

test('a tool failure outside an ADLC repo creates no .adlc directory', () => {
  const plain = mkdtempSync(join(tmpdir(), 'adlc-copilot-plain-'));
  try {
    const result = runFlail(plain, envWithoutPluginData());
    assert.equal(result.status, 0);
    assert.equal(existsSync(join(plain, '.adlc')), false, 'hook created a .adlc/ outside a repo');
  } finally {
    rmSync(plain, { recursive: true, force: true });
  }
});

test('a tool failure inside a real ADLC repo still records flail state', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-copilot-repo-'));
  try {
    mkdirSync(join(root, '.adlc'), { recursive: true });
    writeFileSync(join(root, '.adlc', 'tickets.json'), '{"tickets":[]}\n');
    const result = runFlail(root, envWithoutPluginData());
    assert.equal(result.status, 0);
    assert.ok(
      existsSync(join(root, '.adlc', '.plugin-data', 'flail-state.json')),
      'flail detection must keep working where it belongs',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an explicit PLUGIN_DATA is honored even outside a repo (the host chose it)', () => {
  const plain = mkdtempSync(join(tmpdir(), 'adlc-copilot-explicit-'));
  try {
    const chosen = join(plain, 'host-state');
    const result = runFlail(plain, envWithoutPluginData({ PLUGIN_DATA: chosen }));
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
  const root = mkdtempSync(join(tmpdir(), 'adlc-copilot-subdir-'));
  try {
    mkdirSync(join(root, '.adlc'), { recursive: true });
    writeFileSync(join(root, '.adlc', 'tickets.json'), '{"tickets":[]}\n');
    const sub = join(root, 'packages', 'app');
    mkdirSync(sub, { recursive: true });
    const result = runFlail(sub, envWithoutPluginData());
    assert.equal(result.status, 0);
    assert.ok(
      existsSync(join(root, '.adlc', '.plugin-data', 'flail-state.json')),
      'flail state must be recorded at the enclosing ADLC root',
    );
    assert.equal(existsSync(join(sub, '.adlc')), false, 'and must not create a nested .adlc in the subdir');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// A nested independent repo must not write its flail state into an ancestor
// project's .adlc/ (adversarial-review finding): the walk stops at a .git
// boundary rather than treating it as a waypoint.
test('the ancestor walk stops at a .git boundary instead of leaking into a parent project', () => {
  const ws = mkdtempSync(join(tmpdir(), 'adlc-copilot-boundary-'));
  try {
    mkdirSync(join(ws, '.adlc'), { recursive: true });
    writeFileSync(join(ws, '.adlc', 'tickets.json'), '{"tickets":[]}\n');
    const child = join(ws, 'child-repo');
    mkdirSync(join(child, '.git'), { recursive: true });
    const result = runFlail(child, envWithoutPluginData());
    assert.equal(result.status, 0);
    assert.equal(existsSync(join(ws, '.adlc', '.plugin-data')), false, 'leaked into the parent project');
    assert.equal(existsSync(join(child, '.adlc')), false, 'created a .adlc in the nested repo');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
