import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scaffold } from '../index.mjs';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin/adlc-init.mjs');

function withConfig(config, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-init-harnesses-shape-'));
  try {
    mkdirSync(join(dir, '.adlc'), { recursive: true });
    const text = `${JSON.stringify(config)}\n`;
    writeFileSync(join(dir, '.adlc/config.json'), text);
    fn(dir, text);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const [label, harnesses] of [['an array', []], ['a string', 'codex'], ['a number', 3], ['null', null]]) {
  test(`--harness against a config whose harnesses is ${label} warns, leaves the file, and fails the run`, () => {
    withConfig({ version: 1, securityMode: 'unsigned-fallback', harnesses }, (dir, text) => {
      const result = scaffold({ root: dir, harness: 'cursor' });
      assert.equal(result.updated.includes('.adlc/config.json'), false);
      assert.ok(
        result.warnings.some((w) => w.includes('`harnesses` is not an object') && w.includes('cursor')),
        `warnings: ${JSON.stringify(result.warnings)}`,
      );
      assert.equal(readFileSync(join(dir, '.adlc/config.json'), 'utf8'), text);

      const res = spawnSync(process.execPath, [BIN, '--root', dir, '--harness', 'codex', '--json'], { encoding: 'utf8' });
      assert.equal(res.status, 1);
      assert.equal(JSON.parse(res.stdout).ok, false);
    });
  });
}

test('without --harness a non-object harnesses field is left alone and reported unchanged', () => {
  withConfig({ version: 1, harnesses: [] }, (dir) => {
    const result = scaffold({ root: dir });
    assert.ok(result.unchanged.includes('.adlc/config.json'));
    assert.equal(result.warnings.some((w) => w.includes('`harnesses`')), false);
  });
});
