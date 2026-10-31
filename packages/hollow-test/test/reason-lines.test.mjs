// reason-lines.test.mjs — the diff-derived "produced zero mutants" refusal:
// one reason keeps today's single line; several print one per indented line,
// and the closing sentence then gets its own line.
// Runs the real binary in scratch git repos; offline.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitRepo, runBin } from '@adlc/core/test-kit';

const BIN = fileURLToPath(new URL('../bin/hollow-test.mjs', import.meta.url));

const CLOSING = 'The changed code was never actually verified; refusing to report a pass.';
const NO_MUTANT = 'no mutable line was found (comment-only, blank, or a shape none of the mutation operators recognize)';

// Nothing any mutation operator recognizes.
const ZERO_MUTANT_FUNCTION = "export function announce() {\n  console.log('called');\n}\n";

function repo(t, addSecondCommit) {
  const { dir, git } = gitRepo(t, 'hollow-reason-lines-');
  mkdirSync(join(dir, 'src'));
  mkdirSync(join(dir, 'test'));
  writeFileSync(join(dir, 'src', 'math.mjs'), 'export function add(a, b) {\n  return a + b;\n}\n');
  writeFileSync(join(dir, 'test', 'math.test.mjs'), [
    "import { it } from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { add } from '../src/math.mjs';",
    "it('sums', () => { assert.strictEqual(add(2, 3), 5); });",
    '',
  ].join('\n'));
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  addSecondCommit(dir);
  git('add', '-A');
  git('commit', '-q', '-m', 'change');
  return dir;
}

function run(dir) {
  return runBin(BIN, ['--test-cmd', 'node --test test/*.test.mjs', '--base', 'HEAD~1'], { cwd: dir, timeout: 60000 });
}

describe('hollow-test zero-mutant refusal layout', () => {
  it('one reason prints on one line, the same as before', (t) => {
    const dir = repo(t, (d) => writeFileSync(join(d, 'src', 'announce.mjs'), ZERO_MUTANT_FUNCTION));
    const r = run(dir);
    assert.equal(r.status, 1, r.stderr);
    assert.ok(
      r.stderr.split('\n').includes(
        `error: diff-derived file(s) produced zero mutants — src/announce.mjs: ${NO_MUTANT}. ${CLOSING}`,
      ),
      `expected the single-line refusal, got:\n${r.stderr}`,
    );
  });

  it('several reasons print one per line, then the closing sentence on its own line',
    { skip: process.platform === 'win32' ? 'POSIX symlinks' : false },
    (t) => {
      const dir = repo(t, (d) => {
        writeFileSync(join(d, 'src', 'announce.mjs'), ZERO_MUTANT_FUNCTION);
        symlinkSync('./does-not-exist.mjs', join(d, 'src', 'broken.mjs'));
      });
      const r = run(dir);
      assert.equal(r.status, 1, r.stderr);
      const lines = r.stderr.split('\n');
      const at = lines.indexOf('error: diff-derived file(s) produced zero mutants —');
      assert.notEqual(at, -1, `expected the heading on its own line, got:\n${r.stderr}`);
      assert.deepEqual(lines.slice(at + 1, at + 4), [
        `  src/announce.mjs: ${NO_MUTANT}`,
        '  src/broken.mjs: could not be read',
        CLOSING,
      ]);
    });
});
