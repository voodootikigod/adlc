import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCAFFOLD = new URL('../lib/scaffold.mjs', import.meta.url).href;
const PROBE = `import(${JSON.stringify(SCAFFOLD)}).then((m) => console.log(JSON.stringify(m.evaluateEffectiveGitignoreContract(process.cwd(), [], ['.adlc/config.json']))))`;
const SCRUBBED = ['ADLC_MANIFEST_KEY', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'];

function probe(cwd, env) {
  const res = spawnSync(process.execPath, ['-e', PROBE], { cwd, env, encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  return JSON.parse(res.stdout);
}

test('an exported GIT_DIR naming another repository does not redirect the ignore probe', () => {
  const base = mkdtempSync(join(tmpdir(), 'adlc-init-probe-env-'));
  try {
    const good = join(base, 'good');
    const other = join(base, 'other');
    for (const dir of [good, other]) {
      mkdirSync(dir);
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    }
    writeFileSync(join(good, '.gitignore'), '.adlc/*\n!.adlc/config.json\n');
    writeFileSync(join(other, '.git/info/exclude'), '.adlc/\n');
    const env = { ...process.env, GIT_DIR: join(other, '.git'), GIT_WORK_TREE: other };
    assert.deepEqual(probe(good, env), []);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('the git probe child inherits neither the manifest key nor GIT_* repository selectors', () => {
  const base = mkdtempSync(join(tmpdir(), 'adlc-init-probe-env-'));
  try {
    const bin = join(base, 'bin');
    const envDump = join(base, 'env.txt');
    mkdirSync(bin);
    const shim = join(bin, 'git');
    writeFileSync(shim, `#!/bin/sh\nenv >> '${envDump}'\nexit 1\n`);
    chmodSync(shim, 0o755);
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      ADLC_MANIFEST_KEY: 'dummy-not-a-key',
      GIT_DIR: '/nonexistent',
      GIT_WORK_TREE: '/nonexistent',
      GIT_INDEX_FILE: '/nonexistent/index',
    };
    probe(base, env);
    const seen = readFileSync(envDump, 'utf8').split('\n').map((line) => line.split('=')[0]);
    for (const name of SCRUBBED) assert.equal(seen.includes(name), false, `${name} reached the git child`);
    assert.ok(seen.includes('PATH'), 'the shim ran');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
