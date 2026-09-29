import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scaffold } from '../index.mjs';
import { ADLC_GITIGNORE_LINES } from '../lib/gitignore-defaults.mjs';
import { REQUIRED_COMMITTABLE_PATHS } from '../lib/scaffold.mjs';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin/adlc-init.mjs');

function ignoredByGit(dir) {
  return REQUIRED_COMMITTABLE_PATHS.filter((p) => spawnSync('git', ['check-ignore', '--no-index', '-q', '--', p], { cwd: dir }).status === 0);
}

function inRepo(gitignore, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-init-anchor-repair-'));
  try {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    writeFileSync(join(dir, '.gitignore'), gitignore);
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a stanza line that precedes a missing anchor is moved after it, leaving every required path committable', () => {
  inRepo('node_modules/\n!.adlc/config.json\n!.adlc/tickets/\n', (dir) => {
    const result = scaffold({ root: dir, harness: 'codex' });
    assert.ok(result.updated.includes('.gitignore'));
    assert.deepEqual(result.warnings.filter((w) => w.includes('gitignore')), []);
    assert.deepEqual(ignoredByGit(dir), []);
    const lines = readFileSync(join(dir, '.gitignore'), 'utf8').split('\n');
    assert.equal(lines[0], 'node_modules/', 'unrelated lines keep their place');
    const stanzaStart = lines.indexOf('.adlc/*');
    assert.deepEqual(lines.slice(stanzaStart, stanzaStart + ADLC_GITIGNORE_LINES.length), [...ADLC_GITIGNORE_LINES]);
    assert.equal(lines.filter((l) => l === '!.adlc/config.json').length, 1, 'no duplicated negation');
  });
});

test('the repaired file is stable: a second run changes nothing and exits 0', () => {
  inRepo('!.adlc/config.json\n', (dir) => {
    scaffold({ root: dir, harness: 'codex' });
    const after = readFileSync(join(dir, '.gitignore'), 'utf8');
    const res = spawnSync(process.execPath, [BIN, '--root', dir, '--harness', 'codex', '--json'], { encoding: 'utf8' });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.ok(JSON.parse(res.stdout).unchanged.includes('.gitignore'));
    assert.equal(readFileSync(join(dir, '.gitignore'), 'utf8'), after);
  });
});
