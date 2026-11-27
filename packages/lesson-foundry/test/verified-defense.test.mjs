import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
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
  const cwdDir = mkdtempSync(join(tmpdir(), 'foundry-cli-cwd-'));
  const repoRootDir = mkdtempSync(join(tmpdir(), 'foundry-cli-root-'));
  t.after(() => {
    rmSync(cwdDir, { recursive: true, force: true });
    rmSync(repoRootDir, { recursive: true, force: true });
  });

  const dotAdlc = join(cwdDir, '.adlc');
  mkdirSync(dotAdlc, { recursive: true });

  // Baseline file lives ONLY in repoRootDir (not in cwdDir) so --root is load-bearing
  const uniqueTok = 'ZZ_FIXTURE_ONLY_TOKEN_99182';
  writeFileSync(join(repoRootDir, 'index.mjs'), `const token = "${uniqueTok}";\n`, 'utf8');

  const findingsLines = [
    JSON.stringify({ file: 'src/a.mjs', ts: '2026-01-01T00:00:00Z', desc: `prohibited token identifier "${uniqueTok}" detected in syntax`, category: 'correctness' }),
    JSON.stringify({ file: 'src/b.mjs', ts: '2026-01-01T00:01:00Z', desc: `prohibited token identifier "${uniqueTok}" detected in syntax`, category: 'correctness' }),
  ].join('\n');
  writeFileSync(join(dotAdlc, 'findings.jsonl'), findingsLines + '\n', 'utf8');

  // Without --verify-checks (default false), cluster stays lint and does NOT emit interrogation-template.md
  const outDefault = join(cwdDir, 'lessons-default');
  const resDefault = spawnSync(process.execPath, [
    CLI_PATH,
    '--ledger', 'findings',
    '--out-dir', outDefault,
    '--root', repoRootDir,
    '--write',
  ], {
    cwd: cwdDir,
    encoding: 'utf8',
  });
  assert.equal(resDefault.status, 0, (resDefault.stderr || '') + '\n' + (resDefault.stdout || ''));
  assert.equal(existsSync(join(outDefault, 'interrogation-template.md')), false);

  const outDir = join(cwdDir, 'lessons');
  const res = spawnSync(process.execPath, [
    CLI_PATH,
    '--ledger', 'findings',
    '--out-dir', outDir,
    '--root', repoRootDir,
    '--verify-checks',
    '--write',
    '--gate',
    '--json',
  ], {
    cwd: cwdDir,
    encoding: 'utf8',
  });

  assert.equal(res.status, 0, (res.stderr || '') + '\n' + (res.stdout || ''));
  const parsedJson = JSON.parse(res.stdout);
  assert.equal(parsedJson.gate.pass, true);
  assert.deepEqual(parsedJson.gate.unbanked, []);
  const templatePath = join(outDir, 'interrogation-template.md');
  const templateContent = readFileSync(templatePath, 'utf8');
  assert.match(templateContent, /ZZ_FIXTURE_ONLY_TOKEN_99182/);
});
