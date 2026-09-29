// A skill is shown as [OK] and counted clean only when the checker says allOk:
// at least one claim verified and none stale. A skill whose claims are all
// unverifiable is [UNVERIFIED], counted separately, and never stamped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmp } from '@adlc/core/test-kit';
import { formatTable, formatJson } from '../lib/format.mjs';

const BIN = fileURLToPath(new URL('../bin/skill-rot.mjs', import.meta.url));

function result(path, ok, stale, unverifiable) {
  return { path, ok, stale, unverifiable, staleDetails: [], allOk: ok > 0 && stale === 0 };
}

const ROOT = '/repo';
const RESULTS = [
  result('/repo/skills/ok/SKILL.md', 2, 0, 1),
  result('/repo/skills/unv/SKILL.md', 0, 0, 1),
  result('/repo/skills/stale/SKILL.md', 1, 1, 0),
  result('/repo/skills/none/SKILL.md', 0, 0, 0),
];

test('formatTable labels each status from the checker verdict', () => {
  const table = formatTable(RESULTS, ROOT);
  assert.match(table, /\[OK\] {4}skills\/ok\/SKILL\.md/);
  assert.match(table, /\[UNVERIFIED\] skills\/unv\/SKILL\.md/);
  assert.match(table, /\[STALE\] skills\/stale\/SKILL\.md/);
  assert.match(table, /\[NO-CLAIMS\] skills\/none\/SKILL\.md/);
  assert.equal((table.match(/\[OK\]/g) ?? []).length, 1);
  assert.match(table, /Summary: 4 skill\(s\) checked, 1 clean, 1 stale, 1 no claims, 1 unverified$/);
});

test('formatJson counts an unverifiable-only skill as unverified, not clean', () => {
  const json = formatJson(RESULTS, ROOT);
  assert.deepEqual(json.summary, { total: 4, clean: 1, stale: 1, noClaims: 1, unverified: 1 });
  const unv = json.skills.find((s) => s.path === 'skills/unv/SKILL.md');
  assert.equal(unv.allOk, false);
  assert.equal(unv.unverified, true);
  assert.equal(json.skills.find((s) => s.path === 'skills/ok/SKILL.md').unverified, undefined);
});

test('CLI: an unverifiable-only skill is [UNVERIFIED], not clean, and not stamped', (t) => {
  const dir = tmp(t, 'skill-rot-unverified-');
  const skill = join(dir, 'skills', 'unv', 'SKILL.md');
  mkdirSync(join(dir, 'skills', 'unv'), { recursive: true });
  writeFileSync(skill, '# Unv\nRun yarn run my-script for details.\n');

  const table = spawnSync(process.execPath, [BIN, 'skills', '--write'], { cwd: dir, encoding: 'utf8' });
  assert.equal(table.status, 0, table.stderr);
  assert.match(table.stdout, /\[UNVERIFIED\] skills\/unv\/SKILL\.md/);
  assert.doesNotMatch(table.stdout, /\[OK\]/);
  assert.match(table.stdout, /0 clean, 0 stale, 0 no claims, 1 unverified/);
  assert.doesNotMatch(readFileSync(skill, 'utf8'), /last-verified/);

  const json = spawnSync(process.execPath, [BIN, 'skills', '--json'], { cwd: dir, encoding: 'utf8' });
  assert.equal(json.status, 0, json.stderr);
  const parsed = JSON.parse(json.stdout);
  assert.equal(parsed.summary.clean, 0);
  assert.equal(parsed.summary.unverified, 1);
});
