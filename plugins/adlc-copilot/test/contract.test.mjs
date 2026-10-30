import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('package.json scripts.test covers test/, hooks/test/, lib/test/, and mcp/test/ (#814)', () => {
  const pkg = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'package.json'), 'utf8'));
  for (const glob of ['test/*.test.mjs', 'hooks/test/*.test.mjs', 'lib/test/*.test.mjs', 'mcp/test/*.test.mjs']) {
    assert.ok(pkg.scripts?.test?.includes(glob), `scripts.test must include ${glob}`);
  }
});
