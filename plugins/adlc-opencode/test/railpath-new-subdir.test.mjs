// railpath-new-subdir.test.mjs — regression tests for issue #1062 in opencode plugin
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkRail } from '../rails-checker.mjs';

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'railpath-deep-'));
  dirs.push(dir);
  const root = realpathSync(dir);
  mkdirSync(join(root, '.adlc'), { recursive: true });
  writeFileSync(
    join(root, '.adlc', 'tickets.json'),
    JSON.stringify({ tickets: [{ id: 'T1', title: 'T1 fixture', rails: ['locked/**'] }] }),
  );
  mkdirSync(join(root, 'locked'), { recursive: true });
  symlinkSync(join(root, 'locked'), join(root, 'aliasdir'));
  return root;
}

const env = { ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: 'T1' };

test('checkRail: denies write to missing subdir under symlinked rail', () => {
  const dir = makeRepo();
  const r1 = checkRail({ filePath: 'aliasdir/newdir/new.mjs', tool: 'write', root: dir, env });
  assert.equal(r1.decision, 'deny');

  const r2 = checkRail({ filePath: 'aliasdir/a/b/new.mjs', tool: 'write', root: dir, env });
  assert.equal(r2.decision, 'deny');

  const control = checkRail({ filePath: 'src/newdir/ok.mjs', tool: 'write', root: dir, env });
  assert.equal(control.decision, 'allow');
});
