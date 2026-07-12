import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRunConfig, DEFAULTS } from '../lib/config.mjs';

test('flags override config which overrides defaults', () => {
  const c = resolveRunConfig({ concurrency: 4 }, { concurrency: 8 });
  assert.equal(c.concurrency, 8);
  assert.equal(resolveRunConfig({}, {}).concurrency, DEFAULTS.concurrency);
  assert.equal(resolveRunConfig({ base: 'develop' }, {}).base, 'develop');
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
