import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scaffold } from '../index.mjs';
import { ADLC_GITIGNORE_LINES } from '../lib/gitignore-defaults.mjs';
import {
  REQUIRED_COMMITTABLE_PATHS,
  evaluateGitignoreContract,
  evaluateEffectiveGitignoreContract,
} from '../lib/scaffold.mjs';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin/adlc-init.mjs');

// Mis-ordered gitignore with all required lines present, but .adlc/* placed at the end (after negations)
const MISORDERED_GITIGNORE = [
  'node_modules/',
  '!.adlc/config.json',
  '!.adlc/tickets.json',
  '!.adlc/tickets/',
  '!.adlc/tickets/**',
  '!.adlc/ticket-archive/',
  '!.adlc/ticket-archive/**',
  '!.adlc/specs/',
  '!.adlc/manifest.jsonl',
  '!.adlc/manifest.d/',
  '!.adlc/manifest.d/**',
  '.adlc/manifest.d/.lineage',
  '.adlc/manifest.d/*.lock',
  '.adlc/manifest.d/*.tmp-*',
  '.adlc/*',
].join('\n') + '\n';

test('scaffold detects mis-ordered gitignore in a git repo and warns instead of reporting unchanged', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-init-misordered-'));
  try {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    writeFileSync(join(dir, '.gitignore'), MISORDERED_GITIGNORE);

    const result = scaffold({ root: dir });

    assert.equal(
      result.unchanged.includes('.gitignore'),
      false,
      'mis-ordered .gitignore must NOT be reported as unchanged',
    );
    const gitignoreWarnings = result.warnings.filter((w) => w.toLowerCase().includes('gitignore'));
    assert.ok(gitignoreWarnings.length > 0, 'result.warnings must include a warning about mis-ordered gitignore rules');
    assert.equal(readFileSync(join(dir, '.gitignore'), 'utf8'), MISORDERED_GITIGNORE, '.gitignore must remain untouched');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scaffold evaluates rule ordering even when git repository is absent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-init-misordered-'));
  try {
    writeFileSync(join(dir, '.gitignore'), MISORDERED_GITIGNORE);

    const result = scaffold({ root: dir });

    assert.equal(
      result.unchanged.includes('.gitignore'),
      false,
      'mis-ordered .gitignore without git must NOT be reported as unchanged',
    );
    const gitignoreWarnings = result.warnings.filter((w) => w.toLowerCase().includes('gitignore'));
    assert.ok(gitignoreWarnings.length > 0, 'result.warnings must include a warning when git repo is absent');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('properly ordered gitignore without git reports unchanged', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-init-misordered-'));
  try {
    const properContent = '# ADLC runtime\n' + ADLC_GITIGNORE_LINES.join('\n') + '\n';
    writeFileSync(join(dir, '.gitignore'), properContent);

    const result = scaffold({ root: dir });
    assert.ok(result.unchanged.includes('.gitignore'), 'properly ordered .gitignore without git must be reported unchanged');
    const gitignoreWarnings = result.warnings.filter((w) => w.toLowerCase().includes('gitignore'));
    assert.equal(gitignoreWarnings.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('evaluateEffectiveGitignoreContract uses git probe when git repository is present', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-init-misordered-'));
  try {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    writeFileSync(join(dir, '.gitignore'), MISORDERED_GITIGNORE);

    const ignored = evaluateEffectiveGitignoreContract(dir, []);
    assert.deepEqual(ignored, [...REQUIRED_COMMITTABLE_PATHS]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('evaluateEffectiveGitignoreContract falls back to rule ordering when not in git repository', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-init-misordered-'));
  try {
    writeFileSync(join(dir, '.gitignore'), MISORDERED_GITIGNORE);

    const ignored = evaluateEffectiveGitignoreContract(dir, MISORDERED_GITIGNORE.split('\n'));
    assert.deepEqual(ignored, [...REQUIRED_COMMITTABLE_PATHS]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('adlc-init CLI exits 1 and does not print "already current" on mis-ordered gitignore', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-init-misordered-'));
  try {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    writeFileSync(join(dir, '.gitignore'), MISORDERED_GITIGNORE);

    // First run scaffolds config, etc.
    const res1 = spawnSync(process.execPath, [BIN, '--root', dir, '--harness', 'codex'], { encoding: 'utf8' });
    assert.equal(res1.status, 1, 'first init run must exit 1 due to mis-ordered gitignore');
    assert.equal(res1.stdout.includes('already current'), false, 'must not print already current');

    // Second run has everything else current, but gitignore still misordered
    const res2 = spawnSync(process.execPath, [BIN, '--root', dir, '--harness', 'codex'], { encoding: 'utf8' });
    assert.equal(res2.status, 1, 'second init run must exit 1');
    assert.equal(res2.stdout.includes('already current'), false, 'second run must not print already current');
    assert.match(res2.stderr + res2.stdout, /gitignore/i, 'output must warn about gitignore');

    // JSON mode verification
    const resJson = spawnSync(process.execPath, [BIN, '--root', dir, '--harness', 'codex', '--json'], { encoding: 'utf8' });
    assert.equal(resJson.status, 1, 'json init run must exit 1');
    const parsed = JSON.parse(resJson.stdout);
    assert.equal(parsed.ok, false, 'json result.ok must be false');
    assert.equal(parsed.unchanged.includes('.gitignore'), false, 'json result.unchanged must not include .gitignore');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('properly ordered gitignore reports unchanged and init exits 0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-init-misordered-'));
  try {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    const properContent = '# ADLC runtime\n' + ADLC_GITIGNORE_LINES.join('\n') + '\n';
    writeFileSync(join(dir, '.gitignore'), properContent);

    const result = scaffold({ root: dir });
    assert.ok(result.unchanged.includes('.gitignore'), 'properly ordered .gitignore must be reported unchanged');
    const gitignoreWarnings = result.warnings.filter((w) => w.toLowerCase().includes('gitignore'));
    assert.equal(gitignoreWarnings.length, 0, 'properly ordered .gitignore must produce no gitignore warnings');

    const res = spawnSync(process.execPath, [BIN, '--root', dir, '--harness', 'codex'], { encoding: 'utf8' });
    assert.equal(res.status, 0, 'init on properly ordered repo must exit 0');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('required committable paths (.adlc/config.json, .adlc/manifest.jsonl, .adlc/tickets/.store.json, .adlc/manifest.d/seg-1.jsonl) are each verified', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-init-misordered-'));
  try {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    // An ignore file where config.json negation is misplaced before .adlc/*
    const misorderedConfig = [
      '!.adlc/config.json',
      '.adlc/*',
      '!.adlc/tickets.json',
      '!.adlc/tickets/',
      '!.adlc/tickets/**',
      '!.adlc/ticket-archive/',
      '!.adlc/ticket-archive/**',
      '!.adlc/specs/',
      '!.adlc/manifest.jsonl',
      '!.adlc/manifest.d/',
      '!.adlc/manifest.d/**',
      '.adlc/manifest.d/.lineage',
      '.adlc/manifest.d/*.lock',
      '.adlc/manifest.d/*.tmp-*',
    ].join('\n') + '\n';
    writeFileSync(join(dir, '.gitignore'), misorderedConfig);

    const result = scaffold({ root: dir });
    assert.equal(result.unchanged.includes('.gitignore'), false);
    const gitignoreWarnings = result.warnings.filter((w) => w.toLowerCase().includes('gitignore'));
    assert.ok(gitignoreWarnings.length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('evaluateGitignoreContract tests individual path rules and ordering semantics', () => {
  // Comments and empty lines are skipped
  const linesWithComments = [
    '',
    '# A comment',
    '   ',
    '/.adlc/*',
    '!.adlc/config.json',
  ];
  const ignored1 = evaluateGitignoreContract(linesWithComments, ['.adlc/config.json']);
  assert.deepEqual(ignored1, [], 'config.json is negated after broad ignore');

  const ignoredAll = evaluateGitignoreContract(
    ['.adlc/', '!.adlc/tickets/'],
    ['.adlc/tickets/.store.json', '.adlc/manifest.jsonl'],
  );
  assert.deepEqual(ignoredAll, ['.adlc/manifest.jsonl'], 'tickets are negated, manifest is ignored');

  const ignoredManifestSeg = evaluateGitignoreContract(
    ['!.adlc/manifest.d/**', '.adlc/*'],
    ['.adlc/manifest.d/seg-1.jsonl'],
  );
  assert.deepEqual(ignoredManifestSeg, ['.adlc/manifest.d/seg-1.jsonl'], 'manifest.d is overridden by later .adlc/*');

  const slashRootPattern = evaluateGitignoreContract(
    ['/.adlc/*'],
    ['.adlc/config.json'],
  );
  assert.deepEqual(slashRootPattern, ['.adlc/config.json'], 'leading slash on .adlc/* matches .adlc/config.json');

  const trailingSlashPattern = evaluateGitignoreContract(
    ['.adlc/tickets/'],
    ['.adlc/tickets/.store.json'],
  );
  assert.deepEqual(trailingSlashPattern, ['.adlc/tickets/.store.json'], 'trailing slash on directory matches file inside');

  const bareDirPattern = evaluateGitignoreContract(
    ['.adlc'],
    ['.adlc/config.json'],
  );
  assert.deepEqual(bareDirPattern, ['.adlc/config.json'], 'bare directory name pattern matches files inside');

  const unmatchedPattern = evaluateGitignoreContract(
    ['node_modules/'],
    ['.adlc/config.json'],
  );
  assert.deepEqual(unmatchedPattern, [], 'unmatched pattern leaves path unignored');

  // Slashless patterns match basenames at any directory depth
  const ignoredJson = evaluateGitignoreContract(['*.json'], ['.adlc/config.json']);
  assert.deepEqual(ignoredJson, ['.adlc/config.json'], '*.json matches .adlc/config.json at depth');

  const ignoredJsonl = evaluateGitignoreContract(
    ['*.jsonl'],
    ['.adlc/manifest.jsonl', '.adlc/manifest.d/seg-1.jsonl'],
  );
  assert.deepEqual(
    ignoredJsonl,
    ['.adlc/manifest.jsonl', '.adlc/manifest.d/seg-1.jsonl'],
    '*.jsonl matches manifest.jsonl and seg-1.jsonl at varying depths',
  );

  const ignoredPrefixWildcard = evaluateGitignoreContract(
    ['seg-*.jsonl'],
    ['.adlc/manifest.d/seg-1.jsonl'],
  );
  assert.deepEqual(ignoredPrefixWildcard, ['.adlc/manifest.d/seg-1.jsonl'], 'seg-*.jsonl matches basename');

  const rootOnlyJson = evaluateGitignoreContract(['/*.json'], ['.adlc/config.json']);
  assert.deepEqual(rootOnlyJson, [], '/*.json with leading slash does not match nested .adlc/config.json');

  const unignoredSlashless = evaluateGitignoreContract(
    ['*.json', '!.adlc/config.json'],
    ['.adlc/config.json'],
  );
  assert.deepEqual(unignoredSlashless, [], '*.json negated by !.adlc/config.json');

  const nonMatchingSlashless = evaluateGitignoreContract(
    ['*.txt'],
    ['.adlc/config.json'],
  );
  assert.deepEqual(nonMatchingSlashless, [], '*.txt does not match .adlc/config.json');
});

test('scaffold normalizes .adlc/ placed after negations, writes update, and warns about mis-ordered rules', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-init-misordered-'));
  try {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    const content = [
      '!.adlc/config.json',
      '!.adlc/manifest.jsonl',
      '!.adlc/tickets/.store.json',
      '!.adlc/manifest.d/seg-*.jsonl',
      '.adlc/',
    ].join('\n') + '\n';
    writeFileSync(join(dir, '.gitignore'), content);

    const result = scaffold({ root: dir });
    assert.ok(result.updated.includes('.gitignore'), '.gitignore must be updated by normalization');
    const gitignoreWarnings = result.warnings.filter((w) => w.toLowerCase().includes('gitignore'));
    assert.ok(gitignoreWarnings.length > 0, 'must warn about mis-ordered rules after normalization');

    const res = spawnSync(process.execPath, [BIN, '--root', dir, '--harness', 'codex'], { encoding: 'utf8' });
    assert.equal(res.status, 1, 'init CLI must exit 1 due to mis-ordered rules after normalization');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scaffold appending missing .adlc/* after pre-existing negation updates file and warns', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-init-misordered-'));
  try {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    // Pre-existing negation without .adlc/*
    writeFileSync(join(dir, '.gitignore'), '!.adlc/config.json\n');

    const result = scaffold({ root: dir });
    assert.ok(result.updated.includes('.gitignore'), '.gitignore must be updated when appending missing lines');
    const gitignoreWarnings = result.warnings.filter((w) => w.toLowerCase().includes('gitignore'));
    assert.ok(gitignoreWarnings.length > 0, 'must warn when appended .adlc/* leaves negation dead');

    const res = spawnSync(process.execPath, [BIN, '--root', dir, '--harness', 'codex'], { encoding: 'utf8' });
    assert.equal(res.status, 1, 'init CLI must exit 1 when appended .adlc/* leaves negation dead');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test('scaffold detects mis-ordered gitignore when required files are already tracked in git', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-init-tracked-'));
  try {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    mkdirSync(join(dir, '.adlc'), { recursive: true });
    writeFileSync(join(dir, '.adlc', 'config.json'), '{"version": 1}\n');
    execFileSync('git', ['add', '.adlc/config.json'], { cwd: dir });
    execFileSync('git', ['commit', '-m', 'commit tracked config'], { cwd: dir });

    // Now introduce mis-ordered .gitignore where .adlc/* is last
    const content = [
      '# ADLC runtime',
      '!.adlc/config.json',
      '!.adlc/manifest.jsonl',
      '!.adlc/tickets/',
      '!.adlc/manifest.d/',
      '.adlc/*',
    ].join('\n') + '\n';
    writeFileSync(join(dir, '.gitignore'), content);

    const res = spawnSync(process.execPath, [BIN, '--root', dir, '--harness', 'codex'], { encoding: 'utf8' });
    assert.equal(res.status, 1, 'init CLI must exit 1 even when required files are already tracked in git');
    assert.match(res.stderr, /gitignore.*\.adlc\/config\.json/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('evaluateGitignoreContract matches wildcard directory patterns like */ in fallback', () => {
  const lines = [
    '!.adlc/config.json',
    '*/',
  ];
  const ignored = evaluateGitignoreContract(lines, ['.adlc/config.json']);
  assert.deepEqual(ignored, ['.adlc/config.json'], 'wildcard directory rule */ must match directory in fallback');
});
