import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const BIN = join(REPO_ROOT, 'packages/consensus-fix/bin/consensus-fix.mjs');

describe('T-P10: consensus-fix repo containment and active-ticket rail enforcement', () => {
  it('rejects --files escaping repo root via ../ traversal', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'adlc-cfix-escape-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const res = spawnSync(
      process.execPath,
      [BIN, '--test-cmd', 'node -e 0', '--files', '../outside.mjs', '--prompt-only'],
      { cwd: dir, encoding: 'utf8' },
    );
    assert.equal(res.status, 1);
    assert.match(res.stderr, /escapes repository root/);
  });

  it('rejects --files matching an active ticket rail or trust-root rail', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'adlc-cfix-rail-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, '.adlc'), { recursive: true });
    mkdirSync(join(dir, 'test'), { recursive: true });
    writeFileSync(join(dir, 'test', 'frozen.test.mjs'), 'export const x = 1;\n');
    writeFileSync(join(dir, '.adlc', 'tickets.json'), JSON.stringify({
      tickets: [{ id: 'T1', title: 'Railed', scope: ['src/**'], rails: ['test/frozen.test.mjs'], edges: [] }],
    }));

    const railRes = spawnSync(
      process.execPath,
      [BIN, '--test-cmd', 'node -e 0', '--files', 'test/frozen.test.mjs', '--prompt-only'],
      { cwd: dir, encoding: 'utf8' },
    );
    assert.equal(railRes.status, 1);
    assert.match(railRes.stderr, /protected rail/);

    const trustRootRes = spawnSync(
      process.execPath,
      [BIN, '--test-cmd', 'node -e 0', '--files', '.adlc/tickets.json', '--prompt-only'],
      { cwd: dir, encoding: 'utf8' },
    );
    assert.equal(trustRootRes.status, 1);
    assert.match(trustRootRes.stderr, /protected rail/);
  });
});
