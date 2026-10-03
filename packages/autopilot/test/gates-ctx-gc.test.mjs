// The S5 fixture context must keep git auto-gc out of EVERY repository its git
// children touch — including the nested ones production creates under the
// fixture root (worker mirror, gate mirror, gate clones). A detached auto-gc
// racing the fixture's recursive teardown is an ENOTEMPTY/ENOENT flake, and a
// per-repository `git config` cannot reach repositories production clones
// later (a clone inherits no config from its source), so the guard has to ride
// the environment every git child is spawned with.
//
// Regression test for a fixture defect, not a spec criterion: absent from ac-registry.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { createWorkerMirror, createGateMirror } from '../lib/mirror.mjs';
import { makeCtx, REAL_GIT } from './helpers/gates-ctx.mjs';
import { makeRepo, addIssueWorktree } from './helpers/gates-fixture.mjs';

const ISSUE = 7;

/** `git config --get <key>` in `dir` under `env` — what a git child spawned with that env sees. */
const configUnder = (env, dir, key) => {
  const r = spawnSync(REAL_GIT, ['-C', dir, 'config', '--get', key], { env, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
};

test('every git child of the gates-ctx fixture runs with auto-gc disabled, in the nested repositories production clones too', async () => {
  const { root, baseOid } = makeRepo();
  try {
    const ctx = makeCtx({ repoRoot: root, baseOid });
    addIssueWorktree(root, ctx.paths.issueWorktree(ISSUE), ISSUE, baseOid);
    const mirror = await createWorkerMirror({ ctx, issue: ISSUE });
    const gate = await createGateMirror({ ctx, issue: ISSUE, attestedHead: baseOid, baseOid });
    // The worker mirror is cloned, the gate mirror is `init` + push: both creators are checked.
    const creators = ctx.recorder.filter((r) => r.argv.includes('clone') || r.argv.includes('init'));
    assert.ok(creators.length >= 2, 'production created the worker and the gate mirror');
    for (const rec of creators) {
      for (const dir of [mirror, gate]) {
        assert.equal(configUnder(rec.env, dir, 'gc.auto'), '0', `gc.auto is 0 in ${dir} under the creating spawn's env`);
        assert.equal(configUnder(rec.env, dir, 'gc.autoDetach'), 'false', `gc.autoDetach is false in ${dir} under the creating spawn's env`);
      }
      assert.equal(rec.env.GIT_CONFIG_GLOBAL, '/dev/null', "the operator's global config stays isolated");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
