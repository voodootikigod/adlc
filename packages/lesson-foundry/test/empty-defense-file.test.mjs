import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildClusters, findUnbankedClusters } from '../lib/foundry.mjs';

const BIN = resolve(new URL('../bin/lesson-foundry.mjs', import.meta.url).pathname);

function runCli(args, cwd) {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 15000,
  });
  return { stdout: result.stdout, stderr: result.stderr, code: result.status };
}

test('AC1: 0-byte defense file (.lint.json) does not grant legacy credit; cluster remains unbanked', () => {
  const dir = mkdtempSync(join(tmpdir(), 'empty-defense-test-'));
  try {
    const outDir = join(dir, 'lessons');
    mkdirSync(outDir, { recursive: true });
    const findings = [
      { ts: 't1', file: 'a.mjs', line: 1, category: 'security', desc: 'eval("alert(1)") is dangerous' },
      { ts: 't2', file: 'b.mjs', line: 2, category: 'security', desc: 'eval("alert(2)") is dangerous' },
    ];
    const [cluster] = buildClusters(findings, 2);
    assert.equal(cluster.route, 'lint');
    // Create a 0-byte file matching the cluster's slug name
    writeFileSync(join(outDir, `${cluster.name}.lint.json`), '', 'utf8');

    const unbanked = findUnbankedClusters([cluster], outDir, existsSync);
    assert.equal(unbanked.length, 1, '0-byte lint defense file must leave cluster unbanked');
    assert.equal(unbanked[0].name, cluster.name);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AC1: 0-byte defense file (.SKILL.md) does not grant legacy credit; cluster remains unbanked', () => {
  const dir = mkdtempSync(join(tmpdir(), 'empty-defense-test-'));
  try {
    const outDir = join(dir, 'lessons');
    mkdirSync(outDir, { recursive: true });
    const findings = [
      { ts: 't1', file: 'a.mjs', line: 1, category: 'convention', desc: 'missing error handling in async functions' },
      { ts: 't2', file: 'b.mjs', line: 2, category: 'convention', desc: 'no error handling for async operation' },
    ];
    const [cluster] = buildClusters(findings, 2);
    assert.equal(cluster.route, 'skill');
    // Create a 0-byte file matching the cluster's slug name
    writeFileSync(join(outDir, `${cluster.name}.SKILL.md`), '', 'utf8');

    const unbanked = findUnbankedClusters([cluster], outDir, existsSync);
    assert.equal(unbanked.length, 1, '0-byte skill defense file must leave cluster unbanked');
    assert.equal(unbanked[0].name, cluster.name);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AC1: whitespace-only defense file does not grant legacy credit; cluster remains unbanked', () => {
  const dir = mkdtempSync(join(tmpdir(), 'empty-defense-test-'));
  try {
    const outDir = join(dir, 'lessons');
    mkdirSync(outDir, { recursive: true });
    const findings = [
      { ts: 't1', file: 'a.mjs', line: 1, category: 'convention', desc: 'missing error handling in async functions' },
      { ts: 't2', file: 'b.mjs', line: 2, category: 'convention', desc: 'no error handling for async operation' },
    ];
    const [cluster] = buildClusters(findings, 2);
    assert.equal(cluster.route, 'skill');
    // Whitespace only
    writeFileSync(join(outDir, `${cluster.name}.SKILL.md`), '   \n\t  \n  ', 'utf8');

    const unbanked = findUnbankedClusters([cluster], outDir, existsSync);
    assert.equal(unbanked.length, 1, 'whitespace-only defense file must leave cluster unbanked');
    assert.equal(unbanked[0].name, cluster.name);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AC2: unreadable defense file (EISDIR / read error) does not grant legacy credit; cluster remains unbanked', () => {
  const dir = mkdtempSync(join(tmpdir(), 'empty-defense-test-'));
  try {
    const outDir = join(dir, 'lessons');
    mkdirSync(outDir, { recursive: true });
    const findings = [
      { ts: 't1', file: 'a.mjs', line: 1, category: 'security', desc: 'eval("alert(1)") is dangerous' },
      { ts: 't2', file: 'b.mjs', line: 2, category: 'security', desc: 'eval("alert(2)") is dangerous' },
    ];
    const [cluster] = buildClusters(findings, 2);
    // Create a directory with the artifact's name to trigger an EISDIR readFileSync error
    mkdirSync(join(outDir, `${cluster.name}.lint.json`));

    const unbanked = findUnbankedClusters([cluster], outDir, existsSync);
    assert.equal(unbanked.length, 1, 'unreadable defense file (EISDIR) must leave cluster unbanked');
    assert.equal(unbanked[0].name, cluster.name);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AC2: custom readFile returning null or throwing does not grant legacy credit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'empty-defense-test-'));
  try {
    const outDir = join(dir, 'lessons');
    mkdirSync(outDir, { recursive: true });
    const findings = [
      { ts: 't1', file: 'a.mjs', line: 1, category: 'security', desc: 'eval("alert(1)") is dangerous' },
      { ts: 't2', file: 'b.mjs', line: 2, category: 'security', desc: 'eval("alert(2)") is dangerous' },
    ];
    const [cluster] = buildClusters(findings, 2);
    // File exists according to existsSync
    writeFileSync(join(outDir, `${cluster.name}.lint.json`), 'placeholder', 'utf8');

    // readFile mock that returns null (read error)
    const unbankedNull = findUnbankedClusters(
      [cluster],
      outDir,
      existsSync,
      () => null,
      () => [`${cluster.name}.lint.json`],
    );
    assert.equal(unbankedNull.length, 1, 'readFile returning null must leave cluster unbanked');

    // readFile mock that throws
    const unbankedThrow = findUnbankedClusters(
      [cluster],
      outDir,
      existsSync,
      () => { throw new Error('EACCES permission denied'); },
      () => [`${cluster.name}.lint.json`],
    );
    assert.equal(unbankedThrow.length, 1, 'readFile throwing must leave cluster unbanked');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AC3: existing valid legacy defense files with content still receive legacy credit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'empty-defense-test-'));
  try {
    const outDir = join(dir, 'lessons');
    mkdirSync(outDir, { recursive: true });
    const findings = [
      { ts: 't1', file: 'a.mjs', line: 1, category: 'convention', desc: 'missing error handling in async functions' },
      { ts: 't2', file: 'b.mjs', line: 2, category: 'convention', desc: 'no error handling for async operation' },
    ];
    const [cluster] = buildClusters(findings, 2);
    // Valid legacy defense file with content without member markers
    writeFileSync(join(outDir, `${cluster.name}.SKILL.md`), '# Hand-authored skill rule\nAlways handle errors.\n', 'utf8');

    const unbanked = findUnbankedClusters([cluster], outDir, existsSync);
    assert.deepEqual(unbanked, [], 'non-empty legacy defense file must grant legacy credit');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AC3: 1-character legacy defense file is non-empty and receives credit (kills off-by-one mutant)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'empty-defense-test-'));
  try {
    const outDir = join(dir, 'lessons');
    mkdirSync(outDir, { recursive: true });
    const findings = [
      { ts: 't1', file: 'a.mjs', line: 1, category: 'convention', desc: 'missing error handling in async functions' },
      { ts: 't2', file: 'b.mjs', line: 2, category: 'convention', desc: 'no error handling for async operation' },
    ];
    const [cluster] = buildClusters(findings, 2);
    // 1-character defense file (trimmed length is exactly 1)
    writeFileSync(join(outDir, `${cluster.name}.SKILL.md`), 'x', 'utf8');

    const unbanked = findUnbankedClusters([cluster], outDir, existsSync);
    assert.deepEqual(unbanked, [], '1-character legacy defense file must grant legacy credit');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AC1/AC3: CLI --gate exits 2 on 0-byte defense file and 0 on non-empty legacy defense file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'empty-defense-test-'));
  try {
    const adlcDir = join(dir, '.adlc');
    const lessonsDir = join(adlcDir, 'lessons');
    mkdirSync(lessonsDir, { recursive: true });

    const findings = [
      { ts: '2025-01-01', tool: 'test', file: 'a.mjs', line: 1, category: 'security', severity: 'high', desc: 'eval("alert(1)") is dangerous' },
      { ts: '2025-01-02', tool: 'test', file: 'b.mjs', line: 2, category: 'security', severity: 'high', desc: 'eval("alert(2)") is dangerous' },
    ];
    const content = findings.map((e) => JSON.stringify(e)).join('\n') + '\n';
    writeFileSync(join(adlcDir, 'findings.jsonl'), content, 'utf8');

    const [cluster] = buildClusters(findings, 2);
    const defensePath = join(lessonsDir, `${cluster.name}.lint.json`);

    // 1. With 0-byte file: --gate must exit 2
    writeFileSync(defensePath, '', 'utf8');
    const resEmpty = runCli(['--ledger', 'findings', '--min', '2', '--gate', '--out-dir', lessonsDir], dir);
    assert.strictEqual(resEmpty.code, 2, '0-byte defense file must cause --gate to exit 2');
    assert.match(resEmpty.stderr, /unbanked/, 'stderr must report unbanked lesson');

    // 2. With valid non-empty legacy content: --gate must exit 0
    writeFileSync(defensePath, '{"pattern":"eval\\\\(","message":"no eval"}', 'utf8');
    const resValid = runCli(['--ledger', 'findings', '--min', '2', '--gate', '--out-dir', lessonsDir], dir);
    assert.strictEqual(resValid.code, 0, 'non-empty defense file must cause --gate to exit 0');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
