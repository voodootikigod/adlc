// typed-package-consumers.test.mjs — every package that ships declarations
// must be importable by a strict nodenext TypeScript consumer, through every
// export-map entry that carries a "types" condition.
//
// The package list is derived from packages/*/package.json rather than
// hand-listed, so a package that starts shipping types is gated the moment it
// declares them. Compiled without --skipLibCheck: the declarations themselves
// are what is under test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '../..');
const TSC = join(ROOT, 'node_modules/typescript/bin/tsc');
const NO_TSC = !existsSync(TSC) && 'typescript not installed';

/** { name, dir, entries: [{ specifier, runtime, types }] } for every package with a "types" field. */
export function typedPackages(root = ROOT) {
  const out = [];
  for (const name of readdirSync(join(root, 'packages')).sort()) {
    const manifestPath = join(root, 'packages', name, 'package.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (!manifest.types) continue;
    const entries = [];
    for (const [key, target] of Object.entries(manifest.exports ?? { '.': { types: manifest.types, default: manifest.main } })) {
      if (typeof target !== 'object' || target === null || !target.types) continue;
      entries.push({
        specifier: key === '.' ? manifest.name : `${manifest.name}/${key.slice(2)}`,
        runtime: join(root, 'packages', name, target.default ?? target.import),
        types: join(root, 'packages', name, target.types),
      });
    }
    out.push({ name: manifest.name, dir: join(root, 'packages', name), entries });
  }
  return out;
}

function tsc(file) {
  return spawnSync(process.execPath, [
    TSC, '--noEmit', '--strict', '--lib', 'es2022', '--types', 'node',
    '--module', 'nodenext', '--moduleResolution', 'nodenext', file,
  ], { encoding: 'utf8', cwd: ROOT });
}

/** Writes `source` as a consumer inside the repo (so workspace links resolve) and compiles it. */
function compileConsumer(t, source) {
  const dir = mkdtempSync(join(ROOT, 'node_modules', '.adlc-typed-consumer-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'consumer.mts');
  writeFileSync(file, source);
  const result = tsc(file);
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

test('every package that declares "types" is discovered, including @adlc/core', () => {
  const names = typedPackages().map((p) => p.name);
  assert.ok(names.includes('@adlc/core'), `@adlc/core ships index.d.ts; discovered: ${names.join(', ')}`);
  assert.ok(names.includes('@adlc/tickets'), `@adlc/tickets ships index.d.ts; discovered: ${names.join(', ')}`);
});

test('@adlc/core/test-kit ships its own declarations through the export map', () => {
  const core = typedPackages().find((p) => p.name === '@adlc/core');
  const kit = core.entries.find((e) => e.specifier === '@adlc/core/test-kit');
  assert.ok(kit, 'the ./test-kit export must carry a "types" condition, or TS consumers get an implicit any');
  assert.ok(existsSync(kit.types), `${kit.types} is declared but missing`);
});

for (const pkg of typedPackages()) {
  for (const entry of pkg.entries) {
    test(`a strict nodenext consumer can import every runtime export of ${entry.specifier}`, { skip: NO_TSC }, async (t) => {
      const names = Object.keys(await import(pathToFileURL(entry.runtime).href)).sort();
      assert.ok(names.length > 0, `${entry.specifier} exports nothing at runtime`);
      const { status, output } = compileConsumer(t, [
        `import { ${names.join(', ')} } from '${entry.specifier}';`,
        `export const used: unknown[] = [${names.join(', ')}];`,
        '',
      ].join('\n'));
      assert.equal(status, 0, `${entry.specifier} does not type-check for a consumer:\n${output}`);
    });
  }
}

test('test-kit declarations are real types, not an implicit any', { skip: NO_TSC }, (t) => {
  const header = [
    "import { tmp, gitRepo, runBin, withScopedContext } from '@adlc/core/test-kit';",
    'declare const t: { after(fn: () => void): void };',
  ];
  const valid = compileConsumer(t, [
    ...header,
    'export const dir: string = tmp(t, "x-");',
    'export const repo: string = gitRepo(t, { branch: "main" }).dir;',
    'export const out: Promise<number> = withScopedContext(async (ctx) => { tmp(ctx); return 1; });',
    'export const status: number | null = runBin("bin.mjs", ["--help"]).status;',
    '',
  ].join('\n'));
  assert.equal(valid.status, 0, `valid test-kit usage does not type-check:\n${valid.output}`);

  // Each misuse sits on its own line and must be reported at that line. Were
  // the subpath an implicit any, none of them would be an error.
  const misuses = [
    'tmp();',
    'tmp("prefix-");',
    'gitRepo({ prefix: "p-" });',
    'export const wrong: number = tmp(t);',
  ];
  const invalid = compileConsumer(t, [...header, ...misuses, ''].join('\n'));
  assert.notEqual(invalid.status, 0, 'misusing the test-kit must fail to type-check');
  misuses.forEach((misuse, i) => {
    const line = header.length + i + 1;
    assert.match(invalid.output, new RegExp(`consumer\\.mts\\(${line},`), `no type error reported for line ${line}: ${misuse}\n${invalid.output}`);
  });
});
