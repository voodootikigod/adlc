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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

test('a TypeScript consumer can import every runtime export', { skip: !existsSync(TSC) && 'typescript not installed' }, async () => {
  // This REPLACES a regex parity check that searched index.d.ts for each export
  // name as a bare word. It reported success for `invalid`, `conflict`, `policy`
  // and `operational` — none of which were declared — because those words
  // appear inside the TicketErrorKind union literal. A gate that matches prose
  // is not a gate.
  //
  // Compiling a real consumer is the only version that cannot be fooled: tsc
  // resolves the package's own "types" entry and reports TS2305 for anything
  // the declarations do not actually export.
  const runtime = await import('../../packages/tickets/index.mjs');
  const names = Object.keys(runtime).sort();
  assert.ok(names.length > 80, `expected the full export surface, got ${names.length}`);

  // Inside the repo: '@adlc/tickets' resolves by walking up to the workspace
  // link in node_modules, which a system temp dir cannot reach.
  const dir = mkdtempSync(join(ROOT, 'node_modules', '.adlc-dts-consumer-'));
  try {
    const fixture = join(dir, 'consumer.ts');
    writeFileSync(fixture, [
      `import { ${names.join(', ')} } from '@adlc/tickets';`,
      `export const used: unknown[] = [${names.join(', ')}];`,
      '',
    ].join('\n'));
    const result = spawnSync(process.execPath, [
      TSC, '--noEmit', '--strict', '--lib', 'es2022', '--types', 'node',
      '--module', 'nodenext', '--moduleResolution', 'nodenext', fixture,
    ], { encoding: 'utf8', cwd: ROOT });
    assert.equal(result.status, 0, `a TS consumer cannot import the published surface:\n${result.stdout}${result.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('declarations do not promise behavior the implementation lacks', { skip: !existsSync(TSC) && 'typescript not installed' }, () => {
  // deepClone was declared `<T>(value: T): T`, so `deepClone(new Date())`
  // inferred Date and a following `.getTime()` compiled — while the runtime
  // returns an ISO string and throws. A signature wider than the implementation
  // moves the failure past the compiler, which is worse than no types at all.
  const dir = mkdtempSync(join(ROOT, 'node_modules', '.adlc-dts-negative-'));
  try {
    const fixture = join(dir, 'negative.ts');
    writeFileSync(fixture, [
      "import { deepClone } from '@adlc/tickets';",
      // JSON-representable input is fine and keeps its type.
      // deepClone returns JsonValue, NOT the input type — four rounds proved the
      // T -> T promise false in a new way each time, so a caller that knows its
      // shape asserts it once at the call site rather than everywhere.
      "export const ok = deepClone({ a: 1 }) as { a: number };",
      // A Date is NOT JSON-representable, so this must be rejected at compile
      // time rather than compiling and failing at runtime.
      "export const bad = deepClone(new Date());",
      '',
    ].join('\n'));
    const result = spawnSync(process.execPath, [
      TSC, '--noEmit', '--strict', '--lib', 'es2022', '--types', 'node',
      '--module', 'nodenext', '--moduleResolution', 'nodenext', fixture,
    ], { encoding: 'utf8', cwd: ROOT });
    assert.notEqual(result.status, 0, 'deepClone(new Date()) must not type-check');
    assert.match(`${result.stdout}${result.stderr}`, /Date/, 'and the error must point at the Date argument');
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /negative\.ts\(2,/, 'the JSON-shaped call must still be accepted');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('declarations compile with no @types installed at all', { skip: !existsSync(TSC) && 'typescript not installed' }, () => {
  // A published .d.ts must stand on its own. An earlier revision carried
  // `/// <reference types="node" />`, which made @types/node a hard requirement
  // of merely importing the package: a project with only typescript and
  // @adlc/tickets failed to resolve the reference before type-checking a single
  // line of its own code.
  //
  // Compiled OUTSIDE the repo so no node_modules/@types is in scope — inside it,
  // tsc auto-includes every @types package and the check proves nothing.
  const dir = mkdtempSync(join(tmpdir(), 'adlc-dts-standalone-'));
  try {
    const copy = join(dir, 'index.d.ts');
    writeFileSync(copy, readFileSync(join(ROOT, 'packages/tickets/index.d.ts'), 'utf8'));
    const result = spawnSync(process.execPath, [TSC, '--noEmit', '--strict', '--lib', 'es2022', 'index.d.ts'], {
      encoding: 'utf8', cwd: dir,
    });
    assert.equal(result.status, 0, `the shipped declarations need an ambient type they do not declare:\n${result.stdout}${result.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
