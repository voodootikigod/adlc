// Every published packages/* member must declare each @adlc/* package its
// shipped code imports. Inside the monorepo an undeclared import still resolves
// through the hoisted workspace link, so only a standalone install of the
// published tarball would notice — at import time, with ERR_MODULE_NOT_FOUND.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PACKAGES = join(ROOT, 'packages');
const SUITE_DIRECTORIES = new Set(['test', 'cli-test', 'adapter-test', 'node_modules']);

/** Bare `@adlc/<name>` package names referenced by static or dynamic imports. */
export function adlcImports(source) {
  const names = new Set();
  const re = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"](@adlc\/[a-z0-9-]+)(?:\/[^'"]*)?['"]/g;
  for (const match of source.matchAll(re)) names.add(match[1]);
  return names;
}

function shippedSources(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SUITE_DIRECTORIES.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...shippedSources(full));
    else if (/\.(?:mjs|js|cjs)$/.test(entry.name)) files.push(full);
  }
  return files;
}

/** @adlc/* imports of one package that its package.json does not declare. */
export function undeclaredAdlcImports(packageDir) {
  const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
  const declared = new Set([
    manifest.name,
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ]);
  const missing = new Set();
  for (const file of shippedSources(packageDir)) {
    for (const name of adlcImports(readFileSync(file, 'utf8'))) {
      if (!declared.has(name)) missing.add(name);
    }
  }
  return [...missing].sort();
}

test('adlcImports sees static, side-effect, dynamic and subpath imports', () => {
  const src = [
    "import { a } from '@adlc/core';",
    "import '@adlc/tickets';",
    "const m = await import('@adlc/fleet');",
    "import { tmp } from '@adlc/core/test-kit';",
    "import x from './local.mjs';",
    "import y from '@other/pkg';",
  ].join('\n');
  assert.deepEqual([...adlcImports(src)].sort(), ['@adlc/core', '@adlc/fleet', '@adlc/tickets']);
});

test('every packages/* member declares the @adlc/* packages its shipped code imports', () => {
  const offenders = [];
  for (const entry of readdirSync(PACKAGES, { withFileTypes: true })) {
    const dir = join(PACKAGES, entry.name);
    if (!entry.isDirectory() || !existsSync(join(dir, 'package.json'))) continue;
    const missing = undeclaredAdlcImports(dir);
    if (missing.length > 0) offenders.push(`packages/${entry.name}: ${missing.join(', ')}`);
  }
  assert.deepEqual(offenders, [], `undeclared @adlc/* dependencies:\n  ${offenders.join('\n  ')}`);
});
