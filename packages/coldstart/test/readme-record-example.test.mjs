// readme-record-example.test.mjs — the README's --record-verdict worked
// example must pipe JSON that parses to {gaps:[...], ticketHash:"…"}: the
// P0 assertion (packages/runner/lib/assertions.mjs) JSON.parses
// data.verdict and requires that shape, so free-form prose recorded via
// this example would satisfy the CLI but fail the gate. This test extracts
// the JSON literal from the README's stdin example and asserts it parses
// to that shape, so the doc can't drift stale again without this test
// catching it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const README = readFileSync(join(HERE, '..', 'README.md'), 'utf8');

test('README stdin --record-verdict example pipes valid P0 verdict JSON', () => {
  const match = README.match(/echo '(\{[^']*\})'/);
  assert.ok(match, 'README must show a JSON literal piped to --record-verdict');
  const parsed = JSON.parse(match[1].replace('<ticketHash from `adlc ticket show T1 --json`>', 'deadbeef'));
  assert.ok(Array.isArray(parsed.gaps), 'the example must include a gaps array');
  assert.equal(typeof parsed.ticketHash, 'string', 'the example must include a ticketHash placeholder');
});
