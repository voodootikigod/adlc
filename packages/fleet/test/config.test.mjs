import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveRunConfig, loadConfig, DEFAULTS } from '../lib/config.mjs';

test('the concrete default constants are the documented values', () => {
  // Pin the literal values (not just "=== DEFAULTS.x", which a mutation of the
  // constant would slip past).
  assert.equal(DEFAULTS.concurrency, 2);
  assert.equal(DEFAULTS.timeoutMinutes, 30);
  assert.equal(DEFAULTS.base, 'main');
});

test('flags override config which overrides defaults', () => {
  const c = resolveRunConfig({ concurrency: 4 }, { concurrency: 8 });
  assert.equal(c.concurrency, 8);
  assert.equal(resolveRunConfig({}, {}).concurrency, DEFAULTS.concurrency);
  assert.equal(resolveRunConfig({ base: 'develop' }, {}).base, 'develop');
});

test('loadConfig returns the fleet block, or {} (never null) when absent/broken', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-config-'));
  assert.deepEqual(loadConfig(dir), {}, 'no config.json → empty object, not null');
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ fleet: { concurrency: 5 } }));
  assert.deepEqual(loadConfig(dir), { concurrency: 5 });
  writeFileSync(join(dir, 'config.json'), 'not json{');
  assert.deepEqual(loadConfig(dir), {}, 'malformed config → {} (never throws or returns null)');
});

test('operator-local flag sets operatorOverride; repo config sets it via a warning-only path (N1)', () => {
  // Operator CLI flag → real override.
  const viaFlag = resolveRunConfig({}, { disposableContainer: true });
  assert.equal(viaFlag.operatorOverride, true);
  assert.equal(viaFlag.repoConfigOverride, false);
  assert.equal(viaFlag.warnings.length, 0);

  // Repo-committed config → NOT an operator override; warns and is ignored (N1).
  const viaRepo = resolveRunConfig({ disposableContainer: true }, {});
  assert.equal(viaRepo.operatorOverride, false, 'repo config must not enable the override');
  assert.equal(viaRepo.repoConfigOverride, true);
  assert.ok(viaRepo.warnings.some((w) => /N1|cannot disable/i.test(w)));
});

test('gate/init/allowedCommands pass through from config', () => {
  const c = resolveRunConfig({ gate: { test: 'npm test' }, init: 'npm ci', allowedCommands: ['node x'] }, {});
  assert.deepEqual(c.gate, { test: 'npm test' });
  assert.equal(c.init, 'npm ci');
  assert.deepEqual(c.allowedCommands, ['node x']);
});
