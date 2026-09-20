// railpath-new-subdir.test.mjs — regression tests for issue #1062 in pi plugin
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkStructuredWrite } from '../lib/rails-checker.mjs';

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'railpath-deep-'));
  dirs.push(dir);
  const root = realpathSync(dir);
  mkdirSync(join(root, 'test'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'test', 'a.test.mjs'), '// test file\n');
  symlinkSync('../test', join(root, 'src', 'alias'));
  return root;
}

const ticket = { id: 'T1', title: 'T1 fixture', rails: ['test/**'], scope: [] };

test('checkStructuredWrite: denies write to missing subdir under symlinked rail', () => {
  const root = makeRepo();
  const res1 = checkStructuredWrite('src/alias/newdir/x.test.mjs', ticket, root);
  assert.equal(res1.decision, 'deny');
  assert.match(res1.reason, /rail/);

  const res2 = checkStructuredWrite('src/alias/a/b/x.test.mjs', ticket, root);
  assert.equal(res2.decision, 'deny');
  assert.match(res2.reason, /rail/);

  const control = checkStructuredWrite('src/newdir/ok.mjs', ticket, root);
  assert.equal(control.decision, 'allow');
});
