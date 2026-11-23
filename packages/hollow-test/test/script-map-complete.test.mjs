import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmp } from '@adlc/core/test-kit';
import { testTargetFor, classify, fileTestCmdsFor, ROOT } from '../lib/gate-plan.mjs';
import { buildTrialEnv } from '../lib/runner.mjs';
import { hollowTestArgsFor } from '../../../scripts/mutation-gate.mjs';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'hollow-test.mjs');

test('gate-plan maps scripts/* exact entries and includes hooks/test on plugin root changes', () => {
  assert.equal(testTargetFor('scripts/copilot-install-smoke.mjs', ROOT), 'scripts/test/smoke-teardown.test.mjs');
  assert.equal(testTargetFor('scripts/router/gen-routers.mjs', ROOT), 'scripts/test/router-drift.test.mjs');
  assert.equal(testTargetFor('scripts/toolkit-floor-check.mjs', ROOT), 'scripts/test/toolkit-floor.test.mjs');
  assert.match(testTargetFor('scripts/run-tests.mjs', ROOT), /run-tests-parallel\.test\.mjs/);
  assert.equal(testTargetFor('scripts/preflight-fast.mjs', ROOT), 'scripts/test/run-tests-parallel.test.mjs');

  const pluginRoot = testTargetFor('plugins/adlc-copilot/rails-checker.mjs', ROOT);
  assert.ok(pluginRoot.includes('plugins/adlc-copilot/test/*.test.mjs'));
  assert.ok(pluginRoot.includes('plugins/adlc-copilot/hooks/test/*.test.mjs'));

  const fast = classify(['packages/core/lib/mutate.mjs', 'scripts/preflight-fast.mjs'], 12, ROOT);
  assert.equal(fast.kind, 'fast');
  const perFile = fileTestCmdsFor(fast.files, ROOT);
  assert.equal(perFile['packages/core/lib/mutate.mjs'], 'node --test packages/core/test/*.test.mjs');
  assert.equal(perFile['scripts/preflight-fast.mjs'], 'node --test scripts/test/run-tests-parallel.test.mjs');

  // hollowTestArgsFor passes --skip-baseline and --file-test-map ONLY on fast path
  const fastArgs = hollowTestArgsFor(fast, { base: 'origin/main', budget: { draw: 12 }, root: ROOT });
  assert.ok(fastArgs.includes('--skip-baseline'));
  assert.ok(fastArgs.includes('--file-test-map'));
  const slowArgs = hollowTestArgsFor(
    { kind: 'slow', testCmd: 'node scripts/run-tests.mjs', max: 3, uncovered: ['x.mjs'], skipped: [] },
    { base: 'origin/main', budget: { draw: 3 }, root: ROOT },
  );
  assert.equal(slowArgs.includes('--skip-baseline'), false);
  assert.equal(slowArgs.includes('--file-test-map'), false);
});

test('buildTrialEnv scrubs ADLC_MANIFEST_KEY and secrets while preserving empty key and heap knob', () => {
  const env = buildTrialEnv({
    PATH: '/usr/bin',
    ADLC_MANIFEST_KEY: 'super-secret',
    GITHUB_TOKEN: 'ghp_123',
    HOLLOW_TEST_MAX_OLD_SPACE_MB: '512',
    NODE_OPTIONS: '--trace-warnings',
  });
  assert.equal(Object.hasOwn(env, 'ADLC_MANIFEST_KEY'), false);
  assert.equal(Object.hasOwn(env, 'GITHUB_TOKEN'), false);
  assert.equal(env.HOLLOW_TEST_MAX_OLD_SPACE_MB, '512');
  assert.equal(env.NODE_OPTIONS, '--trace-warnings');

  const emptyKeyEnv = buildTrialEnv({ PATH: '/usr/bin', ADLC_MANIFEST_KEY: '' });
  assert.equal(emptyKeyEnv.ADLC_MANIFEST_KEY, '');
});

test('hollow-test exits fast on comment-only diffs without running baseline, and honours --skip-baseline and --file-test-map', (t) => {
  const dir = tmp(t, 'hollow-fast-');
  const git = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'a.mjs'), 'export const a = 1;\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'init']);

  // Comment-only change: even with a failing --test-cmd, exits 0 without running baseline
  writeFileSync(join(dir, 'src', 'a.mjs'), '// doc comment\nexport const a = 1;\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'comment only']);
  const commentRes = spawnSync(
    process.execPath,
    [BIN, '--base', 'HEAD~1', '--test-cmd', 'node -e "process.exit(9)"'],
    { cwd: dir, encoding: 'utf8' },
  );
  assert.equal(commentRes.status, 0, commentRes.stderr);

  // Real code change with --skip-baseline and --file-test-map
  writeFileSync(join(dir, 'src', 'a.mjs'), '// doc comment\nexport const a = (x) => x === 1;\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'add fn']);
  const mapArg = JSON.stringify({ 'src/a.mjs': 'node -e "import(\'./src/a.mjs\').then(m => { if (!m.a(1)) process.exit(1); })"' });
  const mappedRes = spawnSync(
    process.execPath,
    [BIN, '--base', 'HEAD~1', '--test-cmd', 'node -e "process.exit(9)"', '--skip-baseline', '--file-test-map', mapArg, '--max', '1'],
    { cwd: dir, encoding: 'utf8' },
  );
  assert.equal(mappedRes.status, 0, `${mappedRes.stdout}\n${mappedRes.stderr}`);
});
