// AC3 pin (#242): the Copilot rails-guard adapter must NOT re-implement rail
// logic — its inline shell classifier is a verbatim copy of the canonical
// @adlc/core implementation (packages/core/lib/shell.mjs). If either side is
// edited without the other, this test fails instead of silently diverging.
//
// This is the same drift-pin packages/core/test/shell.test.mjs applies to the
// codex hook, kept here (in #242 scope) so the copilot copy is covered by the
// plugin's own suite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const HOOK = join(here, '..', 'hooks', 'adlc-rails-guard.mjs');
const CORE = join(here, '..', '..', '..', 'packages', 'core', 'lib', 'shell.mjs');

const CLASSIFIERS = [
  'shellHasMutation',
  'shellHasOpaqueMutation',
  'shellIsPositivelyReadOnly',
  'shellHasWriteOption',
  'shellChangesCwd',
  'shellHasExpansion',
];

test('copilot inline shell classifier matches canonical @adlc/core (no vendored re-implementation)', () => {
  const hook = readFileSync(HOOK, 'utf8');
  const core = readFileSync(CORE, 'utf8');
  const extract = (src, fn) => {
    const m = src.match(new RegExp(`function ${fn}\\(text\\) \\{[\\s\\S]*?\\n\\}`));
    assert.ok(m, `${fn} found`);
    return m[0].replace(/\s+/g, ' ');
  };
  for (const fn of CLASSIFIERS) {
    assert.equal(extract(hook, fn), extract(core, fn), `${fn} drifted between copilot hook and @adlc/core`);
  }
});
