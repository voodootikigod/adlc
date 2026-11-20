import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildVacuousPrompt, DEFAULT_CRITERIA_MAX_BYTES } from '../lib/llm.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SPEC_LINT_BIN = join(REPO_ROOT, 'packages/spec-lint/bin/spec-lint.mjs');

describe('T-P12: spec-lint fails closed instead of silently truncating criteria >8KB', () => {
  it('buildVacuousPrompt throws when criteria exceed DEFAULT_CRITERIA_MAX_BYTES and succeeds when maxBytes is raised', () => {
    const longCriterion = { line: 1, text: `Verify via \`npm test\`: ${'a'.repeat(DEFAULT_CRITERIA_MAX_BYTES + 100)} TAIL_SENTINEL` };
    assert.throws(
      () => buildVacuousPrompt([longCriterion]),
      /exceeds --max-bytes/,
    );
    const prompt = buildVacuousPrompt([longCriterion], { maxBytes: DEFAULT_CRITERIA_MAX_BYTES + 500 });
    assert.ok(prompt.includes('TAIL_SENTINEL'), 'raised maxBytes must include trailing criteria without truncation');
  });

  it('buildVacuousPrompt rejects non-positive or non-integer maxBytes', () => {
    for (const bad of [0, -10, 1.5, NaN]) {
      assert.throws(() => buildVacuousPrompt([{ line: 1, text: 'ok' }], { maxBytes: bad }), /positive integer/);
    }
  });

  it('CLI --prompt-only fails closed (exit 1) above 8KB unless --max-bytes is raised', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'adlc-speclint-trunc-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const specPath = join(dir, 'large-spec.md');
    const lines = ['# Large Spec', '', '## Acceptance Criteria'];
    for (let i = 0; i < 60; i += 1) {
      lines.push(`- Criterion ${i}: verify via \`npm test\` — ${'x'.repeat(150)}`);
    }
    lines.push('- Final criterion: verify via `npm test` — FINAL_CRITERION_SENTINEL');
    writeFileSync(specPath, lines.join('\n') + '\n');

    const failRes = spawnSync(process.execPath, [SPEC_LINT_BIN, specPath, '--prompt-only'], { encoding: 'utf8' });
    assert.equal(failRes.status, 1, `expected exit 1 on >8KB spec, got ${failRes.status}`);
    assert.match(failRes.stderr, /exceeds --max-bytes/);

    const badFlagRes = spawnSync(process.execPath, [SPEC_LINT_BIN, specPath, '--prompt-only', '--max-bytes', '0'], { encoding: 'utf8' });
    assert.equal(badFlagRes.status, 1);
    assert.match(badFlagRes.stderr, /--max-bytes must be a positive integer/);

    const okRes = spawnSync(process.execPath, [SPEC_LINT_BIN, specPath, '--prompt-only', '--max-bytes', '25000'], { encoding: 'utf8' });
    assert.equal(okRes.status, 0, okRes.stderr);
    assert.ok(okRes.stdout.includes('FINAL_CRITERION_SENTINEL'), 'output must retain final criterion without truncation');
  });
});
