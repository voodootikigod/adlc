// Regression test for #833: action.mjs must resolve its plugin root from its
// own install location (import.meta.url), never from HERDR_PLUGIN_ROOT env
// or a cwd-relative default — both are attacker/host-controlled surfaces
// that can point the ticket-show spawn at a file inside the INSPECTED repo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { planAction } from '../lib/actions.mjs';

const testDir = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(testDir, '..');
const actionBin = join(pluginRoot, 'bin', 'action.mjs');

test('AC3: HERDR_PLUGIN_ROOT is fully removed from action.mjs', () => {
  const src = readFileSync(actionBin, 'utf8');
  assert.equal((src.match(/HERDR_PLUGIN_ROOT/g) ?? []).length, 0);
});

test('action.mjs exports resolvePluginRoot() without triggering main() on import', async () => {
  const mod = await import('../bin/action.mjs');
  assert.equal(typeof mod.resolvePluginRoot, 'function');
});

test('AC1: resolvePluginRoot equals the real plugin root regardless of an attacker-controlled HERDR_PLUGIN_ROOT and an unrelated cwd', async () => {
  const mod = await import('../bin/action.mjs');
  const evilTmp = mkdtempSync(join(tmpdir(), 'herdr-evil-'));
  const savedEnv = process.env.HERDR_PLUGIN_ROOT;
  const savedCwd = process.cwd();
  try {
    process.env.HERDR_PLUGIN_ROOT = evilTmp;
    process.chdir(evilTmp);
    const resolved = mod.resolvePluginRoot();
    assert.equal(resolve(resolved), pluginRoot);
    assert.notEqual(resolve(resolved), resolve(evilTmp));
  } finally {
    process.chdir(savedCwd);
    if (savedEnv === undefined) delete process.env.HERDR_PLUGIN_ROOT;
    else process.env.HERDR_PLUGIN_ROOT = savedEnv;
    rmSync(evilTmp, { recursive: true, force: true });
  }
});

test('AC2: the ticket-show spawn argv is built from the real plugin root string action.mjs resolved, never a literal "." or env value', async () => {
  const mod = await import('../bin/action.mjs');
  const realRoot = mod.resolvePluginRoot();
  const target = { ok: true, repoRoot: '/repo' };
  const active = { state: 'active', id: 't-x' };
  const plan = planAction('ticket-show', target, active, { pluginRoot: realRoot });
  const spawned = plan.herdrArgs.slice(plan.herdrArgs.indexOf('--') + 1);
  assert.equal(spawned[1], `${realRoot}/bin/show-ticket.mjs`);
  assert.notEqual(spawned[1], './bin/show-ticket.mjs');
  assert.ok(!spawned[1].includes('undefined'));
});

test('importing action.mjs does not itself spawn or notify (main() is guarded)', async () => {
  // If main() ran unconditionally on import, this import would attempt a
  // live herdr call and either hang or throw inside a bare test-runner
  // context. A clean, fast resolution here is the regression signal.
  const before = Date.now();
  await import(`../bin/action.mjs?guardProbe=${Math.random()}`);
  assert.ok(Date.now() - before < 2000, 'import must not trigger main()');
});

test('isMainEntry: false when argv1 is undefined/empty, never calls pathToFileURL(undefined)', async () => {
  const mod = await import('../bin/action.mjs');
  assert.equal(mod.isMainEntry(undefined, import.meta.url), false);
  assert.equal(mod.isMainEntry('', import.meta.url), false);
  assert.equal(mod.isMainEntry(null, import.meta.url), false);
});

test('isMainEntry: true only when the module URL matches argv1s file URL exactly', async () => {
  const mod = await import('../bin/action.mjs');
  const url = pathToFileURL(actionBin).href;
  assert.equal(mod.isMainEntry(actionBin, url), true);
  assert.equal(mod.isMainEntry('/some/other/file.mjs', url), false);
});

test('handleMainFailure always exits with code 0, never a nonzero code', async () => {
  const mod = await import('../bin/action.mjs');
  const calls = [];
  const originalExit = process.exit;
  process.exit = (code) => { calls.push(code); };
  try {
    mod.handleMainFailure();
  } finally {
    process.exit = originalExit;
  }
  assert.deepEqual(calls, [0]);
});
