import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('README documents POSIX platform requirement (#715)', () => {
  const readme = readFileSync(join(PKG_ROOT, 'README.md'), 'utf8');
  assert.match(readme, /## Platform support/);
  assert.match(readme, /POSIX/);
  assert.match(readme, /darwin/);
  assert.match(readme, /linux/);
});
