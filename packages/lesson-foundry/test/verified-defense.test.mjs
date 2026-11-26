import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyLintClusters } from '../lib/verify-defense.mjs';

const CLI_PATH = fileURLToPath(new URL('../bin/lesson-foundry.mjs', import.meta.url));

test('verifyLintClusters: keeps valid lint cluster when synthetic checks pass and baseline is clean', (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'verify-defense-clean-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));

  writeFileSync(join(rootDir, 'clean.js'), 'const a = 1;\n', 'utf8');

  const findings = [
    { file: 'a.mjs', desc: 'found "BANNED_MAGIC_TOKEN_XYZ" in code', category: 'correctness' },
    { file: 'b.mjs', desc: 'also has "BANNED_MAGIC_TOKEN_XYZ"', category: 'correctness' },
  ];
  const clusters = [
    {
      name: 'banned-magic-token',
      route: 'lint',
      indices: [0, 1],
    },
  ];

  verifyLintClusters(clusters, findings, { root: rootDir });
  assert.equal(clusters[0].route, 'lint');
  assert.equal(clusters[0].demotedReason, undefined);
});

test('verifyLintClusters: demotes lint cluster to spec-gap when baseline root contains pattern', (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'verify-defense-matched-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));

  writeFileSync(join(rootDir, 'existing.mjs'), 'const validCode = "VALID_EXISTING_TOKEN_123";\n', 'utf8');

  const findings = [
    { file: 'x.mjs', desc: 'quoted token "VALID_EXISTING_TOKEN_123" mentioned in prose', category: 'correctness' },
    { file: 'y.mjs', desc: 'another finding mentions "VALID_EXISTING_TOKEN_123"', category: 'correctness' },
  ];
  const clusters = [
    {
      name: 'valid-existing-token',
      route: 'lint',
      indices: [0, 1],
    },
  ];

  verifyLintClusters(clusters, findings, { root: rootDir });
  assert.equal(clusters[0].route, 'spec-gap');
  assert.equal(clusters[0].demotedReason, 'matches-existing-repo');
});

test('lesson-foundry --verify-checks CLI integration: demotes false-positive lint to spec-gap and writes template', (t) => {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'foundry-cli-fixture-'));
  t.after(() => rmSync(fixtureDir, { recursive: true, force: true }));

  const dotAdlc = join(fixtureDir, '.adlc');
  mkdirSync(dotAdlc, { recursive: true });

  // Baseline file matching the quoted token in finding
  writeFileSync(join(fixtureDir, 'index.mjs'), 'const token = "MY_SPECIAL_TOKEN_ABC";\n', 'utf8');

  // Ledger with 2 findings with identical non-quoted tokens so they cluster
  const findingsLines = [
    JSON.stringify({ file: 'src/a.mjs', ts: '2026-01-01T00:00:00Z', desc: 'prohibited token identifier "MY_SPECIAL_TOKEN_ABC" detected in syntax', category: 'correctness' }),
    JSON.stringify({ file: 'src/b.mjs', ts: '2026-01-01T00:01:00Z', desc: 'prohibited token identifier "MY_SPECIAL_TOKEN_ABC" detected in syntax', category: 'correctness' }),
  ].join('\n');
  writeFileSync(join(dotAdlc, 'findings.jsonl'), findingsLines + '\n', 'utf8');

  const outDir = join(fixtureDir, 'lessons');

  const res = spawnSync(process.execPath, [
    CLI_PATH,
    '--ledger', 'findings',
    '--out-dir', outDir,
    '--root', fixtureDir,
    '--verify-checks',
    '--write',
    '--gate',
    '--json',
  ], {
    cwd: fixtureDir,
    encoding: 'utf8',
  });

  assert.equal(res.status, 0, (res.stderr || '') + '\n' + (res.stdout || ''));
  const templatePath = join(outDir, 'interrogation-template.md');
  const templateContent = readFileSync(templatePath, 'utf8');
  assert.match(templateContent, /MY_SPECIAL_TOKEN_ABC/);
});
