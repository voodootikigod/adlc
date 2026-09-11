// #990: the recover fixture's auto-gc guard must reach EVERY repository that
// comes into existence underneath it — not only the two it creates by hand.
//
// #962 pinned gc.auto=0 / gc.autoDetach=false on `repo/` and `origin.git` after
// a detached background gc raced the fixture teardown's recursive rm. But the
// autopilot's own production code creates a THIRD real repository inside the
// fixture working tree during a run: lib/deps.mjs `installGateDeps` clones into
// `paths.gateDeps(n)` = `<repoRoot>/.adlc/autopilot-runs/<n>/gate-deps`. A clone
// does not inherit arbitrary config from its source, so that repository was born
// with auto-gc still enabled and nothing in the fixture ever named it.
//
// These are real `git config --get` reads through a git process carrying the
// fixture's own environment — the same environment every git child the fixture
// spawns (production's clones included) runs under, which is precisely the
// process that would otherwise fork an auto-gc.

import { test } from './helpers/node-test.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createFixture, GIT } from './helpers/recover-fixture.mjs';

/** Read a key from a repository's EFFECTIVE config, as a git child of this fixture sees it. */
const readCfg = (fx, dir, key, { gitDir = false } = {}) =>
  spawnSync(GIT, gitDir ? [`--git-dir=${dir}`, 'config', '--get', key] : ['-C', dir, 'config', '--get', key], { env: fx.base, encoding: 'utf8' });

function assertAutoGcDisabled(fx, dir, label, opts = {}) {
  const auto = readCfg(fx, dir, 'gc.auto', opts);
  assert.equal(auto.status, 0, `gc.auto is not set for ${label} (${dir}): status ${auto.status}, stderr ${auto.stderr}`);
  assert.equal(auto.stdout.trim(), '0', `gc.auto must be 0 for ${label}`);
  const detach = readCfg(fx, dir, 'gc.autoDetach', opts);
  assert.equal(detach.status, 0, `gc.autoDetach is not set for ${label} (${dir}): status ${detach.status}, stderr ${detach.stderr}`);
  assert.equal(detach.stdout.trim(), 'false', `gc.autoDetach must be false for ${label}`);
}

/** Clone through the production spawn path with production's exact cloneAt flags (lib/deps.mjs). */
async function productionClone(fx, dest) {
  const runDir = join(dest, '..');
  mkdirSync(runDir, { recursive: true });
  const r = await fx.ctx.git.local(runDir, ['clone', '-q', '--no-hardlinks', '--no-checkout', fx.repoRoot, dest]);
  assert.equal(r.status, 0, `clone into ${dest} failed: ${r.stderr}`);
  return dest;
}

export async function gcGuardReachesTheNestedGateDepsRepo() {
  const fx = createFixture();
  try {
    // The exact path from the CI failure: .adlc/autopilot-runs/7/gate-deps.
    const dest = await productionClone(fx, fx.paths.gateDeps(7));
    assertAutoGcDisabled(fx, dest, 'the nested gate-deps repository');

    // The read above uses fx.base. On its own that would only prove the fixture
    // hands ITSELF a gc-disabling environment. Tie it to reality: the clone that
    // created this repository was RECORDED, so assert the guard travels in the
    // environment that spawn actually ran under — and read the value back out of
    // that file with real git rather than matching its text.
    const cloneSpawn = fx.recorder.find((r) => r.argv[0] === GIT && r.argv.includes('clone') && r.argv.includes(dest));
    assert.ok(cloneSpawn, 'the production clone into gate-deps was recorded');
    const globalPath = cloneSpawn.env.GIT_CONFIG_GLOBAL;
    assert.ok(globalPath && globalPath !== '/dev/null', `the clone carried a real GIT_CONFIG_GLOBAL, got ${globalPath}`);
    for (const [key, want] of [['gc.auto', '0'], ['gc.autoDetach', 'false']]) {
      const r = spawnSync(GIT, ['config', '--file', globalPath, '--get', key], { env: fx.base, encoding: 'utf8' });
      assert.equal(r.status, 0, `${key} absent from the config the clone itself carried (${globalPath}): ${r.stderr}`);
      assert.equal(r.stdout.trim(), want, `${key} in the config the clone itself carried`);
    }
  } finally { fx.cleanup(); }
}
test('#990: a repository created under .adlc/autopilot-runs/<n>/gate-deps the way production creates it has auto-gc disabled', gcGuardReachesTheNestedGateDepsRepo);

export async function gcGuardIsStructuralNotEnumerated() {
  const fx = createFixture();
  try {
    // A path the fixture names NOWHERE. A guard that special-cases gate-deps fails here.
    const dest = await productionClone(fx, join(fx.root, 'unrelated', 'somewhere-else.git'));
    assertAutoGcDisabled(fx, dest, 'an unenumerated nested repository');
  } finally { fx.cleanup(); }
}
test('#990: the guard is structural — a repository at a path the fixture never names also has auto-gc disabled', gcGuardIsStructuralNotEnumerated);

export function gcGuardStillCoversTheTwoOriginalRepositories() {
  const fx = createFixture();
  try {
    assertAutoGcDisabled(fx, fx.repoRoot, 'the fixture working repo');
    assertAutoGcDisabled(fx, fx.originPath, 'the bare origin', { gitDir: true });
  } finally { fx.cleanup(); }
}
test('#990: the two repositories guarded since #962 still have auto-gc disabled', gcGuardStillCoversTheTwoOriginalRepositories);
