// plugin-options.test.mjs — T30: per-repo config via the opencode.json plugin
// tuple (["@adlc/opencode-package", {...}] → the plugin function's 2nd arg,
// per @opencode-ai/plugin `Plugin = (input, options?) => Hooks`). Env vars win
// over options. Offline, temp-dir only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adlcRailsGuard, optionsToEnv } from '../index.mjs';

const railedRepo = () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-opts-'));
  mkdirSync(join(dir, '.adlc'), { recursive: true });
  writeFileSync(join(dir, '.adlc', 'tickets.json'), JSON.stringify({ tickets: [{ id: 'T1', rails: ['test/**'] }] }));
  return dir;
};

const withEnv = async (patch, fn) => {
  const saved = { ...process.env };
  try {
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return await fn();
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
};

// ---- optionsToEnv mapping ----
test('optionsToEnv maps the documented options and NOTHING else (bypasses stay env-only)', () => {
  assert.deepEqual(optionsToEnv({}), {});
  assert.deepEqual(optionsToEnv({ advisoryHooks: true }), { ADLC_ALLOW_ADVISORY_HOOKS: '1' });
  assert.deepEqual(optionsToEnv({ advisoryHooks: false }), {});
  assert.deepEqual(optionsToEnv({ ungatedTools: ['a', 'b'] }), { ADLC_UNGATED_TOOLS: 'a,b' });
  assert.deepEqual(optionsToEnv({ ungatedTools: 'a,b' }), { ADLC_UNGATED_TOOLS: 'a,b' });
  assert.deepEqual(optionsToEnv({ suppressionEnforcement: true, scopeEnforcement: true }),
    { ADLC_SUPPRESSION_ENFORCEMENT: '1', ADLC_SCOPE_ENFORCEMENT: '1' });
  // audited bypasses must never be settable from repo config
  assert.deepEqual(optionsToEnv({ railsBypass: true, buildGateBypass: true, ADLC_RAILS_BYPASS: '1' }), {});
});

// ---- options change hook behavior ----
test('advisoryHooks option: a rail edit warns instead of throwing', async () => {
  const dir = railedRepo();
  await withEnv({ ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: 'T1', ADLC_ALLOW_ADVISORY_HOOKS: undefined }, async () => {
    const hooks = await adlcRailsGuard({ worktree: dir }, { advisoryHooks: true });
    // resolves (advisory) rather than throwing (enforcing)
    await hooks['tool.execute.before']({ tool: 'edit', sessionID: 's', callID: 'c' }, { args: { filePath: 'test/x.mjs' } });
  }).finally(() => rmSync(dir, { recursive: true, force: true }));
});

test('default (no options): the same rail edit throws — options must not weaken the default', async () => {
  const dir = railedRepo();
  await withEnv({ ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: 'T1', ADLC_ALLOW_ADVISORY_HOOKS: undefined }, async () => {
    const hooks = await adlcRailsGuard({ worktree: dir });
    await assert.rejects(() =>
      hooks['tool.execute.before']({ tool: 'edit', sessionID: 's', callID: 'c' }, { args: { filePath: 'test/x.mjs' } }));
  }).finally(() => rmSync(dir, { recursive: true, force: true }));
});

test('env var OVERRIDES the option: explicit ADLC_ALLOW_ADVISORY_HOOKS=0 keeps enforcement despite advisory option', async () => {
  const dir = railedRepo();
  await withEnv({ ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: 'T1', ADLC_ALLOW_ADVISORY_HOOKS: '0' }, async () => {
    const hooks = await adlcRailsGuard({ worktree: dir }, { advisoryHooks: true });
    await assert.rejects(() =>
      hooks['tool.execute.before']({ tool: 'edit', sessionID: 's', callID: 'c' }, { args: { filePath: 'test/x.mjs' } }));
  }).finally(() => rmSync(dir, { recursive: true, force: true }));
});

test('ungatedTools option exempts a benign no-target tool that would otherwise fail closed', async () => {
  const dir = railedRepo();
  await withEnv({ ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: 'T1', ADLC_UNGATED_TOOLS: undefined }, async () => {
    // unknown tool, no extractable target → fail-closed deny by default…
    const strict = await adlcRailsGuard({ worktree: dir });
    await assert.rejects(() =>
      strict['tool.execute.before']({ tool: 'symbols_index', sessionID: 's', callID: 'c' }, { args: { query: 'x' } }));
    // …but the per-repo option exempts it (still spoof-guarded upstream)
    const relaxed = await adlcRailsGuard({ worktree: dir }, { ungatedTools: ['symbols_index'] });
    await relaxed['tool.execute.before']({ tool: 'symbols_index', sessionID: 's', callID: 'c' }, { args: { query: 'x' } });
  }).finally(() => rmSync(dir, { recursive: true, force: true }));
});
