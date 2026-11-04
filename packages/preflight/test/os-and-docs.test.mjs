import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('package.json declares os: [darwin, linux] (#715)', () => {
  const pkg = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8'));
  assert.deepEqual(pkg.os, ['darwin', 'linux']);
});

test('README documents POSIX platform requirement (#715)', () => {
  const readme = readFileSync(join(PKG_ROOT, 'README.md'), 'utf8');
  assert.match(readme, /POSIX/);
  assert.match(readme, /darwin/);
  assert.match(readme, /linux/);
});
