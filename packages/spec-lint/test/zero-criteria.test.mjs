// spec-lint zero-criteria gate — a spec with no recognized acceptance criteria
// must FAIL closed (exit 2), not pass by vacuous truth.
// Seam 7 remediation (delta.md / PR #486): the F1 gate that rejects
// under-specification was itself passing a spec that specified nothing.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const BIN = new URL('../bin/spec-lint.mjs', import.meta.url).pathname;

function runCli(specText, extraArgs = []) {
  const dir = mkdtempSync(join(tmpdir(), 'spec-lint-zc-'));
  const spec = join(dir, 'spec.md');
  writeFileSync(spec, specText);
  try {
    const stdout = execFileSync(process.execPath, [BIN, spec, ...extraArgs], {
      encoding: 'utf8',
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('spec-lint zero-criteria gate (fail closed)', () => {
  it('exits 2 when a spec has no acceptance criteria at all', () => {
    const { code } = runCli('# Feature\n\nSome prose describing intent, but no criteria.\n');
    assert.equal(code, 2);
  });

  it('exits 2 when criteria sit under an unrecognized heading (so none are parsed)', () => {
    const spec = '# Feature\n\n## Totally Unrecognized Heading\n- do the thing, verify: `node --test x.test.mjs`\n';
    const { code } = runCli(spec);
    assert.equal(code, 2);
  });

  it('exits 2 in --json mode with zero criteria, and still emits the json body', () => {
    const { code, stdout } = runCli('# Feature\n\nNo criteria here.\n', ['--json']);
    assert.equal(code, 2);
    assert.match(stdout, /"total":\s*0/);
  });

  it('still exits 0 for a spec with a verified criterion (regression guard)', () => {
    const spec = '# Feature\n\n## Acceptance Criteria\n- The build passes. verify: `node --test test/build.test.mjs`\n';
    const { code } = runCli(spec);
    assert.equal(code, 0);
  });
});
