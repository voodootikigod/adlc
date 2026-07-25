// type-declarations.test.mjs — the shipped .d.ts files must actually compile.
//
// packages/tickets/test/help.test.mjs checks that every runtime export has a
// DECLARATION, which is a name match. It cannot tell whether the declaration
// file is valid TypeScript: 26 exports were undeclared and two more referenced
// `Buffer` with no `@types/node` reference, so a consumer's build broke on a
// file every JS-only gate in the repo called fine.
//
// Lives in scripts/test/ because it needs the root devDependency (typescript),
// which the packages themselves must not depend on (CONVENTIONS rule 1).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '../..');
const TSC = join(ROOT, 'node_modules/typescript/bin/tsc');

/** Every .d.ts a package ships via its "types" field. */
const DECLARATIONS = ['packages/tickets/index.d.ts'];

function compile(paths) {
  return spawnSync(process.execPath, [
    // NO --skipLibCheck: it suppresses checking of .d.ts files, which is every
    // file this gate exists to check. With it the gate passed on a declaration
    // referencing a type that does not exist.
    TSC, '--noEmit', '--strict', '--lib', 'es2022', '--types', 'node',
    ...paths.map((path) => join(ROOT, path)),
  ], { encoding: 'utf8', cwd: ROOT });
}

test('every shipped declaration file compiles under --strict', { skip: !existsSync(TSC) && 'typescript not installed' }, () => {
  for (const path of DECLARATIONS) {
    assert.ok(existsSync(join(ROOT, path)), `${path} is declared as shipped but missing`);
  }
  const result = compile(DECLARATIONS);
  assert.equal(result.status, 0, `tsc rejected the shipped declarations:\n${result.stdout}${result.stderr}`);
});

test('the compile gate actually fails on a broken declaration', {
  skip: !existsSync(TSC) && 'typescript not installed',
}, () => {
  // A tsc invocation that silently checks nothing would pass the test above no
  // matter what shipped. Point it at a file that cannot compile and require a
  // non-zero exit.
  const result = compile(['scripts/test/fixtures/broken.d.ts']);
  assert.notEqual(result.status, 0, 'the gate must reject a declaration that does not compile');
});
