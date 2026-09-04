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

test('P5 prosecutor roster: all 5 lenses, main prosecutor, and verifier exist and have matching unique names', () => {
  const names = new Set();
  for (const file of PROSECTOR_ROSTER) {
    const fullPath = join(agentsDir, file);
    assert.ok(existsSync(fullPath), `Agent file missing: ${file}`);
    const content = readFileSync(fullPath, 'utf8');
    const expectedName = file.replace(/\.md$/, '');
    const nameMatch = content.match(/^name:\s*(.+)$/m);
    assert.ok(nameMatch, `Frontmatter name missing in ${file}`);
    const actualName = nameMatch[1].trim();
    assert.equal(actualName, expectedName, `Frontmatter name '${actualName}' in ${file} does not match expected '${expectedName}'`);
    assert.equal(names.has(actualName), false, `Duplicate frontmatter name '${actualName}' in ${file}`);
    names.add(actualName);
    assert.match(content, /description:/m, `Description missing in ${file}`);
  }
});

test('adlc-prosecute command exists and documents multi-lens fan-out', () => {
  const cmdPath = join(here, '..', 'commands', 'adlc-prosecute.md');
  assert.ok(existsSync(cmdPath), 'commands/adlc-prosecute.md missing');
  const content = readFileSync(cmdPath, 'utf8');
  assert.match(content, /invoke_subagent/);
  assert.match(content, /prosecutor-contract/);
  assert.match(content, /prosecutor-verifier/);
});

test('adlc-prosecutor skill documents invoke_subagent fan-out payload', () => {
  const skillPath = join(here, '..', 'skills', 'adlc-prosecutor', 'SKILL.md');
  assert.ok(existsSync(skillPath), 'skills/adlc-prosecutor/SKILL.md missing');
  const content = readFileSync(skillPath, 'utf8');
  assert.match(content, /invoke_subagent/);
  assert.match(content, /TypeName": "prosecutor-contract/);
});
