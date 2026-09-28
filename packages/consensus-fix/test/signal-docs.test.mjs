/**
 * signal-docs.test.mjs — the README and the docs-site page state the same
 * termination-signal guarantee, and it names the one case that is not covered.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const README = fileURLToPath(new URL('../README.md', import.meta.url));
const MIRROR = fileURLToPath(new URL('../../../apps/docs/content/docs/toolkit/consensus-fix.mdx', import.meta.url));

function signalClaim(path) {
  const line = readFileSync(path, 'utf8').split('\n').find((l) => l.startsWith('- **Termination signal restore**'));
  assert.ok(line, `${path} has no termination-signal bullet`);
  return line;
}

test('README and docs mirror carry the same termination-signal guarantee', () => {
  assert.equal(signalClaim(MIRROR), signalClaim(README));
});

test('termination-signal guarantee covers in-flight commands and names the SIGKILL gap', () => {
  const claim = signalClaim(README);
  assert.match(claim, /while a candidate's test or rails command is running/);
  assert.match(claim, /no winner is applied/);
  assert.match(claim, /SIGKILL sent to consensus-fix itself cannot be handled/);
});
