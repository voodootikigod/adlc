// prosecutor.test.mjs — verifies the full 5-lens prosecutor roster and verifier agent definitions.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const agentsDir = join(here, '..', 'agents');

const PROSECTOR_ROSTER = [
  'prosecutor.md',
  'prosecutor-contract.md',
  'prosecutor-correctness.md',
  'prosecutor-diff.md',
  'prosecutor-security.md',
  'prosecutor-tests.md',
  'prosecutor-verifier.md',
];

test('P5 prosecutor roster: all 5 lenses, main prosecutor, and verifier exist', () => {
  for (const file of PROSECTOR_ROSTER) {
    const fullPath = join(agentsDir, file);
    assert.ok(existsSync(fullPath), `Agent file missing: ${file}`);
    const content = readFileSync(fullPath, 'utf8');
    assert.match(content, /^---\nname:\s*prosecutor(-[a-z]+)?$/m, `Frontmatter name missing or invalid in ${file}`);
    assert.match(content, /description:/m, `Description missing in ${file}`);
  }
});
