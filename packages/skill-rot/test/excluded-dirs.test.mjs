// node_modules and .git are skipped by name while walking below a search root.
// The exclusion is judged relative to the root the caller named, so a root that
// itself lives under such a directory is still searched. A symlink whose target
// resolves into an excluded directory is skipped in default discovery and is an
// error in strict (explicit-path) mode, where a clean verdict must mean every
// named skill was inspected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmp } from '@adlc/core/test-kit';
import { findSkills } from '../lib/find-skills.mjs';

const BIN = fileURLToPath(new URL('../bin/skill-rot.mjs', import.meta.url));

function skill(path, body = '# S\nRun `ls`.\n') {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'SKILL.md'), body);
  return join(path, 'SKILL.md');
}

test('an explicit root inside node_modules is searched', (t) => {
  const dir = tmp(t, 'skill-rot-excl-');
  const found = skill(join(dir, 'node_modules', '@vendor', 'pkg', 'skills', 'bar'));
  for (const strict of [true, false]) {
    assert.deepEqual(findSkills(['node_modules/@vendor/pkg/skills'], dir, { strict }), [found]);
  }
});

test('a repo checked out below a node_modules or .git directory still finds its skills', (t) => {
  for (const parent of ['node_modules', '.git']) {
    const repo = join(tmp(t, 'skill-rot-excl-'), parent, 'repo');
    const found = skill(join(repo, '.claude', 'skills', 'x'));
    assert.deepEqual(findSkills(['.claude/skills'], repo), [found]);
  }
});

test('node_modules and .git below the root are still skipped by name', (t) => {
  const dir = tmp(t, 'skill-rot-excl-');
  const kept = skill(join(dir, 'skills', 'real'));
  skill(join(dir, 'skills', 'node_modules', 'dep'));
  skill(join(dir, 'skills', '.git', 'hooks'));
  for (const strict of [true, false]) {
    assert.deepEqual(findSkills(['skills'], dir, { strict }), [kept]);
  }
});

for (const excluded of ['node_modules', '.git']) {
  test(`strict mode refuses a symlink whose target is inside ${excluded}`, (t) => {
    const dir = tmp(t, 'skill-rot-excl-');
    skill(join(dir, 'skills', 'real'));
    const target = join(dir, 'shared', excluded, 'vendor');
    skill(target);
    symlinkSync(target, join(dir, 'skills', 'vendor'));
    assert.throws(
      () => findSkills(['skills'], dir, { strict: true }),
      new RegExp(`symlink into an excluded directory: .*skills/vendor`),
    );
    assert.equal(findSkills(['skills'], dir).length, 1, 'default discovery still skips it');
  });
}

test('CLI: an explicit root holding a link into node_modules exits 1 instead of a clean pass', (t) => {
  const dir = tmp(t, 'skill-rot-excl-');
  skill(join(dir, 'skills', 'real'));
  const target = join(dir, 'node_modules', '@vendor', 'pkg', 'skills', 'bar');
  skill(target, '# Bar\nRun `definitely-not-a-real-cmd-xyz`.\n');
  symlinkSync(target, join(dir, 'skills', 'vendor'));
  const res = spawnSync(process.execPath, [BIN, 'skills'], { cwd: dir, encoding: 'utf8' });
  assert.equal(res.status, 1, `stdout=${res.stdout} stderr=${res.stderr}`);
  assert.match(res.stderr, /symlink into an excluded directory/);
});

test('CLI: the linked target named explicitly is checked', (t) => {
  const dir = tmp(t, 'skill-rot-excl-');
  const target = join(dir, 'node_modules', '@vendor', 'pkg', 'skills');
  skill(join(target, 'bar'), '# Bar\nRun `definitely-not-a-real-cmd-xyz`.\n');
  const res = spawnSync(process.execPath, [BIN, 'node_modules/@vendor/pkg/skills'], { cwd: dir, encoding: 'utf8' });
  assert.equal(res.status, 2, `stdout=${res.stdout} stderr=${res.stderr}`);
  assert.match(res.stdout, /\[STALE\]/);
});
