// no-criteria-lines.test.mjs — the "no acceptance criteria" gate failure is
// printed as short lines, not one long line.
// Runs the real binary; offline, temp dirs only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmp, runBin } from '@adlc/core/test-kit';

const BIN = fileURLToPath(new URL('../bin/spec-lint.mjs', import.meta.url));

test('no-criteria message is three short lines', (t) => {
  const dir = tmp(t, 'spec-lint-lines-');
  const spec = join(dir, 'spec.md');
  writeFileSync(spec, '# Feature\n\nSome prose describing intent, but no criteria.\n');
  const r = runBin(BIN, [spec], { cwd: dir });
  assert.equal(r.status, 2, r.stderr);
  const lines = r.stderr.trim().split('\n');
  const start = lines.indexOf('spec-lint: no acceptance criteria found.');
  assert.notEqual(start, -1, `heading line missing:\n${r.stderr}`);
  assert.deepEqual(lines.slice(start), [
    'spec-lint: no acceptance criteria found.',
    'State at least one criterion under a recognized heading (Acceptance Criteria / Requirements).',
    'Give each criterion a verification method. Zero criteria fails the gate.',
  ]);
  for (const line of lines) {
    assert.ok(line.length <= 120, `line longer than 120 characters (${line.length}): ${line}`);
  }
});
