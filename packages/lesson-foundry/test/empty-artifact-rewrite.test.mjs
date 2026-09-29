// --write preserves an existing artifact only when it holds content. An empty
// or whitespace-only artifact defends nothing (the gate does not credit it), so
// plain --write regenerates it instead of reporting it as a hand-refined file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmp } from '@adlc/core/test-kit';
import { hasDefenseContent, readArtifact, writeFileAtomic } from '../lib/artifact-io.mjs';

const BIN = resolve(new URL('../bin/lesson-foundry.mjs', import.meta.url).pathname);

const LINT_ENTRIES = [
  { ts: '2025-01-01', tool: 'test', file: 'a.mjs', line: 1, category: 'security', severity: 'high', desc: 'missing null check before calling "db.query"' },
  { ts: '2025-01-02', tool: 'test', file: 'b.mjs', line: 2, category: 'security', severity: 'high', desc: 'missing null check before calling "db.query"' },
];

function setup(t) {
  const dir = tmp(t, 'lf-empty-artifact-');
  mkdirSync(join(dir, '.adlc'), { recursive: true });
  writeFileSync(join(dir, '.adlc', 'findings.jsonl'), LINT_ENTRIES.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return { dir, outDir: join(dir, '.adlc', 'lessons') };
}

function run(dir, args) {
  const res = spawnSync(process.execPath, [BIN, ...args], { cwd: dir, encoding: 'utf8', timeout: 15000 });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

function lintPath(outDir) {
  const files = readdirSync(outDir).filter((f) => f.endsWith('.lint.json'));
  assert.equal(files.length, 1, `expected one .lint.json, found: ${files.join(', ')}`);
  return join(outDir, files[0]);
}

for (const [label, body] of [['0-byte', ''], ['whitespace-only', '  \n\t\n']]) {
  test(`plain --write regenerates a ${label} artifact and the gate then passes`, (t) => {
    const { dir, outDir } = setup(t);
    assert.equal(run(dir, ['--write', '--out-dir', outDir]).code, 0);
    const path = lintPath(outDir);
    const scaffold = readFileSync(path, 'utf8');
    writeFileSync(path, body);
    assert.equal(run(dir, ['--gate', '--out-dir', outDir]).code, 2, 'precondition: the gate does not credit an empty artifact');

    const rewrite = run(dir, ['--write', '--out-dir', outDir]);
    assert.equal(rewrite.code, 0, rewrite.stderr);
    assert.match(rewrite.stdout, /empty \(regenerated\):.*\.lint\.json/);
    assert.doesNotMatch(rewrite.stdout, /exists \(skipped\):.*\.lint\.json/);
    assert.equal(readFileSync(path, 'utf8'), scaffold);

    assert.equal(run(dir, ['--gate', '--out-dir', outDir]).code, 0);
  });
}

test('--json --write does not list a regenerated empty artifact as skipped', (t) => {
  const { dir, outDir } = setup(t);
  assert.equal(run(dir, ['--write', '--out-dir', outDir]).code, 0);
  const path = lintPath(outDir);
  writeFileSync(path, '');
  const res = run(dir, ['--write', '--json', '--out-dir', outDir]);
  assert.equal(res.code, 0, res.stderr);
  const skipped = JSON.parse(res.stdout).writeSkipped;
  assert.ok(skipped.length > 0, 'precondition: the non-empty sibling artifact is still skipped');
  assert.ok(!skipped.includes(path), `the regenerated artifact must not be listed as skipped: ${skipped}`);
});

test('a non-empty hand-edited artifact is still preserved', (t) => {
  const { dir, outDir } = setup(t);
  assert.equal(run(dir, ['--write', '--out-dir', outDir]).code, 0);
  const path = lintPath(outDir);
  writeFileSync(path, '{"pattern":"HAND"}\n');
  const res = run(dir, ['--write', '--out-dir', outDir]);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /exists \(skipped\)/);
  assert.equal(readFileSync(path, 'utf8'), '{"pattern":"HAND"}\n');
});

test('--write leaves no temporary files beside the artifacts', (t) => {
  const { dir, outDir } = setup(t);
  assert.equal(run(dir, ['--write', '--out-dir', outDir]).code, 0);
  const stray = readdirSync(outDir).filter((f) => f.includes('.tmp'));
  assert.deepEqual(stray, []);
});

test('hasDefenseContent requires a non-whitespace string', () => {
  assert.equal(hasDefenseContent('x'), true);
  assert.equal(hasDefenseContent(' \n{}\n'), true);
  assert.equal(hasDefenseContent(''), false);
  assert.equal(hasDefenseContent(' \n\t'), false);
  assert.equal(hasDefenseContent(null), false);
  assert.equal(hasDefenseContent(undefined), false);
});

test('writeFileAtomic replaces the target and removes its temp file when the rename fails', (t) => {
  const dir = tmp(t, 'lf-atomic-');
  const target = join(dir, 'a.lint.json');
  writeFileAtomic(target, 'one');
  writeFileAtomic(target, 'two');
  assert.equal(readFileSync(target, 'utf8'), 'two');
  assert.deepEqual(readdirSync(dir), ['a.lint.json']);

  const blocked = join(dir, 'blocked');
  mkdirSync(join(blocked, 'child'), { recursive: true });
  assert.throws(() => writeFileAtomic(blocked, 'x'));
  assert.deepEqual(readdirSync(dir).sort(), ['a.lint.json', 'blocked']);
});

test('readArtifact returns the text, or null when unreadable', (t) => {
  const dir = tmp(t, 'lf-read-');
  writeFileSync(join(dir, 'f'), 'body');
  assert.equal(readArtifact(join(dir, 'f')), 'body');
  assert.equal(readArtifact(join(dir, 'missing')), null);
  assert.equal(readArtifact(dir), null);
});
