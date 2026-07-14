import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { MARKETING_GATES } from '../lib/marketing-gates.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const cli = path.join(repoRoot, 'packages/cli/bin/adlc.mjs');

test('every homepage gate names a real umbrella CLI command', () => {
  for (const gate of MARKETING_GATES) {
    assert.ok(gate.command.startsWith(`adlc ${gate.name}`), gate.command);
    const result = spawnSync(process.execPath, [cli, gate.name, '--help'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, `${gate.name}: ${result.stderr}`);
  }
});

test('homepage examples use the required current flags', () => {
  const byName = Object.fromEntries(MARKETING_GATES.map((gate) => [gate.name, gate.command]));
  assert.match(byName['rails-guard'], /--base main --ticket T42 --tickets/);
  assert.doesNotMatch(byName['rails-guard'], /--check/);
  assert.match(byName['hollow-test'], /--test-cmd/);
  assert.match(byName['review-calibration'], /--review-cmd "adlc review --base \{base\}"/);
  const nestedReview = spawnSync(process.execPath, [cli, 'review', '--help'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.equal(nestedReview.status, 0, nestedReview.stderr);
});
