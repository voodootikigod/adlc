import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateAll } from '../scripts/gen-schema.mjs';
import { DEFS } from '../lib/schema.mjs';

const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'schemas');

test('drift gate: committed schemas/*.json match the generator output', () => {
  const generated = generateAll();
  for (const [file, content] of Object.entries(generated)) {
    const committed = readFileSync(join(SCHEMA_DIR, file), 'utf8');
    assert.equal(committed, content, `${file} has drifted — run: node scripts/gen-schema.mjs`);
  }
});

test('every definition produces exactly one committed schema file', () => {
  const generated = Object.keys(generateAll()).sort();
  const expected = Object.values(DEFS).map((d) => `${d.id}.schema.json`).sort();
  assert.deepEqual(generated, expected);
});

test('each schema is valid JSON with $id and the draft 2020-12 $schema', () => {
  for (const def of Object.values(DEFS)) {
    const obj = JSON.parse(readFileSync(join(SCHEMA_DIR, `${def.id}.schema.json`), 'utf8'));
    assert.equal(obj.$schema, 'https://json-schema.org/draft/2020-12/schema');
    assert.ok(obj.$id.endsWith(`${def.id}.schema.json`), `${def.id} missing/!$id`);
    assert.equal(obj.type, 'object');
  }
});

test('dependency hygiene (AC5): no third-party runtime deps — only @adlc/* allowed', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const thirdParty = Object.keys(pkg.dependencies ?? {}).filter((d) => !d.startsWith('@adlc/'));
  assert.deepEqual(thirdParty, [], `non-@adlc runtime dependency present: ${thirdParty.join(', ')}`);
});
