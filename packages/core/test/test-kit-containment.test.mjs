// test-kit-containment.test.mjs — a fixture's git commands must never reach the
// repository the test runs in.
//
// gitRepo() configures an identity and disables signing in its fixture. If its
// directory is ever lost (the mutation gate substitutes `undefined` for a const,
// or a refactor drops it), execFileSync falls back to process.cwd() and those
// writes land in the surrounding repository's .git/config — shared by every
// worktree, so every later commit there is made as the fixture identity.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmp } from '../lib/test-kit.mjs';

const KIT = fileURLToPath(new URL('../lib/test-kit.mjs', import.meta.url));
const LOST_DIR = 'const dir = tmp(t, prefix);';

/** A throwaway repository to stand in for the one the tests run inside. */
function outerRepo(t) {
  const dir = tmp(t, 'adlc-kit-outer-');
  execFileSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

function localConfig(repo) {
  return readFileSync(join(repo, '.git', 'config'), 'utf8');
}

function runModule(cwd, lines) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', lines.join('\n')], {
    cwd, encoding: 'utf8', timeout: 30_000,
  });
}

test('gitRepo() refuses to run git when its fixture directory is lost', (t) => {
  const source = readFileSync(KIT, 'utf8');
  assert.ok(source.includes(LOST_DIR), 'the fixture directory assignment moved; update this test');
  const mutant = join(tmp(t, 'adlc-kit-mutant-'), 'test-kit.mjs');
  writeFileSync(mutant, source.replace(LOST_DIR, 'const dir = undefined;'));

  const outer = outerRepo(t);
  const before = localConfig(outer);
  const r = runModule(outer, [
    `import { gitRepo } from ${JSON.stringify(pathToFileURL(mutant).href)};`,
    'try { gitRepo({ after() {} }); console.log("ran"); } catch (e) { console.log("refused: " + e.message); }',
  ]);

  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^refused: /, `gitRepo ran git with no fixture directory:\n${r.stdout}`);
  assert.equal(localConfig(outer), before, 'the surrounding repository config was modified');
});

test('gitRepo() still configures its own fixture and nothing around it', (t) => {
  const outer = outerRepo(t);
  const before = localConfig(outer);
  const r = runModule(outer, [
    `import { gitRepo } from ${JSON.stringify(pathToFileURL(KIT).href)};`,
    'const hooks = []; const { git } = gitRepo({ after: (fn) => hooks.push(fn) });',
    'console.log(git("config", "--get", "user.name").trim());',
    'for (const fn of hooks) fn();',
  ]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'tester');
  assert.equal(localConfig(outer), before);
});
